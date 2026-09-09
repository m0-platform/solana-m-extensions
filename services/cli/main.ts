import { Command } from "commander";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createInitializeDefaultAccountStateInstruction,
  createSetAuthorityInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  getTokenMetadata,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TYPE_SIZE,
  AccountState,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  createUpdateAuthorityInstruction,
  createUpdateFieldInstruction,
  Field,
  pack,
  TokenMetadata,
} from "@solana/spl-token-metadata";
import {
  createInitializeConfidentialTransferMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
} from "./token-extensions";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { ExtSwap } from "../../target/types/ext_swap";
import { MExt as MigrateExt } from "../../target/types/migrate";
import { MExt as CrankExt } from "../../target/types/crank";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { sha256 } from "@noble/hashes/sha2";
import {
  createFungible,
  fetchMetadataFromSeeds,
  mplTokenMetadata,
  updateV1,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  percentAmount,
  createSignerFromKeypair,
  signerIdentity,
  publicKey,
} from "@metaplex-foundation/umi";

const EXT_SWAP_IDL = require("../../target/idl/ext_swap.json");
const NO_YIELD_EXT_IDL = require("../../target/idl/no_yield.json");
const SCALED_UI_EXT_IDL = require("../../target/idl/scaled_ui.json");
const CRANK_EXT_IDL = require("../../target/idl/crank.json");
const MIGRATE_EXT_IDL = require("../../target/idl/migrate.json");

// Extension mints
const mints: { [key: string]: string } = {
  extaykYu5AQcDm3qZAbiDN3yp6skqn6Nssj7veUUGZw:
    "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX",
  extMahs9bUFMYcviKCvnSRaXgs5PcqmMzcnHRtTqE85:
    "usdkyPPxgV7sfNyKb8eDz66ogPrkRXG3wS2FVb6LLUf",
  Fb2AsCKmPd4gKhabT6KsremSHMrJ8G2Mopnc6rDQZX9e:
    "usdkbee86pkLyRmxfFCdkyySpxRb5ndCxVsK2BkRXwX",
  "3PskKTHgboCbUSQPMcCAZdZNFHbNvSoZ8zEFYANCdob7":
    "usdkyPPxgV7sfNyKb8eDz66ogPrkRXG3wS2FVb6LLUf",
  wMXX1K1nca5W4pZr1piETe78gcAVVrEFi9f4g46uXko:
    "mzeroXDoBpRVhnEXBra27qzAMdxgpWVY3DzQW7xMVJp",
  mexteGyWXgUR65XepNKtLJ2H66MmyLWrDSeA1bqzZ4C:
    "xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y",
  extUkDFf3HLekkxbcZ3XRUizMjbxMJgKBay3p9xGVmg:
    "usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia",
  mextzNVPUbLbvyBwqBqnC5J1SSwjDLjjR4yppf6EBzc:
    "dawn7ZUF7h7anFuEsDdAU1Y3HYwikwqNMAENZsQJdNL"
};

const M_MINT = new PublicKey("mzerojk9tg56ebsrEAhfkyc9VgKjTW2zDqp6C5mhjzH");
const EXT_SWAP: PublicKey = new PublicKey(
  "MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH",
);

function keysFromEnv(keys: string[]) {
  return keys.map((key) =>
    Keypair.fromSecretKey(Buffer.from(JSON.parse(process.env[key] ?? "[]"))),
  );
}

function anchorProvider(connection: Connection, owner: Keypair) {
  return new AnchorProvider(connection, new Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: false,
  });
}

async function main() {
  const program = new Command();
  const connection = new Connection(process.env.RPC_URL ?? "");

  program.command("print-extensions").action(async () => {
    const { execSync } = require("child_process");

    const opKeys: { [name: string]: string } = {
      USDK: "op://Solana Dev/Solana Program Keys/program-keypair-1",
      USDKY: "op://Solana Dev/Solana Program Keys/program-keypair-2",
      "USD+": "op://Solana Dev/Solana Program Keys/program-keypair-3",
      XO: "op://Solana Dev/Solana Program Keys/solana-earner-delta-keypair",
    };

    const tableData = Object.entries(opKeys).map(([name, path]) => {
      const raw = execSync(`op read "${path}"`, { encoding: "utf-8" }).trim();
      const keypair = Keypair.fromSecretKey(Buffer.from(JSON.parse(raw)));
      return {
        Name: name,
        Address: keypair.publicKey.toBase58(),
      };
    });

    console.table(tableData);
  });

  program
    .command("create-ext-mint")
    .description(
      "Create a new mint for an M extension using the Token2022 program",
    )
    .option("-n, --name <string>", "Token Name", process.env.EXT_NAME)
    .option("-s, --symbol <string>", "Token Symbol", process.env.EXT_SYMBOL)
    .option("-u, --uri [string]", "Token URI", process.env.EXT_URI)
    .option("--init-scaled-ui", "Enable scaled UI amounts", false)
    .option(
      "--confidential-transfers-authority <pubkey>",
      "Enable confidential transfers",
      "",
    )
    .option("--transfer-hook-authority <pubkey>", "Enable transfer hook", "")
    .option("--pause-authority <pubkey>", "Enable pauser extension", "")
    .option(
      "--permanent-delegate-authority <pubkey>",
      "permanent delegate extension",
      "",
    )
    .option("--legacy-program", "Do not use Token2022 program", false)
    .option("-f --freeze-authority <pubkey>", "Token freeze authority", "")
    .option("--metadata-authority <pubkey>", "Metadata authority", "")
    .option("--init-default-state", "Default accounts state", false)
    .action(
      async ({
        name,
        symbol,
        uri,
        initScaledUi,
        confidentialTransfersAuthority,
        pauseAuthority,
        legacyProgram,
        freezeAuthority,
        permanentDelegateAuthority,
        metadataAuthority,
        transferHookAuthority,
        initDefaultState,
      }) => {
        const [payer, mint, ext] = keysFromEnv([
          "PAYER_KEYPAIR",
          "EXT_MINT_KEYPAIR",
          "EXT_PROGRAM_KEYPAIR",
        ]);

        console.log(
          `Deploying ${mint.publicKey.toBase58()} for extension program ${ext.publicKey.toBase58()}`,
        );

        const authority = process.env.SQUADS_MULTISIG
          ? new PublicKey(process.env.SQUADS_MULTISIG)
          : payer.publicKey;

        // Get the mint authority by deriving the PDA from the extension program
        let mintAuthority = PublicKey.findProgramAddressSync(
          [Buffer.from("mint_authority")],
          ext.publicKey,
        )[0];

        if (legacyProgram) {
          const umi = createUmi(process.env.RPC_URL!);
          const owner = umi.eddsa.createKeypairFromSecretKey(payer.secretKey);
          const _mint = umi.eddsa.createKeypairFromSecretKey(mint.secretKey);

          umi.use(signerIdentity(createSignerFromKeypair(umi, owner)));
          umi.use(mplTokenMetadata());

          await createFungible(umi, {
            name,
            symbol,
            decimals: 6,
            mint: createSignerFromKeypair(umi, _mint),
            uri,
            sellerFeeBasisPoints: percentAmount(0),
          }).sendAndConfirm(umi);

          // Transfer mint authority to extension program pda
          const setAuthorities = new Transaction().add(
            createSetAuthorityInstruction(
              mint.publicKey,
              payer.publicKey,
              AuthorityType.MintTokens,
              mintAuthority,
              undefined,
              TOKEN_PROGRAM_ID,
            ),
          );

          const freezeAuth = freezeAuthority ?? process.env.SQUADS_MULTISIG;

          if (freezeAuth) {
            setAuthorities.add(
              createSetAuthorityInstruction(
                mint.publicKey,
                payer.publicKey,
                AuthorityType.FreezeAccount,
                new PublicKey(freezeAuth),
                undefined,
                TOKEN_PROGRAM_ID,
              ),
            );
          }

          setAuthorities.feePayer = payer.publicKey;
          const blockhash = await connection.getLatestBlockhash();
          setAuthorities.recentBlockhash = blockhash.blockhash;
          await connection.sendTransaction(setAuthorities, [payer], {
            preflightCommitment: "processed",
          });

          console.log(`Created token mint at ${mint.publicKey.toBase58()}`);
          return;
        }

        // Create the list of extensions
        let extensions: ExtensionType[] = [ExtensionType.MetadataPointer];
        if (initScaledUi) {
          console.log("Adding scaled UI amount extension");
          extensions.push(ExtensionType.ScaledUiAmountConfig);
        }
        if (confidentialTransfersAuthority) {
          console.log("Adding confidential transfer extension");
          extensions.push(ExtensionType.ConfidentialTransferMint);
        }
        if (transferHookAuthority) {
          console.log("Adding transfer hook extension");
          extensions.push(ExtensionType.TransferHook);
        }
        if (pauseAuthority) {
          console.log("Adding pausable extension");
          extensions.push(ExtensionType.PausableConfig);
        }
        if (permanentDelegateAuthority) {
          console.log("Adding permanent delegate extension");
          extensions.push(ExtensionType.PermanentDelegate);
        }
        if (initDefaultState) {
          console.log("Adding default accounts state extension");
          extensions.push(ExtensionType.DefaultAccountState);
        }

        // Create the token 2022 mint with the ScaledUiAmount extension
        await createToken2022Mint(
          connection,
          payer,
          authority,
          mint,
          mintAuthority,
          freezeAuthority ? new PublicKey(freezeAuthority) : authority,
          pauseAuthority ? new PublicKey(pauseAuthority) : null,
          permanentDelegateAuthority
            ? new PublicKey(permanentDelegateAuthority)
            : null,
          metadataAuthority ? new PublicKey(metadataAuthority) : null,
          transferHookAuthority ? new PublicKey(transferHookAuthority) : null,
          confidentialTransfersAuthority
            ? new PublicKey(confidentialTransfersAuthority)
            : null,
          name,
          symbol,
          uri,
          extensions,
        );

        console.log(`Created token mint at ${mint.publicKey.toBase58()}`);
      },
    );

  program
    .command("create-vault-m-ata")
    .description(
      "Creates an associated token account for the M mint for the extension program's vault PDA.",
    )
    .action(async ({}) => {
      const [owner, extProgram] = keysFromEnv([
        "PAYER_KEYPAIR",
        "EXT_PROGRAM_KEYPAIR",
      ]);

      // Create the vault ATA for the ext program if it doesn't exist
      const vault = PublicKey.findProgramAddressSync(
        [Buffer.from("m_vault")],
        extProgram.publicKey,
      )[0];
      console.log("Vault PDA:", vault.toBase58());
      const vaultAta = await getOrCreateAssociatedTokenAccount(
        connection,
        owner,
        M_MINT,
        vault,
        true,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Vault ATA:", vaultAta.address.toBase58());
    });

  program
    .command("create-ata")
    .description(
      "Creates an associated token account for the provided account on the provided mint",
    )
    .option("-m, --mint <pubkey>", "Mint public key")
    .option("-a, --account <pubkey>", "Account public key")
    .action(async ({ mint, account }) => {
      const [owner] = keysFromEnv(["PAYER_KEYPAIR"]);

      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        owner,
        new PublicKey(mint),
        new PublicKey(account),
        true,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("ATA:", ata.address.toBase58());
    });

  program
    .command("initialize-ext")
    .description("Initialize the extension program")
    .option("-v, --variant <string>", "Program variant", "no-yield")
    .option("-f, --fee [number]", "Fee in bps", "0")
    .option(
      '-t, --token-program <"spl"|"token2022">',
      "Token program",
      "token2022",
    )
    .action(async ({ variant, fee, tokenProgram }) => {
      const [payer, extMint, program] = keysFromEnv([
        "PAYER_KEYPAIR",
        "EXT_MINT_KEYPAIR",
        "EXT_PROGRAM_KEYPAIR",
      ]);

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      // Setup wrap authorities list
      const swapGlobalSigner = PublicKey.findProgramAddressSync(
        [Buffer.from("global")],
        EXT_SWAP,
      )[0];
      const portalTokenAuth = PublicKey.findProgramAddressSync(
        [Buffer.from("token_authority")],
        new PublicKey("mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY"),
      )[0];

      const wrapAuthorities: PublicKey[] = [
        swapGlobalSigner,
        portalTokenAuth,
        admin,
      ];

      let transaction: Transaction;
      switch (variant) {
        case "no-yield":
          // Insert the program ID into the IDL so we can interact with it
          NO_YIELD_EXT_IDL.address = program.publicKey.toBase58();

          const noYieldProgram = new Program(
            NO_YIELD_EXT_IDL,
            anchorProvider(connection, payer),
          );

          transaction = await noYieldProgram.methods
            .initialize(wrapAuthorities)
            .accounts({
              admin: admin,
              mMint: M_MINT,
              extMint: extMint.publicKey,
              extTokenProgram:
                tokenProgram === "spl"
                  ? TOKEN_PROGRAM_ID
                  : TOKEN_2022_PROGRAM_ID,
            })
            .transaction();

          console.log("Initialized no yield extension");
          break;

        case "scaled-ui":
          // Insert the program ID into the IDL so we can interact with it
          SCALED_UI_EXT_IDL.address = program.publicKey.toBase58();

          const suiProgram = new Program(
            SCALED_UI_EXT_IDL,
            anchorProvider(connection, payer),
          );

          transaction = await suiProgram.methods
            .initialize(wrapAuthorities, new BN(fee))
            .accounts({
              admin: admin,
              mMint: M_MINT,
              extMint: extMint.publicKey,
              extTokenProgram:
                tokenProgram === "spl"
                  ? TOKEN_PROGRAM_ID
                  : TOKEN_2022_PROGRAM_ID,
            })
            .transaction();

          console.log("Initialized scaled UI extension");

          break;
        default:
          throw new Error(`Unknown variant: ${variant}`);
      }

      transaction.feePayer = admin;
      transaction.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;

      sendOrSerialize(transaction, connection, payer);
    });

  program
    .command("migrate-ext")
    .option("-e, --extension <name>", "Extension program ID", "M0_WM")
    .action(async ({ extension }) => {
      const [payer, ext] = keysFromEnv(["PAYER_KEYPAIR", extension]);
      MIGRATE_EXT_IDL.address = ext.publicKey;
      console.log("Migrating extension:", ext.publicKey.toBase58());

      const program = new Program<MigrateExt>(
        MIGRATE_EXT_IDL,
        anchorProvider(connection, payer),
      );

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const vault = PublicKey.findProgramAddressSync(
        [Buffer.from("m_vault")],
        ext.publicKey,
      )[0];

      const tx = await program.methods
        .migrateM()
        .accountsPartial({
          admin,
          newMMint: M_MINT,
          extMint: mints[ext.publicKey.toBase58()],
        })
        .transaction();

      await sendOrSerialize(tx, connection, payer);
    });

  program
    .command("initialize-ext-swap")
    .description("Initialize the Extension Swap Facility")
    .action(async () => {
      const [payer] = keysFromEnv(["PAYER_KEYPAIR"]);
      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const extSwap = new Program<ExtSwap>(
        EXT_SWAP_IDL,
        anchorProvider(connection, payer),
      );

      const tx = await extSwap.methods
        .initializeGlobal()
        .accounts({
          admin,
        })
        .transaction();

      tx.feePayer = admin;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      sendOrSerialize(tx, connection, payer);
    });

  program
    .command("add-wrap-authority")
    .description("Add a wrap authority on the Extension program")
    .option("-e, --extension <name>", "Extension program ID", "M0_WM")
    .argument(
      "<wrapAuthorities>",
      "Comma-separated list of pubkeys to whitelist",
    )
    .action(async (wrapAuthorities, { extension }) => {
      const [payer, ext] = keysFromEnv(["PAYER_KEYPAIR", extension]);

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      // Insert the program ID into the IDL so we can interact with it
      NO_YIELD_EXT_IDL.address = ext.publicKey.toBase58();

      const program = new Program(
        NO_YIELD_EXT_IDL,
        anchorProvider(connection, payer),
      );

      const tx = new Transaction();

      for (const auth of wrapAuthorities.split(",")) {
        tx.add(
          await program.methods
            .addWrapAuthority(new PublicKey(auth))
            .accounts({
              admin,
            })
            .instruction(),
        );
      }

      tx.feePayer = admin;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      sendOrSerialize(tx, connection, payer);
    });

  program.command("reset-swap-authority").action(async () => {
    const [payer] = keysFromEnv(["PAYER_KEYPAIR"]);
    const admin = process.env.SQUADS_MULTISIG
      ? new PublicKey(process.env.SQUADS_MULTISIG)
      : payer.publicKey;

    const tx = new Transaction().add(
      new TransactionInstruction({
        programId: EXT_SWAP,
        keys: [
          {
            pubkey: admin,
            isSigner: true,
            isWritable: false,
          },
          {
            pubkey: PublicKey.findProgramAddressSync(
              [Buffer.from("global")],
              EXT_SWAP,
            )[0],
            isSigner: false,
            isWritable: true,
          },
        ],
        data: Buffer.concat([
          Buffer.from(sha256("global:reset_whitelists").subarray(0, 8)),
        ]),
      }),
    );

    tx.feePayer = admin;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    sendOrSerialize(tx, connection, payer);
  });

  program
    .command("whitelist-swap-unwrapper")
    .description("Whitelist an unwrapper on the swap program")
    .argument("<authorities>", "Comma-separated list of pubkeys to whitelist")
    .action(async (auths) => {
      const [payer] = keysFromEnv(["PAYER_KEYPAIR"]);

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const swap = new Program<ExtSwap>(
        EXT_SWAP_IDL,
        anchorProvider(connection, payer),
      );

      const tx = new Transaction();

      for (const auth of auths.split(",")) {
        tx.add(
          await swap.methods
            .whitelistUnwrapper(new PublicKey(auth))
            .accounts({
              admin,
            })
            .instruction(),
        );
      }

      tx.feePayer = admin;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      sendOrSerialize(tx, connection, payer);
    });

  program
    .command("whitelist-extensions")
    .description("Whitelist extensions on the Swap Facility")
    .argument("<extensions>", "Comma-separated list of extensions")
    .action(async (extensions) => {
      const [payer] = keysFromEnv(["PAYER_KEYPAIR"]);

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const extSwap = new Program<ExtSwap>(
        EXT_SWAP_IDL,
        anchorProvider(connection, payer),
      );

      const tx = new Transaction();

      for (const ext of extensions.split(",")) {
        tx.add(
          await extSwap.methods
            .whitelistExtension()
            .accountsPartial({
              admin,
              extProgram: new PublicKey(ext),
              extMint: mints[ext],
            })
            .instruction(),
        );
      }

      tx.feePayer = admin;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      sendOrSerialize(tx, connection, payer);
    });

  program
    .command("remove-whitelisted-extensions")
    .description("Remove whitelisted extensions on the Swap Facility")
    .argument("<extensions>", "Extension to remove")
    .action(async (extensions) => {
      const [payer] = keysFromEnv(["PAYER_KEYPAIR"]);

      const admin = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const extSwap = new Program<ExtSwap>(
        EXT_SWAP_IDL,
        anchorProvider(connection, payer),
      );

      const tx = new Transaction();

      for (const extension of extensions.split(",")) {
        tx.add(
          await extSwap.methods
            .removeWhitelistedExtension(new PublicKey(extension))
            .accounts({
              admin,
            })
            .instruction(),
        );
      }

      tx.feePayer = admin;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      sendOrSerialize(tx, connection, payer);
    });

  program
    .command("update-swap-lut")
    .description("Create or update the LUT for common addresses")
    .action(async () => {
      const [owner, wM, ext1, ext2] = keysFromEnv([
        "PAYER_KEYPAIR",
        "M0_WM",
        "USDK",
        "USDKY",
        "USDP",
        "XO",
      ]);
      const ixs = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
      ];

      // Get or create LUT
      let tableAddress: PublicKey;
      if (process.env.LOOKUP_TABLE) {
        tableAddress = new PublicKey(process.env.LOOKUP_TABLE);
      } else {
        const [lookupTableIx, lookupTableAddress] =
          AddressLookupTableProgram.createLookupTable({
            authority: owner.publicKey,
            payer: owner.publicKey,
            recentSlot:
              (await connection.getSlot({ commitment: "finalized" })) - 10,
          });

        console.log(`Creating lookup table: ${lookupTableAddress.toBase58()}`);
        tableAddress = lookupTableAddress;
        ixs.push(lookupTableIx);
      }

      const addressesForTable = [EXT_SWAP];

      // Swap program addresses
      addressesForTable.push(
        PublicKey.findProgramAddressSync([Buffer.from("global")], EXT_SWAP)[0],
        PublicKey.findProgramAddressSync(
          [Buffer.from("global")],
          new PublicKey("mz2vDzjbQDUDXBH6FPF5s4odCJ4y8YLE5QWaZ8XdZ9Z"),
        )[0],
        M_MINT,
        new PublicKey("mz2vDzjbQDUDXBH6FPF5s4odCJ4y8YLE5QWaZ8XdZ9Z"), // earn
        new PublicKey("63MBrEFq6pV6RLDuC3aQTcRhZuysgFcrfDS1dsFXxv2o"), // transiever pda
        new PublicKey("execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV"), // executor
      );

      // Add common addresses for each extension
      for (const ext of [wM, ext1, ext2]) {
        const mint = new PublicKey(mints[ext.publicKey.toBase58()]);

        const vault = PublicKey.findProgramAddressSync(
          [Buffer.from("m_vault")],
          ext.publicKey,
        )[0];

        const vaultAta = getAssociatedTokenAddressSync(
          mint,
          vault,
          true,
          TOKEN_2022_PROGRAM_ID,
        );

        addressesForTable.push(
          ext.publicKey,
          PublicKey.findProgramAddressSync(
            [Buffer.from("global")],
            ext.publicKey,
          )[0],
          mint,
          vault,
          PublicKey.findProgramAddressSync(
            [Buffer.from("mint_authority")],
            ext.publicKey,
          )[0],
          vaultAta,
        );
      }

      // get rate limit PDAs
      for (const chainID of process.env.NETWORK === "devnet" ? [1, 51] : []) {
        const inbox = PublicKey.findProgramAddressSync(
          [
            Buffer.from("inbox_rate_limit"),
            new BN(chainID).toArrayLike(Buffer, "le", 2),
          ],
          new PublicKey("mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY"),
        )[0];
        const peer = PublicKey.findProgramAddressSync(
          [Buffer.from("peer"), new BN(chainID).toArrayLike(Buffer, "le", 2)],
          new PublicKey("mzp1q2j5Hr1QuLC3KFBCAUz5aUckT6qyuZKZ3WJnMmY"),
        )[0];
        addressesForTable.push(inbox, peer);
      }

      // Fetch current state of LUT
      let existingAddresses: PublicKey[] = [];
      if (process.env.LOOKUP_TABLE) {
        const state = (await connection.getAddressLookupTable(tableAddress))
          .value?.state.addresses;
        if (!state) {
          throw new Error(
            `Failed to fetch state for address lookup table ${tableAddress}`,
          );
        }
        if (state.length === 256) {
          throw new Error("LUT is full");
        }

        existingAddresses = state;
      }

      // Dedupe missing addresses
      const toAdd = addressesForTable.filter(
        (address) => !existingAddresses.find((a) => a.equals(address)),
      );
      if (toAdd.length === 0) {
        console.log("No addresses to add");
        return;
      }

      if (existingAddresses.length + toAdd.length > 256) {
        throw new Error(`cannot add ${toAdd.length} more addresses`);
      }

      ixs.push(
        AddressLookupTableProgram.extendLookupTable({
          payer: owner.publicKey,
          authority: owner.publicKey,
          lookupTable: tableAddress,
          addresses: toAdd,
        }),
      );

      // Send transaction
      const blockhash = await connection.getLatestBlockhash("finalized");

      const messageV0 = new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: blockhash.blockhash,
        instructions: ixs,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([owner]);
      const txid = await connection.sendTransaction(transaction);
      console.log(`Transaction sent ${txid}\t${toAdd.length} addresses added`);

      // Confirm
      const confirmation = await connection.confirmTransaction(
        {
          signature: txid,
          blockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
        },
        "confirmed",
      );
      if (confirmation.value.err) {
        throw new Error(`Transaction not confirmed: ${confirmation.value.err}`);
      }
    });

  program
    .command("update-mint")
    .option("-n, --name <string>", "Token Name")
    .option("-s, --symbol <string>", "Token Symbol")
    .option("-u, --uri <string>", "Token metadata URI")
    .option("-f, --field <key:value>", "Metadata field")
    .option("--legacy-program", "Do not use Token2022 program", false)
    .action(async ({ name, symbol, uri, field, legacyProgram }) => {
      const [mint, payer] = keysFromEnv(["EXT_MINT_KEYPAIR", "PAYER_KEYPAIR"]);

      if (legacyProgram) {
        if (!uri) {
          throw new Error("URI is required when updating legacy token");
        }

        const umi = createUmi(process.env.RPC_URL!);
        const owner = umi.eddsa.createKeypairFromSecretKey(payer.secretKey);
        umi.use(signerIdentity(createSignerFromKeypair(umi, owner)));

        const metaplexMint = publicKey(mint.publicKey.toBase58());
        const initialMetadata = await fetchMetadataFromSeeds(umi, {
          mint: metaplexMint,
        });

        await updateV1(umi, {
          mint: metaplexMint,
          data: { ...initialMetadata, uri },
        }).sendAndConfirm(umi);

        return;
      }

      const metadata = await getTokenMetadata(
        connection,
        mint.publicKey,
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      if (!metadata) {
        throw new Error(
          `No metadata found for mint ${mint.publicKey.toBase58()}`,
        );
      }

      const currentSize = pack(metadata).length;
      const instructions: TransactionInstruction[] = [];
      const auth = new PublicKey(process.env.SQUADS_MULTISIG!);

      if (name) {
        console.log(`Updating token name to: ${name}`);
        metadata.name = name;

        instructions.push(
          createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            metadata: mint.publicKey,
            updateAuthority: auth,
            field: Field.Name,
            value: name,
          }),
        );
      }

      if (symbol) {
        console.log(`Updating token symbol to: ${symbol}`);
        metadata.symbol = symbol;

        instructions.push(
          createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            metadata: mint.publicKey,
            updateAuthority: auth,
            field: Field.Symbol,
            value: symbol,
          }),
        );
      }

      if (uri) {
        console.log(`Updating token metadata to: ${uri}`);
        metadata.uri = uri;

        instructions.push(
          createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            metadata: mint.publicKey,
            updateAuthority: auth,
            field: Field.Uri,
            value: uri,
          }),
        );
      }

      if (field) {
        const idx = (field as string).search(":");
        const key = (field as string).substring(0, idx);
        const value = (field as string).substring(idx + 1);

        console.log(`Adding additional metadata field: ${key}=${value}`);
        metadata.additionalMetadata.push([key, value]);

        instructions.push(
          createUpdateFieldInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            metadata: mint.publicKey,
            updateAuthority: auth,
            field: key,
            value: value,
          }),
        );
      }

      // rent for additional metadata size
      const newSize = pack(metadata).length;

      if (newSize > currentSize) {
        const accountInfo = await connection.getAccountInfo(mint.publicKey);
        const lamports = await connection.getMinimumBalanceForRentExemption(
          accountInfo!.data.length + newSize - currentSize,
        );

        const diff = lamports - accountInfo!.lamports;

        if (diff > 0) {
          console.log(
            `Mint needs ${diff} lamports to cover additional metadata size`,
          );

          instructions.push(
            SystemProgram.transfer({
              fromPubkey: auth,
              toPubkey: mint.publicKey,
              lamports: diff,
            }),
          );
        }
      }

      const tx = new Transaction().add(...instructions);
      tx.feePayer = auth;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const b = tx.serialize({ verifySignatures: false });
      console.log("Transaction:", {
        b64: b.toString("base64"),
        b58: bs58.encode(b),
      });
    });

  program
    .command("set-yield-recipient")
    .option("-e, --extension <name>", "Extension name", "M0_WM")
    .argument("<user-token-account>", "User token account")
    .argument("<recipient-token-account>", "Yield recipient token account")
    .action(async (userTokenAccount, recipientTokenAccount, { extension }) => {
      const [payer, extKey] = keysFromEnv(["PAYER_KEYPAIR", extension]);

      const earnManager = process.env.SQUADS_MULTISIG
        ? new PublicKey(process.env.SQUADS_MULTISIG)
        : payer.publicKey;

      const userTA = new PublicKey(userTokenAccount);
      const recipientTA = new PublicKey(recipientTokenAccount);

      let idl = CRANK_EXT_IDL;
      // Insert the program ID into the IDL so we can interact with it
      idl.address = extKey.publicKey.toBase58();

      const ext = new Program<CrankExt>(idl, anchorProvider(connection, payer));
      const earnerAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("earner"), userTA.toBuffer()],
        extKey.publicKey,
      )[0];
      const earnManagerAccount = PublicKey.findProgramAddressSync(
        [Buffer.from("earn_manager"), earnManager.toBuffer()],
        extKey.publicKey,
      )[0];

      const ix = await ext.methods
        .setRecipient()
        .accountsPartial({
          signer: earnManager,
          earnerAccount: earnerAccount,
          earnManagerAccount: earnManagerAccount,
          recipientTokenAccount: recipientTA,
        })
        .instruction();

      if (process.env.SQUADS_MULTISIG) {
        const tx = new Transaction().add(ix);
        tx.feePayer = earnManager;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const b = tx.serialize({ verifySignatures: false });
        console.log("Transaction:", {
          b64: b.toString("base64"),
          b58: bs58.encode(b),
        });
      } else {
        const tx = new Transaction().add(ix);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

        const sig = await connection.sendTransaction(tx, [payer]);
        console.log(`Txn sent: ${sig}`);
      }
    });

  await program.parseAsync(process.argv);
}

async function createToken2022Mint(
  connection: Connection,
  payer: Keypair,
  authority: PublicKey,
  mint: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  pauserAuthority: PublicKey | null,
  permanentDelegateAuthority: PublicKey | null,
  metadataAuthority: PublicKey | null,
  transferHookAuthority: PublicKey | null,
  confidentialTransfersAuthority: PublicKey | null,
  tokenName: string,
  tokenSymbol: string,
  uri: string,
  extensions: ExtensionType[],
  evmTokenAddress: string | null = null,
) {
  const metaData: TokenMetadata = {
    updateAuthority: authority,
    mint: mint.publicKey,
    name: tokenName,
    symbol: tokenSymbol,
    uri,
    additionalMetadata: evmTokenAddress ? [["evm", evmTokenAddress]] : [],
  };

  // mint size with extensions
  const metadataExtension = TYPE_SIZE + LENGTH_SIZE;
  const metadataLen = pack(metaData).length;
  const mintLen = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(
    mintLen + metadataExtension + metadataLen,
  );

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ];

  for (const extension of extensions) {
    switch (extension) {
      case ExtensionType.MetadataPointer:
        instructions.push(
          createInitializeMetadataPointerInstruction(
            mint.publicKey,
            metadataAuthority ?? authority,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      case ExtensionType.ScaledUiAmountConfig:
        instructions.push(
          createInitializeScaledUiAmountConfigInstruction(
            mint.publicKey,
            mintAuthority, // mint authority must be scaled ui config authority
            1.0, // multiplier
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      case ExtensionType.TransferHook:
        instructions.push(
          createInitializeTransferHookInstruction(
            mint.publicKey,
            transferHookAuthority ?? authority,
            PublicKey.default, // no transfer hook
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      case ExtensionType.ConfidentialTransferMint:
        instructions.push(
          createInitializeConfidentialTransferMintInstruction(
            mint.publicKey,
            confidentialTransfersAuthority ?? authority,
            false,
          ),
        );
        break;
      case ExtensionType.PausableConfig:
        instructions.push(
          createInitializePausableConfigInstruction(
            mint.publicKey,
            pauserAuthority!,
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      case ExtensionType.PermanentDelegate:
        instructions.push(
          createInitializePermanentDelegateInstruction(
            mint.publicKey,
            permanentDelegateAuthority!,
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      case ExtensionType.DefaultAccountState:
        instructions.push(
          createInitializeDefaultAccountStateInstruction(
            mint.publicKey,
            AccountState.Initialized,
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        break;
      default:
        throw new Error(`Unsupported extension: ${extension}`);
    }
  }

  instructions.push(
    ...[
      createInitializeMintInstruction(
        mint.publicKey,
        6,
        payer.publicKey, // will transfer on last instruction
        freezeAuthority, // if null, there is no freeze authority
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: payer.publicKey,
        mint: mint.publicKey,
        mintAuthority: payer.publicKey,
        name: metaData.name,
        symbol: metaData.symbol,
        uri: metaData.uri,
      }),
    ],
  );

  if (evmTokenAddress) {
    instructions.push(
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: payer.publicKey,
        field: metaData.additionalMetadata[0][0],
        value: metaData.additionalMetadata[0][1],
      }),
    );
  }

  instructions.push(
    ...[
      // transfer metadata and mint authorities
      createUpdateAuthorityInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        oldAuthority: payer.publicKey,
        newAuthority: metadataAuthority ?? authority,
      }),
      createSetAuthorityInstruction(
        mint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        mintAuthority,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
  );

  const blockhash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([payer, mint]);

  await connection.sendTransaction(transaction);
}

async function sendOrSerialize(
  tx: Transaction,
  connection: Connection,
  payer: Keypair,
) {
  if (process.env.SQUADS_MULTISIG) {
    const b = tx.serialize({ verifySignatures: false });
    console.log("Transaction:", {
      b64: b.toString("base64"),
      b58: bs58.encode(b),
    });
  } else {
    const sig = await connection.sendTransaction(tx, [payer]);
    console.log(`Txn sent: ${sig}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
