import { Program, AnchorError, BN } from "@coral-xyz/anchor";
import { LiteSVM } from "litesvm";
import { LiteSVMProvider } from "anchor-litesvm";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountState,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeImmutableOwnerInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAccountLen,
  getMint,
  getMintLen,
  getAssociatedTokenAddressSync,
  createInitializeAccountInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  createUpdateDefaultAccountStateInstruction,
  ExtensionType,
  getExtensionData,
  createApproveCheckedInstruction,
  createFreezeAccountInstruction,
} from "@solana/spl-token";
import {
  ZERO_WORD,
  InitializeScaledUiAmountConfigInstructionData,
  ScaledUiAmountConfig,
  ScaledUiAmountConfigLayout,
  MerkleTree,
  ProofElement,
} from "../test-utils";
import { MExt as ScaledUIExt } from "../../target/types/scaled_ui";
import { MExt as NoYieldExt } from "../../target/types/no_yield";
import { MExt as CrankExt } from "../../target/types/crank";
import { Earn } from "../programs/earn";
import { ExtSwap } from "../../target/types/ext_swap";

export enum Comparison {
  Equal,
  GreaterThan,
  GreaterThanOrEqual,
  LessThan,
  LessThanOrEqual,
}

// Type definitions for accounts to make it easier to do comparisons

export enum Variant {
  NoYield = "no_yield",
  ScaledUi = "scaled_ui",
  Crank = "crank",
}

type MExt = NoYieldExt | ScaledUIExt | CrankExt;

type YieldVariant = { noYield: {} } | { scaledUi: {} } | { crank: {} };

export type YieldConfig<V extends Variant> = V extends Variant.ScaledUi
  ? {
      yieldVariant?: YieldVariant;
      feeBps?: BN;
      lastMIndex?: BN;
      lastExtIndex?: BN;
    }
  : V extends Variant.Crank
  ? {
      yieldVariant?: YieldVariant;
      earnAuthority?: PublicKey;
      lastMIndex?: BN;
      lastExtIndex?: BN;
      timestamp?: BN;
    }
  : {
      yieldVariant?: YieldVariant;
    };

export type ExtGlobal<V extends Variant> = {
  admin?: PublicKey;
  pendingAdmin?: PublicKey | null;
  extMint?: PublicKey;
  mMint?: PublicKey;
  mEarnGlobalAccount?: PublicKey;
  bump?: number;
  mVaultBump?: number;
  extMintAuthorityBump?: number;
  wrapAuthorities?: PublicKey[];
  yieldConfig?: YieldConfig<V>;
};

export type EarnManager = {
  earnManager?: PublicKey;
  isActive?: boolean;
  feeBps?: BN;
  feeTokenAccount?: PublicKey | null;
  bump?: number;
};

export type Earner = {
  lastClaimIndex?: BN;
  lastClaimTimestamp?: BN;
  bump?: number;
  user?: PublicKey;
  userTokenAccount?: PublicKey;
  earnManager?: PublicKey;
  recipientTokenAccount?: PublicKey | null;
};

const PROGRAM_ID = new PublicKey(
  "3C865D264L4NkAm78zfnDzQJJvXuU3fMjRUvRxyPi5da"
);

class ExtensionTestBase {
  public svm: LiteSVM;
  public provider: LiteSVMProvider;
  public earn: Program<Earn>;
  public admin: Keypair;
  public mMint: Keypair;
  public mMintAuthority: Keypair;
  public nonAdmin: Keypair;
  public mEarnerList: PublicKey[] = [];

  constructor(addresses: PublicKey[]) {
    const EARN_IDL = require("../programs/earn.json");

    // Initialize the SVM instance with all necessary configurations
    this.svm = new LiteSVM()
      .withSplPrograms() // Add SPL programs (including token programs)
      .withBuiltins() // Add builtin programs
      .withSysvars() // Setup standard sysvars
      .withPrecompiles() // Add standard precompiles
      .withBlockhashCheck(true); // Optional: disable blockhash checking for tests

    // Add the earn program to the SVM instance
    this.svm.addProgramFromFile(
      new PublicKey(EARN_IDL.address),
      "tests/programs/earn.so"
    );

    // Replace the default token2022 program with the (newer) one from the workspace
    this.svm.addProgramFromFile(
      TOKEN_2022_PROGRAM_ID,
      "tests/programs/spl_token_2022.so"
    );

    // Create an anchor provider from the liteSVM instance
    this.provider = new LiteSVMProvider(this.svm);

    // Create program instances
    this.earn = new Program<Earn>(EARN_IDL, this.provider);

    // Generate keypairs for various roles and fund them
    this.admin = new Keypair();
    this.mMint = new Keypair();
    this.mMintAuthority = new Keypair();
    this.nonAdmin = new Keypair();

    addresses = addresses.concat([
      this.admin.publicKey,
      this.nonAdmin.publicKey,
    ]);

    for (const address of addresses) {
      this.svm.airdrop(address, BigInt(10 * LAMPORTS_PER_SOL));
    }
  }

  async _init(initialSupply: BN, initialIndex: BN) {
    // Create the M token mint
    await this.createMMint(this.mMint, initialSupply);

    // Initialize the earn program
    await this.initializeEarn(initialIndex);
  }

  // Helper functions for token operations and checks on the SVM instance
  public async expectTokenBalance(
    tokenAccount: PublicKey,
    expectedBalance: BN,
    op: Comparison = Comparison.Equal,
    tolerance?: BN,
    use2022: boolean = true
  ) {
    const balance = (
      await getAccount(
        this.provider.connection,
        tokenAccount,
        undefined,
        use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      )
    ).amount;

    switch (op) {
      case Comparison.GreaterThan:
        expect(balance).toBeGreaterThan(BigInt(expectedBalance.toString()));
        if (tolerance) {
          expect(balance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        }
        break;
      case Comparison.GreaterThanOrEqual:
        expect(balance).toBeGreaterThanOrEqual(
          BigInt(expectedBalance.toString())
        );
        if (tolerance) {
          expect(balance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        }
        break;
      case Comparison.LessThan:
        expect(balance).toBeLessThan(BigInt(expectedBalance.toString()));
        if (tolerance) {
          expect(balance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
        }
        break;
      case Comparison.LessThanOrEqual:
        expect(balance).toBeLessThanOrEqual(BigInt(expectedBalance.toString()));
        if (tolerance) {
          expect(balance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
        }
        break;
      default:
        if (tolerance) {
          expect(balance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
          expect(balance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        } else {
          expect(balance).toEqual(BigInt(expectedBalance.toString()));
        }
        break;
    }
  }

  public async expectTokenUiBalance(
    tokenAccount: PublicKey,
    expectedBalance: BN,
    op: Comparison = Comparison.Equal,
    tolerance?: BN
  ) {
    const account = await getAccount(
      this.provider.connection,
      tokenAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    const multiplier = (await this.getScaledUiAmountConfig(account.mint))
      .multiplier;

    const scale = 1e12;

    const uiBalance =
      (account.amount * BigInt(Math.floor(multiplier * scale))) / BigInt(scale);

    switch (op) {
      case Comparison.GreaterThan:
        expect(uiBalance).toBeGreaterThan(BigInt(expectedBalance.toString()));
        if (tolerance) {
          expect(uiBalance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        }
        break;
      case Comparison.GreaterThanOrEqual:
        expect(uiBalance).toBeGreaterThanOrEqual(
          BigInt(expectedBalance.toString())
        );
        if (tolerance) {
          expect(uiBalance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        }
        break;
      case Comparison.LessThan:
        expect(uiBalance).toBeLessThan(BigInt(expectedBalance.toString()));
        if (tolerance) {
          expect(uiBalance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
        }
        break;
      case Comparison.LessThanOrEqual:
        expect(uiBalance).toBeLessThanOrEqual(
          BigInt(expectedBalance.toString())
        );
        if (tolerance) {
          expect(uiBalance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
        }
        break;
      default:
        if (tolerance) {
          expect(uiBalance).toBeGreaterThanOrEqual(
            BigInt(expectedBalance.sub(tolerance).toString())
          );
          expect(uiBalance).toBeLessThanOrEqual(
            BigInt(expectedBalance.add(tolerance).toString())
          );
        } else {
          expect(uiBalance).toEqual(BigInt(expectedBalance.toString()));
        }
        break;
    }
  }

  public async createATA(
    mint: PublicKey,
    owner: PublicKey,
    use2022: boolean = true
  ) {
    const tokenAccount = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const createATA = createAssociatedTokenAccountInstruction(
      this.admin.publicKey, // payer
      tokenAccount, // ata
      owner, // owner
      mint, // mint
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    let tx = new Transaction().add(createATA);

    await this.provider.sendAndConfirm!(tx, [this.admin]);

    return tokenAccount;
  }

  public async getATA(
    mint: PublicKey,
    owner: PublicKey,
    use2022: boolean = true
  ) {
    // Check to see if the ATA already exists, if so return its key
    const tokenAccount = getAssociatedTokenAddressSync(
      mint,
      owner,
      true,
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tokenAccountInfo = this.svm.getAccount(tokenAccount);

    if (!tokenAccountInfo) {
      await this.createATA(mint, owner, use2022);
    }

    return tokenAccount;
  }

  public async createTokenAccount(
    mint: PublicKey,
    owner: PublicKey,
    use2022: boolean = true,
    immutableOwner: boolean = false
  ) {
    // We want to create a token account that is not the ATA
    const tokenAccount = new Keypair();
    const tokenAccountLen =
      use2022 && immutableOwner
        ? getAccountLen([ExtensionType.ImmutableOwner])
        : ACCOUNT_SIZE;

    let ixs: TransactionInstruction[] = [];
    ixs.push(
      SystemProgram.createAccount({
        fromPubkey: this.admin.publicKey,
        newAccountPubkey: tokenAccount.publicKey,
        space: tokenAccountLen,
        lamports:
          await this.provider.connection.getMinimumBalanceForRentExemption(
            tokenAccountLen
          ),
        programId: use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
      })
    );
    if (use2022 && immutableOwner) {
      ixs.push(
        createInitializeImmutableOwnerInstruction(
          tokenAccount.publicKey,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }
    ixs.push(
      createInitializeAccountInstruction(
        tokenAccount.publicKey,
        mint,
        owner,
        use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
      )
    );

    let tx = new Transaction();
    tx.add(...ixs);

    await this.provider.sendAndConfirm!(tx, [this.admin, tokenAccount]);

    return { tokenAccount: tokenAccount.publicKey };
  }

  public async closeTokenAccount(
    owner: Keypair,
    tokenAccount: PublicKey,
    use2022: boolean = true
  ) {
    const closeIx = createCloseAccountInstruction(
      tokenAccount,
      owner.publicKey,
      owner.publicKey,
      [],
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );

    let tx = new Transaction().add(closeIx);

    await this.provider.sendAndConfirm!(tx, [owner]);
  }

  public async freezeTokenAccount(
    tokenAccount: PublicKey,
    mint: PublicKey,
    freezeAuthority: Keypair,
    use2022: boolean = true
  ) {
    const freezeIx = createFreezeAccountInstruction(
      tokenAccount,
      mint,
      freezeAuthority.publicKey,
      [],
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );

    let tx = new Transaction().add(freezeIx);

    await this.provider.sendAndConfirm!(tx, [freezeAuthority]);
  }

  public async createMint(
    mint: Keypair,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey | null,
    use2022: boolean = true,
    decimals = 6
  ) {
    // Create and initialize mint account

    const tokenProgram = use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    const mintLen = getMintLen([]);
    const mintLamports =
      await this.provider.connection.getMinimumBalanceForRentExemption(mintLen);
    const createMintAccount = SystemProgram.createAccount({
      fromPubkey: this.admin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: tokenProgram,
    });

    const initializeMint = createInitializeMintInstruction(
      mint.publicKey,
      decimals, // decimals
      mintAuthority, // mint authority
      freezeAuthority, // freeze authority
      tokenProgram
    );

    let tx = new Transaction();
    tx.add(createMintAccount, initializeMint);

    await this.provider.sendAndConfirm!(tx, [this.admin, mint]);

    // Verify the mint was created properly
    const mintInfo = await this.provider.connection.getAccountInfo(
      mint.publicKey
    );
    if (!mintInfo) {
      throw new Error("Mint account was not created");
    }

    return mint.publicKey;
  }

  public createInitializeScaledUiAmountConfigInstruction(
    mint: PublicKey,
    authority: PublicKey | null,
    multiplier: number,
    programId: PublicKey = TOKEN_2022_PROGRAM_ID
  ): TransactionInstruction {
    const keys = [{ pubkey: mint, isSigner: false, isWritable: true }];

    const data = Buffer.alloc(
      InitializeScaledUiAmountConfigInstructionData.span
    );
    InitializeScaledUiAmountConfigInstructionData.encode(
      {
        instruction: 43, // scaled ui amount extension
        scaledUiAmountInstruction: 0, // initialize
        authority: authority ?? PublicKey.default,
        multiplier: multiplier,
      },
      data
    );

    return new TransactionInstruction({ keys, programId, data });
  }

  public async createScaledUiMint(
    mint: Keypair,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey | null,
    decimals = 6
  ) {
    // Create and initialize mint account

    const tokenProgram = TOKEN_2022_PROGRAM_ID;

    const mintLen = getMintLen([ExtensionType.ScaledUiAmountConfig]);
    const mintLamports =
      await this.provider.connection.getMinimumBalanceForRentExemption(mintLen);
    const createMintAccount = SystemProgram.createAccount({
      fromPubkey: this.admin.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports: mintLamports,
      programId: tokenProgram,
    });

    const initializeScaledUiAmountConfig =
      this.createInitializeScaledUiAmountConfigInstruction(
        mint.publicKey,
        mintAuthority,
        1.0,
        tokenProgram
      );

    const initializeMint = createInitializeMintInstruction(
      mint.publicKey,
      decimals, // decimals
      mintAuthority, // mint authority
      freezeAuthority, // freeze authority
      tokenProgram
    );

    let tx = new Transaction();
    tx.add(createMintAccount, initializeScaledUiAmountConfig, initializeMint);

    await this.provider.sendAndConfirm!(tx, [this.admin, mint]);

    // Verify the mint was created properly
    const mintInfo = await this.provider.connection.getAccountInfo(
      mint.publicKey
    );
    if (!mintInfo) {
      throw new Error("Mint account was not created");
    }

    return mint.publicKey;
  }

  public async getScaledUiAmountConfig(
    mint: PublicKey
  ): Promise<ScaledUiAmountConfig> {
    const mintAccount = await getMint(
      this.provider.connection,
      mint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const extensionData = getExtensionData(
      ExtensionType.ScaledUiAmountConfig,
      mintAccount.tlvData
    );
    if (extensionData === null) {
      throw new Error("Extension data not found");
    }

    return ScaledUiAmountConfigLayout.decode(extensionData);
  }

  public async createMMint(mint: Keypair, initialSupply: BN) {
    // mint size with extensions
    const mintLen = getMintLen([
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.DefaultAccountState,
      ExtensionType.PermanentDelegate,
    ]);

    const lamports =
      await this.provider.connection.getMinimumBalanceForRentExemption(mintLen);

    const earnAuth = this.getEarnGlobalAccount();

    const instructions = [
      SystemProgram.createAccount({
        fromPubkey: this.admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeScaledUiAmountConfigInstruction(
        mint.publicKey,
        earnAuth,
        1.0,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeDefaultAccountStateInstruction(
        mint.publicKey,
        AccountState.Initialized,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        earnAuth,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        6,
        this.admin.publicKey,
        this.admin.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
    ];

    const tokenAccount = getAssociatedTokenAddressSync(
      mint.publicKey,
      this.admin.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Mint initial supply of tokens to admin
    instructions.push(
      createAssociatedTokenAccountInstruction(
        this.admin.publicKey,
        tokenAccount,
        this.admin.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToCheckedInstruction(
        mint.publicKey,
        tokenAccount,
        this.admin.publicKey,
        initialSupply.toNumber(),
        6,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    );

    // Set the default account state to frozen
    instructions.push(
      createUpdateDefaultAccountStateInstruction(
        mint.publicKey,
        AccountState.Frozen,
        this.admin.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    );

    // Set authorities
    instructions.push(
      createSetAuthorityInstruction(
        mint.publicKey,
        this.admin.publicKey,
        AuthorityType.FreezeAccount,
        earnAuth,
        undefined,
        TOKEN_2022_PROGRAM_ID
      ),
      createSetAuthorityInstruction(
        mint.publicKey,
        this.admin.publicKey,
        AuthorityType.MintTokens,
        this.mMintAuthority.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID
      )
    );

    let tx = new Transaction();
    tx.add(...instructions);

    await this.provider.sendAndConfirm!(tx, [this.admin, mint]);

    // Verify the mint was created properly
    const mintInfo = await this.provider.connection.getAccountInfo(
      mint.publicKey
    );
    if (!mintInfo) {
      throw new Error("Mint account was not created");
    }
  }

  public async mintM(to: PublicKey, amount: BN) {
    const toATA: PublicKey = await this.getATA(this.mMint.publicKey, to);

    const mintToInstruction = createMintToCheckedInstruction(
      this.mMint.publicKey,
      toATA,
      this.mMintAuthority.publicKey,
      amount.toNumber(),
      6,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    let tx = new Transaction();
    tx.add(mintToInstruction);
    await this.provider.sendAndConfirm!(tx, [this.mMintAuthority]);
  }

  public async getTokenBalance(
    tokenAccount: PublicKey,
    use2022: boolean = true
  ) {
    const tokenAccountInfo = await getAccount(
      this.provider.connection,
      tokenAccount,
      undefined,
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );

    if (!tokenAccountInfo) {
      throw new Error("Account not created");
    }

    return new BN(tokenAccountInfo.amount.toString());
  }

  public async getTokenUiBalance(tokenAccount: PublicKey, multiplier?: number) {
    const tokenAccountInfo = await getAccount(
      this.provider.connection,
      tokenAccount,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    if (!tokenAccountInfo) {
      throw new Error("Account not created");
    }

    const mp =
      multiplier ??
      (await this.getScaledUiAmountConfig(tokenAccountInfo.mint)).multiplier;

    const scale = 1e12;

    const uiBalance =
      (tokenAccountInfo.amount * BigInt(Math.floor(mp * scale))) /
      BigInt(scale);

    return new BN(uiBalance.toString());
  }

  async getTokenSupply(
    mint: PublicKey,
    multiplier: number = 1.0,
    use2022: boolean = true
  ) {
    const mintInfo = await getMint(
      this.provider.connection,
      mint,
      undefined,
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );
    if (!mintInfo) {
      throw new Error("Mint not found");
    }

    return new BN(Math.floor(Number(mintInfo.supply) * multiplier));
  }

  public async toUiAmount(mint: PublicKey, principal: BN): Promise<BN> {
    const mintInfo = await getMint(
      this.provider.connection,
      mint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    if (!mintInfo) {
      throw new Error("Mint not found");
    }

    const scaledUiAmountConfig = await this.getScaledUiAmountConfig(mint);
    const scale = new BN(1e12);
    const multiplier = scaledUiAmountConfig.multiplier;

    return principal
      .mul(new BN(Math.floor(multiplier * scale.toNumber())))
      .div(scale);
  }

  public async toPrincipal(mint: PublicKey, uiAmount: BN): Promise<BN> {
    const mintInfo = await getMint(
      this.provider.connection,
      mint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    if (!mintInfo) {
      throw new Error("Mint not found");
    }

    const scaledUiAmountConfig = await this.getScaledUiAmountConfig(mint);
    const scale = new BN(1e12);
    const multiplier = scaledUiAmountConfig.multiplier;

    return uiAmount
      .mul(scale)
      .div(new BN(Math.floor(multiplier * scale.toNumber())));
  }

  public async approve(
    source: Keypair,
    delegate: PublicKey,
    mint: PublicKey,
    amount: BN,
    use2022: boolean = true
  ) {
    const sourceATA: PublicKey = await this.getATA(
      mint,
      source.publicKey,
      use2022
    );

    const approveIx = createApproveCheckedInstruction(
      sourceATA,
      mint,
      delegate,
      source.publicKey,
      BigInt(amount.toString()),
      6, // decimals
      [],
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );

    let tx = new Transaction();
    tx.add(approveIx);
    await this.provider.sendAndConfirm!(tx, [source]);

    return { sourceATA };
  }

  // general SVM cheat functions
  public warp(seconds: BN, increment: boolean) {
    const clock = this.svm.getClock();
    clock.unixTimestamp = increment
      ? clock.unixTimestamp + BigInt(seconds.toString())
      : BigInt(seconds.toString());
    this.svm.setClock(clock);
  }

  public currentTime(): BN {
    return new BN(this.svm.getClock().unixTimestamp.toString());
  }

  // Helper functions for Earn and MExt program PDAs
  public getEarnGlobalAccount(): PublicKey {
    const [globalAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      this.earn.programId
    );

    return globalAccount;
  }

  public getEarnTokenAuthority(): PublicKey {
    const [earnTokenAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_authority")],
      this.earn.programId
    );

    return earnTokenAuthority;
  }

  // Utility functions for the tests
  public expectAccountEmpty(account: PublicKey) {
    const accountInfo = this.svm.getAccount(account);

    if (accountInfo) {
      expect(accountInfo.lamports).toBe(0);
      expect(accountInfo.data.length).toBe(0);
      expect(accountInfo.owner).toStrictEqual(SystemProgram.programId);
    }
  }

  public async expectAnchorError(txResult: Promise<string>, errCode: string) {
    try {
      await txResult;
      throw new Error("Transaction should have reverted");
    } catch (e) {
      if (!(e instanceof AnchorError))
        throw new Error(`Expected AnchorError, got ${e}`);
      const err: AnchorError = e;
      expect(err.error.errorCode.code).toStrictEqual(errCode);
    }
  }

  public async expectSystemError(txResult: Promise<string>) {
    let reverted = false;
    try {
      await txResult;
    } catch (e) {
      // console.log(e.transactionMessage);
      // console.log(e.logs);
      reverted = true;
    } finally {
      expect(reverted).toBe(true);
    }
  }

  createUniqueKeyArray = (size: number) => {
    return new Array(size).fill(PublicKey.default).map((_, i, arr) => {
      let key = PublicKey.unique();
      while (key.equals(PublicKey.default) || arr.includes(key)) {
        key = PublicKey.unique();
      }
      return key;
    });
  };

  padKeyArray = (array: PublicKey[], desiredLen: number) => {
    const currentLen = array.length;

    if (currentLen > desiredLen) {
      throw new Error("Array is too long");
    }

    const padding = new Array(desiredLen - currentLen).fill(PublicKey.default);
    return array.concat(padding);
  };

  // instruction convenience functions for earn program
  async initializeEarn(initialIndex: BN) {
    // Send the transaction
    try {
      await this.earn.methods
        .initialize(initialIndex)
        .accounts({
          admin: this.admin.publicKey,
          mMint: this.mMint.publicKey,
        })
        .signers([this.admin])
        .rpc();
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  public async propagateIndex(
    newIndex: BN,
    earnerMerkleRoot: number[] = ZERO_WORD
  ) {
    // Send the instruction
    await this.earn.methods
      .propagateIndex(newIndex, earnerMerkleRoot)
      .accounts({
        signer: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  async addRegistrarEarner(
    earner: PublicKey,
    proof: ProofElement[],
    earnerTokenAccount?: PublicKey
  ) {
    // Get the earner ATA
    const tokenAccount =
      earnerTokenAccount ?? (await this.getATA(this.mMint.publicKey, earner));

    // Send the instruction
    await this.earn.methods
      .addRegistrarEarner(earner, proof)
      .accountsPartial({
        signer: this.nonAdmin.publicKey,
        userTokenAccount: tokenAccount,
      })
      .signers([this.nonAdmin])
      .rpc();
  }

  async removeRegistrarEarner(
    earner: PublicKey,
    proofs: ProofElement[][],
    neighbors: number[][],
    earnerTokenAccount?: PublicKey
  ) {
    // Get the earner ATA
    const tokenAccount =
      earnerTokenAccount ?? (await this.getATA(this.mMint.publicKey, earner));

    // Send the instruction
    await this.earn.methods
      .removeRegistrarEarner(proofs, neighbors)
      .accountsPartial({
        signer: this.nonAdmin.publicKey,
        userTokenAccount: tokenAccount,
      })
      .signers([this.nonAdmin])
      .rpc();
  }

  public async addMEarner(earner: PublicKey, earnerTokenAccount?: PublicKey) {
    // Check that the earner is not already in the list
    if (this.mEarnerList.map((e) => e.toBase58()).includes(earner.toBase58())) {
      throw new Error("Earner already exists in the list");
    }

    // Add the earner to the list and get the merkle tree
    this.mEarnerList.push(earner);
    const earnerMerkleTree = new MerkleTree(this.mEarnerList);

    // Get the current index to reuse
    const mScaledUiConfig = await this.getScaledUiAmountConfig(
      this.mMint.publicKey
    );

    const currentIndex = new BN(Math.ceil(mScaledUiConfig.multiplier * 1e12));

    // Propagate the merkle root
    await this.propagateIndex(currentIndex, earnerMerkleTree.getRoot());

    // Create the earner token for the m token
    const tokenAccount =
      earnerTokenAccount ?? (await this.getATA(this.mMint.publicKey, earner));

    // Add the earner to the earn program
    const { proof } = earnerMerkleTree.getInclusionProof(earner);
    await this.addRegistrarEarner(earner, proof, tokenAccount);
  }

  public async removeMEarner(
    earner: PublicKey,
    earnerTokenAccount?: PublicKey
  ) {
    // Check that the earner is in the list
    if (
      !this.mEarnerList.map((e) => e.toBase58()).includes(earner.toBase58())
    ) {
      throw new Error("Earner does not exist in the list");
    }

    // Remove the earner from the list and get the merkle tree
    this.mEarnerList = this.mEarnerList.filter((e) => !e.equals(earner));
    const earnerMerkleTree = new MerkleTree(this.mEarnerList);

    // Get the current index to reuse
    const mScaledUiConfig = await this.getScaledUiAmountConfig(
      this.mMint.publicKey
    );
    const currentIndex = new BN(mScaledUiConfig.newMultiplier * 1e12);

    // Propagate the merkle root
    await this.propagateIndex(currentIndex, earnerMerkleTree.getRoot());

    // Get the earner token account
    const tokenAccount =
      earnerTokenAccount ?? (await this.getATA(this.mMint.publicKey, earner));

    // Remove the earner from the earn program
    const { proofs, neighbors } = earnerMerkleTree.getExclusionProof(earner);
    await this.removeRegistrarEarner(earner, proofs, neighbors, tokenAccount);
  }
}

// Test harness for the MExt program that encapsulates all the necessary setup and helper functions to test a given program variant
export class ExtensionTest<
  V extends Variant = Variant.ScaledUi
> extends ExtensionTestBase {
  public variant: V;
  public ext: Program<MExt>;
  public extMint: Keypair;
  public extTokenProgram: PublicKey;
  public earnAuthority: Keypair;
  public wrapAuthority: Keypair;
  public nonWrapAuthority: Keypair;

  constructor(variant: V, extTokenProgram: PublicKey, addresses: PublicKey[]) {
    super(addresses);

    this.variant = variant;
    this.extTokenProgram = extTokenProgram;

    if (
      variant === Variant.ScaledUi &&
      extTokenProgram !== TOKEN_2022_PROGRAM_ID
    ) {
      throw new Error("Scaled UI variant must use the TOKEN_2022_PROGRAM_ID");
    }

    const M_EXT_IDL = require(`../../target/idl/${variant}.json`);

    // Add the ext program to the SVM instance
    this.svm.addProgramFromFile(PROGRAM_ID, `target/deploy/${variant}.so`);

    // Create program instances
    this.ext = new Program<MExt>(M_EXT_IDL, this.provider);

    // Generate keypairs for various roles and fund them
    this.extMint = new Keypair();
    this.earnAuthority = new Keypair();
    this.wrapAuthority = new Keypair();
    this.nonWrapAuthority = new Keypair();

    const toFund = [
      this.earnAuthority.publicKey,
      this.wrapAuthority.publicKey,
      this.nonWrapAuthority.publicKey,
    ];

    for (const address of toFund) {
      this.svm.airdrop(address, BigInt(10 * LAMPORTS_PER_SOL));
    }
  }

  public async init(initialSupply: BN, initialIndex: BN) {
    // Call the base init function
    await this._init(initialSupply, initialIndex);

    // Create the Ext token mint
    switch (this.variant) {
      case Variant.NoYield:
        await this.createMint(
          this.extMint,
          this.getExtMintAuthority(),
          this.admin.publicKey,
          this.extTokenProgram === TOKEN_2022_PROGRAM_ID,
          6
        );
        break;
      case Variant.ScaledUi:
        await this.createScaledUiMint(
          this.extMint,
          this.getExtMintAuthority(),
          this.admin.publicKey,
          6
        );
        break;
      case Variant.Crank:
        await this.createMint(
          this.extMint,
          this.getExtMintAuthority(),
          this.admin.publicKey,
          this.extTokenProgram === TOKEN_2022_PROGRAM_ID,
          6
        );
        break;
      default:
        throw new Error("Unsupported variant for MExt");
    }

    // Add the m vault as an M earner
    const mVault = this.getMVault();
    await this.addMEarner(mVault);
  }

  public async getExtTokenSupply(mint: PublicKey, use2022: boolean) {
    const mintInfo = await getMint(
      this.provider.connection,
      mint,
      undefined,
      use2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    );
    if (!mintInfo) {
      throw new Error("Mint not found");
    }

    return new BN(
      Math.floor(Number(mintInfo.supply) * (await this.getCurrentMultiplier()))
    );
  }

  // MExt program PDAs
  public getExtGlobalAccount(): PublicKey {
    const [globalAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      this.ext.programId
    );

    return globalAccount;
  }

  public getExtMintAuthority(): PublicKey {
    const [extMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      this.ext.programId
    );

    return extMintAuthority;
  }

  public getMVault(): PublicKey {
    const [mVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("m_vault")],
      this.ext.programId
    );

    return mVault;
  }

  public async getNewMultiplier(newIndex: BN): Promise<number> {
    if (this.variant !== Variant.ScaledUi) {
      return 1.0;
    }

    const yieldConfig: YieldConfig<Variant.ScaledUi> = (
      await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
    ).yieldConfig;

    const lastExtIndex = yieldConfig.lastExtIndex!;
    const lastMIndex = yieldConfig.lastMIndex!;
    const feeBps = yieldConfig.feeBps!.toNumber();
    const indexScale = new BN(1e12);

    // Mirror calculate_new_index in programs/m_ext/src/utils/conversion.rs
    // exactly, including its integer-truncating division steps, so the
    // expected value matches the on-chain result instead of relying on a
    // float tolerance to absorb the truncation.
    const mIncreaseFactor = newIndex.mul(indexScale).div(lastMIndex);

    const extIncreaseFactor =
      feeBps === 0
        ? mIncreaseFactor.toNumber()
        : Math.floor(
            (mIncreaseFactor.toNumber() / 1e12) ** (1 - feeBps / 1e4) * 1e12,
          );

    const newExtIndex = lastExtIndex
      .mul(new BN(extIncreaseFactor))
      .div(indexScale);

    return newExtIndex.toNumber() / 1e12;
  }

  public async getCurrentMultiplier(): Promise<number> {
    if (this.variant !== Variant.ScaledUi) {
      return 1.0;
    }

    const yieldConfig: YieldConfig<Variant.ScaledUi> = (
      await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
    ).yieldConfig;

    return yieldConfig.lastExtIndex!.toNumber() / 1e12;
  }

  public async getCurrentExtIndex(): Promise<BN> {
    if (this.variant === Variant.NoYield) {
      return new BN(1e12);
    } else if (this.variant === Variant.ScaledUi) {
      const yieldConfig: YieldConfig<Variant.ScaledUi> = (
        await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
      ).yieldConfig;
      return yieldConfig.lastExtIndex!;
    } else if (this.variant === Variant.Crank) {
      const yieldConfig: YieldConfig<Variant.Crank> = (
        await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
      ).yieldConfig;
      return yieldConfig.lastExtIndex!;
    } else {
      throw new Error("Unsupported variant for MExt");
    }
  }

  public async getNewExtIndex(newMIndex: BN): Promise<BN> {
    if (this.variant === Variant.NoYield) {
      return new BN(1e12);
    } else if (this.variant === Variant.ScaledUi) {
      const yieldConfig: YieldConfig<Variant.ScaledUi> = (
        await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
      ).yieldConfig;
      const newExtIndex =
        (yieldConfig.lastExtIndex!.toNumber() / 1e12) *
        (newMIndex.toNumber() / yieldConfig.lastMIndex!.toNumber()) **
          (1 - yieldConfig.feeBps!.toNumber() / 1e4);
      return new BN(Math.floor(newExtIndex * 1e12));
    } else if (this.variant === Variant.Crank) {
      const yieldConfig: YieldConfig<Variant.Crank> = (
        await this.ext.account.extGlobalV2.fetch(this.getExtGlobalAccount())
      ).yieldConfig;
      return newMIndex
        .mul(yieldConfig.lastExtIndex!)
        .div(yieldConfig.lastMIndex!);
    } else {
      throw new Error("Unsupported variant for MExt");
    }
  }

  /**
   * Get the current M index from the M mint's scaled UI config.
   * This is the index used for M token principal <-> UI amount conversions.
   * Uses newMultiplier to match Rust multiplier_to_index behavior.
   */
  public async getCurrentMIndex(): Promise<BN> {
    const scaledUiConfig = await this.getScaledUiAmountConfig(this.mMint.publicKey);
    // Use newMultiplier to match Rust: multiplier_to_index(m_scaled_ui_config.new_multiplier)
    const multiplier = scaledUiConfig.newMultiplier;
    // index = multiplier * 1e12 (same formula as Rust multiplier_to_index)
    return new BN(Math.floor(multiplier * 1e12));
  }

  /**
   * Calculate the expected principals from a UI amount for wrap/unwrap operations.
   * This mirrors the Rust amount_to_principal_down calculation.
   *
   * @param uiAmount - The UI amount being wrapped/unwrapped
   * @returns Object with mPrincipal and extPrincipal
   */
  public async getExpectedWrapPrincipals(uiAmount: BN): Promise<{
    mPrincipal: BN;
    extPrincipal: BN;
  }> {
    const INDEX_SCALE = new BN("1000000000000"); // 1e12

    const mIndex = await this.getCurrentMIndex();
    const extIndex = await this.getCurrentExtIndex();

    // amount_to_principal_down: principal = (amount * INDEX_SCALE) / index
    const mPrincipal = uiAmount.mul(INDEX_SCALE).div(mIndex);
    const extPrincipal = uiAmount.mul(INDEX_SCALE).div(extIndex);

    return { mPrincipal, extPrincipal };
  }

  /**
   * Calculate expected principal from UI amount for a specific index.
   * Mirrors Rust amount_to_principal_down.
   */
  public amountToPrincipalDown(amount: BN, index: BN): BN {
    const INDEX_SCALE = new BN("1000000000000"); // 1e12
    if (index.eq(INDEX_SCALE)) {
      return amount;
    }
    return amount.mul(INDEX_SCALE).div(index);
  }

  /**
   * Calculate expected UI amount from principal for a specific index.
   * Mirrors Rust principal_to_amount_down.
   */
  public principalToAmountDown(principal: BN, index: BN): BN {
    const INDEX_SCALE = new BN("1000000000000"); // 1e12
    if (index.eq(INDEX_SCALE)) {
      return principal;
    }
    return index.mul(principal).div(INDEX_SCALE);
  }

  public async expectExtGlobalState(expected: ExtGlobal<V>) {
    const state = await this.ext.account.extGlobalV2.fetch(
      this.getExtGlobalAccount()
    );

    if (expected.admin) expect(state.admin).toEqual(expected.admin);
    if (expected.pendingAdmin !== undefined) {
      expect(state.pendingAdmin).toEqual(expected.pendingAdmin);
    }
    if (expected.extMint) expect(state.extMint).toEqual(expected.extMint);
    if (expected.mMint) expect(state.mMint).toEqual(expected.mMint);
    if (expected.mEarnGlobalAccount)
      expect(state.mEarnGlobalAccount).toEqual(expected.mEarnGlobalAccount);

    if (expected.yieldConfig) {
      switch (this.variant) {
        case Variant.NoYield:
          expect(state.yieldConfig).toEqual({
            yieldVariant: { noYield: {} },
          });
          break;
        case Variant.ScaledUi:
          this.expectScaledUiYieldConfig(
            state.yieldConfig,
            expected.yieldConfig
          );
          break;
        case Variant.Crank:
          this.expectCrankYieldConfig(state.yieldConfig, expected.yieldConfig);
          break;
        default:
          throw new Error("Unsupported variant for yield config");
      }
    }
    if (expected.bump) expect(state.bump).toEqual(expected.bump);
    if (expected.mVaultBump)
      expect(state.mVaultBump).toEqual(expected.mVaultBump);
    if (expected.extMintAuthorityBump)
      expect(state.extMintAuthorityBump).toEqual(expected.extMintAuthorityBump);
  }

  private expectScaledUiYieldConfig<V extends Variant.ScaledUi>(
    actual: YieldConfig<V>,
    expected: YieldConfig<V>
  ) {
    expect(actual.yieldVariant!).toEqual({ scaledUi: {} }); // scaled ui amount variant
    if (expected.feeBps) {
      expect(actual.feeBps!.toString()).toEqual(expected.feeBps.toString());
    }
    if (expected.lastMIndex) {
      expect(actual.lastMIndex!.toString()).toEqual(
        expected.lastMIndex.toString()
      );
    }
    if (expected.lastExtIndex) {
      // account floating point precision rounding issues
      const exp_high = expected.lastExtIndex.toNumber() + 1;
      const exp_low = expected.lastExtIndex.toNumber() - 1;

      expect(actual.lastExtIndex!.toNumber()).toBeGreaterThanOrEqual(exp_low);
      expect(actual.lastExtIndex!.toNumber()).toBeLessThanOrEqual(exp_high);
    }
  }

  private expectCrankYieldConfig<V extends Variant.Crank>(
    actual: YieldConfig<V>,
    expected: YieldConfig<V>
  ) {
    expect(actual.yieldVariant!).toEqual({ crank: {} }); // crank variant

    if (expected.earnAuthority) {
      expect(actual.earnAuthority!).toEqual(expected.earnAuthority);
    }
    if (expected.lastMIndex) {
      expect(actual.lastMIndex!.toString()).toEqual(
        expected.lastMIndex.toString()
      );
    }
    if (expected.lastExtIndex) {
      expect(actual.lastExtIndex!.toString()).toEqual(
        expected.lastExtIndex.toString()
      );
    }
    if (expected.timestamp) {
      expect(actual.timestamp!.toString()).toEqual(
        expected.timestamp.toString()
      );
    }
  }

  public async expectEarnManagerState(
    earnManagerAccount: PublicKey,
    expected: EarnManager
  ) {
    const state = await this.ext.account.earnManager.fetch(earnManagerAccount);

    if (expected.earnManager)
      expect(state.earnManager).toEqual(expected.earnManager);
    if (expected.isActive !== undefined)
      expect(state.isActive).toEqual(expected.isActive);
    if (expected.feeBps)
      expect(state.feeBps.toString()).toEqual(expected.feeBps.toString());
    if (expected.feeTokenAccount)
      expect(state.feeTokenAccount).toEqual(expected.feeTokenAccount);
  }

  public async expectEarnerState(earnerAccount: PublicKey, expected: Earner) {
    const state = await this.ext.account.earner.fetch(earnerAccount);

    if (expected.lastClaimIndex)
      expect(state.lastClaimIndex.toString()).toEqual(
        expected.lastClaimIndex.toString()
      );
    if (expected.lastClaimTimestamp)
      expect(state.lastClaimTimestamp.toString()).toEqual(
        expected.lastClaimTimestamp.toString()
      );
    if (expected.bump) expect(state.bump).toEqual(expected.bump);
    if (expected.user) expect(state.user).toEqual(expected.user);
    if (expected.userTokenAccount)
      expect(state.userTokenAccount).toEqual(expected.userTokenAccount);
    if (expected.earnManager)
      expect(state.earnManager).toEqual(expected.earnManager);
    if (expected.recipientTokenAccount)
      expect(state.recipientTokenAccount).toEqual(
        expected.recipientTokenAccount
      );
  }

  public async expectScaledUiAmountConfig(
    mint: PublicKey,
    expected: ScaledUiAmountConfig
  ) {
    const state = await this.getScaledUiAmountConfig(mint);

    if (expected.authority) expect(state.authority).toEqual(expected.authority);
    if (expected.multiplier) {
      // account for javascript vs. rust floating point precision differences
      // use ±2/1e12 to absorb floating-point rounding in the division itself
      const exp_high = (Math.floor(expected.multiplier * 1e12) + 2) / 1e12;
      const exp_low = (Math.floor(expected.multiplier * 1e12) - 2) / 1e12;

      expect(state.multiplier).toBeGreaterThanOrEqual(exp_low);
      expect(state.multiplier).toBeLessThanOrEqual(exp_high);
    }
    if (expected.newMultiplierEffectiveTimestamp)
      expect(state.newMultiplierEffectiveTimestamp.toString()).toEqual(
        expected.newMultiplierEffectiveTimestamp.toString()
      );
    if (expected.newMultiplier) {
      // account for javascript vs. rust floating point precision differences
      // use ±2/1e12 to absorb floating-point rounding in the division itself
      const exp_high = (Math.floor(expected.newMultiplier * 1e12) + 2) / 1e12;
      const exp_low = (Math.floor(expected.newMultiplier * 1e12) - 2) / 1e12;

      expect(state.newMultiplier).toBeGreaterThanOrEqual(exp_low);
      expect(state.newMultiplier).toBeLessThanOrEqual(exp_high);
    }
  }

  createUniqueKeyArray = (size: number) => {
    return new Array(size).fill(PublicKey.default).map((_, i, arr) => {
      let key = PublicKey.unique();
      while (key.equals(PublicKey.default) || arr.includes(key)) {
        key = PublicKey.unique();
      }
      return key;
    });
  };

  public async expectExtSolvent() {
    const extSupply = await this.getExtTokenSupply(
      this.extMint.publicKey,
      this.useToken2022ForExt
    );
    const mVaultUiBalance = await this.getTokenUiBalance(
      await this.getATA(this.mMint.publicKey, this.getMVault())
    );

    this.variant === Variant.ScaledUi
      ? expect(BigInt(mVaultUiBalance.toString())).toBeGreaterThan(
          BigInt(extSupply.sub(BN.min(new BN(2), extSupply)).toString())
        ) // allow for a rounding error of 2 for scaled ui due to precision issues
      : expect(BigInt(mVaultUiBalance.toString())).toBeGreaterThanOrEqual(
          BigInt(extSupply.toString())
        );
  }

  // Helper functions for executing MExt instructions
  public async initializeExt(wrapAuthorities: PublicKey[], feeBps?: BN) {
    switch (this.variant) {
      case Variant.ScaledUi:
        if (!feeBps) {
          throw new Error("fee_bps is required for Scaled UI variant");
        }
        // Send the transaction
        await this.ext.methods
          .initialize(wrapAuthorities, feeBps)
          .accounts({
            admin: this.admin.publicKey,
            mMint: this.mMint.publicKey,
            extMint: this.extMint.publicKey,
            extTokenProgram: this.extTokenProgram,
          })
          .signers([this.admin])
          .rpc();
        break;
      case Variant.Crank:
        await this.ext.methods
          .initialize(wrapAuthorities, this.earnAuthority.publicKey)
          .accounts({
            admin: this.admin.publicKey,
            mMint: this.mMint.publicKey,
            extMint: this.extMint.publicKey,
            extTokenProgram: this.extTokenProgram,
          })
          .signers([this.admin])
          .rpc();
        break;
      case Variant.NoYield:
        // Send the transaction
        await this.ext.methods
          .initialize(wrapAuthorities)
          .accounts({
            admin: this.admin.publicKey,
            mMint: this.mMint.publicKey,
            extMint: this.extMint.publicKey,
            extTokenProgram: this.extTokenProgram,
          })
          .signers([this.admin])
          .rpc();
        break;
      default:
        throw new Error("Unsupported variant for initializeExt");
    }
  }

  public async addWrapAuthority(newWrapAuthority: PublicKey) {
    // Send the instruction
    await this.ext.methods
      .addWrapAuthority(newWrapAuthority)
      .accounts({})
      .signers([this.admin])
      .rpc();
  }

  public async removeWrapAuthority(oldWrapAuthority: PublicKey) {
    // Send the instruction
    await this.ext.methods
      .removeWrapAuthority(oldWrapAuthority)
      .accounts({})
      .signers([this.admin])
      .rpc();
  }

  public async prepWrap(
    from: PublicKey,
    to?: PublicKey,
    fromMTokenAccount?: PublicKey,
    toExtTokenAccount?: PublicKey,
    vaultMTokenAccount?: PublicKey
  ): Promise<{
    vaultMTokenAccount: PublicKey;
    fromMTokenAccount: PublicKey;
    toExtTokenAccount: PublicKey;
  }> {
    // Get m vault pda
    const mVault = this.getMVault();

    // Create accounts if needed
    fromMTokenAccount =
      fromMTokenAccount ?? (await this.getATA(this.mMint.publicKey, from));
    toExtTokenAccount =
      toExtTokenAccount ??
      (await this.getATA(
        this.extMint.publicKey,
        to ?? from,
        this.useToken2022ForExt
      ));
    vaultMTokenAccount =
      vaultMTokenAccount ?? (await this.getATA(this.mMint.publicKey, mVault));

    return {
      vaultMTokenAccount,
      fromMTokenAccount,
      toExtTokenAccount,
    };
  }

  public async wrap(
    tokenAuthority: Keypair,
    amount: BN,
    wrapAuthority?: Keypair | null,
    from?: PublicKey,
    to?: PublicKey
  ): Promise<{
    vaultMTokenAccount: PublicKey;
    fromMTokenAccount: PublicKey;
    toExtTokenAccount: PublicKey;
  }> {
    // Setup the instruction
    const { vaultMTokenAccount, fromMTokenAccount, toExtTokenAccount } =
      await this.prepWrap(from ?? tokenAuthority.publicKey, to);

    // Send the instruction
    await this.ext.methods
      .wrap(amount)
      .accounts({
        tokenAuthority: tokenAuthority.publicKey,
        wrapAuthority: wrapAuthority
          ? wrapAuthority.publicKey
          : this.ext.programId,
        fromMTokenAccount,
        toExtTokenAccount,
        extTokenProgram: this.extTokenProgram,
      })
      .signers(
        wrapAuthority ? [tokenAuthority, wrapAuthority] : [tokenAuthority]
      )
      .rpc();

    return { vaultMTokenAccount, fromMTokenAccount, toExtTokenAccount };
  }

  public async prepUnwrap(
    from: PublicKey,
    to?: PublicKey,
    toMTokenAccount?: PublicKey,
    fromExtTokenAccount?: PublicKey,
    vaultMTokenAccount?: PublicKey
  ): Promise<{
    vaultMTokenAccount: PublicKey;
    toMTokenAccount: PublicKey;
    fromExtTokenAccount: PublicKey;
  }> {
    // Get m vault pda
    const mVault = this.getMVault();

    toMTokenAccount =
      toMTokenAccount ?? (await this.getATA(this.mMint.publicKey, to ?? from));
    fromExtTokenAccount =
      fromExtTokenAccount ??
      (await this.getATA(
        this.extMint.publicKey,
        from,
        this.useToken2022ForExt
      ));
    vaultMTokenAccount =
      vaultMTokenAccount ?? (await this.getATA(this.mMint.publicKey, mVault));

    return {
      vaultMTokenAccount,
      toMTokenAccount,
      fromExtTokenAccount,
    };
  }

  public async unwrap(
    tokenAuthority: Keypair,
    amount: BN,
    wrapAuthority?: Keypair | null,
    from?: PublicKey,
    to?: PublicKey
  ): Promise<{
    vaultMTokenAccount: PublicKey;
    toMTokenAccount: PublicKey;
    fromExtTokenAccount: PublicKey;
  }> {
    // Setup the instruction
    const { vaultMTokenAccount, toMTokenAccount, fromExtTokenAccount } =
      await this.prepUnwrap(from ?? tokenAuthority.publicKey, to);

    // Send the instruction
    await this.ext.methods
      .unwrap(amount)
      .accounts({
        tokenAuthority: tokenAuthority.publicKey,
        unwrapAuthority: wrapAuthority
          ? wrapAuthority.publicKey
          : this.ext.programId,
        toMTokenAccount,
        fromExtTokenAccount,
        extTokenProgram: this.extTokenProgram,
      })
      .signers(
        wrapAuthority ? [tokenAuthority, wrapAuthority] : [tokenAuthority]
      )
      .rpc();

    return { vaultMTokenAccount, toMTokenAccount, fromExtTokenAccount };
  }

  public async sync(): Promise<PublicKey> {
    switch (this.variant) {
      case Variant.NoYield:
        throw new Error("sync is not supported for No Yield variant");
        break;
      case Variant.ScaledUi:
        // Sync is open to any address
        await this.ext.methods
          .sync()
          .accounts({
            extTokenProgram: this.extTokenProgram,
          })
          .signers([])
          .rpc();
        break;
      case Variant.Crank:
        // For Crank variant, we have to use the earn authority to sync
        await this.ext.methods
          .sync()
          .accounts({
            earnAuthority: this.earnAuthority.publicKey,
            extTokenProgram: this.extTokenProgram,
          })
          .signers([this.earnAuthority])
          .rpc();
        break;
      default:
        throw new Error("Unsupported variant for sync");
    }

    return this.getExtGlobalAccount();
  }

  public async claimFees(
    toTokenAccount?: PublicKey
  ): Promise<{ recipientExtTokenAccount: PublicKey }> {
    const recipientExtTokenAccount =
      toTokenAccount ??
      (await this.getATA(
        this.extMint.publicKey,
        this.admin.publicKey,
        this.useToken2022ForExt
      ));

    // Send the instruction
    await this.ext.methods
      .claimFees()
      .accountsPartial({
        admin: this.admin.publicKey,
        recipientExtTokenAccount,
        extTokenProgram: this.extTokenProgram,
      })
      .signers([this.admin])
      .rpc();

    return { recipientExtTokenAccount };
  }

  // Helper functions for Crank variant functionality

  public getEarnManagerAccount(earnManager: PublicKey): PublicKey {
    const [earnManagerAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("earn_manager"), earnManager.toBuffer()],
      this.ext.programId
    );

    return earnManagerAccount;
  }

  public getEarnerAccount(userTokenAccount: PublicKey): PublicKey {
    const [earnerAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("earner"), userTokenAccount.toBuffer()],
      this.ext.programId
    );

    return earnerAccount;
  }

  public async addEarnManager(
    earnManager: PublicKey,
    feeBps: BN,
    feeTokenAccount?: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error("addEarnManager is only available for Crank variant");
    }

    const feeTokenATA =
      feeTokenAccount ??
      (await this.getATA(
        this.extMint.publicKey,
        earnManager,
        this.useToken2022ForExt
      ));

    await this.ext.methods
      .addEarnManager(earnManager, feeBps)
      .accountsPartial({
        admin: this.admin.publicKey,
        feeTokenAccount: feeTokenATA,
      })
      .signers([this.admin])
      .rpc();
  }

  public async removeEarnManager(earnManager: PublicKey) {
    if (this.variant !== Variant.Crank) {
      throw new Error("removeEarnManager is only available for Crank variant");
    }

    await this.ext.methods
      .removeEarnManager()
      .accountsPartial({
        admin: this.admin.publicKey,
        earnManagerAccount: this.getEarnManagerAccount(earnManager),
      })
      .signers([this.admin])
      .rpc();
  }

  public async setEarnAuthority(newEarnAuthority: PublicKey) {
    if (this.variant !== Variant.Crank) {
      throw new Error("setEarnAuthority is only available for Crank variant");
    }

    await this.ext.methods
      .setEarnAuthority(newEarnAuthority)
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  public async addEarner(
    earnManager: Keypair,
    user: PublicKey,
    userTokenAccount?: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error("addEarner is only available for Crank variant");
    }

    const userTokenATA =
      userTokenAccount ??
      (await this.getATA(
        this.extMint.publicKey,
        user,
        this.useToken2022ForExt
      ));

    await this.ext.methods
      .addEarner(user)
      .accounts({
        signer: earnManager.publicKey,
        userTokenAccount: userTokenATA,
      })
      .signers([earnManager])
      .rpc();
  }

  public async removeEarner(earnManager: Keypair, userTokenAccount: PublicKey) {
    if (this.variant !== Variant.Crank) {
      throw new Error("removeEarner is only available for Crank variant");
    }

    await this.ext.methods
      .removeEarner()
      .accounts({
        signer: earnManager.publicKey,
      })
      .signers([earnManager])
      .rpc();
  }

  public async transferEarner(
    fromEarnManager: Keypair,
    toEarnManager: PublicKey,
    userTokenAccount: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error("transferEarner is only available for Crank variant");
    }

    await this.ext.methods
      .transferEarner(toEarnManager)
      .accountsPartial({
        signer: fromEarnManager.publicKey,
        earnerAccount: this.getEarnerAccount(userTokenAccount),
      })
      .signers([fromEarnManager])
      .rpc();
  }

  public async configureEarnManager(
    earnManager: Keypair,
    feeBps?: BN,
    feeTokenAccount?: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error(
        "configureEarnManager is only available for Crank variant"
      );
    }

    await this.ext.methods
      .configureEarnManager(feeBps || null)
      .accounts({
        signer: earnManager.publicKey,
        feeTokenAccount: feeTokenAccount || null,
      })
      .signers([earnManager])
      .rpc();
  }

  public async setRecipient(
    signer: Keypair,
    earnerAccount: PublicKey,
    recipientTokenAccount?: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error("setRecipient is only available for Crank variant");
    }

    await this.ext.methods
      .setRecipient()
      .accountsPartial({
        signer: signer.publicKey,
        earnerAccount,
        recipientTokenAccount: recipientTokenAccount || null,
      })
      .signers([signer])
      .rpc();
  }

  public async claimFor(
    userTokenAccount: PublicKey,
    snapshotBalance: BN,
    feeTokenAccount?: PublicKey
  ) {
    if (this.variant !== Variant.Crank) {
      throw new Error("claimFor is only available for Crank variant");
    }

    const earnerAccount = this.getEarnerAccount(userTokenAccount);
    const earnerAccountInfo = await this.ext.account.earner.fetch(
      earnerAccount
    );
    const earnManagerAccount = this.getEarnManagerAccount(
      earnerAccountInfo.earnManager
    );

    await this.ext.methods
      .claimFor(snapshotBalance)
      .accountsPartial({
        earnAuthority: this.earnAuthority.publicKey,
        userTokenAccount,
        earnerAccount,
        earnManagerAccount,
        earnManagerTokenAccount: feeTokenAccount,
        extTokenProgram: this.extTokenProgram,
      })
      .signers([this.earnAuthority])
      .rpc();
  }

  // Helper method to determine if we should use TOKEN_2022_PROGRAM_ID for ext mint operations
  public get useToken2022ForExt(): boolean {
    return this.extTokenProgram === TOKEN_2022_PROGRAM_ID;
  }

  // Admin transfer helper methods

  public async transferAdmin(newAdmin: PublicKey) {
    await this.ext.methods
      .transferAdmin(newAdmin)
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  public async acceptAdmin(pendingAdmin: Keypair) {
    await this.ext.methods
      .acceptAdmin()
      .accounts({
        pendingAdmin: pendingAdmin.publicKey,
      })
      .signers([pendingAdmin])
      .rpc();
  }

  public async revokeAdminTransfer() {
    await this.ext.methods
      .revokeAdminTransfer()
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }
}

// Extension Swap Test class that supports multiple extension programs and the swap program
export class ExtensionSwapTest extends ExtensionTestBase {
  public swapProgram: Program<ExtSwap>;
  public extensionPrograms: { [key: string]: Program<MExt> } = {};
  public extensionMints: { [key: string]: Keypair } = {};
  public swapperKeypair: Keypair;

  // Program IDs from the Makefile for test extension programs
  private static readonly EXT_PROGRAM_IDS = {
    extA: new PublicKey("3joDhmLtHLrSBGfeAe1xQiv3gjikes3x8S4N3o6Ld8zB"),
    extB: new PublicKey("HSMnbWEkB7sEQAGSzBPeACNUCXC9FgNeeESLnHtKfoy3"),
    extC: new PublicKey("81gYpXqg8ZT9gdkFSe35eqiitqBWqVfYwDwVfXuk8Xfw"),
  };

  constructor(addresses: PublicKey[] = []) {
    // Initialize with ScaledUi variant and TOKEN_2022_PROGRAM_ID
    super(addresses);

    // Load and add extension programs
    const NO_YIELD_IDL = require("../../target/idl/no_yield.json");
    const SCALED_UI_IDL = require("../../target/idl/scaled_ui.json");

    // Add the test extension programs to SVM
    this.svm.addProgramFromFile(
      ExtensionSwapTest.EXT_PROGRAM_IDS.extA,
      "tests/programs/ext_a.so"
    );
    this.svm.addProgramFromFile(
      ExtensionSwapTest.EXT_PROGRAM_IDS.extB,
      "tests/programs/ext_b.so"
    );
    this.svm.addProgramFromFile(
      ExtensionSwapTest.EXT_PROGRAM_IDS.extC,
      "tests/programs/ext_c.so"
    );

    // Create program instances
    this.extensionPrograms.extA = new Program<MExt>(
      { ...NO_YIELD_IDL, address: ExtensionSwapTest.EXT_PROGRAM_IDS.extA },
      this.provider
    );
    this.extensionPrograms.extB = new Program<MExt>(
      { ...SCALED_UI_IDL, address: ExtensionSwapTest.EXT_PROGRAM_IDS.extB },
      this.provider
    );
    this.extensionPrograms.extC = new Program<MExt>(
      { ...NO_YIELD_IDL, address: ExtensionSwapTest.EXT_PROGRAM_IDS.extC },
      this.provider
    );

    // Load and add swap program
    const EXT_SWAP_IDL = require("../../target/idl/ext_swap.json");

    // Add swap program to SVM
    this.svm.addProgramFromFile(
      new PublicKey(EXT_SWAP_IDL.address),
      "target/deploy/ext_swap.so"
    );

    // Create swap program instance
    this.swapProgram = new Program(EXT_SWAP_IDL, this.provider);

    // Create swapper keypair
    this.swapperKeypair = new Keypair();

    // Fund the swapper
    this.svm.airdrop(
      this.swapperKeypair.publicKey,
      BigInt(10 * LAMPORTS_PER_SOL)
    );
  }

  public async init(initialSupply: BN, initialIndex: BN) {
    // Initialize base MExt functionality
    await this._init(initialSupply, initialIndex);

    // Create extension mints BEFORE initializing extension programs
    await this.createExtensionMints();

    // Make the M vaults earners
    await this.addAllExtensionVaultsAsEarners();

    // Initialize extension programs AFTER mints are created
    await this.initializeExtensionPrograms();

    // Initialize swap program
    await this.initializeSwapProgram();

    // Setup swapper keypair
    // Add swapper as an M earner, which unfreezes the ATA
    await this.addMEarner(this.swapperKeypair.publicKey);

    // Mint some M tokens to the swapper
    await this.mintM(this.swapperKeypair.publicKey, new BN(1_000_000));
  }

  private async createExtensionMints() {
    // Create mints for each extension
    this.extensionMints.mintA = new Keypair();
    this.extensionMints.mintB = new Keypair();
    this.extensionMints.mintC = new Keypair();

    // Create mint authorities for each extension program
    const mintAuthA = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      this.extensionPrograms.extA.programId
    )[0];

    const mintAuthB = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      this.extensionPrograms.extB.programId
    )[0];

    const mintAuthC = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      this.extensionPrograms.extC.programId
    )[0];

    // ext_a: no-yield variant - use regular TOKEN_2022 mint
    await this.createMint(
      this.extensionMints.mintA,
      mintAuthA,
      mintAuthA,
      true // use TOKEN_2022_PROGRAM_ID
    );

    // ext_b: scaled-ui variant - use ScaledUi mint
    await this.createScaledUiMint(
      this.extensionMints.mintB,
      mintAuthB,
      mintAuthB
    );

    // ext_c: no-yield variant with extra accounts - use regular TOKEN_2022 mint
    await this.createMint(
      this.extensionMints.mintC,
      mintAuthC,
      mintAuthC,
      true // use TOKEN_2022_PROGRAM_ID
    );
  }

  private async initializeExtensionPrograms() {
    // ext_a: no-yield variant - initialize with just wrap authorities
    await this.extensionPrograms.extA.methods
      .initialize([this.admin.publicKey])
      .accounts({
        admin: this.admin.publicKey,
        mMint: this.mMint.publicKey,
        extMint: this.extensionMints.mintA.publicKey,
        extTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([this.admin])
      .rpc();

    // ext_b: scaled-ui variant - initialize with wrap authorities and fee_bps
    await this.extensionPrograms.extB.methods
      .initialize([this.admin.publicKey], new BN(500)) // 5% fee
      .accounts({
        admin: this.admin.publicKey,
        mMint: this.mMint.publicKey,
        extMint: this.extensionMints.mintB.publicKey,
        extTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([this.admin])
      .rpc();

    // ext_c: no-yield variant with extra accounts - initialize with just wrap authorities
    await this.extensionPrograms.extC.methods
      .initialize([this.admin.publicKey])
      .accounts({
        admin: this.admin.publicKey,
        mMint: this.mMint.publicKey,
        extMint: this.extensionMints.mintC.publicKey,
        extTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([this.admin])
      .rpc();
  }

  private async initializeSwapProgram() {
    await this.swapProgram.methods
      .initializeGlobal()
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  // Helper methods for swap testing
  public async whitelistExtension(
    extensionProgramId: PublicKey,
    mint: PublicKey
  ) {
    await this.swapProgram.methods
      .whitelistExtension()
      .accountsPartial({
        admin: this.admin.publicKey,
        extProgram: extensionProgramId,
        extMint: mint,
      })
      .signers([this.admin])
      .rpc();
  }

  public async whitelistUnwrapper(unwrapper: PublicKey) {
    await this.swapProgram.methods
      .whitelistUnwrapper(unwrapper)
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  public async addWrapAuthorityToExtension(
    extensionKey: string,
    authority: PublicKey
  ) {
    const program = this.extensionPrograms[extensionKey];
    if (!program) throw new Error(`Extension ${extensionKey} not found`);

    await program.methods
      .addWrapAuthority(authority)
      .accounts({
        admin: this.admin.publicKey,
      })
      .signers([this.admin])
      .rpc();
  }

  public getSwapGlobalAccount(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("global")],
      this.swapProgram.programId
    )[0];
  }

  public getExtensionProgramId(key: string): PublicKey {
    const program = this.extensionPrograms[key];
    if (!program) throw new Error(`Extension ${key} not found`);
    return program.programId;
  }

  public getExtensionMint(key: string): PublicKey {
    const mint = this.extensionMints[key];
    if (!mint) throw new Error(`Extension mint ${key} not found`);
    return mint.publicKey;
  }

  // Override getMVault to support multiple extension programs
  public getMVaultForExtension(extensionProgramId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("m_vault")],
      extensionProgramId
    )[0];
  }

  // Update M earner setup to include all extension vaults
  async addAllExtensionVaultsAsEarners() {
    const vaults = [
      this.getMVaultForExtension(this.extensionPrograms.extA.programId),
      this.getMVaultForExtension(this.extensionPrograms.extB.programId),
      this.getMVaultForExtension(this.extensionPrograms.extC.programId),
    ];

    // Add all vaults to the earner list
    for (const vault of vaults) {
      await this.addMEarner(vault);
    }
  }

  /**
   * Get the current M index from the M mint's scaled UI config.
   * This is the index used for M token principal <-> UI amount conversions.
   * Uses newMultiplier to match Rust multiplier_to_index behavior.
   */
  public async getCurrentMIndex(): Promise<BN> {
    const scaledUiConfig = await this.getScaledUiAmountConfig(this.mMint.publicKey);
    // Use newMultiplier to match Rust: multiplier_to_index(m_scaled_ui_config.new_multiplier)
    const multiplier = scaledUiConfig.newMultiplier;
    // index = multiplier * 1e12 (same formula as Rust multiplier_to_index)
    return new BN(Math.floor(multiplier * 1e12));
  }
}
