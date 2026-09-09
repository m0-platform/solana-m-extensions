import { Command } from "commander";
import shell from "shelljs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import fs from "fs";

const EXT_SWAP_PID = "MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH";

if (!fs.existsSync("devnet-keypair.json")) {
  throw new Error("devnet keypair not found");
}

const opts: shell.ExecOptions & { async: false } = {
  silent: true,
  async: false,
};

(async function main() {
  const program = new Command();

  program
    .command("deploy-program")
    .requiredOption("-t, --type <type>", "Yield type") // no-yield, scaled-ui
    .requiredOption("-e, --extension <name>", "Extension program ID") // e.g. USDK
    .option("-c, --computePrice <number>", "Compute price", "300000")
    .action(({ type, extension, computePrice }) => {
      const [pid] = keysFromEnv([extension]);
      const pubkey = pid.publicKey.toBase58();

      console.log(`Building and deploying extension ${pubkey} (${type})`);

      buildProgram(pubkey, type);
      deployProgram(pid, parseInt(computePrice));
    });

  program
    .command("transfer-upgrade-auth")
    .argument("programID")
    .action((programID) => {
      const pid = new PublicKey(programID);

      const result = shell.exec(
        `solana program set-upgrade-authority \
          ${pid.toBase58()} \
          --new-upgrade-authority ${process.env.SQUADS_MULTISIG} \
          --skip-new-upgrade-authority-signer-check \
          --keypair devnet-keypair.json \
          --url ${process.env.RPC_URL}`,
        opts,
      );
      if (result.code !== 0) throw new Error(`Build failed: ${result.stderr}`);

      console.log(`Upgrade authority set\n${result.stdout}`);
    });

  program
    .command("set-idl")
    .requiredOption("-t, --type <type>", "Yield type") // e.g. scaled-ui
    .requiredOption("-e, --extension <name>", "Extension program ID") // e.g. USDKy
    .option("--skip-build", "Skip building the program", false) // if deployment was done immediately before, rebuilding is not required.
    .option("-i, --init", "Upload IDL for the first time", false) // indicates if the data account to store the IDL is created in this transaction.
    .option("-s, --swapProgram", "Update swap program", false)
    .action(({ type, extension, skipBuild, init, swapProgram }) => {
      const [pid] = keysFromEnv([extension]);
      const pubkey = swapProgram ? EXT_SWAP_PID : pid.publicKey.toBase58();

      if (!skipBuild) {
        console.log(`Building IDL for extension ${pubkey}`);
        buildProgram(pubkey, type, false, swapProgram);
      }

      console.log(`Uploading IDL for extension ${pubkey}`);

      if (swapProgram) {
        postSwapIDL();
        return;
      }

      postIDL(pubkey, init);

      console.log("IDL successfully uploaded")
    });

  program
    .command("upgrade-program")
    .option("-t, --type <type>", "Yield type", "scaled-ui")
    .option("-e, --extension <name>", "Extension program ID", "USDK")
    .option("-c, --computePrice <number>", "Compute price", "300000")
    .option("-s, --swapProgram", "Update swap program", false)
    .option("-a, --squadsAuth", "If Squads multisig is the auth", false)
    .option("-b, --skipBuild", "Skip build and deploy", false)
    .option("-m, --migrate", "Include migrate feature", false)
    .action(
      ({
        type,
        extension,
        migrate,
        computePrice,
        swapProgram,
        squadsAuth,
        skipBuild,
      }) => {
        const [pid] = keysFromEnv([extension]);
        const pubkey = pid.publicKey.toBase58();

        if (!skipBuild) buildProgram(pubkey, type, migrate, swapProgram);
        updateProgram(pubkey, parseInt(computePrice), squadsAuth, swapProgram);
      },
    );

  program
    .command("extend-program")
    .description("Extend a program account to fit a larger binary ")
    .argument("<programId>", "Program ID to extend")
    .option(
      "-b, --binary <path>",
      "Path to the new program binary",
      "target/verifiable/m_ext.so",
    )
    .action(async (programId, { binary }) => {
      if (!fs.existsSync(binary)) {
        throw new Error(
          `Binary not found at ${binary}. Build the program first.`,
        );
      }

      const newBinarySize = fs.statSync(binary).size;
      const connection = new Connection(process.env.RPC_URL!);
      const programPubkey = new PublicKey(programId);

      // Fetch program account to extract ProgramData address
      const programAccount = await connection.getAccountInfo(programPubkey);
      if (!programAccount) {
        throw new Error(`Program account not found: ${programId}`);
      }

      // BPF Upgradeable Loader "Program" variant: 4-byte discriminator + 32-byte programdata address
      const programDataAddress = new PublicKey(
        programAccount.data.subarray(4, 36),
      );

      // ProgramData header: 4 (discriminator) + 8 (slot) + 1 (Option tag) + 32 (authority) = 45 bytes
      const PROGRAMDATA_HEADER_SIZE = 45;
      const programDataAccount = await connection.getAccountInfo(
        programDataAddress,
      );
      if (!programDataAccount) {
        throw new Error(
          `ProgramData account not found: ${programDataAddress.toBase58()}`,
        );
      }

      const currentDataLength =
        programDataAccount.data.length - PROGRAMDATA_HEADER_SIZE;
      const additionalBytes = newBinarySize - currentDataLength;

      if (additionalBytes <= 0) {
        console.log(
          `Program already has enough space (current: ${currentDataLength}, needed: ${newBinarySize})`,
        );
        return;
      }

      console.log(`Current program data length: ${currentDataLength}`);
      console.log(`New binary size:             ${newBinarySize}`);
      console.log(`Additional bytes needed:     ${additionalBytes}`);

      // Build the BPF Loader ExtendProgram instruction
      const BPF_LOADER_UPGRADEABLE = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111",
      );

      const data = Buffer.alloc(8);
      data.writeUInt32LE(6, 0); // ExtendProgram discriminator
      data.writeUInt32LE(Math.floor(additionalBytes * 1.05), 4); // Add 5% buffer to avoid underestimating

      const payer = new PublicKey(process.env.SQUADS_MULTISIG!);

      const ix = new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE,
        keys: [
          { pubkey: programDataAddress, isSigner: false, isWritable: true },
          {
            pubkey: new PublicKey(programId),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: payer, isSigner: true, isWritable: true },
        ],
        data,
      });

      const tx = new Transaction().add(ix);
      tx.feePayer = payer;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const serialized = tx.serialize({ verifySignatures: false });
      console.log("Transaction:", {
        b64: serialized.toString("base64"),
        b58: bs58.encode(serialized),
      });
    });

  program
    .command("close-buffers")
    .description("Close all buffer accounts")
    .option(
      "-r, --recipient <pubkey>",
      "Refund recipient",
      "D76ySoHPwD8U2nnTTDqXeUJQg5UkD9UD1PUE1rnvPAGm",
    )
    .action(async ({ recipient }) => {
      const authorityPubkey = new PublicKey(process.env.SQUADS_MULTISIG!);
      const recipientPubkey = new PublicKey(recipient);

      const connection = new Connection(process.env.RPC_URL!);
      const BPF_LOADER_UPGRADEABLE = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111",
      );

      // Find all buffer accounts owned by the authority
      const accounts = await connection.getProgramAccounts(
        BPF_LOADER_UPGRADEABLE,
        {
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: bs58.encode(Buffer.from([1, 0, 0, 0])),
              },
            }, // Buffer account type
            {
              memcmp: {
                offset: 4,
                bytes: bs58.encode(
                  Buffer.concat([Buffer.from([1]), authorityPubkey.toBuffer()]),
                ),
              },
            }, // Option::Some(authority)
          ],
          dataSlice: { offset: 0, length: 0 },
        },
      );

      if (accounts.length === 0) {
        console.log("No buffer accounts found for this authority");
        return;
      }

      console.log(`Found ${accounts.length} buffer account(s):`);

      // Close instruction discriminator (variant 5 of UpgradeableLoaderInstruction)
      const data = Buffer.alloc(4);
      data.writeUInt32LE(5, 0);

      const instructions = accounts.map(
        ({ pubkey }) =>
          new TransactionInstruction({
            programId: BPF_LOADER_UPGRADEABLE,
            keys: [
              { pubkey, isSigner: false, isWritable: true },
              { pubkey: recipientPubkey, isSigner: false, isWritable: true },
              { pubkey: authorityPubkey, isSigner: true, isWritable: false },
            ],
            data,
          }),
      );

      const { blockhash } = await connection.getLatestBlockhash();

      const tx = new Transaction().add(...instructions);
      tx.feePayer = authorityPubkey;
      tx.recentBlockhash = blockhash;

      const serialized = tx.serialize({ verifySignatures: false });

      console.log(`Transaction closing ${accounts.length} buffer(s):`, {
        b64: serialized.toString("base64"),
        b58: bs58.encode(serialized),
      });
    });

  program
    .command("verify-pda-txn")
    .option("-t, --type <type>", "Yield type", "scaled-ui")
    .option("-e, --extension <name>", "Extension program ID", "USDK")
    .option(
      "-h, --hash <name>",
      "Commit hash",
      "88a692239f1c336d412d591c78bbf31043ad0af2",
    )
    .action(({ type, extension, hash }) => {
      const [pid] = keysFromEnv([extension]);
      const pubkey = pid.publicKey.toBase58();
      verifyPdaTransaction(pubkey, type, hash);
    });

  program
    .command("verify-build")
    .description("Compare the on-chain program hash against a local build hash")
    .option("-t, --type <type>", "Yield type", "scaled-ui")
    .option("-e, --extension <name>", "Extension program ID", "USDK")
    .option("-s, --swapProgram", "Verify swap program", false)
    .option("-b, --skipBuild", "Skip build and use existing binary", false)
    .option("-m, --migrate", "Include migrate feature", false)
    .action(({ type, extension, swapProgram, skipBuild, migrate }) => {
      const [pid] = keysFromEnv([extension]);
      const pubkey = swapProgram ? EXT_SWAP_PID : pid.publicKey.toBase58();
      const binaryPath = `target/verifiable/${
        swapProgram ? "ext_swap" : "m_ext"
      }.so`;

      if (!skipBuild) {
        buildProgram(pubkey, type, migrate, swapProgram);
      }

      if (!fs.existsSync(binaryPath)) {
        throw new Error(
          `Binary not found at ${binaryPath}. Build the program first or remove --skipBuild.`,
        );
      }

      // Get on-chain program hash
      const onChainResult = shell.exec(
        `solana-verify get-program-hash -u ${process.env.RPC_URL} ${pubkey}`,
        opts,
      );
      if (onChainResult.code !== 0) {
        throw new Error(`Failed to get on-chain hash: ${onChainResult.stderr}`);
      }
      const onChainHash = onChainResult.stdout.trim();

      // Get local executable hash
      const localResult = shell.exec(
        `solana-verify get-executable-hash ${binaryPath}`,
        opts,
      );
      if (localResult.code !== 0) {
        throw new Error(`Failed to get local hash: ${localResult.stderr}`);
      }
      const localHash = localResult.stdout.trim();

      console.log(`On-chain hash: ${onChainHash}`);
      console.log(`Local hash:    ${localHash}`);

      if (onChainHash === localHash) {
        console.log(
          "\n✅ Hashes match — local build is verified against the deployed program.",
        );
      } else {
        console.log(
          "\n❌ Hash mismatch — local build does NOT match the deployed program.",
        );
        process.exit(1);
      }
    });

  program
    .command("submit-verify-job")
    .option("-e, --extension <name>", "Extension program ID", "USDK")
    .action(({ type, extension, hash }) => {
      const [pid] = keysFromEnv([extension]);
      const pubkey = pid.publicKey.toBase58();

      const result = shell.exec(
        `solana-verify remote submit-job \ 
          --program-id ${pubkey} \ 
          --uploader ${process.env.SQUADS_MULTISIG}`,
        opts,
      );

      console.log(`Submit verify job: ${result.stdout}`);
    });

  await program.parseAsync(process.argv);
})();

function buildProgram(
  pid: string,
  yieldFeature: string,
  includeMigrate = false,
  swapProgram = false,
) {
  // remove old binary
  shell.rm("-f", "target/verifiable/m_ext.so");
  shell.rm("-f", "target/verifiable/ext_swap.so");

  // not building an extension
  if (swapProgram) {
    console.log("Building swap program...");
    const res = shell.exec(
      `anchor build -p ext_swap --verifiable ${
        includeMigrate ? "-- --features migrate" : ""
      }`,
      opts,
    );
    if (res.code !== 0) throw new Error(`Swap build failed: ${res.stderr}`);
    return;
  }

  // set program ID to the extension program
  setProgramID(pid);

  // set program ID in referenced v1 IDL
  for (const file of [
    "programs/m_ext/idls/m_ext_v1_no_yield.json",
    "programs/m_ext/idls/m_ext_v1_scaled_ui.json",
  ]) {
    const idl = JSON.parse(fs.readFileSync(file, "utf-8"));
    idl.address = pid;
    fs.writeFileSync(file, JSON.stringify(idl, null, 2));
  }

  console.log(`Building extension program ${pid}...`);

  const result = shell.exec(
    `anchor build -p m_ext --verifiable -- --features ${yieldFeature}${
      includeMigrate ? ",migrate" : ""
    }${
      pid === "wMXX1K1nca5W4pZr1piETe78gcAVVrEFi9f4g46uXko" ? ",wm" : ""
    } --no-default-features`,
    opts,
  );
  if (result.code !== 0) {
    throw new Error(`Build failed: ${result.stderr}`);
  }

  // revert to default program ID
  setProgramID("3C865D264L4NkAm78zfnDzQJJvXuU3fMjRUvRxyPi5da");
}

function deployProgram(programKeypair: Keypair, computePrice: number) {
  shell.exec(`echo '[${programKeypair.secretKey}]' > pid.json`, opts);

  const result = shell.exec(
    `solana program deploy \
      --url ${process.env.RPC_URL} \
      --with-compute-unit-price ${computePrice} \
      --keypair devnet-keypair.json \
      --max-sign-attempts 3 \
      --program-id pid.json \
      target/verifiable/m_ext.so`,
    opts,
  );

  // delete the temporary pid keypair file
  shell.exec("rm pid.json");

  if (result.code !== 0) {
    throw new Error(`Deploy failed: ${result.stderr}`);
  }

  console.log(`Deployed program: ${result.stdout}`);
}

function updateProgram(
  pid: string,
  computePrice: number,
  squadsAuth = false,
  swapProgram = false,
) {
  // create a temporary buffer to write the upgrade to
  shell.exec(
    "solana-keygen new --no-bip39-passphrase --force -s --outfile=buffer.json",
    opts,
  );

  const bufferAddress = shell
    .exec("solana-keygen pubkey buffer.json", opts)
    .stdout.trim();

  console.log(`Buffer address: ${bufferAddress}`);

  let result = shell.exec(
    `solana program write-buffer \
      --url ${process.env.RPC_URL} \
      --with-compute-unit-price ${computePrice} \
      --keypair devnet-keypair.json \
      --max-sign-attempts 3 \
      --buffer buffer.json \
      target/verifiable/${swapProgram ? "ext_swap" : "m_ext"}.so`,
    opts,
  );
  if (result.code !== 0) {
    throw new Error(`Buffer write failed: ${result.stderr}`);
  }

  if (squadsAuth) {
    const auth = process.env.SQUADS_MULTISIG;
    console.log(`Transferring buffer authority to ${auth}`);

    // transfer the buffer authority to provided pubkey
    const result = shell.exec(
      `solana program set-buffer-authority \
        --url ${process.env.RPC_URL} \
        --keypair devnet-keypair.json \
        --new-buffer-authority ${auth} \
         ${bufferAddress} `,
      opts,
    );
    if (result.code !== 0) {
      throw new Error(`Set buffer authority failed: ${result.stderr}`);
    }

    return;
  }

  // upgrade the program with the new buffer
  result = shell.exec(
    `solana program upgrade \
      --url ${process.env.RPC_URL} \
      --keypair devnet-keypair.json \
      ${bufferAddress} \
      ${swapProgram ? "MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH" : pid}`,
    opts,
  );
  if (result.code !== 0) {
    throw new Error(`Upgrade failed: ${result.stderr}`);
  }

  console.log("Program updated");

  // delete the temporary buffer file
  shell.exec("rm buffer.json");
}

function postIDL(pid: string, init = false) {
  shell.exec(
    `anchor idl ${init ? "init" : "upgrade"} \
      -f target/idl/m_ext.json \
      --provider.cluster ${process.env.RPC_URL} \
      --provider.wallet devnet-keypair.json \
      ${pid}`,
    opts,
  );
}

function postSwapIDL() {
  shell.exec(
    `anchor idl upgrade \
      -f target/idl/ext_swap.json \
      --provider.cluster ${process.env.RPC_URL} \
      --provider.wallet devnet-keypair.json \
      MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH`,
    opts,
  );
}

function verifyPdaTransaction(
  pid: string,
  yieldFeature: string,
  commitHash: string,
  libraryName = "m_ext",
) {
  const result = shell.exec(
    `solana-verify export-pda-tx \
      -u ${process.env.RPC_URL} \ 
      --program-id ${pid} \
      https://github.com/m0-foundation/solana-extensions --library-name ${libraryName} \ 
      --commit-hash ${commitHash} \
      --uploader ${process.env.SQUADS_MULTISIG} \
      -- --features ${yieldFeature} --no-default-features`,
    opts,
  );

  console.log(`PDA verification transaction: ${result.stdout}`);
}

function setProgramID(pid: string) {
  shell.sed(
    "-i",
    /declare_id!\("[^"]*"\)/,
    `declare_id!("${pid}")`,
    "programs/m_ext/src/lib.rs",
  );
}

function keysFromEnv(keys: string[]) {
  const foundKeys = keys.map((key) => {
    const val = process.env[key];
    if (val === undefined) {
      console.error(`environment variable ${key} must be set`);
      process.exit(1);
    }

    return Keypair.fromSecretKey(Buffer.from(JSON.parse(val)))
  });

  return foundKeys;
}
