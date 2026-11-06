// Unit tests for the `handoff` instruction (no-yield and scaled-ui builds): hand
// the extension's mint over to an M0 V2 Issuer Gateway deployment. Every test
// runs against three mint shapes:
//   xo     no-yield build, plain mint
//   usdk   no-yield build, mint with Scaled UI Amount (multiplier fixed at 1.0)
//   usdky  scaled-ui build, mint with Scaled UI Amount (multiplier above 1.0)
//
// The gateway program itself is not loaded. handoff validates the target
// Stablecoin account by derivation, owner, and bytes, so the tests plant that
// account directly with `setAccount`. A crank build at the wM id (ext_wm.so,
// see the Makefile) is loaded so the vault wrap runs for real.
//
// [X] given the admin, a funded vault, and an AdoptionPending target
//   [X] it moves the mint authority to the target
//   [X] it wraps the whole vault into wM for the issuer and closes the vault ATA
//   [X] it clears the wrap authorities
//   [X] wrap is dead afterwards
// [X] given an empty vault                              it hands over and closes the vault with no wrap
// [X] given a non-admin signer                          it reverts with NotAuthorized
// [X] given a target that is not the derived PDA        it reverts with ConstraintSeeds
// [X] given a target not owned by the gateway program   it reverts with InvalidAccount
// [X] given a target not in AdoptionPending             it reverts with InvalidAccount
// [X] given a target with a wrong discriminator, version, mint or length
//                                                       it reverts with InvalidAccount
// [X] given a wrap program that is not wM               it reverts with InvalidAccount
// [X] given a vault PDA off wM's wrap list              it reverts with NotAuthorized
// [X] given a recipient account for another mint        it reverts with ConstraintTokenMint
// [X] given a recipient not owned by the pinned wallet  it reverts with ConstraintTokenOwner
// [X] given a second call after a successful handoff    it reverts
// [X] given a mint with Scaled UI Amount (usdk, usdky)
//   [X] it moves the Scaled UI authority to the target
// [X] given an unsynced scaled-ui ext (usdky)           it syncs holder yield before the wrap
// [X] given a plain mint (xo)                           it touches no Scaled UI authority

import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";

import { ExtensionTest, Variant } from "./ext_test_harness";
import { MExt as CrankExt } from "../../target/types/crank";

const CRANK_IDL = require("../../target/idl/crank.json");

type Shape = {
  name: string;
  variant: Variant.NoYield | Variant.ScaledUi;
  scaledUiMint: boolean;
};

const shapes: Shape[] = [
  { name: "xo", variant: Variant.NoYield, scaledUiMint: false },
  { name: "usdk", variant: Variant.NoYield, scaledUiMint: true },
  { name: "usdky", variant: Variant.ScaledUi, scaledUiMint: true },
];

const initialSupply = new BN(100_000_000); // 100 tokens with 6 decimals
const initialIndex = new BN(1_100_000_000_000); // 1.1 with 12 decimals
const wrappedAmount = new BN(25_000_000); // 25 tokens with 6 decimals
const INDEX_SCALE = new BN(1_000_000_000_000);

// Gateway `Stablecoin` wire facts, mirroring the constants in
// programs/m_ext/src/instructions/handoff.rs.
const STABLECOIN_LEN = 164;
const STABLECOIN_DISCRIMINATOR = 2;
const STABLECOIN_ACCOUNT_VERSION = 1;
const MINT_ORIGIN_OFFSET = 5;
const MINT_ORIGIN_ADOPTION_PENDING = 1;
const MINT_OFFSET = 10;

// The gateway id the test binary pins, `GATEWAY_PROGRAM_ID` in
// programs/m_ext/src/instructions/handoff.rs.
const gatewayProgram = new PublicKey(
  "EDKMBb8e1DyCZtUrczZeJgxWgMU2nLBCuK31XzPnXWu3"
);

// The issuer wallet the test binary pins, `RECIPIENT` in
// programs/m_ext/src/instructions/handoff.rs.
const recipient = new PublicKey("8dDyonHjmXBUpTy6hkWd4CbKHLeqkimv4SpR1ZqK2G3t");

// wM, `WM_PROGRAM_ID` in programs/m_ext/src/instructions/handoff.rs.
const wmProgramId = new PublicKey(
  "wMXX1K1nca5W4pZr1piETe78gcAVVrEFi9f4g46uXko"
);

const pda = (seed: string, program: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from(seed)], program)[0];

describe.each(shapes)("handoff unit tests ($name)", (shape) => {
  let $: ExtensionTest<any>;
  let wm: Program<CrankExt>;
  let wmMint: Keypair;
  let vaultMTokenAccount: PublicKey;
  let issuerWmTokenAccount: PublicKey;

  const mAta = (owner: PublicKey): PublicKey =>
    getAssociatedTokenAddressSync(
      $.mMint.publicKey,
      owner,
      true,
      TOKEN_2022_PROGRAM_ID
    );

  const stablecoinPda = (): PublicKey =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("stablecoin"), $.extMint.publicKey.toBuffer()],
      gatewayProgram
    )[0];

  // Plant a gateway Stablecoin account the way `adopt_stablecoin` leaves it.
  const plantStablecoin = (opts?: {
    address?: PublicKey;
    owner?: PublicKey;
    mintOrigin?: number;
    edit?: (data: Buffer) => Buffer;
  }): PublicKey => {
    const address = opts?.address ?? stablecoinPda();
    const data = Buffer.alloc(STABLECOIN_LEN);
    data[0] = STABLECOIN_DISCRIMINATOR;
    data[1] = STABLECOIN_ACCOUNT_VERSION;
    data[MINT_ORIGIN_OFFSET] = opts?.mintOrigin ?? MINT_ORIGIN_ADOPTION_PENDING;
    $.extMint.publicKey.toBuffer().copy(data, MINT_OFFSET);
    $.svm.setAccount(address, {
      lamports: 10_000_000,
      data: opts?.edit ? opts.edit(data) : data,
      owner: opts?.owner ?? gatewayProgram,
      executable: false,
    });
    return address;
  };

  const handoff = (
    stablecoin: PublicKey,
    opts?: {
      signer?: Keypair;
      wmProgram?: PublicKey;
      recipientWmTokenAccount?: PublicKey;
    }
  ) => {
    const signer = opts?.signer ?? $.admin;
    const wmVault = pda("m_vault", wmProgramId);
    return $.ext.methods
      .handoff()
      .accountsPartial({
        admin: signer.publicKey,
        globalAccount: $.getExtGlobalAccount(),
        extMint: $.extMint.publicKey,
        extMintAuthority: $.getExtMintAuthority(),
        stablecoin,
        mMint: $.mMint.publicKey,
        mVault: $.getMVault(),
        vaultMTokenAccount,
        wmMint: wmMint.publicKey,
        recipientWmTokenAccount:
          opts?.recipientWmTokenAccount ?? issuerWmTokenAccount,
        wmProgram: opts?.wmProgram ?? wmProgramId,
        wmGlobal: pda("global", wmProgramId),
        wmMVault: wmVault,
        wmMintAuthority: pda("mint_authority", wmProgramId),
        wmVaultMTokenAccount: mAta(wmVault),
        mTokenProgram: TOKEN_2022_PROGRAM_ID,
        extTokenProgram: TOKEN_2022_PROGRAM_ID,
        wmTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  };

  // Load wM and wire it the way the cutover needs: the wM admin lists this
  // extension's vault PDA as a wrap authority.
  const setUpWm = async () => {
    $.svm.addProgramFromFile(wmProgramId, "tests/programs/ext_wm.so");
    wm = new Program<CrankExt>(
      { ...CRANK_IDL, address: wmProgramId },
      $.provider
    );

    wmMint = new Keypair();
    const wmMintAuthority = pda("mint_authority", wmProgramId);
    await $.createMint(wmMint, wmMintAuthority, wmMintAuthority, true);
    await $.addMEarner(pda("m_vault", wmProgramId));
    await wm.methods
      .initialize([$.getMVault()], $.admin.publicKey)
      .accounts({
        admin: $.admin.publicKey,
        mMint: $.mMint.publicKey,
        extMint: wmMint.publicKey,
        extTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([$.admin])
      .rpc();

    // The issuer's wM account. wM accounts are not frozen, so no earner step.
    issuerWmTokenAccount = await $.getATA(wmMint.publicKey, recipient);
  };

  beforeEach(async () => {
    $ = new ExtensionTest(shape.variant, TOKEN_2022_PROGRAM_ID, []);
    $.scaledUiMint = shape.scaledUiMint;
    await $.init(initialSupply, initialIndex);
    await $.initializeExt(
      [$.admin.publicKey, $.wrapAuthority.publicKey],
      shape.variant === Variant.ScaledUi ? new BN(0) : undefined
    );
    await setUpWm();

    vaultMTokenAccount = await $.getATA($.mMint.publicKey, $.getMVault());

    // Nonzero supply and a funded vault, as at any real cutover. The index
    // bump accrues the vault (an M earner) past its last claim. A scaled-ui
    // ext stays unsynced, as a live one usually is, so handoff must sync it.
    await $.wrap($.admin, wrappedAmount);
    await $.propagateIndex(new BN(1_200_000_000_000));
  });

  const testScaledUiMint = shape.scaledUiMint ? test : test.skip;
  const testPlain = shape.scaledUiMint ? test.skip : test;
  const testScaledUi = shape.variant === Variant.ScaledUi ? test : test.skip;

  test("hands the mint over, wraps the vault into wM, and tombstones", async () => {
    const stablecoin = plantStablecoin();
    const wmVault = mAta(pda("m_vault", wmProgramId));
    const vaultPrincipal = await $.getTokenBalance(vaultMTokenAccount);
    expect(vaultPrincipal.gtn(0)).toBe(true);
    const wmVaultBefore = await $.getTokenBalance(wmVault);

    await handoff(stablecoin);

    // Mint authority sits at the Stablecoin PDA.
    const mintInfo = await getMint(
      $.provider.connection,
      $.extMint.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(mintInfo.mintAuthority?.toBase58()).toEqual(stablecoin.toBase58());

    // Every unit of vault principal moved into the wM vault, and the V1 vault
    // closed (litesvm keeps a zero-lamport stub).
    const vaultAfter = $.svm.getAccount(vaultMTokenAccount);
    expect(!vaultAfter || Number(vaultAfter.lamports) === 0).toBe(true);
    const wmVaultAfter = await $.getTokenBalance(wmVault);
    expect(wmVaultAfter.sub(wmVaultBefore).toString()).toEqual(
      vaultPrincipal.toString()
    );

    // The issuer holds the vault's $M amount as wM: principal times the M
    // index, rounded up, which wrap floors back to the vault principal.
    const mIndex = await $.getCurrentMIndex();
    const expectedWm = vaultPrincipal
      .mul(mIndex)
      .add(INDEX_SCALE.subn(1))
      .div(INDEX_SCALE);
    const issuerWm = await $.getTokenBalance(issuerWmTokenAccount);
    expect(issuerWm.toString()).toEqual(expectedWm.toString());

    // Tombstone: no wrap authorities remain.
    const global = await $.ext.account.extGlobalV2.fetch(
      $.getExtGlobalAccount()
    );
    expect(global.wrapAuthorities.length).toEqual(0);

    // Wrap is dead: the authority list is empty.
    await expect($.wrap($.admin, new BN(1_000_000))).rejects.toThrow();
  });

  test("non-admin signer - reverts", async () => {
    const stablecoin = plantStablecoin();
    await $.expectAnchorError(
      handoff(stablecoin, { signer: $.nonAdmin }),
      "NotAuthorized"
    );
  });

  test("target is not the derived PDA - reverts", async () => {
    const elsewhere = plantStablecoin({
      address: Keypair.generate().publicKey,
    });
    await $.expectAnchorError(handoff(elsewhere), "ConstraintSeeds");
  });

  test("target not owned by the gateway program - reverts", async () => {
    const stablecoin = plantStablecoin({ owner: SystemProgram.programId });
    await $.expectAnchorError(handoff(stablecoin), "InvalidAccount");
  });

  test("target not in AdoptionPending - reverts", async () => {
    const stablecoin = plantStablecoin({ mintOrigin: 2 }); // Adopted
    await $.expectAnchorError(handoff(stablecoin), "InvalidAccount");
  });

  test.each<[string, (data: Buffer) => Buffer]>([
    ["discriminator", (d) => (d.fill(9, 0, 1), d)],
    ["account version", (d) => (d.fill(9, 1, 2), d)],
    [
      "mint",
      (d) => (Keypair.generate().publicKey.toBuffer().copy(d, MINT_OFFSET), d),
    ],
    ["length", (d) => d.subarray(0, MINT_OFFSET + 31)],
  ])("target with a wrong %s - reverts", async (_, edit) => {
    const stablecoin = plantStablecoin({ edit });
    await $.expectAnchorError(handoff(stablecoin), "InvalidAccount");
  });

  test("empty vault - hands over and closes the vault with no wrap", async () => {
    const stablecoin = plantStablecoin();
    const vault = $.svm.getAccount(vaultMTokenAccount)!;
    const data = Buffer.from(vault.data);
    data.writeBigUInt64LE(0n, 64); // token account amount
    $.svm.setAccount(vaultMTokenAccount, { ...vault, data });

    await handoff(stablecoin);

    const vaultAfter = $.svm.getAccount(vaultMTokenAccount);
    expect(!vaultAfter || Number(vaultAfter.lamports) === 0).toBe(true);
    const issuerWm = await $.getTokenBalance(issuerWmTokenAccount);
    expect(issuerWm.toString()).toEqual("0");
  });

  test("wrap program is not wM - reverts", async () => {
    const stablecoin = plantStablecoin();
    await $.expectAnchorError(
      handoff(stablecoin, { wmProgram: $.ext.programId }),
      "InvalidAccount"
    );
  });

  test("vault PDA not on wM's wrap list - reverts", async () => {
    const stablecoin = plantStablecoin();
    await wm.methods
      .removeWrapAuthority($.getMVault())
      .accounts({ admin: $.admin.publicKey })
      .signers([$.admin])
      .rpc();
    await $.expectAnchorError(handoff(stablecoin), "NotAuthorized");
  });

  test("recipient account holds another mint - reverts", async () => {
    const stablecoin = plantStablecoin();
    const extAccount = await $.getATA($.extMint.publicKey, recipient);
    await $.expectAnchorError(
      handoff(stablecoin, { recipientWmTokenAccount: extAccount }),
      "ConstraintTokenMint"
    );
  });

  test("recipient account not owned by the pinned wallet - reverts", async () => {
    const stablecoin = plantStablecoin();
    const elsewhere = await $.getATA(
      wmMint.publicKey,
      Keypair.generate().publicKey
    );
    await $.expectAnchorError(
      handoff(stablecoin, { recipientWmTokenAccount: elsewhere }),
      "ConstraintTokenOwner"
    );
  });

  test("second call after a successful handoff - reverts", async () => {
    const stablecoin = plantStablecoin();
    await handoff(stablecoin);
    // The vault ATA is closed, so the account constraints fail before any CPI.
    await $.expectSystemError(handoff(stablecoin));
  });

  testScaledUiMint(
    "moves the Scaled UI authority with the mint authority",
    async () => {
      const stablecoin = plantStablecoin();
      const before = await $.getScaledUiAmountConfig($.extMint.publicKey);
      expect(before.authority.toBase58()).toEqual(
        $.getExtMintAuthority().toBase58()
      );

      await handoff(stablecoin);

      const after = await $.getScaledUiAmountConfig($.extMint.publicKey);
      expect(after.authority.toBase58()).toEqual(stablecoin.toBase58());
    }
  );

  testScaledUi("syncs holder yield before the wrap", async () => {
    const stablecoin = plantStablecoin();
    const before = await $.getScaledUiAmountConfig($.extMint.publicKey);
    await handoff(stablecoin);

    // The multiplier rises to the propagated index, so holders keep the yield
    // instead of it reaching the recipient as wM.
    const after = await $.getScaledUiAmountConfig($.extMint.publicKey);
    expect(after.newMultiplier).toBeGreaterThan(before.newMultiplier);
  });

  testPlain("a plain mint has no Scaled UI authority to move", async () => {
    const stablecoin = plantStablecoin();
    await handoff(stablecoin);
    const mintInfo = await getMint(
      $.provider.connection,
      $.extMint.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(mintInfo.mintAuthority?.toBase58()).toEqual(stablecoin.toBase58());
  });
});
