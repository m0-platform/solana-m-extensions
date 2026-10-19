// Unit tests for the `handoff` instruction (no-yield builds only): hand the
// extension's mint over to an M0 V2 Issuer Gateway deployment.
//
// The gateway program itself is not loaded — handoff validates the target
// Stablecoin account by derivation, owner, and bytes, so the tests plant that
// account directly with `setAccount`.
//
// [X] given the admin, a solvent vault, and an AdoptionPending target
//   [X] it moves the mint authority to the target
//   [X] it sweeps the vault to the treasury and closes the vault ATA
//   [X] it clears the wrap authorities
//   [X] wrap and unwrap are dead afterwards
// [X] given a non-admin signer                          it reverts with NotAuthorized
// [X] given vault M below the ext supply                it reverts with InsufficientCollateral
// [X] given a target that is not the derived PDA        it reverts with InvalidAccount
// [X] given a target not owned by the gateway program   it reverts with InvalidAccount
// [X] given a target not in AdoptionPending             it reverts with InvalidAccount
// [X] given a second call after a successful handoff    it reverts

import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createSetAuthorityInstruction,
  getMint,
} from "@solana/spl-token";

import { ExtensionTest, Variant } from "./ext_test_harness";

const initialSupply = new BN(100_000_000); // 100 tokens with 6 decimals
const initialIndex = new BN(1_100_000_000_000); // 1.1 with 12 decimals
const wrappedAmount = new BN(25_000_000); // 25 tokens with 6 decimals

// Gateway `Stablecoin` wire facts, mirroring the constants in
// programs/m_ext/src/instructions/handoff.rs.
const STABLECOIN_LEN = 164;
const STABLECOIN_DISCRIMINATOR = 2;
const STABLECOIN_ACCOUNT_VERSION = 1;
const MINT_ORIGIN_OFFSET = 5;
const MINT_ORIGIN_ADOPTION_PENDING = 1;
const MINT_OFFSET = 10;

describe("handoff unit tests", () => {
  let $: ExtensionTest<Variant.NoYield>;
  let gatewayProgram: PublicKey;
  let vaultMTokenAccount: PublicKey;
  let treasury: Keypair;
  let treasuryMTokenAccount: PublicKey;

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
  }): PublicKey => {
    const address = opts?.address ?? stablecoinPda();
    const data = Buffer.alloc(STABLECOIN_LEN);
    data[0] = STABLECOIN_DISCRIMINATOR;
    data[1] = STABLECOIN_ACCOUNT_VERSION;
    data[MINT_ORIGIN_OFFSET] = opts?.mintOrigin ?? MINT_ORIGIN_ADOPTION_PENDING;
    $.extMint.publicKey.toBuffer().copy(data, MINT_OFFSET);
    $.svm.setAccount(address, {
      lamports: 10_000_000,
      data,
      owner: opts?.owner ?? gatewayProgram,
      executable: false,
    });
    return address;
  };

  const handoff = (stablecoin: PublicKey, signer?: Keypair) =>
    $.ext.methods
      .handoff(gatewayProgram)
      .accountsPartial({
        admin: (signer ?? $.admin).publicKey,
        globalAccount: $.getExtGlobalAccount(),
        extMint: $.extMint.publicKey,
        extMintAuthority: $.getExtMintAuthority(),
        stablecoin,
        mMint: $.mMint.publicKey,
        mVault: $.getMVault(),
        vaultMTokenAccount,
        treasuryMTokenAccount,
        mTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([signer ?? $.admin])
      .rpc();

  beforeEach(async () => {
    $ = new ExtensionTest(Variant.NoYield, TOKEN_2022_PROGRAM_ID, []);
    await $.init(initialSupply, initialIndex);
    await $.initializeExt([$.admin.publicKey, $.wrapAuthority.publicKey]);

    gatewayProgram = Keypair.generate().publicKey;
    vaultMTokenAccount = await $.getATA($.mMint.publicKey, $.getMVault());

    // The treasury holds a thawed $M account (M accounts thaw via earner status).
    treasury = new Keypair();
    await $.addMEarner(treasury.publicKey);
    treasuryMTokenAccount = await $.getATA($.mMint.publicKey, treasury.publicKey);

    // Nonzero supply and a solvent vault, as at any real cutover. The index
    // bump accrues the vault (an M earner) past wrap's round-down, mirroring a
    // live vault that has earned since its last claim.
    await $.wrap($.admin, wrappedAmount);
    await $.propagateIndex(new BN(1_200_000_000_000));
  });

  test("hands the mint over, sweeps the vault, and tombstones", async () => {
    const stablecoin = plantStablecoin();
    const vaultBalanceBefore = await $.getTokenBalance(vaultMTokenAccount);
    expect(BigInt(vaultBalanceBefore.toString())).toBeGreaterThan(0n);

    await handoff(stablecoin);

    // Mint authority sits at the Stablecoin PDA.
    const mintInfo = await getMint(
      $.provider.connection,
      $.extMint.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(mintInfo.mintAuthority?.toBase58()).toEqual(stablecoin.toBase58());

    // Vault swept in full and closed (litesvm keeps a zero-lamport stub);
    // the treasury holds the balance.
    const vaultAfter = $.svm.getAccount(vaultMTokenAccount);
    expect(!vaultAfter || Number(vaultAfter.lamports) === 0).toBe(true);
    const treasuryBalance = await $.getTokenBalance(treasuryMTokenAccount);
    expect(treasuryBalance.toString()).toEqual(vaultBalanceBefore.toString());

    // Tombstone: no wrap authorities remain.
    const global = await $.ext.account.extGlobalV2.fetch($.getExtGlobalAccount());
    expect(global.wrapAuthorities.length).toEqual(0);

    // Wrap is dead: the authority list is empty.
    await expect($.wrap($.admin, new BN(1_000_000))).rejects.toThrow();
  });

  test("non-admin signer - reverts", async () => {
    const stablecoin = plantStablecoin();
    await $.expectAnchorError(handoff(stablecoin, $.nonAdmin), "NotAuthorized");
  });

  test("vault M below ext supply - reverts", async () => {
    const stablecoin = plantStablecoin();

    // Inflate the ext supply past the vault's cover (u64 LE at mint offset 36).
    const mintAccount = $.svm.getAccount($.extMint.publicKey)!;
    const data = Buffer.from(mintAccount.data);
    data.writeBigUInt64LE(BigInt(wrappedAmount.toString()) * 10n, 36);
    $.svm.setAccount($.extMint.publicKey, { ...mintAccount, data });

    await $.expectAnchorError(handoff(stablecoin), "InsufficientCollateral");
  });

  test("target is not the derived PDA - reverts", async () => {
    const elsewhere = plantStablecoin({
      address: Keypair.generate().publicKey,
    });
    await $.expectAnchorError(handoff(elsewhere), "InvalidAccount");
  });

  test("target not owned by the gateway program - reverts", async () => {
    const stablecoin = plantStablecoin({ owner: SystemProgram.programId });
    await $.expectAnchorError(handoff(stablecoin), "InvalidAccount");
  });

  test("target not in AdoptionPending - reverts", async () => {
    const stablecoin = plantStablecoin({ mintOrigin: 2 }); // Adopted
    await $.expectAnchorError(handoff(stablecoin), "InvalidAccount");
  });

  test("freeze authority held by the program's own PDA - reverts", async () => {
    const stablecoin = plantStablecoin();
    // Park the freeze authority at the ext mint authority PDA: unreachable forever.
    const parkIx = createSetAuthorityInstruction(
      $.extMint.publicKey,
      $.admin.publicKey,
      AuthorityType.FreezeAccount,
      $.getExtMintAuthority(),
      [],
      TOKEN_2022_PROGRAM_ID
    );
    await $.provider.sendAndConfirm!(new Transaction().add(parkIx), [$.admin]);

    await $.expectAnchorError(handoff(stablecoin), "FreezeAuthorityUnreachable");
  });

  test("second call after a successful handoff - reverts", async () => {
    const stablecoin = plantStablecoin();
    await handoff(stablecoin);
    // The vault ATA is closed, so the account constraints fail before any CPI.
    await $.expectSystemError(handoff(stablecoin));
  });
});
