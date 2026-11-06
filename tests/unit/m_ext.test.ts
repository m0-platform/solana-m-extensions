import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { randomInt } from "crypto";

import { Comparison, ExtensionTest, Variant } from "./ext_test_harness";

// Unit tests for ext earn program

// Start parameters for M Earn
const initialSupply = new BN(100_000_000); // 100 tokens with 6 decimals
const initialIndex = new BN(1_100_000_000_000); // 1.1 with 12 decimals
const ONE = new BN(1_000_000_000_000); // 1.0 with 12 decimals

const VARIANTS = [
  [Variant.NoYield, TOKEN_2022_PROGRAM_ID],
  [Variant.NoYield, TOKEN_PROGRAM_ID],
  [Variant.ScaledUi, TOKEN_2022_PROGRAM_ID],
  [Variant.Crank, TOKEN_PROGRAM_ID],
  [Variant.Crank, TOKEN_2022_PROGRAM_ID],
];

// Implement test cases for all variants
// Most are the same, but allows conditional tests when required for different variants
for (const [variant, tokenProgramId] of VARIANTS) {
  let $: ExtensionTest<Variant>;

  describe(`${variant} - ${
    tokenProgramId === TOKEN_2022_PROGRAM_ID ? "Token2022" : "Token"
  } unit tests`, () => {
    beforeEach(async () => {
      // Create new extenstion test harness and then initialize it
      $ = new ExtensionTest(
        variant as Variant,
        tokenProgramId as PublicKey,
        [],
      );
      await $.init(initialSupply, initialIndex);
    });

    describe("admin instruction tests", () => {
      describe("initialize unit tests", () => {
        // general test cases
        // [X] given the m_mint is not owned by the token2022 program
        //   [X] it reverts with a ConstraintAddress error
        // [X] given the ext_mint is not owned by the correct token program
        //   [X] it reverts with a ConstraintMintTokenProgram error
        // [X] given the ext_mint decimals do not match the m_mint decimals
        //   [X] it reverts with a ConstraintMintDecimals error
        // [X] given the M earn global account does not match the PDA on the earn program
        //   [X] it reverts with a SeedsConstraint error
        // [X] given the m_earner_account is not the required PDA
        //   [X] it reverts with a SeedsConstraint error
        // [X] given the ext_mint_authority is not the required PDA
        //   [X] it reverts with a SeedsConstraint error
        // [X] given the ext_mint does not have a freeze authority
        //   [X] it reverts with a InvalidMint error
        // [X] given the wrap authorities are not unique
        //   [X] it reverts with an InvalidParam error

        // given the m_mint is not owned by the token2022 program
        // it reverts with a ConstraintAddress error -> actually get AccountNotInitialized error before this
        test("m_mint not owned by token2022 - reverts", async () => {
          // Create a mint owned by a different program
          const wrongMint = new Keypair();
          await $.createMint(
            wrongMint,
            $.nonAdmin.publicKey,
            $.nonAdmin.publicKey,
            false,
          );

          // Create/get the m vault ATA for the wrong mint to avoid account not initialized error
          const vaultMTokenAccount = await $.getATA(
            wrongMint.publicKey,
            $.getMVault(),
            false,
          );

          // Attempt to send the transaction
          await $.expectSystemError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accountsPartial({
                admin: $.nonAdmin.publicKey,
                mMint: wrongMint.publicKey,
                extMint: $.extMint.publicKey,
                vaultMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
          );
        });

        // given the ext_mint is not owned by the correct token program
        // it reverts with a ConstraintMintTokenProgram error
        test("ext_mint not owned by the correct token program - reverts", async () => {
          // Create a mint owned by a different program
          const wrongMint = new Keypair();
          await $.createMint(
            wrongMint,
            $.nonAdmin.publicKey,
            $.nonAdmin.publicKey,
            !$.useToken2022ForExt,
          );

          // Attempt to send the transaction
          await $.expectAnchorError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accounts({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: wrongMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "ConstraintMintTokenProgram",
          );
        });

        // given the decimals on ext_mint do not match M
        // it reverts with a MintDecimals error
        test("ext_mint incorrect decimals - reverts", async () => {
          // Create a mint owned by a different program
          const badMint = new Keypair();
          await $.createMint(
            badMint,
            $.nonAdmin.publicKey,
            $.nonAdmin.publicKey,
            $.useToken2022ForExt,
            9,
          );

          // Attempt to send the transaction
          await $.expectAnchorError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accounts({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: badMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "ConstraintMintDecimals",
          );
        });

        // given the M earn global account is invalid
        // it reverts with a seeds constraint (or other account error)
        test("m_earn_global_account is incorrect - reverts", async () => {
          // Change the m earn global account
          const mEarnGlobalAccount = PublicKey.unique();
          if (mEarnGlobalAccount == $.getEarnGlobalAccount()) return;

          // Attempt to send transaction
          // Expect error (could be one of several "SeedsConstraint", "AccountOwnedByWrongProgram", "AccountNotInitialized")
          await $.expectSystemError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accountsPartial({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: $.extMint.publicKey,
                mEarnGlobalAccount: mEarnGlobalAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
          );
        });

        // given ext_mint_authority is not required PDA
        // it reverts with a seeds constraint
        test("ext_mint_authority is incorrect - reverts", async () => {
          // Change the ext mint authority
          const extMintAuthority = PublicKey.unique();
          if (extMintAuthority == $.getExtMintAuthority()) return;

          // Attempt to send transaction
          // Expect error (could be one of several "SeedsConstraint", "AccountOwnedByWrongProgram", "AccountNotInitialized")
          await $.expectSystemError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accountsPartial({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: $.extMint.publicKey,
                extMintAuthority: extMintAuthority,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
          );
        });

        // given the ext_mint does not have a freeze authority
        // it reverts with a InvalidMint error
        test("ext_mint does not have a freeze authority - reverts", async () => {
          // Create a mint without a freeze authority
          const wrongMint = new Keypair();
          await $.createMint(
            wrongMint,
            $.nonAdmin.publicKey,
            null,
            $.useToken2022ForExt,
            6,
          );

          // Attempt to send the transaction
          await $.expectAnchorError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize([])
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize([], new BN(0))
              : $.ext.methods.initialize([], $.earnAuthority.publicKey)
            )
              .accounts({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: wrongMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "InvalidMint",
          );
        });

        // given wrap authorities includes a duplicate, non-default public key
        // it reverts with an InvalidParam error
        test("wrap authorities includes a duplicate public key - reverts", async () => {
          // Change the wrap authorities
          const wrapAuthorities: PublicKey[] = $.createUniqueKeyArray(10);
          wrapAuthorities[0] = wrapAuthorities[1];

          // Attempt to send transaction
          await $.expectAnchorError(
            (variant === Variant.NoYield
              ? $.ext.methods.initialize(wrapAuthorities)
              : variant === Variant.ScaledUi
              ? $.ext.methods.initialize(wrapAuthorities, new BN(0))
              : $.ext.methods.initialize(
                  wrapAuthorities,
                  $.earnAuthority.publicKey,
                )
            )
              .accounts({
                admin: $.nonAdmin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: $.extMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "InvalidParam",
          );
        });

        // no yield test cases
        // [X] given all accounts and params are correct
        //   [X] the global account is created
        //   [X] the admin is set to the signer
        //   [X] the m_mint is set correctly
        //   [X] the ext_mint is set correctly
        //   [X] the m_earn_global_account is set correctly
        //   [X] the bumps are set correctly
        //   [X] the wrap authorities are set correctly

        if (variant === Variant.NoYield) {
          // given accounts and params are correct
          // it creates the global account
          // it sets the admin to the signer
          // it sets the m_mint to the provided mint
          // it sets the ext_mint to the provided mint
          // it sets the m_earn_global_account to the provided account
          // it sets the scaled ui amount multiplier and timestamp to the values on the m earner account
          // it sets the bumps to the correct values
          test("initialize - success", async () => {
            // Get a random number of wrap authorities
            // We use the padded array to check the stored state after the call
            const numWrapAuthorities = randomInt(10);
            const wrapAuthorities: PublicKey[] =
              $.createUniqueKeyArray(numWrapAuthorities);

            // Derive PDA bumps
            const [, bump] = PublicKey.findProgramAddressSync(
              [Buffer.from("global")],
              $.ext.programId,
            );
            const [, mVaultBump] = PublicKey.findProgramAddressSync(
              [Buffer.from("m_vault")],
              $.ext.programId,
            );
            const [, extMintAuthorityBump] = PublicKey.findProgramAddressSync(
              [Buffer.from("mint_authority")],
              $.ext.programId,
            );

            // Ensure the global account has not been created yet
            const globalAccount = $.getExtGlobalAccount();
            $.expectAccountEmpty(globalAccount);

            // Send the transaction
            await $.ext.methods
              .initialize(wrapAuthorities)
              .accounts({
                admin: $.admin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: $.extMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.admin])
              .rpc();

            // Check the state of the global account
            await $.expectExtGlobalState({
              admin: $.admin.publicKey,
              extMint: $.extMint.publicKey,
              mMint: $.mMint.publicKey,
              mEarnGlobalAccount: $.getEarnGlobalAccount(),
              bump,
              mVaultBump,
              extMintAuthorityBump,
              yieldConfig: {
                yieldVariant: { noYield: {} },
              },
              wrapAuthorities,
            });

            // Confirm the size of the global account based on the number of wrap authorities
            const expectedSize = 176 + 1 + wrapAuthorities.length * 32; // 176 bytes base size + 1 for yield config discriminator + 4 bytes for vector length + 32 bytes per wrap authority
            const extGlobalSize = await $.provider.connection
              .getAccountInfo(globalAccount)
              .then((info) => info?.data.length || 0);
            expect(extGlobalSize).toEqual(expectedSize);
          });
        }

        // scaled ui test cases
        // [X] given the ext_mint does not have the scaled ui amount extension
        //   [X] it reverts with a InvalidMint error
        // [X] given the ext_mint has the scaled ui amount extension, but the authority is not the mint authority PDA
        //   [X] it reverts with an InvalidMint error
        // [X] given all accounts and params are correct
        //   [X] the global account is created
        //   [X] the admin is set to the signer
        //   [X] the m_mint is set correctly
        //   [X] the ext_mint is set correctly
        //   [X] the m_earn_global_account is set correctly
        //   [X] the bumps are set correctly
        //   [X] the wrap authorities are set correctly
        //   [X] the multiplier on the ext mint is initialized to m index
        //   [X] the timestamp on the ext mint is set to the m timestamp

        if (variant === Variant.ScaledUi) {
          // given the ext_mint does not have the scaled ui amount extension
          // it reverts with a InvalidMint error
          test("ext_mint does not have the scaled ui amount extension - reverts", async () => {
            // Create a mint without the scaled ui amount extension
            const wrongMint = new Keypair();
            await $.createMint(
              wrongMint,
              $.getExtMintAuthority(),
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
              6,
            ); // valid otherwise

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .initialize([], new BN(0))
                .accounts({
                  admin: $.nonAdmin.publicKey,
                  mMint: $.mMint.publicKey,
                  extMint: wrongMint.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "InvalidMint",
            );
          });

          // given the ext_mint has the scaled ui amount extension, but the authority is not the mint authority PDA
          // it reverts with an InvalidMint error
          test("ext_mint has the scaled ui amount extension, but the authority is not the mint authority PDA - reverts", async () => {
            // Create a mint with the scaled ui amount extension
            const wrongMint = new Keypair();
            await $.createScaledUiMint(
              wrongMint,
              $.nonAdmin.publicKey,
              $.nonAdmin.publicKey,
              6,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .initialize([], new BN(0))
                .accounts({
                  admin: $.nonAdmin.publicKey,
                  mMint: $.mMint.publicKey,
                  extMint: wrongMint.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "InvalidMint",
            );
          });

          // given accounts and params are correct
          // it creates the global account
          // it sets the admin to the signer
          // it sets the m_mint to the provided mint
          // it sets the ext_mint to the provided mint
          // it sets the m_earn_global_account to the provided account
          // it sets the scalued ui amount multiplier and timestamp to the values on the m earn global account
          // it sets the bumps to the correct values
          test("initialize - success", async () => {
            // Get a random number of wrap authorities
            // We use the padded array to check the stored state after the call
            const numWrapAuthorities = randomInt(10);
            const wrapAuthorities: PublicKey[] =
              $.createUniqueKeyArray(numWrapAuthorities);

            // Derive PDA bumps
            const [, bump] = PublicKey.findProgramAddressSync(
              [Buffer.from("global")],
              $.ext.programId,
            );
            const [, mVaultBump] = PublicKey.findProgramAddressSync(
              [Buffer.from("m_vault")],
              $.ext.programId,
            );
            const [, extMintAuthorityBump] = PublicKey.findProgramAddressSync(
              [Buffer.from("mint_authority")],
              $.ext.programId,
            );

            // Ensure the global account has not been created yet
            const globalAccount = $.getExtGlobalAccount();
            $.expectAccountEmpty(globalAccount);

            // Get a random fee bps
            const feeBps = new BN(randomInt(10000));

            // Send the transaction
            await $.ext.methods
              .initialize(wrapAuthorities, feeBps)
              .accounts({
                admin: $.admin.publicKey,
                mMint: $.mMint.publicKey,
                extMint: $.extMint.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.admin])
              .rpc();

            // Check the state of the global account
            await $.expectExtGlobalState({
              admin: $.admin.publicKey,
              extMint: $.extMint.publicKey,
              mMint: $.mMint.publicKey,
              mEarnGlobalAccount: $.getEarnGlobalAccount(),
              bump,
              mVaultBump,
              extMintAuthorityBump,
              wrapAuthorities,
              yieldConfig: {
                yieldVariant: { scaledUi: {} },
                feeBps,
                lastMIndex: initialIndex,
                lastExtIndex: ONE,
              },
            });

            // Check the size of the global account based on the number of wrap authorities
            const expectedSize = 176 + 25 + wrapAuthorities.length * 32; // 176 bytes base size + 25 yield config size + 32 bytes per wrap authority
            const extGlobalSize = await $.provider.connection
              .getAccountInfo(globalAccount)
              .then((info) => info?.data.length || 0);
            expect(extGlobalSize).toEqual(expectedSize);

            // Check the state of the mint
            await $.expectScaledUiAmountConfig($.extMint.publicKey, {
              authority: $.getExtMintAuthority(),
              multiplier: 1.0,
              newMultiplierEffectiveTimestamp: BigInt(
                $.currentTime().toString(),
              ),
              newMultiplier: 1.0,
            });
          });
        }
      });

      describe("admin transfer unit tests", () => {
        const newAdmin = new Keypair();
        let wrapAuthorities: PublicKey[];

        beforeEach(async () => {
          wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];

          const feeBps =
            variant === Variant.NoYield ? new BN(0) : new BN(randomInt(10000));
          // Initialize the extension program
          await $.initializeExt(wrapAuthorities, feeBps);

          // Airdrop SOL to the new admin to pay for transactions
          $.svm.airdrop(newAdmin.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
        });

        describe("transfer_admin unit tests", () => {
          // given the admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("Non-admin tries to transfer admin - reverts", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .transferAdmin(newAdmin.publicKey)
                .accounts({
                  admin: $.nonAdmin.publicKey,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the admin signs the transaction
          // given the new admin is the same as current admin
          // it reverts with InvalidParam error
          test("Transfer admin to same admin - reverts", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .transferAdmin($.admin.publicKey)
                .accounts({
                  admin: $.admin.publicKey,
                })
                .signers([$.admin])
                .rpc(),
              "InvalidParam",
            );
          });

          // given the admin signs the transaction
          // given the new admin is different
          // it sets pending_admin to the new admin
          test("Transfer admin - success", async () => {
            // Transfer admin to newAdmin
            await $.ext.methods
              .transferAdmin(newAdmin.publicKey)
              .accounts({
                admin: $.admin.publicKey,
              })
              .signers([$.admin])
              .rpc();

            // Check that pending_admin is set correctly
            await $.expectExtGlobalState({
              admin: $.admin.publicKey,
              pendingAdmin: newAdmin.publicKey,
            });
          });
        });

        describe("accept_admin unit tests", () => {
          beforeEach(async () => {
            // Set up a pending admin transfer
            await $.transferAdmin(newAdmin.publicKey);
          });

          // given the pending admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("Wrong account tries to accept admin - reverts", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .acceptAdmin()
                .accounts({
                  pendingAdmin: $.nonAdmin.publicKey,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the pending admin signs the transaction
          // it transfers admin ownership and clears pending_admin
          test("Accept admin transfer - success", async () => {
            // Accept the admin transfer
            await $.acceptAdmin(newAdmin);

            // Check that admin is updated and pending_admin is cleared
            await $.expectExtGlobalState({
              admin: newAdmin.publicKey,
              pendingAdmin: null,
            });
          });
        });

        describe("revoke_admin_transfer unit tests", () => {
          // given there is no pending admin transfer
          // it reverts with InvalidParam error
          test("Revoke when no pending transfer - reverts", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .revokeAdminTransfer()
                .accounts({
                  admin: $.admin.publicKey,
                })
                .signers([$.admin])
                .rpc(),
              "InvalidParam",
            );
          });

          // given there is a pending admin transfer
          describe("with pending admin transfer", () => {
            beforeEach(async () => {
              // Set up a pending admin transfer
              await $.transferAdmin(newAdmin.publicKey);
            });

            // given the non-admin tries to revoke the transfer
            // it reverts with NotAuthorized error
            test("Non-admin tries to revoke transfer - reverts", async () => {
              await $.expectAnchorError(
                $.ext.methods
                  .revokeAdminTransfer()
                  .accounts({
                    admin: $.nonAdmin.publicKey,
                  })
                  .signers([$.nonAdmin])
                  .rpc(),
                "NotAuthorized",
              );
            });

            // given the admin revokes the transfer
            // it clears the pending_admin field
            test("Admin revokes transfer - success", async () => {
              // Verify there is a pending admin transfer
              await $.expectExtGlobalState({
                admin: $.admin.publicKey,
                pendingAdmin: newAdmin.publicKey,
              });

              // Revoke the admin transfer
              await $.revokeAdminTransfer();

              // Check that pending_admin is cleared
              await $.expectExtGlobalState({
                admin: $.admin.publicKey,
                pendingAdmin: null,
              });
            });

            // given the admin revokes the transfer
            // given the old pending admin tries to accept
            // it reverts with NotAuthorized error
            test("Cannot accept after revocation - reverts", async () => {
              // Revoke the admin transfer
              await $.revokeAdminTransfer();

              // Attempt to accept the revoked transfer
              await $.expectAnchorError(
                $.ext.methods
                  .acceptAdmin()
                  .accounts({
                    pendingAdmin: newAdmin.publicKey,
                  })
                  .signers([newAdmin])
                  .rpc(),
                "NotAuthorized",
              );
            });
          });
        });
      });

      describe("add_wrap_authority unit tests", () => {
        let wrapAuthorities: PublicKey[];

        beforeEach(async () => {
          wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];

          const feeBps =
            variant === Variant.NoYield ? new BN(0) : new BN(randomInt(10000));
          // Initialize the extension program
          await $.initializeExt(wrapAuthorities, feeBps);
        });

        // test cases
        // [X] given the admin does not sign the transaction
        //   [X] it reverts with a NotAuthorized error
        // [X] given the admin signs the transaction
        //   [X] given the new wrap authority is already in the list
        //     [X] it reverts with a InvalidParam error
        //   [X] given the new wrap authority is not in the list
        //     [X] it adds the new wrap authority to the list
        //     [X] it resizes the ext global account to accommodate the new wrap authority

        // given the admin does not sign the transaction
        // it reverts with a NotAuthorized error
        test("admin does not sign - reverts", async () => {
          // Attempt to send the transaction
          await $.expectAnchorError(
            $.ext.methods
              .addWrapAuthority($.nonWrapAuthority.publicKey)
              .accounts({
                admin: $.nonAdmin.publicKey,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "NotAuthorized",
          );
        });

        // given the admin signs the transaction
        // given the new wrap authority is already in the list
        // it reverts with a InvalidParam error
        test("new wrap authority already in the list - reverts", async () => {
          // Attempt to send the transaction
          await $.expectAnchorError(
            $.ext.methods
              .addWrapAuthority($.wrapAuthority.publicKey)
              .accounts({ admin: $.admin.publicKey })
              .signers([$.admin])
              .rpc(),
            "InvalidParam",
          );
        });

        // given the admin signs the transaction
        // given the new wrap authority is not in the list
        // it adds the new wrap authority to the list
        // it resizes the ext global account to accommodate the new wrap authority
        test("new wrap authority is not in the list - success", async () => {
          // Cache the size of the ext global account
          const extGlobalAccount = $.getExtGlobalAccount();
          const extGlobalSize = await $.provider.connection
            .getAccountInfo(extGlobalAccount)
            .then((info) => info?.data.length || 0);

          // Send the transaction
          await $.ext.methods
            .addWrapAuthority($.nonWrapAuthority.publicKey)
            .accounts({
              admin: $.admin.publicKey,
            })
            .signers([$.admin])
            .rpc();

          // Check that the wrap authority was added
          wrapAuthorities.push($.nonWrapAuthority.publicKey);

          await $.expectExtGlobalState({
            wrapAuthorities,
          });

          // Check that the ext global account was resized
          const newExtGlobalSize = await $.provider.connection
            .getAccountInfo(extGlobalAccount)
            .then((info) => info?.data.length || 0);
          expect(newExtGlobalSize).toEqual(extGlobalSize + 32); // 32 bytes for the new wrap authority
        });
      });

      describe("remove_wrap_authority unit tests", () => {
        let wrapAuthorities: PublicKey[];

        beforeEach(async () => {
          wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];

          const feeBps =
            variant === Variant.NoYield ? new BN(0) : new BN(randomInt(10000));
          // Initialize the extension program
          await $.initializeExt(wrapAuthorities, feeBps);
        });

        // test cases
        // [X] given the admin does not sign the transaction
        //   [X] it reverts with a NotAuthorized error
        // [X] given the admin signs the transaction
        //   [X] given the wrap authority is not in the list
        //     [X] it reverts with a InvalidParam error
        //   [X] given the wrap authority is in the list
        //     [X] it removes the wrap authority from the list
        //     [X] it resizes the ext global account down to accommodate the removed wrap authority

        // given the admin does not sign the transaction
        // it reverts with a NotAuthorized error
        test("admin does not sign - reverts", async () => {
          // Attempt to send the transaction
          await $.expectAnchorError(
            $.ext.methods
              .removeWrapAuthority($.wrapAuthority.publicKey)
              .accounts({
                admin: $.nonAdmin.publicKey,
              })
              .signers([$.nonAdmin])
              .rpc(),
            "NotAuthorized",
          );
        });

        // given the admin signs the transaction
        // given the wrap authority is not in the list
        // it reverts with a InvalidParam error
        test("wrap authority not in the list - reverts", async () => {
          // Attempt to send the transaction
          await $.expectAnchorError(
            $.ext.methods
              .removeWrapAuthority($.nonWrapAuthority.publicKey)
              .accounts({ admin: $.admin.publicKey })
              .signers([$.admin])
              .rpc(),
            "InvalidParam",
          );
        });

        // given the admin signs the transaction
        // given the wrap authority is in the list
        // it removes the wrap authority from the list
        // it resizes the ext global account down to accommodate the removed wrap authority
        test("wrap authority is in the list - success", async () => {
          // Cache the size of the ext global account
          const extGlobalAccount = $.getExtGlobalAccount();
          const extGlobalSize = await $.provider.connection
            .getAccountInfo(extGlobalAccount)
            .then((info) => info?.data.length || 0);

          // Send the transaction
          await $.ext.methods
            .removeWrapAuthority($.wrapAuthority.publicKey)
            .accounts({
              admin: $.admin.publicKey,
            })
            .signers([$.admin])
            .rpc();

          // Check that the wrap authority was added
          wrapAuthorities.pop();

          await $.expectExtGlobalState({
            wrapAuthorities,
          });

          // Check that the ext global account was resized
          const newExtGlobalSize = await $.provider.connection
            .getAccountInfo(extGlobalAccount)
            .then((info) => info?.data.length || 0);
          expect(newExtGlobalSize).toEqual(extGlobalSize - 32); // remove 32 bytes
        });
      });

      if (variant !== Variant.Crank) {
        describe("claim_fees unit tests", () => {
          // general test cases
          // [X] given the admin does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the admin signs the transaction
          //   [X] given the m vault is not the m vault PDA
          //     [X] it reverts with a ConstraintSeeds error
          //   [X] given the m vault token account is not the m vault PDA's ATA
          //     [X] it reverts with a ConstraintAssociated error
          //   [X] given the ext mint does not match the one on the global account
          //     [X] it reverts with an InvalidMint error
          //   [X] given the ext mint authority is not the ext mint authority PDA
          //     [X] it reverts with a ConstraintSeeds error
          //   [X] given the m earn global account does not match the derived PDA
          //     [X] it reverts with a ConstraintSeeds error
          //   [X] given the recipient token account is not a token account for the m mint
          //     [X] it reverts with a ConstraintTokenMint error
          //   [X] given the vault m token account is frozen (i.e. extension is not approved as an earner)
          //     [X] it reverts with a VaultFrozen error

          const initialWrappedAmount = new BN(10_000_000); // 10 with 6 decimals
          let wrapAuthorities: PublicKey[];
          const feeBps = new BN(randomInt(1, 10000)); // non-zero
          const startIndex = new BN(
            randomInt(initialIndex.toNumber() + 1, 2e12),
          );

          beforeEach(async () => {
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, feeBps);

            // Wrap some tokens from the admin to make the m vault's balance non-zero
            await $.wrap($.admin, initialWrappedAmount);

            // Propagate the start index
            await $.propagateIndex(startIndex);

            if (variant === Variant.ScaledUi) {
              // Sync the multiplier
              await $.sync();
            }
            // Reset the blockhash to avoid issues with duplicate transactions
            $.svm.expireBlockhash();
          });

          // given the admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("admin does not sign - reverts", async () => {
            const recipientExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.nonAdmin.publicKey,
                  recipientExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the m vault is not the m vault PDA
          // it reverts with a ConstraintSeeds error
          test("m vault is not the m vault PDA - reverts", async () => {
            // Change the m vault
            const mVault = PublicKey.unique();
            if (mVault === $.getMVault()) return;

            // Create the ATA for the fake m vault so we avoid account not initialized errors
            const mVaultATA = await $.getATA($.mMint.publicKey, mVault);

            const recipientExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  mVault,
                  vaultMTokenAccount: mVaultATA,
                  recipientExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given the m vault token account is not the m vault PDA's ATA
          // it reverts with a ConstraintAssociated error
          test("m vault token account is not the m vault PDA's ATA - reverts", async () => {
            // Create a token account for the M vault that is not the ATA
            const mVault = $.getMVault();
            const { tokenAccount: nonAtaAccount } = await $.createTokenAccount(
              $.mMint.publicKey,
              mVault,
              true,
              true,
            );

            const recipientExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  vaultMTokenAccount: nonAtaAccount,
                  recipientExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintAssociated",
            );
          });

          // given the ext mint does not match the one on the global account
          // it reverts with an InvalidMint error
          test("ext mint does not match global account - reverts", async () => {
            // Create a new mint
            const wrongMint = new Keypair();
            await $.createMint(
              wrongMint,
              $.nonAdmin.publicKey,
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
              6,
            );

            const recipientExtTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  extMint: wrongMint.publicKey,
                  recipientExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "InvalidMint",
            );
          });

          // given the ext mint authority is not the ext mint authority PDA
          // it reverts with a ConstraintSeeds error
          test("ext mint authority is not the ext mint authority PDA - reverts", async () => {
            // Change the ext mint authority
            const extMintAuthority = PublicKey.unique();
            if (extMintAuthority === $.getExtMintAuthority()) return;

            const recipientExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );
            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  extMintAuthority,
                  recipientExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given the recipient token account is not a token account for the ext mint
          // it reverts with a ConstraintTokenMint error
          test("recipient token account is not for ext mint - reverts", async () => {
            // Create a token account for the m mint
            const wrongTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.admin.publicKey,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: wrongTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given the vault m token account is frozen (i.e. extension is not approved as an earner)
          // it reverts with a VaultFrozen error
          test("vault m token account is frozen - reverts", async () => {
            // Remove the vault as an M earner to freeze it
            await $.removeMEarner($.getMVault());

            await $.expectAnchorError(
              $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    $.admin.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "VaultFrozen",
            );
          });

          // yield variant test cases
          //   [X] given all the accounts are correct
          //     [X] given the multiplier is not synced
          //       [X] it syncs the multiplier to the current
          //       [X] given the m vault has excess collateral
          //         [X] it transfers the excess collateral to the recipient token account
          //       [X] given the m vault does not have excess collateral
          //         [X] it reverts with an InsufficientCollateral error
          //     [X] given the multiplier is already synced
          //       [X] given the m vault has excess collateral
          //         [X] it transfers the excess collateral to the recipient token account
          //       [X] given the m vault does not have excess collateral
          //         [X] it completes but doesn't transfer any tokens

          if (variant === Variant.ScaledUi) {
            // given all accounts are correct
            // given the multiplier is not synced
            // it syncs the multiplier to the current
            // given the m vault has excess collateral
            // it transfers the excess collateral to the recipient token account
            test("multiplier not synced, excess collateral exists - success", async () => {
              // warp forward in time slightly
              $.warp(new BN(60), true);

              // Propagate a new index to create a situation where multiplier needs sync
              const newIndex = new BN(
                randomInt(startIndex.toNumber() + 1, 2e12),
              );
              await $.propagateIndex(newIndex);
              const mVault = $.getMVault();
              const mVaultATA = await $.getATA($.mMint.publicKey, mVault);

              // Cache balances before claim excess
              const initialVaultBalance = await $.getTokenBalance(mVaultATA);
              const initialVaultUiBalance = await $.getTokenUiBalance(
                mVaultATA,
              );
              const recipientATA = await $.getATA(
                $.extMint.publicKey,
                $.admin.publicKey,
                $.useToken2022ForExt,
              );

              // Get the new multiplier calculate the expected excess
              const multiplier = await $.getNewMultiplier(newIndex);

              const initialRecipientPrincipal = await $.getTokenBalance(
                recipientATA,
                $.useToken2022ForExt,
              );
              const initialRecipientBalance = await $.getTokenUiBalance(
                recipientATA,
                multiplier,
              );

              const extSupply = await getMint(
                $.provider.connection,
                $.extMint.publicKey,
                undefined,
                $.extTokenProgram,
              ).then((mint) => mint.supply);

              const requiredCollateral = new BN(
                Math.ceil(Number(extSupply) * multiplier),
              );

              const expectedExcess =
                initialVaultUiBalance.sub(requiredCollateral);
              const expectedExcessPrincipal = new BN(
                Math.floor(Number(expectedExcess) / multiplier),
              );

              // Setup and execute the instruction
              await $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: recipientATA,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc();

              // Verify multiplier was updated

              await $.expectScaledUiAmountConfig($.extMint.publicKey, {
                authority: $.getExtMintAuthority(),
                multiplier,
                newMultiplier: multiplier,
                newMultiplierEffectiveTimestamp: BigInt(
                  $.currentTime().toString(),
                ),
              });

              // Verify excess tokens were transferred

              $.expectTokenBalance(mVaultATA, initialVaultBalance);
              $.expectTokenUiBalance(
                recipientATA,
                initialRecipientBalance.add(expectedExcess),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
              $.expectTokenBalance(
                recipientATA,
                initialRecipientPrincipal.add(expectedExcessPrincipal),
              );
            });

            // given all accounts are correct
            // given the multiplier is already synced
            // given the m vault has excess collateral
            // it transfers the excess collateral to the recipient token account
            test("multiplier already synced, excess collateral exists - success", async () => {
              // Cache balances before claim excess
              const mVaultATA = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
              );
              const initialVaultBalance = await $.getTokenBalance(mVaultATA);
              const initialVaultUiBalance = await $.getTokenUiBalance(
                mVaultATA,
              );
              const recipientATA = await $.getATA(
                $.extMint.publicKey,
                $.admin.publicKey,
                $.useToken2022ForExt,
              );

              // Get the current multiplier and calculate the $.expected excess
              const multiplier = await $.getCurrentMultiplier();
              const initialRecipientBalance = await $.getTokenUiBalance(
                recipientATA,
                multiplier,
              );
              const initialRecipientPrincipal = await $.getTokenBalance(
                recipientATA,
                $.useToken2022ForExt,
              );

              const extSupply = await getMint(
                $.provider.connection,
                $.extMint.publicKey,
                undefined,
                $.extTokenProgram,
              ).then((mint) => mint.supply);

              const requiredCollateral = new BN(
                Math.ceil(Number(extSupply) * multiplier),
              );

              const expectedExcess =
                initialVaultUiBalance.sub(requiredCollateral);
              const expectedExcessPrincipal = new BN(
                Math.floor(Number(expectedExcess) / multiplier),
              );

              await $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: recipientATA,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc();

              // Verify excess tokens were transferred
              $.expectTokenBalance(mVaultATA, initialVaultBalance);
              $.expectTokenUiBalance(
                recipientATA,
                initialRecipientBalance.add(expectedExcess),
                Comparison.LessThanOrEqual,
                new BN(1),
              );
              $.expectTokenBalance(
                recipientATA,
                initialRecipientPrincipal.add(expectedExcessPrincipal),
              );
            });

            // given all accounts are correct
            // given the multiplier is already synced
            // given the m vault does not have excess collateral
            // it completes successfully and does not transfer any tokens
            test("multiplier already synced, no excess collateral - success", async () => {
              // claim the existing excess so there isn't extra
              await $.claimFees();
              $.svm.expireBlockhash();

              // Cache balances before claim excess
              const mVaultATA = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
              );
              const initialVaultBalance = await $.getTokenBalance(mVaultATA);
              const recipientATA = await $.getATA(
                $.extMint.publicKey,
                $.admin.publicKey,
                $.useToken2022ForExt,
              );
              const initialRecipientBalance = await $.getTokenBalance(
                recipientATA,
                $.useToken2022ForExt,
              );

              // Attempt to send the transaction
              await $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: recipientATA,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc();

              // Verify no tokens were transferred
              $.expectTokenBalance(mVaultATA, initialVaultBalance);
              $.expectTokenBalance(
                recipientATA,
                initialRecipientBalance,
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
            });
          }

          // no yield test cases
          //   [X] given all the accounts are correct
          //     [X] given the m vault has excess collateral
          //       [X] it transfers the excess collateral to the recipient token account
          //     [X] given the m vault does not have excess collateral
          //       [X] it completes but doesn't transfer any tokens
          if (variant === Variant.NoYield) {
            // given all accounts are correct
            // given the m vault has excess collateral
            // it transfers the excess collateral to the recipient token account
            test("excess collateral exists - success", async () => {
              // Cache balances before claim excess
              const mVaultATA = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
              );
              const initialVaultBalance = await $.getTokenBalance(mVaultATA);
              const initialVaultUiBalance = await $.getTokenUiBalance(
                mVaultATA,
              );
              const recipientATA = await $.getATA(
                $.extMint.publicKey,
                $.admin.publicKey,
                $.useToken2022ForExt,
              );
              const initialRecipientBalance = await $.getTokenBalance(
                recipientATA,
                $.useToken2022ForExt,
              );

              const extSupply = await getMint(
                $.provider.connection,
                $.extMint.publicKey,
                undefined,
                $.extTokenProgram,
              ).then((mint) => mint.supply);

              const expectedExcess = initialVaultUiBalance.sub(
                new BN(extSupply.toString()),
              );

              await $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: recipientATA,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc();

              // Verify excess tokens were transferred
              $.expectTokenBalance(mVaultATA, initialVaultBalance);
              $.expectTokenBalance(
                recipientATA,
                initialRecipientBalance.add(expectedExcess),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
            });

            // given all accounts are correct
            // given the m vault does not have excess collateral
            // it completes successfully and does not transfer any tokens
            test("no excess collateral - success", async () => {
              // claim the existing excess so there isn't extra
              await $.claimFees();
              $.svm.expireBlockhash();

              // Cache balances before claim excess
              const mVaultATA = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
              );
              const initialVaultBalance = await $.getTokenBalance(mVaultATA);
              const recipientATA = await $.getATA(
                $.extMint.publicKey,
                $.admin.publicKey,
                $.useToken2022ForExt,
              );
              const initialRecipientBalance = await $.getTokenBalance(
                recipientATA,
                $.useToken2022ForExt,
              );

              // Attempt to send the transaction
              await $.ext.methods
                .claimFees()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  recipientExtTokenAccount: recipientATA,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc();

              // Verify no tokens were transferred
              $.expectTokenBalance(mVaultATA, initialVaultBalance);
              $.expectTokenBalance(
                recipientATA,
                initialRecipientBalance,
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
            });
          }
        });
      }

      if (variant !== Variant.Crank) {
        describe("delegated claim unit tests", () => {
          const initialWrappedAmount = new BN(10_000_000);
          const feeBps = new BN(randomInt(1, 10000));
          const startIndex = new BN(
            randomInt(initialIndex.toNumber() + 1, 2e12),
          );
          let bot: Keypair;
          let recipient: PublicKey;

          const balanceOf = (tokenAccount: PublicKey) =>
            $.getTokenBalance(tokenAccount, $.useToken2022ForExt);

          const ataOf = (owner: PublicKey) =>
            $.getATA($.extMint.publicKey, owner, $.useToken2022ForExt);

          beforeEach(async () => {
            await $.initializeExt(
              [$.admin.publicKey, $.wrapAuthority.publicKey],
              feeBps,
            );
            await $.wrap($.admin, initialWrappedAmount);
            await $.propagateIndex(startIndex);
            if (variant === Variant.ScaledUi) {
              await $.sync();
            }

            bot = new Keypair();
            $.svm.airdrop(bot.publicKey, BigInt(LAMPORTS_PER_SOL));
            recipient = await ataOf($.nonAdmin.publicKey);
            $.svm.expireBlockhash();
          });

          describe("set_claim_config unit tests", () => {
            test("admin does not sign - reverts", async () => {
              await $.expectAnchorError(
                $.setClaimConfig(bot.publicKey, recipient, $.nonAdmin),
                "NotAuthorized",
              );
            });

            test("recipient is not an ext token account - reverts", async () => {
              const otherMint = new Keypair();
              await $.createMint(
                otherMint,
                $.admin.publicKey,
                null,
                $.useToken2022ForExt,
                6,
              );
              const otherTokenAccount = await $.getATA(
                otherMint.publicKey,
                $.nonAdmin.publicKey,
                $.useToken2022ForExt,
              );

              await $.expectAnchorError(
                $.setClaimConfig(bot.publicKey, otherTokenAccount),
                "ConstraintTokenMint",
              );
            });

            test("creates the config - success", async () => {
              await $.setClaimConfig(bot.publicKey, recipient);

              const config = await $.ext.account.claimConfig.fetch(
                $.getClaimConfigAccount(),
              );
              expect(config.claimAuthority).toEqual(bot.publicKey);
              expect(config.recipientTokenAccount).toEqual(recipient);
            });

            test("overwrites both fields - success", async () => {
              await $.setClaimConfig(bot.publicKey, recipient);
              const newBot = Keypair.generate().publicKey;
              const newRecipient = await ataOf($.admin.publicKey);

              await $.setClaimConfig(newBot, newRecipient);

              const config = await $.ext.account.claimConfig.fetch(
                $.getClaimConfigAccount(),
              );
              expect(config.claimAuthority).toEqual(newBot);
              expect(config.recipientTokenAccount).toEqual(newRecipient);
            });
          });

          describe("remove_claim_config unit tests", () => {
            beforeEach(async () => {
              await $.setClaimConfig(bot.publicKey, recipient);
              $.svm.expireBlockhash();
            });

            test("admin does not sign - reverts", async () => {
              await $.expectAnchorError(
                $.removeClaimConfig($.nonAdmin),
                "NotAuthorized",
              );
            });

            test("closes the config and refunds the admin - success", async () => {
              const before = $.svm.getBalance($.admin.publicKey)!;

              await $.removeClaimConfig();

              $.expectAccountEmpty($.getClaimConfigAccount());
              expect($.svm.getBalance($.admin.publicKey)! > before).toBe(true);
            });

            test("recreates the config after removal - success", async () => {
              await $.removeClaimConfig();

              await $.setClaimConfig(bot.publicKey, recipient);

              const config = await $.ext.account.claimConfig.fetch(
                $.getClaimConfigAccount(),
              );
              expect(config.claimAuthority).toEqual(bot.publicKey);
            });
          });

          describe("claim_fees_delegated unit tests", () => {
            test("no config - reverts", async () => {
              await $.expectAnchorError(
                $.claimFeesDelegated(bot, recipient),
                "AccountNotInitialized",
              );
            });

            describe("with config", () => {
              beforeEach(async () => {
                await $.setClaimConfig(bot.publicKey, recipient);
                $.svm.expireBlockhash();
              });

              test("claim authority claims all excess - success", async () => {
                const before = await balanceOf(recipient);

                await $.claimFeesDelegated(bot, recipient);

                const after = await balanceOf(recipient);
                expect(after.gt(before)).toBe(true);

                const adminATA = await ataOf($.admin.publicKey);
                const adminBefore = await balanceOf(adminATA);
                await $.claimFees(adminATA);
                expect((await balanceOf(adminATA)).eq(adminBefore)).toBe(true);
              });

              test("repeat claim at the same index mints nothing - success", async () => {
                await $.claimFeesDelegated(bot, recipient);
                $.svm.expireBlockhash();
                const before = await balanceOf(recipient);

                await $.claimFeesDelegated(bot, recipient);

                expect((await balanceOf(recipient)).eq(before)).toBe(true);
              });

              test("signer is not the claim authority - reverts", async () => {
                await $.expectAnchorError(
                  $.claimFeesDelegated($.nonAdmin, recipient),
                  "NotAuthorized",
                );
              });

              test("admin is not the claim authority - reverts", async () => {
                await $.expectAnchorError(
                  $.claimFeesDelegated($.admin, recipient),
                  "NotAuthorized",
                );
              });

              test("rotated authority - old reverts, new succeeds", async () => {
                const newBot = new Keypair();
                $.svm.airdrop(newBot.publicKey, BigInt(LAMPORTS_PER_SOL));
                await $.setClaimConfig(newBot.publicKey, recipient);

                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, recipient),
                  "NotAuthorized",
                );
                await $.claimFeesDelegated(newBot, recipient);
              });

              test("config removed - reverts", async () => {
                await $.removeClaimConfig();

                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, recipient),
                  "AccountNotInitialized",
                );
              });

              test("recipient is not the configured one - reverts", async () => {
                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, await ataOf(bot.publicKey)),
                  "InvalidAccount",
                );
              });

              test("recipient is not an ext token account - reverts", async () => {
                const mTokenAccount = await $.getATA(
                  $.mMint.publicKey,
                  $.nonAdmin.publicKey,
                );

                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, mTokenAccount),
                  "InvalidAccount",
                );
              });

              test("recipient changed - old reverts, new succeeds", async () => {
                const newRecipient = await ataOf($.admin.publicKey);
                await $.setClaimConfig(bot.publicKey, newRecipient);

                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, recipient),
                  "InvalidAccount",
                );
                const before = await balanceOf(newRecipient);
                await $.claimFeesDelegated(bot, newRecipient);
                expect((await balanceOf(newRecipient)).gt(before)).toBe(true);
              });

              test("recipient frozen after setup - reverts", async () => {
                await $.freezeTokenAccount(
                  recipient,
                  $.extMint.publicKey,
                  $.admin,
                  $.useToken2022ForExt,
                );

                await $.expectSystemError($.claimFeesDelegated(bot, recipient));
              });

              test("vault m token account is frozen - reverts", async () => {
                await $.removeMEarner($.getMVault());

                await $.expectAnchorError(
                  $.claimFeesDelegated(bot, recipient),
                  "VaultFrozen",
                );
              });

              test("admin claim_fees still pays any recipient - success", async () => {
                const other = await ataOf(bot.publicKey);
                const before = await balanceOf(other);

                await $.claimFees(other);

                expect((await balanceOf(other)).gt(before)).toBe(true);
              });

              test("config survives admin transfer, only new admin can change it", async () => {
                const newAdmin = new Keypair();
                $.svm.airdrop(newAdmin.publicKey, BigInt(LAMPORTS_PER_SOL));
                await $.transferAdmin(newAdmin.publicKey);
                await $.acceptAdmin(newAdmin);

                await $.claimFeesDelegated(bot, recipient);
                await $.expectAnchorError(
                  $.setClaimConfig(bot.publicKey, recipient),
                  "NotAuthorized",
                );
                await $.setClaimConfig(bot.publicKey, recipient, newAdmin);
              });
            });
          });
        });
      }

      if (variant === Variant.ScaledUi) {
        describe("set_fee unit tests", () => {
          // yield variant test cases
          // [X] given the admin does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the admin signs the transaction
          //   [X] given the ext mint does not match the one on the global account
          //     [X] it reverts with an InvalidMint error
          //   [X] given the ext mint authority is not the ext mint authority PDA
          //     [X] it reverts with a ConstraintSeeds error
          //   [X] given all the accounts are correct
          //     [X] given the multiplier is not synced
          //       [X] it syncs the multiplier to the last claimed index
          //       [X] it updates the fee bps
          //     [X] given the multiplier is already synced
          //       [X] it updates the fee bps

          const initialWrappedAmount = new BN(10_000_000); // 10 with 6 decimals
          let wrapAuthorities: PublicKey[];
          const feeBps = new BN(randomInt(1, 10000)); // non-zero
          const startIndex = new BN(
            randomInt(initialIndex.toNumber() + 1, 2e12),
          );

          beforeEach(async () => {
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, feeBps);

            // Wrap some tokens from the admin to make the m vault's balance non-zero
            await $.wrap($.admin, initialWrappedAmount);

            // Propagate the start index
            await $.propagateIndex(startIndex);

            // Sync the multiplier
            await $.sync();

            // Reset the blockhash to avoid issues with duplicate transactions
            $.svm.expireBlockhash();
          });

          // given the admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("admin does not sign - reverts", async () => {
            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .setFee(new BN(randomInt(10000)))
                .accountsPartial({
                  admin: $.nonAdmin.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the admin signs the transaction

          // given the ext mint does not match the one on the global account
          // it reverts with an InvalidMint error
          test("ext mint does not match global account - reverts", async () => {
            // Create a new mint
            const wrongMint = new Keypair();
            await $.createMint(
              wrongMint,
              $.nonAdmin.publicKey,
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
              6,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .setFee(new BN(randomInt(10000)))
                .accountsPartial({
                  admin: $.admin.publicKey,
                  extMint: wrongMint.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "InvalidMint",
            );
          });

          // given the ext mint authority is not the ext mint authority PDA
          // it reverts with a ConstraintSeeds error
          test("ext mint authority is not the ext mint authority PDA - reverts", async () => {
            // Change the ext mint authority
            const extMintAuthority = PublicKey.unique();
            if (extMintAuthority === $.getExtMintAuthority()) return;

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .setFee(new BN(randomInt(10000)))
                .accountsPartial({
                  admin: $.admin.publicKey,
                  extMintAuthority,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given all the accounts are correct
          // given the multiplier is not synced
          // it syncs the multiplier to the last claimed index
          // it updates the fee bps
          test("multiplier not synced - success", async () => {
            // warp forward in time slightly
            $.warp(new BN(60), true);

            // Propagate a new index to create a situation where multiplier needs sync
            const newIndex = new BN(randomInt(startIndex.toNumber() + 1, 2e12));
            await $.propagateIndex(newIndex);

            // Get the new multiplier
            const multiplier = await $.getNewMultiplier(newIndex);

            // Setup and execute the instruction
            const newFee = new BN(randomInt(10000));
            await $.ext.methods
              .setFee(newFee)
              .accountsPartial({
                admin: $.admin.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.admin])
              .rpc();

            // Verify multiplier was updated
            await $.expectScaledUiAmountConfig($.extMint.publicKey, {
              authority: $.getExtMintAuthority(),
              multiplier,
              newMultiplier: multiplier,
              newMultiplierEffectiveTimestamp: BigInt(
                $.currentTime().toString(),
              ),
            });

            // Verify fee bps was updated
            await $.expectExtGlobalState({
              yieldConfig: {
                feeBps: newFee,
                lastExtIndex: new BN(Math.floor(multiplier * 1e12)),
                lastMIndex: newIndex,
              },
            });
          });

          // given all the accounts are correct
          // given the multiplier is already synced
          // it updates the fee bps
          test("multiplier already synced - success", async () => {
            // Cache the current multiplier
            const multiplier = await $.getCurrentMultiplier();

            // Setup and execute the instruction
            const newFee = new BN(randomInt(10000));
            await $.ext.methods
              .setFee(newFee)
              .accountsPartial({
                admin: $.admin.publicKey,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.admin])
              .rpc();

            // Verify fee bps was updated
            await $.expectExtGlobalState({
              yieldConfig: {
                feeBps: newFee,
                lastExtIndex: new BN(Math.floor(multiplier * 1e12)),
                lastMIndex: startIndex,
              },
            });
          });
        });
      }

      if (variant === Variant.Crank) {
        describe("set_earn_authority unit tests", () => {
          // test cases
          //   [X] given the admin signs the transaction
          //      [X] the earn authority is updated
          //   [X] given a non-admin signs the transaction
          //      [X] the transaction reverts with a not authorized error
          let wrapAuthorities: PublicKey[];

          beforeEach(async () => {
            // Initialize the program
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, undefined);
          });

          test("Admin can set new earn authority", async () => {
            // Setup new earn authority
            const newEarnAuthority = new Keypair();

            // Send the transaction
            await $.ext.methods
              .setEarnAuthority(newEarnAuthority.publicKey)
              .accounts({
                admin: $.admin.publicKey,
              })
              .signers([$.admin])
              .rpc();

            // Verify the global state was updated
            await $.expectExtGlobalState({
              yieldConfig: {
                earnAuthority: newEarnAuthority.publicKey,
              },
            });
          });

          test("Non-admin cannot set earn authority", async () => {
            // Attempt to set new earn authority with non-admin
            const newEarnAuthority = new Keypair();

            await $.expectAnchorError(
              $.ext.methods
                .setEarnAuthority(newEarnAuthority.publicKey)
                .accounts({
                  admin: $.nonAdmin.publicKey,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });
        });

        describe("add_earn_manager unit tests", () => {
          // test cases
          // [X] given the admin doesn't sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the admin does sign the transaction
          //   [X] given the fee token account is for the wrong mint
          //     [X] it reverts with a ConstraintTokenMint error
          //   [X] given the fee is higher than 100%
          //     [X] it reverts with an InvalidParam error
          //   [X] given all the accounts and inputs are correct
          //     [X] it initializes an EarnManager account with
          //       [X] the earn manager key
          //       [X] is_active flag set to true
          //       [X] fee_bps that was input
          //       [X] fee_token_account that was provided
          //       [X] the account's bump
          //   [X] given the account already exists
          //     [X] it sets the account data again

          let wrapAuthorities: PublicKey[];
          const earnManagerOne = new Keypair();
          const earnManagerTwo = new Keypair();

          beforeEach(async () => {
            // Initialize the program
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, undefined);
          });

          // given the admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("admin does not sign transaction - reverts", async () => {
            // Get the ATA for the earn manager
            const earnManagerATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // expect a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .addEarnManager(earnManagerOne.publicKey, new BN(100))
                .accountsPartial({
                  admin: $.nonAdmin.publicKey,
                  feeTokenAccount: earnManagerATA,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the admin does sign the transaction
          // given the fee token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("fee_token_account is for the wrong mint - reverts", async () => {
            // Create an ATA for the wrong mint
            const wrongMint = Keypair.generate();
            await $.createMint(wrongMint, $.admin.publicKey, $.admin.publicKey);
            const wrongATA = await $.getATA(
              wrongMint.publicKey,
              earnManagerOne.publicKey,
            );

            // Attempt to send the transaction
            // expect a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .addEarnManager(earnManagerOne.publicKey, new BN(100))
                .accountsPartial({
                  admin: $.admin.publicKey,
                  feeTokenAccount: wrongATA,
                })
                .signers([$.admin])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given the admin does sign the transcation
          // given the fee token account is frozen
          // it reverts with an InvalidAccount error
          test("fee_token_account is frozen - reverts", async () => {
            const earnManagerATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Freeze the account
            await $.freezeTokenAccount(
              earnManagerATA,
              $.extMint.publicKey,
              $.admin,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            await $.expectAnchorError(
              $.ext.methods
                .addEarnManager(earnManagerOne.publicKey, new BN(100))
                .accountsPartial({
                  admin: $.admin.publicKey,
                  feeTokenAccount: earnManagerATA,
                })
                .signers([$.admin])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the admin does sign the transaction
          // given the fee is higher than 100% (in basis points)
          // it reverts with an InvalidParam error
          test("fee higher than 100% - reverts", async () => {
            const feeBps = new BN(randomInt(10001, 2 ** 48 - 1));

            // Attempt to send the instruction
            await $.expectAnchorError(
              $.ext.methods
                .addEarnManager(earnManagerOne.publicKey, feeBps)
                .accountsPartial({
                  admin: $.admin.publicKey,
                  feeTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                })
                .signers([$.admin])
                .rpc(),
              "InvalidParam",
            );
          });

          // given the admin does sign the transaction
          // given all the accounts are correct
          // it initializes the earn manager account and sets its data
          test("add_earn_manager - success", async () => {
            // Setup the instruction
            const feeBps = new BN(randomInt(0, 10000));
            const earnManagerATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Send the transaction
            await $.ext.methods
              .addEarnManager(earnManagerOne.publicKey, feeBps)
              .accountsPartial({
                admin: $.admin.publicKey,
                feeTokenAccount: earnManagerATA,
              })
              .signers([$.admin])
              .rpc();

            const [earnManagerAccount, bump] = PublicKey.findProgramAddressSync(
              [
                Buffer.from("earn_manager"),
                earnManagerOne.publicKey.toBuffer(),
              ],
              $.ext.programId,
            );

            // Check that the state has been updated
            $.expectEarnManagerState(earnManagerAccount, {
              earnManager: earnManagerOne.publicKey,
              isActive: true,
              feeBps,
              feeTokenAccount: earnManagerATA,
              bump,
            });
          });

          // given admin does sign the transaction
          // given the account already exists
          // it sets the data again
          test("add_earn_manager again - success", async () => {
            // Add earn manager initially
            await $.addEarnManager(earnManagerOne.publicKey, new BN(100));

            // Add the earn manager again with a new fee and fee token account
            const newFeeTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerTwo.publicKey,
              $.useToken2022ForExt,
            );
            const feeBps = new BN(10);
            await $.addEarnManager(
              earnManagerOne.publicKey,
              feeBps,
              newFeeTokenAccount,
            );

            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            $.expectEarnManagerState(earnManagerAccount, {
              earnManager: earnManagerOne.publicKey,
              isActive: true,
              feeBps,
              feeTokenAccount: newFeeTokenAccount,
            });
          });
        });

        describe("remove_earn_manager unit tests", () => {
          // test cases
          // [X] given the admin does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the admin does sign the transaction
          //   [X] it sets the is_active flag on the earn manager account to false
          let wrapAuthorities: PublicKey[];
          const earnManagerOne = new Keypair();
          const earnManagerTwo = new Keypair();

          beforeEach(async () => {
            // Initialize the program
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, undefined);

            // Add an earn manager that can be removed
            await $.addEarnManager(earnManagerOne.publicKey, new BN(0));
          });

          // given the admin does not sign the transaction
          // it reverts with a NotAuthorized error
          test("admin does not sign the transaction - reverts", async () => {
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Attempt to send the transaction
            // Expect a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .removeEarnManager()
                .accountsPartial({
                  admin: $.nonAdmin.publicKey,
                  earnManagerAccount,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the admin does sign the transaction
          // given the earn manager account is not initialized
          // it reverts with an AccountNotInitialized error
          test("earn_manager_account not initialized - reverts", async () => {
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerTwo.publicKey,
            );

            // Attempt to send the transaction
            // Expect an AccountNotInitialized error
            await $.expectAnchorError(
              $.ext.methods
                .removeEarnManager()
                .accountsPartial({
                  admin: $.admin.publicKey,
                  earnManagerAccount,
                })
                .signers([$.admin])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given the admin does sign the transaction
          // it sets the is_active flag on the earn manager account to false
          test("remove_earn_manager - success", async () => {
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Confirm that the account is currently active
            $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
            });

            // Send the instruction
            await $.ext.methods
              .removeEarnManager()
              .accountsPartial({
                admin: $.admin.publicKey,
                earnManagerAccount,
              })
              .signers([$.admin])
              .rpc();

            // Confirm the account is not active
            $.expectEarnManagerState(earnManagerAccount, {
              isActive: false,
            });
          });
        });
      }
    });

    describe("wrap_authority instruction tests", () => {
      const mintAmount = new BN(100_000_000); // 100 with 6 decimals
      const initialWrappedAmount = new BN(100_000_000); // 100 with 6 decimals

      let wrapAuthorities: PublicKey[];
      const feeBps = new BN(randomInt(10000));

      const startIndex = new BN(randomInt(initialIndex.toNumber() + 1, 2e12));

      let vaultMTokenAccount: PublicKey;

      // Setup accounts with M tokens so we can test wrapping and unwrapping
      beforeEach(async () => {
        wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];
        vaultMTokenAccount = await $.getATA($.mMint.publicKey, $.getMVault());

        // Initialize the extension program
        await $.initializeExt(wrapAuthorities, feeBps);

        // Add the wrap authority and non-wrap authority as M earners to have thawed token accounts
        await $.addMEarner($.wrapAuthority.publicKey);
        await $.addMEarner($.nonWrapAuthority.publicKey);

        // Mint M tokens to a wrap authority and a non-wrap authority
        await $.mintM($.wrapAuthority.publicKey, mintAmount);
        await $.mintM($.nonWrapAuthority.publicKey, mintAmount);

        // Wrap some tokens from the admin to the make the m vault's balance non-zero
        await $.wrap($.admin, initialWrappedAmount);

        // Propagate the start index
        await $.propagateIndex(startIndex);

        // Sync the scaled ui multiplier with the m index
        if (variant === Variant.ScaledUi) {
          await $.sync();
        }

        // Claim excess tokens to make it easier to test collateral checks
        try {
          await $.claimFees();
        } catch (e) {
          // Ignore the error if there are no excess tokens
        }
      });

      describe("wrap unit tests", () => {
        let fromMTokenAccount: PublicKey;
        let toExtTokenAccount: PublicKey;

        beforeEach(async () => {
          fromMTokenAccount = await $.getATA(
            $.mMint.publicKey,
            $.wrapAuthority.publicKey,
          );
          toExtTokenAccount = await $.getATA(
            $.extMint.publicKey,
            $.wrapAuthority.publicKey,
            $.useToken2022ForExt,
          );
        });

        describe("index same as start", () => {
          // test cases
          // [X] given the m mint account does not match the one stored in the global account
          //   [X] it reverts with an InvalidAccount error
          // [X] given the ext mint account does not match the one stored in the global account
          //   [X] it reverts with an InvalidAccount error
          // [X] given the signer is not the authority on the from m token account and is not delegated by the owner
          //   [X] it reverts with a ConstraintTokenOwner error
          // [X] given the vault M token account is not the M Vaults ATA for the M token mint
          //   [X] it reverts with a ConstraintAssociated error
          // [X] given the from m token account is for the wrong mint
          //   [X] it reverts with a ConstraintTokenMint error
          // [X] given the to ext token account is for the wrong mint
          //   [X] it reverts with a ConstraintTokenMint error
          // [X] given a wrap authority is not provided
          //   [X] given the token authority is not in the wrap authorities list
          //     [X] it reverts with a NotAuthorized error
          //   [X] given the token authority is on the wrap authorities list
          //     [X] given the user does not have enough M tokens
          //       [X] it reverts with a ? error
          //     [X] given the user has enough M tokens
          //       [X] given the token authority is not the owner of the from M token account, but is delegated
          //         [X] it transfers the amount of M tokens from the user's M token account to the M vault token account
          //       [X] given the token authority is the owner of the from M token account
          //         [X] it transfers the amount of M tokens from the user's M token account to the M vault token account
          //       [X] it mints the amount of ext tokens to the user's ext token account
          //       [X] given the user wraps and then unwraps (roundtrip)
          //         [X] the starting balance and ending balance of the user's M token account are the same (within rounding error)
          // [X] given a wrap authority is provided
          //   [X] given the wrap authority is not in the wrap authorities list
          //     [X] it reverts with a NotAuthorized error
          //   [X] given the wrap authority is in the wrap authorities list
          //     [X] given the user does not have enough M tokens
          //       [X] it reverts with a ? error
          //     [X] given the user has enough M tokens
          //       [X] given the token authority is not the owner of the from M token account, but is delegated
          //         [X] it transfers the amount of M tokens from the user's M token account to the M vault token account
          //       [X] given the token authority is the owner of the from M token account
          //         [X] it transfers the amount of M tokens from the user's M token account to the M vault token account
          //       [X] it mints the amount of ext tokens to the user's ext token account
          //       [X] given the user wraps and then unwraps (roundtrip)
          //         [X] the starting balance and ending balance of the user's M token account are the same (within rounding error)

          // given the m mint account does not match the one stored in the global account
          // it reverts with an InvalidAccount error
          test("M mint account does not match global account - reverts", async () => {
            const wrongMint = Keypair.generate();
            await $.createMint(
              wrongMint,
              $.wrapAuthority.publicKey,
              $.admin.publicKey,
              true,
              6,
            );

            fromMTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.wrapAuthority.publicKey,
            );
            vaultMTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.getMVault(),
            );

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  mMint: wrongMint.publicKey,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  vaultMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the ext mint account does not match the one stored in the global account
          // it reverts with an InvalidAccount error
          test("Ext mint account does not match global account - reverts", async () => {
            const wrongMint = Keypair.generate();
            await $.createMint(
              wrongMint,
              $.wrapAuthority.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
              6,
            );

            toExtTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.wrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  extMint: wrongMint.publicKey,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the signer is not the authority on the user M token account and is not delegated
          // it reverts with a ConstraintTokenOwner error
          test("Token authority is not the authority on the from M token account and is not delegated - reverts", async () => {
            // Get the ATA for another user
            fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Attempt to send the transaction
            // Expect revert with TokenOwner error
            await $.expectSystemError(
              $.ext.methods
                .wrap(mintAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
            );
          });

          // given the M vault token account is not the M vault PDA's ATA
          // it reverts with a ConstraintAssociated error
          test("M Vault Token account is the the M Vault PDA's ATA (other token account) - reverts", async () => {
            // Create a token account for the M vault that is not the ATA
            const mVault = $.getMVault();
            const { tokenAccount: vaultMTokenAccount } =
              await $.createTokenAccount($.mMint.publicKey, mVault, true, true);

            // Attempt to send the transaction
            // Expect revert with a ConstraintAssociated error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  vaultMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintAssociated",
            );
          });

          // given the from m token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("From M token account is for wrong mint - reverts", async () => {
            // Attempt to send the transaction
            // Expect revert with a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount: toExtTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given the to ext token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("To Ext token account is for the wrong mint - reverts", async () => {
            // Attempt to send the transaction
            // Expect revert with a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  toExtTokenAccount: fromMTokenAccount,
                  fromMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given a wrap authority is not provided
          // given the token authority is not in the wrap authorities list
          // it reverts with a NotAuthorized error
          test("Token authority is not in the wrap authorities list - reverts", async () => {
            fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );
            toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given a wrap authority is not provided
          // given the token authority is on the wrap authorities list
          // given the user does not have enough M tokens
          // it reverts
          test("Not enough M - reverts", async () => {
            const wrapAmount = new BN(
              randomInt(mintAmount.toNumber() + 1, 2 ** 48 - 1),
            );

            // Attempt to send the transaction
            // Expect an error
            await $.expectSystemError(
              $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
            );
          });

          test("Invalid amount - reverts", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .wrap(new BN(0))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });

          // given a wrap authority is not provided
          // given the token authority is on the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is not the owner of the from M token account, but is delegated
          // it transfers the amount of M tokens from the user's M token account to the M vault token account
          // it mints the amount of ext tokens to the to ext token account
          test("Wrap with delegated authority - success", async () => {
            // This is a UI amount (the wrap instruction now takes UI amounts)
            const wrapAmount = new BN(randomInt(1, mintAmount.toNumber() + 1));

            // Calculate expected principals from the UI amount
            // The wrap instruction calculates m_principal and ext_principal independently
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Approve (delegate) the wrap authority to spend the non-wrap authority's M tokens
            // Need to approve at least mPrincipal since that's what will be transferred
            const { sourceATA: fromMTokenAccount } = await $.approve(
              $.nonWrapAuthority,
              $.wrapAuthority.publicKey,
              $.mMint.publicKey,
              mPrincipal,
            );

            // Setup the instruction
            const toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );
            let toExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                toExtTokenAccount,
              );
            }

            // Send the instruction with the UI amount
            await $.ext.methods
              .wrap(wrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                wrapAuthority: $.ext.programId,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances using calculated principals
            await $.expectTokenBalance(
              fromMTokenAccount,
              fromMTokenAccountBalance.sub(mPrincipal),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.add(mPrincipal),
            );
            await $.expectTokenBalance(
              toExtTokenAccount,
              toExtTokenAccountBalance.add(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                toExtTokenAccount,
                toExtTokenAccountUiBalance!.add(wrapAmount),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is not provided
          // given the token authority is on the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is the owner of the from M token account
          // it transfers the amount of M tokens from the user's M token account to the M vault token account
          // it mints the amount of wM tokens to the user's wM token account
          test("Wrap to wrap authority account - success", async () => {
            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );
            let toExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                toExtTokenAccount,
              );
            }

            // UI amount to wrap
            const wrapAmount = new BN(randomInt(1, mintAmount.toNumber() + 1));

            // Calculate expected principals from the UI amount
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Send the instruction with UI amount
            await $.ext.methods
              .wrap(wrapAmount)
              .accountsPartial({
                tokenAuthority: $.wrapAuthority.publicKey,
                wrapAuthority: $.ext.programId,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances using calculated principals
            await $.expectTokenBalance(
              fromMTokenAccount,
              fromMTokenAccountBalance.sub(mPrincipal),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.add(mPrincipal),
            );
            await $.expectTokenBalance(
              toExtTokenAccount,
              toExtTokenAccountBalance.add(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                toExtTokenAccount,
                toExtTokenAccountUiBalance!.add(wrapAmount),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is not provided
          // given the token authority is on the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is the owner of the from M token account
          // given the signer does not own the to ext token account
          // it transfers the amount of M tokens from the user's M token account to the M vault token account
          // it mints the amount of wM tokens to the user's wM token account
          test("Wrap to different account - success", async () => {
            toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );
            let toExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                toExtTokenAccount,
              );
            }

            // UI amount to wrap
            const wrapAmount = new BN(randomInt(1, mintAmount.toNumber() + 1));

            // Calculate expected principals from the UI amount
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Send the instruction with UI amount
            await $.ext.methods
              .wrap(wrapAmount)
              .accountsPartial({
                tokenAuthority: $.wrapAuthority.publicKey,
                wrapAuthority: $.ext.programId,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances using calculated principals
            await $.expectTokenBalance(
              fromMTokenAccount,
              fromMTokenAccountBalance.sub(mPrincipal),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.add(mPrincipal),
            );
            await $.expectTokenBalance(
              toExtTokenAccount,
              toExtTokenAccountBalance.add(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                toExtTokenAccount,
                toExtTokenAccountUiBalance!.add(wrapAmount),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is not provided
          // given the token authority is on the wrap authorities list
          // given the from token account enough M tokens
          // given the token authority is the owner of the from token account
          // round-trip (wrap / unwrap)
          test("Wrap / unwrap roundtrip - success", async () => {
            // Cache the starting balance of M
            const startingBalance = await $.getTokenBalance(fromMTokenAccount);

            // UI amount to wrap/unwrap - using same UI amount for both operations
            // ensures we burn the same ext tokens we minted
            const wrapAmount = new BN(
              randomInt(1, startingBalance.toNumber() + 1),
            );

            // Calculate expected principals for verification
            const { mPrincipal } = await $.getExpectedWrapPrincipals(
              wrapAmount,
            );

            // Wrap with UI amount
            await $.wrap($.wrapAuthority, wrapAmount);

            // Unwrap with the same UI amount
            // This ensures we burn ext_principal = wrapAmount * 1e12 / ext_index
            // and receive m_principal = wrapAmount * 1e12 / m_index
            await $.unwrap($.wrapAuthority, wrapAmount);

            // Confirm the final balance is the same as the starting balance
            // Using tolerance since there may be rounding in principal calculations
            $.expectTokenBalance(
              fromMTokenAccount,
              startingBalance,
              Comparison.LessThanOrEqual,
              new BN(2),
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is not in the wrap authorities list
          // it reverts with a NotAuthorized error
          test("Wrap authority is not in the wrap authorities list - reverts", async () => {
            // Attempt to send the transaction
            // Expect revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .wrap(mintAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  wrapAuthority: $.nonWrapAuthority.publicKey,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is in the wrap authorities list
          // given the from token account does not have enough M tokens
          // it reverts with a ? error
          test("Not enough M - wrap authority - reverts", async () => {
            const wrapAmount = new BN(
              randomInt(mintAmount.toNumber() + 1, 2 ** 48 - 1),
            );

            // Attempt to send the transaction
            // Expect an error
            await $.expectSystemError(
              $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  wrapAuthority: $.wrapAuthority.publicKey,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority, $.wrapAuthority])
                .rpc(),
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is in the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is not the owner of the from M token account, but is delegated
          // it transfers the amount of M tokens from the user's M token account to the M vault token account
          // it mints the amount of ext tokens to the user's ext token account
          test("Wrap with delegated authority - wrap authority - success", async () => {
            // UI amount to wrap
            const wrapAmount = new BN(randomInt(1, mintAmount.toNumber() + 1));

            // Calculate expected principals from the UI amount
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Approve (delegate) the wrap authority to spend the non-wrap authority's M tokens
            const { sourceATA: fromMTokenAccount } = await $.approve(
              $.nonWrapAuthority,
              $.nonAdmin.publicKey,
              $.mMint.publicKey,
              mPrincipal,
            );

            // Setup the instruction
            const toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );
            let toExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                toExtTokenAccount,
              );
            }

            // Send the instruction with UI amount
            await $.ext.methods
              .wrap(wrapAmount)
              .accounts({
                tokenAuthority: $.nonAdmin.publicKey,
                wrapAuthority: $.wrapAuthority.publicKey,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin, $.wrapAuthority])
              .rpc();

            // Confirm updated balances using calculated principals
            await $.expectTokenBalance(
              fromMTokenAccount,
              fromMTokenAccountBalance.sub(mPrincipal),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.add(mPrincipal),
            );
            await $.expectTokenBalance(
              toExtTokenAccount,
              toExtTokenAccountBalance.add(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                toExtTokenAccount,
                toExtTokenAccountUiBalance!.add(wrapAmount),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is provided
          // given the wrap authority is in the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is the owner of the from M token account
          // it transfers the amount of M tokens from the user's M token account to the M vault token account
          // it mints the amount of ext tokens to the user's ext token account
          test("Wrap to differenct account - wrap authority - success", async () => {
            fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
            );

            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );
            let toExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                toExtTokenAccount,
              );
            }

            // UI amount to wrap
            const wrapAmount = new BN(randomInt(1, mintAmount.toNumber() + 1));

            // Calculate expected principals from the UI amount
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Send the instruction with UI amount
            await $.ext.methods
              .wrap(wrapAmount)
              .accountsPartial({
                tokenAuthority: $.nonWrapAuthority.publicKey,
                wrapAuthority: $.wrapAuthority.publicKey,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonWrapAuthority, $.wrapAuthority])
              .rpc();

            // Confirm updated balances using calculated principals
            await $.expectTokenBalance(
              fromMTokenAccount,
              fromMTokenAccountBalance.sub(mPrincipal),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.add(mPrincipal),
            );
            await $.expectTokenBalance(
              toExtTokenAccount,
              toExtTokenAccountBalance.add(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                toExtTokenAccount,
                toExtTokenAccountUiBalance!.add(wrapAmount),
                Comparison.LessThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is provided
          // given the wrap authority is in the wrap authorities list
          // given the from token account has enough M tokens
          // given the token authority is the owner of the from M token account
          // round-trip (wrap / unwrap)
          test("Wrap / unwrap roundtrip - wrap authority - success", async () => {
            // Cache the starting balance of M
            const startingBalance = await $.getTokenBalance(fromMTokenAccount);

            // UI amount to wrap/unwrap
            const wrapAmount = new BN(
              randomInt(1, startingBalance.toNumber() + 1),
            );

            // Wrap with UI amount
            await $.wrap($.nonWrapAuthority, wrapAmount, $.wrapAuthority);

            // Unwrap with the same UI amount
            await $.unwrap($.nonWrapAuthority, wrapAmount, $.wrapAuthority);

            // Confirm the final balance is the same as the starting balance
            $.expectTokenBalance(
              fromMTokenAccount,
              startingBalance,
              Comparison.LessThanOrEqual,
              new BN(2),
            );
          });
        });

        describe("index different from start (sync required)", () => {
          // M Index is strictly increasing
          const newIndex = new BN(
            randomInt(startIndex.toNumber() + 1, 2e12 + 1),
          );

          beforeEach(async () => {
            // Reset the blockhash to avoid issues with duplicate transactions from multiple claim cycles
            $.svm.expireBlockhash();
          });

          // test cases
          // [x] given the user has no ext tokens to start with
          //   [X] given no flows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] the user receives the correct amount of ext tokens
          //     [X] the extension is solvent
          //   [X] given there are net inflows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] the user receives the correct amount of ext tokens
          //     [X] the extension is solvent
          //   [X] given there are net outflows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] the user receives the correct amount of ext tokens
          //     [X] the extension is solvent
          // [X] given the user has ext tokens to start with
          //   [X] given no flows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] it adjusts the user's existing balance for the new index and then adds the wrap amount
          //     [X] the extension is solvent
          //   [X] given there are net inflows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] it adjusts the user's existing balance for the new index and then adds the wrap amount
          //     [X] the extension is solvent
          //   [X] given there are net outflows before the yield is distributed
          //     [X] it wraps the amount of M tokens from the user's M token account to the M vault token account
          //     [X] it adjusts the user's existing balance for the new index and then adds the wrap amount
          //     [X] the extension is solvent

          describe("user has no starting balance", () => {
            // given no flows before the yield is distributed
            // it wraps the amount of M tokens from the user's M token account to the M vault token account
            // the extension is solvent
            test("Wrap with new index - no flows - success", async () => {
              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              // UI amount to wrap
              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction with UI amount
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Confirm updated balances using calculated principals
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!.add(wrapAmount),
                  Comparison.LessThanOrEqual,
                  new BN(2),
                );
              }
              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });

            // given the extension has net inflows before the yield is distributed
            // it wraps the amount of M tokens from the user's M token account to the M vault token account
            // the extension is solvent
            test("Wrap - extension has inflows - success", async () => {
              // Mint and wrap additional tokens prior to claim
              const inflows = new BN(randomInt(100, mintAmount.toNumber() + 1));
              await $.mintM($.admin.publicKey, inflows);
              await $.wrap($.admin, inflows);

              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              // UI amount to wrap
              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction with UI amount
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Confirm updated balances using calculated principals
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!.add(wrapAmount),
                  Comparison.LessThanOrEqual,
                  new BN(2),
                );
              }
              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });

            // given the extension has net outflows before the yield is distributed
            // it wraps the amount of M tokens from the user's M token account to the M vault token account
            // the extension is solvent
            test("Wrap - extension has outflows - success", async () => {
              // Mint and wrap additional tokens
              const outflows = new BN(
                randomInt(100, initialWrappedAmount.toNumber() + 1),
              );
              await $.unwrap($.admin, outflows);

              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              // UI amount to wrap
              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction with UI amount
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Confirm updated balances using calculated principals
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!.add(wrapAmount),
                  Comparison.LessThanOrEqual,
                  new BN(2),
                );
              }
              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });
          });

          describe("user has starting balance", () => {
            beforeEach(async () => {
              // Give the wrap authority some initial tokens
              const initialAmount = new BN(
                randomInt(1, mintAmount.toNumber() + 1),
              );
              await $.mintM($.wrapAuthority.publicKey, initialAmount);
              await $.wrap($.wrapAuthority, initialAmount);
            });

            // given no flows before the yield is distributed
            // it adjusts the user's existing balance correctly and then adds the new wrapped amount
            // the extension is solvent
            test("Wrap with new index - no flows - success", async () => {
              const startMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              // UI amount to wrap
              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction with UI amount
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Get new multiplier
              const newMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Confirm updated balances using calculated principals
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!
                    .mul(newMultiplier)
                    .div(startMultiplier)
                    .add(wrapAmount),
                  Comparison.Equal,
                  new BN(2),
                );
              }

              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });

            // given the extension has net inflows before the yield is distributed
            // it adjusts the user's existing balance correctly and then adds the new wrapped amount
            // the extension is solvent
            test("Wrap - extension has inflows - success", async () => {
              const startMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Mint and wrap additional tokens prior to claim
              const inflows = new BN(randomInt(100, mintAmount.toNumber() + 1));
              await $.mintM($.admin.publicKey, inflows);
              await $.wrap($.admin, inflows);

              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              // UI amount to wrap
              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction with UI amount
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Get new multiplier
              const newMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Confirm updated balances using calculated principals
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!
                    .mul(newMultiplier)
                    .div(startMultiplier)
                    .add(wrapAmount),
                  Comparison.Equal,
                  new BN(2),
                );
              }
              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });

            // given the extension has net outflows before the yield is distributed
            // it wraps the amount of M tokens from the user's M token account to the M vault token account
            // the extension is solvent
            test("Wrap - extension has outflows - success", async () => {
              const startMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Mint and wrap additional tokens
              const outflows = new BN(
                randomInt(100, initialWrappedAmount.toNumber() + 1),
              );
              await $.unwrap($.admin, outflows);

              // Propagate the new index
              await $.propagateIndex(newIndex);

              // Cache initial balances
              const fromMTokenAccountBalance = await $.getTokenBalance(
                fromMTokenAccount,
              );
              const vaultMTokenAccountBalance = await $.getTokenBalance(
                vaultMTokenAccount,
              );
              const toExtTokenAccountBalance = await $.getTokenBalance(
                toExtTokenAccount,
                $.useToken2022ForExt,
              );
              let toExtTokenAccountUiBalance;
              if (variant === Variant.ScaledUi) {
                toExtTokenAccountUiBalance = await $.getTokenUiBalance(
                  toExtTokenAccount,
                );
              }

              const wrapAmount = new BN(
                randomInt(1, fromMTokenAccountBalance.toNumber() + 1),
              );

              // Send the instruction
              await $.ext.methods
                .wrap(wrapAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc();

              // Calculate expected principals AFTER instruction (indices are now synced)
              const { mPrincipal, extPrincipal } =
                await $.getExpectedWrapPrincipals(wrapAmount);

              // Get new multiplier
              const newMultiplier = new BN(
                Math.floor((await $.getCurrentMultiplier()) * 1e12),
              );

              // Confirm updated balances
              await $.expectTokenBalance(
                fromMTokenAccount,
                fromMTokenAccountBalance.sub(mPrincipal),
              );
              await $.expectTokenBalance(
                vaultMTokenAccount,
                vaultMTokenAccountBalance.add(mPrincipal),
              );
              await $.expectTokenBalance(
                toExtTokenAccount,
                toExtTokenAccountBalance.add(extPrincipal),
                Comparison.Equal,
                undefined,
                $.useToken2022ForExt,
              );
              if (variant === Variant.ScaledUi) {
                await $.expectTokenUiBalance(
                  toExtTokenAccount,
                  toExtTokenAccountUiBalance!
                    .mul(newMultiplier)
                    .div(startMultiplier)
                    .add(wrapAmount),
                  Comparison.Equal,
                  new BN(2),
                );
              }
              // Confirm the extension is solvent
              await $.expectExtSolvent();
            });
          });
        });

        // Precision edge case tests for wrap operations
        // Note: These tests verify precision behavior when M and ext indices differ.
        // For NoYield variant, if M index > ext index (1e12), wrapping can cause
        // slight under-collateralization because fewer M tokens are transferred
        // than ext tokens minted. ScaledUi variant handles this through yield accrual.
        describe("precision edge cases", () => {
          // Test small amount (1 token) handling
          test("wrap with small amount - verifies principals calculated correctly", async () => {
            const fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.wrapAuthority.publicKey,
            );
            const toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.wrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            const vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );

            // Cache initial balances
            const fromMTokenAccountBalance = await $.getTokenBalance(
              fromMTokenAccount,
            );
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toExtTokenAccountBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );

            // Wrap the smallest amount that produces a non-zero principal at the current M index.
            // Formula: ceil(m_index / 1e12) ensures floor(amount * 1e12 / m_index) >= 1.
            const INDEX_SCALE = new BN("1000000000000"); // 1e12
            const mIndex = await $.getCurrentMIndex();
            const wrapAmount = mIndex.add(INDEX_SCALE.subn(1)).div(INDEX_SCALE);

            // Send the instruction
            await $.ext.methods
              .wrap(wrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                wrapAuthority: $.ext.programId,
                fromMTokenAccount,
                toExtTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Calculate expected principals AFTER instruction
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(wrapAmount);

            // Verify no underflow/overflow - balances should have changed
            const newFromBalance = await $.getTokenBalance(fromMTokenAccount);
            const newVaultBalance = await $.getTokenBalance(vaultMTokenAccount);
            const newExtBalance = await $.getTokenBalance(
              toExtTokenAccount,
              $.useToken2022ForExt,
            );

            // M transferred from user to vault
            expect(
              fromMTokenAccountBalance.sub(newFromBalance).toNumber(),
            ).toBe(mPrincipal.toNumber());
            expect(
              newVaultBalance.sub(vaultMTokenAccountBalance).toNumber(),
            ).toBe(mPrincipal.toNumber());
            // Ext minted to user
            expect(newExtBalance.sub(toExtTokenAccountBalance).toNumber()).toBe(
              extPrincipal.toNumber(),
            );

            // For ScaledUi variant, solvency is maintained through yield
            // For NoYield variant, slight under-collateralization is expected
            // when M index > ext index (this is a known limitation)
            if (variant === Variant.ScaledUi) {
              await $.expectExtSolvent();
            }
          });

          // Test that multiple wrap/unwrap cycles don't cause excessive drift
          test("10 wrap/unwrap cycles - vault balance drift is bounded", async () => {
            const vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );

            // Get initial vault balance
            const initialVaultBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );

            const wrapAuthority = $.wrapAuthority;
            const wrapAmount = new BN(1000);

            // Perform 10 wrap/unwrap cycles
            for (let i = 0; i < 10; i++) {
              await $.wrap(wrapAuthority, wrapAmount);
              $.svm.expireBlockhash();
              await $.unwrap(wrapAuthority, wrapAmount);
              $.svm.expireBlockhash();
            }

            // Get final vault balance
            const finalVaultBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );

            // The vault balance drift should be bounded
            // Due to rounding, we may lose or gain a small amount per cycle
            // Max drift per cycle is ~1 token, so max total drift is ~20 tokens
            const drift = Math.abs(
              finalVaultBalance.sub(initialVaultBalance).toNumber(),
            );
            expect(drift).toBeLessThanOrEqual(20);

            // For ScaledUi, verify solvency is maintained
            if (variant === Variant.ScaledUi) {
              await $.expectExtSolvent();
            }
          });

          // Test that vault balance increases correctly on wrap
          test("vault balance increases by mPrincipal on wrap", async () => {
            const vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );

            // Get initial state
            const initialVaultBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );

            // Wrap tokens
            const wrapAmount = new BN(10000);
            await $.wrap($.wrapAuthority, wrapAmount);

            // Calculate expected mPrincipal after wrap
            const { mPrincipal } = await $.getExpectedWrapPrincipals(
              wrapAmount,
            );

            // Get vault balance after wrap
            const afterWrapVaultBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );

            // Vault should have increased by exactly mPrincipal
            expect(
              afterWrapVaultBalance.sub(initialVaultBalance).toNumber(),
            ).toBe(mPrincipal.toNumber());
          });

          // given the M index is high enough that amount_to_principal_down rounds to zero
          // it reverts with InvalidAmount before executing any token operations
          test("wrap reverts with InvalidAmount when m_principal is zero", async () => {
            await $.propagateIndex(new BN(2_000_000_000_000));
            const fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.wrapAuthority.publicKey,
            );
            const toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.wrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // floor(1 * 1e12 / 2e12) = 0, triggering require_gt!(m_principal, 0)
            await $.expectAnchorError(
              $.ext.methods
                .wrap(new BN(1))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });

          // ScaledUI only: ext_index = m_index, so ext_principal rounds to zero at the same threshold
          test("wrap reverts with InvalidAmount when ext_principal is zero", async () => {
            if (variant !== Variant.ScaledUi) return;
            await $.propagateIndex(new BN(2_000_000_000_000));
            const fromMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.wrapAuthority.publicKey,
            );
            const toExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.wrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // floor(1 * 1e12 / 2e12) = 0 for both m and ext principal (ext_index = m_index)
            await $.expectAnchorError(
              $.ext.methods
                .wrap(new BN(1))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  wrapAuthority: $.ext.programId,
                  fromMTokenAccount,
                  toExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });
        });
      });

      describe("unwrap unit tests", () => {
        const wrappedAmount = new BN(25_000_000);

        let fromExtTokenAccount: PublicKey;
        let toMTokenAccount: PublicKey;

        beforeEach(async () => {
          fromExtTokenAccount = await $.getATA(
            $.extMint.publicKey,
            $.wrapAuthority.publicKey,
            $.useToken2022ForExt,
          );
          toMTokenAccount = await $.getATA(
            $.mMint.publicKey,
            $.wrapAuthority.publicKey,
          );

          // Wrap tokens for the users so we can test unwrapping
          await $.wrap($.wrapAuthority, wrappedAmount);
          await $.wrap($.nonWrapAuthority, wrappedAmount, $.wrapAuthority);
        });
        describe("index same as start", () => {
          // test cases
          // [X] given the m mint account does not match the one stored in the global account
          //   [X] it reverts with an InvalidAccount error
          // [X] given the ext mint account does not match the one stored in the global account
          //   [X] it reverts with an InvalidAccount error
          // [X] given the token authority is not the authority on the from ext token account and is not delegated by the owner
          //   [X] it reverts with a Token program error
          // [X] given the vault M token account is not the M Vaults ATA for the M token mint
          //   [X] it reverts with a ConstraintAssociated error
          // [X] given the to m token account is for the wrong mint
          //   [X] it reverts with a ConstraintTokenMint error
          // [X] given the from ext token account is for the wrong mint
          //   [X] it reverts with a ConstraintTokenMint error
          // [X] given a wrap authority is not provided
          //   [X] given the token authority is not in the wrap authorities list
          //     [X] it reverts with a NotAuthorized error
          //   [X] given the token authority is in the wrap authorities list
          //     [X] given the from token account does not have enough ext tokens
          //       [X] it reverts with a token error
          //     [X] given the from token account has enough ext tokens
          //       [X] given the token authority is not the owner of the from ext token account, but is delegated
          //         [X] it burns the amount of ext tokens from the from's ext token account
          //       [X] given the token authority is the owner of the from ext token account
          //         [X] it burns the amount of ext tokens from the from's ext token account
          //       [X] it transfers the amount of M tokens from the M vault token account to the to's M token account
          // [X] given a wrap authority is provided
          //   [X] given the wrap authority does not sign the transaction
          //     [X] it reverts
          //   [X] given the wrap authority is not on the wrap authorities list
          //     [X] it reverts with a NotAuthorized error
          //   [X] given the wrap authority is on the wrap authorities list
          //     [X] given the from token account does not have enough ext tokens
          //       [X] it reverts
          //     [X] given the from token account has enough ext tokens
          //       [X] given the token authority is not the owner of the from ext token account, but is delegated
          //         [X] it burns the amount of ext tokens from the from's ext token account
          //       [X] given the token authority is the owner of the from ext token account
          //         [X] it burns the amount of ext tokens from the from's ext token account
          //       [X] it transfers the amount of M tokens from the M vault token account to the to's M token account

          // given the m mint account does not match the one stored in the global account
          // it reverts with an InvalidAccount error
          test("M mint account does not match global account - reverts", async () => {
            const wrongMint = Keypair.generate();
            await $.createMint(
              wrongMint,
              $.wrapAuthority.publicKey,
              $.admin.publicKey,
              true,
              6,
            );

            // Update the M token accounts
            toMTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.wrapAuthority.publicKey,
            );
            vaultMTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.getMVault(),
            );

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  mMint: wrongMint.publicKey,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  vaultMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the ext mint account does not match the one stored in the global account
          // it reverts with an InvalidAccount error
          test("Ext mint account does not match global account - reverts", async () => {
            const wrongMint = Keypair.generate();
            await $.createMint(
              wrongMint,
              $.wrapAuthority.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
              6,
            );

            // Update the ext token accounts
            fromExtTokenAccount = await $.getATA(
              wrongMint.publicKey,
              $.wrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  extMint: wrongMint.publicKey,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the token authority is not the authority on the from ext token account and not delegated
          // it reverts with a ConstraintTokenOwner error
          test("Token authority is not the authority on the from Ext token account and not delegated - reverts", async () => {
            // Get the ATA for another user
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert with TokenOwner error
            await $.expectSystemError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
            );
          });

          // given the M vault token account is not the M vault PDA's ATA
          // it reverts with a ConstraintAssociated error
          test("M Vault Token account is not the M Vault PDA's ATA (other token account) - reverts", async () => {
            // Create a token account for the M vault that is not the ATA
            const mVault = $.getMVault();
            const { tokenAccount: vaultMTokenAccount } =
              await $.createTokenAccount(
                $.mMint.publicKey,
                $.getMVault(),
                true,
                true,
              );

            // Attempt to send the transaction
            // Expect revert with a ConstraintAssociated error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accountsPartial({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  vaultMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintAssociated",
            );
          });

          // given the user m token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("To M token account is for wrong mint - reverts", async () => {
            // Attempt to send the transaction
            // Expect revert with a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  toMTokenAccount: fromExtTokenAccount,
                  fromExtTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given the user ext token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("From Ext token account is for the wrong mint - reverts", async () => {
            // Attempt to send the transaction
            // Expect revert with a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount: toMTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "ConstraintTokenMint",
            );
          });
          // given a wrap authority is not provided
          // given the token authority is not in the wrap authorities list
          // it reverts with a NotAuthorized error
          test("Token authority is not in the wrap authorities list - reverts", async () => {
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );
            // Attempt to send the transaction
            // Expect revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given a wrap authority is not provided
          // given the token authority is in the wrap authorities list
          // give the from token account does not have enough ext tokens
          // it reverts with a token error since the user's balance is too low
          test("Not enough ext tokens, unwraps user's total balance - reverts", async () => {
            // Get the balance of the from ext token account
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );

            // Create a random amount to unwrap that is greater than the balance
            const unwrapPrincipal = new BN(
              randomInt(fromExtTokenAccountBalance.toNumber() + 1, 2 ** 48 - 1),
            );

            // Attempt to unwrap
            // Expect revert with a token error since the user's balance is too low
            await $.expectSystemError(
              $.ext.methods
                .unwrap(unwrapPrincipal)
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
            );
          });

          // given the unwrap amount is zero
          test("Invalid amount - revert", async () => {
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(new BN(0))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });

          // given a wrap authority is not provided
          // given the token authority is in the wrap authorities list
          // given the from token account has enough ext tokens
          // given the token authority is not the owner of the from ext token account, but is delegated
          // it burns the amount of ext tokens from the from's ext token account
          // it transfers the amount of M tokens from the M vault token account to the to's M token account
          test("Unwrap with delegated authority - success", async () => {
            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Approve (delegate) the wrap authority to spend the non-wrap authority's ext tokens
            const { sourceATA: fromExtTokenAccount } = await $.approve(
              $.nonWrapAuthority,
              $.wrapAuthority.publicKey,
              $.extMint.publicKey,
              extPrincipal,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountUiBalance;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountUiBalance = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountUiBalance!.sub(unwrapAmount),
                Comparison.GreaterThanOrEqual,
                new BN(2),
              );
            }
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
          });

          // given a wrap authority is not provided
          // given the token authority is in the wrap authorities list
          // given the from token account has enough ext tokens
          // it transfers the amount of M tokens from the M vault token account to the user's M token account
          // it burns the amount of ext tokens from the user's ext token account
          test("Unwrap to wrap authority account - success", async () => {
            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accountsPartial({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!.sub(unwrapAmount),
                Comparison.GreaterThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is not provided
          // given the token authority is in the wrap authorities list
          // given the from token account has enough ext tokens
          // it transfers the amount of M tokens from the M vault token account to the to M token account
          // it burns the amount of ext tokens from the from ext token account
          test("Unwrap to different account - success", async () => {
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!.sub(unwrapAmount),
                Comparison.GreaterThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is provided
          // given the wrap authority does not sign the transaction
          // it reverts
          test("Wrap authority does not sign - reverts", async () => {
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Attempt to send the transaction
            // Expect revert
            await $.expectSystemError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  unwrapAuthority: $.wrapAuthority.publicKey,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority])
                .rpc(),
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is not on the wrap authorities list
          // it reverts with a NotAuthorized error
          test("Wrap authority not on wrap authorities list - reverts", async () => {
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Attempt to send the transaction
            // Expect revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(wrappedAmount)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  unwrapAuthority: $.nonAdmin.publicKey,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority, $.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is on the wrap authorities list
          // given the from token account does not have enough ext tokens
          // it reverts with a token error since the user's balance is too low
          test("Not enough ext tokens, unwraps user's total balance - wrap authority - reverts", async () => {
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );
            vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );

            // Get the balance of the from ext token account
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );

            const unwrapPrincipal = new BN(
              randomInt(fromExtTokenAccountBalance.toNumber() + 1, 2 ** 48 - 1),
            );

            // Send the unwrap
            await $.expectSystemError(
              $.ext.methods
                .unwrap(unwrapPrincipal)
                .accounts({
                  tokenAuthority: $.nonWrapAuthority.publicKey,
                  unwrapAuthority: $.wrapAuthority.publicKey,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonWrapAuthority, $.wrapAuthority])
                .rpc(),
            );
          });

          // given a wrap authority is provided
          // given the wrap authority is on the wrap authorities list
          // given the from token account has enough ext tokens
          // given the token authority is not the owner of the from ext token account, but is delegated
          // it burns the amount of ext tokens from the from's ext token account
          // it transfers the amount of M tokens from the M vault token account to the to's M token account
          test("Unwrap with delegated authority - wrap authority - success", async () => {
            vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );

            // Approve (delegate) the nonAdmin to spend the non-wrap authority's ext tokens
            const { sourceATA: fromExtTokenAccount } = await $.approve(
              $.nonWrapAuthority,
              $.nonAdmin.publicKey,
              $.extMint.publicKey,
              wrappedAmount,
              $.useToken2022ForExt,
            );

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.nonAdmin.publicKey,
                unwrapAuthority: $.wrapAuthority.publicKey,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonAdmin, $.wrapAuthority])
              .rpc();

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!.sub(unwrapAmount),
                Comparison.GreaterThanOrEqual,
                new BN(2),
              );
            }
          });

          // given a wrap authority is provided
          // given the wrap authority is on the wrap authorities list
          // given the from token account has enough ext tokens
          // given the token authority is the owner of the from ext token account
          // it burns the amount of ext tokens from the from's ext token account
          // it transfers the amount of M tokens from the M vault token account to the to's M token account
          test("Unwrap with owner authority - wrap authority - success", async () => {
            fromExtTokenAccount = await $.getATA(
              $.extMint.publicKey,
              $.nonWrapAuthority.publicKey,
              $.useToken2022ForExt,
            );
            toMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.nonWrapAuthority.publicKey,
            );
            vaultMTokenAccount = await $.getATA(
              $.mMint.publicKey,
              $.getMVault(),
            );

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.nonWrapAuthority.publicKey,
                unwrapAuthority: $.wrapAuthority.publicKey,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.nonWrapAuthority, $.wrapAuthority])
              .rpc();

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!.sub(unwrapAmount),
                Comparison.GreaterThanOrEqual,
                new BN(2),
              );
            }
          });
        });

        describe("index different from start", () => {
          const newIndex = new BN(
            randomInt(startIndex.toNumber() + 1, 2e12 + 1),
          );
          let newMultiplier: BN = new BN(1e12);
          let startMultiplier: BN = new BN(1e12);

          beforeEach(async () => {
            // Reset the blockhash to avoid issues with duplicate transactions from multiple claim cycles
            $.svm.expireBlockhash();

            startMultiplier = new BN(
              Math.floor((await $.getCurrentMultiplier()) * 1e12),
            );
          });

          // test cases
          // [X] given there are no flows before the yield is distributed
          //   [X] it unwraps the amount of M tokens from the M vault token account to the user's M token account
          //   [X] it burns the correct amount of ext tokens from the user's ext token account
          //   [X] the extension is solvent
          // [X] given there are net inflows before the yield is distributed
          //   [X] it unwraps the amount of M tokens from the M vault token account to the user's M token account
          //   [X] it unwraps the correct amount of ext tokens from the user's ext token account
          //   [X] the extension is solvent
          // [X] given there are net outflows before the yield is distributed
          //   [X] it unwraps the amount of M tokens from the M vault token account to the user's M token account
          //   [X] it unwraps the correct amount of ext tokens from the user's ext token account
          //   [X] the extension is solvent

          // given yield has been minted to the m vault for the new index
          // it unwraps the amount of M tokens from the M vault token account to the user's M token account
          test("Unwrap with new index - no flows - success", async () => {
            // Propagate the new index
            await $.propagateIndex(newIndex);

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Get principals after sync (instruction may have synced the indices)
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Get new multiplier
            const newMultiplier = new BN(
              Math.floor((await $.getCurrentMultiplier()) * 1e12),
            );

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!
                  .mul(newMultiplier)
                  .div(startMultiplier)
                  .sub(unwrapAmount),
                Comparison.Equal,
                new BN(2),
              );
            }

            // Confirm the extension is solvent
            await $.expectExtSolvent();
          });

          // given there are net inflows before the yield is distributed
          // it unwraps the amount of M tokens from the M vault token account to the user's M token account
          // it unwraps the correct amount of ext tokens from the user's ext token account
          // the extension is solvent
          test("Unwrap - extension has inflows - success", async () => {
            // Mint and wrap additional tokens prior to claim
            const inflows = new BN(
              randomInt(100, wrappedAmount.toNumber() + 1),
            );
            await $.mintM($.admin.publicKey, inflows);
            await $.wrap($.admin, inflows);

            // Propagate the new index
            await $.propagateIndex(newIndex);

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Get principals after sync (instruction may have synced the indices)
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Get new multiplier
            const newMultiplier = new BN(
              Math.floor((await $.getCurrentMultiplier()) * 1e12),
            );

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!
                  .mul(newMultiplier)
                  .div(startMultiplier)
                  .sub(unwrapAmount),
                Comparison.Equal,
                new BN(2),
              );
            }

            // Confirm the extension is solvent
            await $.expectExtSolvent();
          });

          // given there are net outflows before the yield is distributed
          // it unwraps the amount of M tokens from the M vault token account to the user's M token account
          // it unwraps the correct amount of ext tokens from the user's ext token account
          // the extension is solvent
          test("Unwrap - extension has outflows - success", async () => {
            // Unwrap tokens prior to claim
            const outflows = new BN(
              randomInt(100, initialWrappedAmount.toNumber() + 1),
            );
            await $.unwrap($.admin, outflows);

            // Propagate the new index
            await $.propagateIndex(newIndex);

            // Cache initial balances
            const fromExtTokenAccountBalance = await $.getTokenBalance(
              fromExtTokenAccount,
              $.useToken2022ForExt,
            );
            let fromExtTokenAccountBalanceUi;
            if (variant === Variant.ScaledUi) {
              fromExtTokenAccountBalanceUi = await $.getTokenUiBalance(
                fromExtTokenAccount,
              );
            }
            const vaultMTokenAccountBalance = await $.getTokenBalance(
              vaultMTokenAccount,
            );
            const toMTokenAccountBalance = await $.getTokenBalance(
              toMTokenAccount,
            );

            const unwrapAmount = new BN(
              randomInt(1, wrappedAmount.toNumber() + 1),
            );

            // Send the instruction
            await $.ext.methods
              .unwrap(unwrapAmount)
              .accounts({
                tokenAuthority: $.wrapAuthority.publicKey,
                unwrapAuthority: $.ext.programId,
                fromExtTokenAccount,
                toMTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.wrapAuthority])
              .rpc();

            // Get principals after sync (instruction may have synced the indices)
            const { mPrincipal, extPrincipal } =
              await $.getExpectedWrapPrincipals(unwrapAmount);

            // Get new multiplier
            const newMultiplier = new BN(
              Math.floor((await $.getCurrentMultiplier()) * 1e12),
            );

            // Confirm updated balances
            await $.expectTokenBalance(
              toMTokenAccount,
              toMTokenAccountBalance.add(mPrincipal),
              Comparison.LessThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              vaultMTokenAccount,
              vaultMTokenAccountBalance.sub(mPrincipal),
              Comparison.GreaterThanOrEqual,
              new BN(2),
            );
            await $.expectTokenBalance(
              fromExtTokenAccount,
              fromExtTokenAccountBalance.sub(extPrincipal),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            if (variant === Variant.ScaledUi) {
              await $.expectTokenUiBalance(
                fromExtTokenAccount,
                fromExtTokenAccountBalanceUi!
                  .mul(newMultiplier)
                  .div(startMultiplier)
                  .sub(unwrapAmount),
                Comparison.Equal,
                new BN(2),
              );
            }

            // Confirm the extension is solvent
            await $.expectExtSolvent();
          });
        });

        describe("precision edge cases", () => {
          // given the M index is high enough that amount_to_principal_down rounds to zero
          // it reverts with InvalidAmount before executing any token operations
          test("unwrap reverts with InvalidAmount when m_principal is zero", async () => {
            await $.propagateIndex(new BN(2_000_000_000_000));

            // floor(1 * 1e12 / 2e12) = 0, triggering require_gt!(m_principal, 0)
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(new BN(1))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });

          // ScaledUI only: ext_index = m_index, so ext_principal rounds to zero at the same threshold
          test("unwrap reverts with InvalidAmount when ext_principal is zero", async () => {
            if (variant !== Variant.ScaledUi) return;
            await $.propagateIndex(new BN(2_000_000_000_000));

            // floor(1 * 1e12 / 2e12) = 0 for both m and ext principal (ext_index = m_index)
            await $.expectAnchorError(
              $.ext.methods
                .unwrap(new BN(1))
                .accounts({
                  tokenAuthority: $.wrapAuthority.publicKey,
                  unwrapAuthority: $.ext.programId,
                  fromExtTokenAccount,
                  toMTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.wrapAuthority])
                .rpc(),
              "InvalidAmount",
            );
          });
        });
      });
    });

    // Scaled UI-specific tests
    if (variant === Variant.ScaledUi) {
      describe("open instruction tests", () => {
        describe("sync unit tests", () => {
          const initialWrappedAmount = new BN(10_000_000); // 10 with 6 decimals

          let wrapAuthorities: PublicKey[];
          const feeBps = new BN(randomInt(10000));

          const startIndex = new BN(
            randomInt(initialIndex.toNumber() + 1, 2e12),
          );

          // Setup accounts with M tokens so we can test wrapping and unwrapping
          beforeEach(async () => {
            wrapAuthorities = [$.admin.publicKey, $.wrapAuthority.publicKey];

            // Initialize the extension program
            await $.initializeExt(wrapAuthorities, feeBps);

            // Wrap some tokens from the admin to the make the m vault's balance non-zero
            await $.wrap($.admin, initialWrappedAmount);

            // Warp ahead slightly to change the timestamp of the new index
            $.warp(new BN(60), true);

            // Propagate the start index
            await $.propagateIndex(startIndex);

            // Reset the blockhash to avoid issues with duplicate transactions from multiple claim cycles
            $.svm.expireBlockhash();
          });

          // test cases
          // [X] given the ext mint account does not match the one stored in the global account
          //   [X] it reverts with an InvalidMint error
          // [X] given the ext mint authority account does match the derived PDA
          //   [X] it reverts with a ConstraintSeeds error
          // [X] given the multiplier is already up to date
          //   [X] it remains the same
          // [X] given the multiplier is not up to date
          //   [X] given the m vault has received yield to match the latest M index
          //     [X] it updates the scaled ui config on the ext mint to match the m index

          // given the ext mint account does not match the one stored in the global account
          // it reverts with an InvalidMint error
          test("Ext mint account does not match global account - reverts", async () => {
            // Create a new mint
            const newMint = Keypair.generate();
            await $.createMint(
              newMint,
              $.nonAdmin.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
              6,
            );

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .sync()
                .accountsPartial({
                  extMint: newMint.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([])
                .rpc(),
              "InvalidMint",
            );
          });

          // given the ext mint authority account does match the derived PDA
          // it reverts with a ConstraintSeeds error
          test("Ext mint authority account does not match derived PDA - reverts", async () => {
            // Change the ext mint authority account
            const extMintAuthority = PublicKey.unique();
            if (extMintAuthority.equals($.getExtMintAuthority())) {
              return;
            }

            // Attempt to send the transaction
            // Expect an invalid account error
            await $.expectAnchorError(
              $.ext.methods
                .sync()
                .accountsPartial({
                  extMintAuthority,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given the multiplier is already up to date
          // it remains the same
          // the extension is solvent
          test("Multiplier is already up to date - success", async () => {
            // Sync the multiplier to the start index
            await $.sync();

            // Load the scaled ui config
            const scaledUiAmountConfig = await $.getScaledUiAmountConfig(
              $.extMint.publicKey,
            );

            $.svm.expireBlockhash();

            // Sync again
            await $.sync();

            // Confirm the scaled ui config on the ext mint is the same
            $.expectScaledUiAmountConfig(
              $.extMint.publicKey,
              scaledUiAmountConfig,
            );

            await $.expectExtSolvent();
          });

          // given the multiplier is not up to date with the m index
          // it updates the scaled ui config on the ext mint to match the m index
          // the extension is solvent
          test("Multiplier is not up to date with the m index - success", async () => {
            // Cache the scaled ui amount config
            const scaledUiAmountConfig = await $.getScaledUiAmountConfig(
              $.extMint.publicKey,
            );

            // Send the instruction
            await $.ext.methods
              .sync()
              .accounts({
                extTokenProgram: $.extTokenProgram,
              })
              .signers([])
              .rpc();

            // Confirm the scaled ui config on the ext mint matches the m index
            const multiplier = await $.getCurrentMultiplier();

            await $.expectScaledUiAmountConfig($.extMint.publicKey, {
              authority: scaledUiAmountConfig.authority,
              multiplier,
              newMultiplier: multiplier,
              newMultiplierEffectiveTimestamp: BigInt(
                $.currentTime().toString(),
              ),
            });

            await $.expectExtSolvent();
          });

          // Test cases for when the extension is not earning
          describe("when extension is not earning (vault M token account is frozen)", () => {
            // Helper to remove the m_earner_account to simulate non-earning state
            let vaultMTokenAccount: PublicKey;
            beforeEach(async () => {
              vaultMTokenAccount = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
                true,
              );

              // Remove the m vault from earning to make it non-earning
              await $.removeMEarner($.getMVault(), vaultMTokenAccount);
            });

            test("sync updates last_m_index but not last_ext_index or multipliers", async () => {
              // Propagate a new index that is greater than the start index
              const newIndex = new BN(
                randomInt(startIndex.toNumber() + 1, 2e12 + 1),
              );
              await $.propagateIndex(newIndex);

              // Cache the current state before sync
              const initialExtGlobalState =
                await $.ext.account.extGlobalV2.fetch($.getExtGlobalAccount());
              const initialScaledUiConfig = await $.getScaledUiAmountConfig(
                $.extMint.publicKey,
              );

              // Send the sync instruction
              await $.ext.methods
                .sync()
                .accounts({
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([])
                .rpc();

              // Check that last_m_index was updated
              await $.expectExtGlobalState({
                ...initialExtGlobalState,
                yieldConfig: {
                  ...(initialExtGlobalState.yieldConfig as any),
                  lastMIndex: newIndex,
                },
              });

              // Check that the ScaledUiAmountConfig multipliers were NOT updated
              await $.expectScaledUiAmountConfig(
                $.extMint.publicKey,
                initialScaledUiConfig,
              );
            });

            test("extension yield distribution correct after resuming earning", async () => {
              // Propagate a new index that is greater than the start index
              const newIndex = new BN(
                randomInt(startIndex.toNumber() + 1, 2e12 + 1),
              );
              await $.propagateIndex(newIndex);

              // Cache the current state before sync
              const initialExtGlobalState =
                await $.ext.account.extGlobalV2.fetch($.getExtGlobalAccount());
              const initialScaledUiConfig = await $.getScaledUiAmountConfig(
                $.extMint.publicKey,
              );

              // Send the sync instruction while the extension is not earning
              await $.ext.methods
                .sync()
                .accounts({
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([])
                .rpc();

              // Expect only last_m_index to be updated
              await $.expectExtGlobalState({
                yieldConfig: {
                  ...(initialExtGlobalState.yieldConfig as any),
                  lastMIndex: newIndex,
                },
              });
              await $.expectScaledUiAmountConfig(
                $.extMint.publicKey,
                initialScaledUiConfig,
              );

              // Warp ahead slightly to change the timestamp of the new index
              $.warp(new BN(60), true);
              $.svm.expireBlockhash();

              // Now resume earning by re-adding the m vault as an earner
              await $.addMEarner($.getMVault(), vaultMTokenAccount);

              // Push a new index to trigger yield distribution
              const laterIndex = new BN(
                randomInt(newIndex.toNumber() + 1, 2e12 + 2),
              );
              await $.propagateIndex(laterIndex);

              // Sync the extension again now that it's earning
              await $.ext.methods
                .sync()
                .accounts({
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([])
                .rpc();

              // Expect the last ext_index and multipliers to be updated correctly on sync
              const expectedNewMultiplier = await $.getNewMultiplier(
                laterIndex,
              );

              await $.expectScaledUiAmountConfig($.extMint.publicKey, {
                authority: initialScaledUiConfig.authority,
                multiplier: expectedNewMultiplier,
                newMultiplier: expectedNewMultiplier,
                newMultiplierEffectiveTimestamp: BigInt(
                  $.currentTime().toString(),
                ),
              });

              await $.expectExtGlobalState({
                yieldConfig: {
                  lastMIndex: laterIndex,
                  lastExtIndex: new BN(
                    Math.floor(expectedNewMultiplier * 1e12),
                  ),
                },
              });
            });
          });
        });
      });
    }

    // Crank-specific tests
    if (variant === Variant.Crank) {
      describe("earn_authority instruction tests", () => {
        const newIndex = new BN(1_200_000_000_000); // 1.2
        let startTime: BN;
        const mintAmount = new BN(100_000_000);
        const earnManagerOne = new Keypair();
        const earnManagerTwo = new Keypair();
        const earnerOne = new Keypair();
        const earnerTwo = new Keypair();

        beforeEach(async () => {
          // Airdrop SOL to the earn managers and earners to pay for transactions
          for (const account of [
            earnManagerOne,
            earnManagerTwo,
            earnerOne,
            earnerTwo,
          ]) {
            $.svm.airdrop(account.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
          }

          // Initialize the program
          await $.initializeExt(
            [$.admin.publicKey, $.wrapAuthority.publicKey],
            undefined,
          );

          // Add an earn manager to create earner accounts
          // Set the fee to zero initially
          await $.addEarnManager(earnManagerOne.publicKey, new BN(0));

          // Add the earners as M earners so they can receive and wrap M tokens
          await $.addMEarner(earnerOne.publicKey);
          await $.addMEarner(earnerTwo.publicKey);

          // Mint M tokens to the earners and then wrap it to Ext tokens
          await $.mintM(earnerOne.publicKey, mintAmount);
          await $.mintM(earnerTwo.publicKey, mintAmount);

          // Propagate the initial index again to update the max M supply during the interval so max yield is sufficient
          // Under normal operation, this happens on any bridge transaction and when yield is distributed
          // However, we are minting tokens here for testing so it is not reflected, therefore, we have to pretend this is a bridge.
          await $.propagateIndex(initialIndex);

          // Add earner one as an ext earner so there is outstanding yield once it is synced
          await $.addEarner(earnManagerOne, earnerOne.publicKey);

          // Wrap the M tokens to Ext tokens to deposit them in the M vault
          await $.wrap(earnerOne, mintAmount, $.wrapAuthority);
          await $.wrap(earnerTwo, mintAmount, $.wrapAuthority);

          startTime = $.currentTime();

          // Warp time forward an hour
          $.warp(new BN(3600), true);

          // Update the index on the Earn program
          await $.propagateIndex(newIndex);
        });

        describe("sync unit tests", () => {
          // test cases
          // [X] given the earn authority does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the earn authority does sign the transaction
          //   [X] given the global_account does not match the seeds
          //     [X] it reverts with an InvalidAccount error
          //   [X] given all accounts are correct
          //     [X] it updates the ExtGlobal index and timestamp to the current index and timestamp on the M Earn Global account

          // given the earn authority does not sign the transaction
          // it reverts with a NotAuthorized error
          test("earn_authority does not sign - reverts", async () => {
            // Attempt to send the transaction
            // Expect it to revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .sync()
                .accountsPartial({
                  earnAuthority: $.nonAdmin.publicKey,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the earn authority does sign the transaction
          // given the global_account does not match the seeds
          // it reverts with a variety of errors (AccountNotInitialized, AccountOwnedByWrongProgram, InvalidAccount)
          test("global_account is invalid - reverts", async () => {
            // Use an incorrect account
            const globalAccount = $.getExtGlobalAccount();
            const wrongAccount = PublicKey.unique();
            if (globalAccount == wrongAccount) return;

            // Attempt to send the transaction
            // Expect it to revert with an error
            await $.expectSystemError(
              $.ext.methods
                .sync()
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  globalAccount: wrongAccount,
                })
                .signers([$.earnAuthority])
                .rpc(),
            );
          });

          // given the earn authority does sign the transaction
          // given all the accounts are correct
          // it updates the index and timestamp of the ExtGlobal account
          test("sync - success", async () => {
            // Confirm the state of the ExtGlobal account before the sync
            await $.expectExtGlobalState({
              yieldConfig: {
                yieldVariant: { crank: {} },
                lastMIndex: initialIndex,
                lastExtIndex: ONE,
                timestamp: startTime,
              },
            });

            // Send the transaction
            await $.ext.methods
              .sync()
              .accountsPartial({ earnAuthority: $.earnAuthority.publicKey })
              .signers([$.earnAuthority])
              .rpc();

            // Expect the ExtGlobal state to be updated
            await $.expectExtGlobalState({
              yieldConfig: {
                yieldVariant: { crank: {} },
                lastMIndex: newIndex,
                lastExtIndex: newIndex.mul(ONE).div(initialIndex),
                timestamp: $.currentTime(),
              },
            });
          });

          // Test cases for when the extension is not earning
          describe("when extension is not earning (vault M token account is frozen)", () => {
            // Helper to remove the m_earner_account to simulate non-earning state
            let vaultMTokenAccount: PublicKey;
            beforeEach(async () => {
              vaultMTokenAccount = await $.getATA(
                $.mMint.publicKey,
                $.getMVault(),
                true,
              );

              // Remove the m vault from earning to make it non-earning
              await $.removeMEarner($.getMVault(), vaultMTokenAccount);
            });

            test("sync updates last_m_index but not last_ext_index", async () => {
              // Propagate another new index that is greater than the start index
              const nextIndex = new BN(
                randomInt(newIndex.toNumber() + 1, 2e12 + 1),
              );
              await $.propagateIndex(nextIndex);

              // Cache the current state before sync
              const initialExtGlobalState =
                await $.ext.account.extGlobalV2.fetch($.getExtGlobalAccount());

              // Send the sync instruction
              await $.ext.methods
                .sync()
                .accounts({
                  earnAuthority: $.earnAuthority.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc();

              // Check that last_m_index was updated
              await $.expectExtGlobalState({
                ...initialExtGlobalState,
                yieldConfig: {
                  ...(initialExtGlobalState.yieldConfig as any),
                  lastMIndex: nextIndex,
                  timestamp: $.currentTime(),
                },
              });
            });

            test("extension yield distribution correct after resuming earning", async () => {
              // Propagate a new index that is greater than the start index
              const nextIndex = new BN(
                randomInt(newIndex.toNumber() + 1, 2e12 + 1),
              );
              await $.propagateIndex(nextIndex);

              // Cache the current state before sync
              const initialExtGlobalState =
                await $.ext.account.extGlobalV2.fetch($.getExtGlobalAccount());

              // Send the sync instruction while the extension is not earning
              await $.ext.methods
                .sync()
                .accounts({
                  earnAuthority: $.earnAuthority.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc();

              // Expect only last_m_index and timestamp to be updated
              await $.expectExtGlobalState({
                yieldConfig: {
                  ...(initialExtGlobalState.yieldConfig as any),
                  lastMIndex: nextIndex,
                  timestamp: $.currentTime(),
                },
              });

              // Warp ahead slightly to change the timestamp of the new index
              $.warp(new BN(60), true);
              $.svm.expireBlockhash();

              // Now resume earning by re-adding the m vault as an earner
              await $.addMEarner($.getMVault(), vaultMTokenAccount);

              // Push a new index to trigger yield distribution
              const laterIndex = new BN(
                randomInt(nextIndex.toNumber() + 1, 2e12 + 2),
              );
              await $.propagateIndex(laterIndex);

              // Sync the extension again now that it's earning
              await $.ext.methods
                .sync()
                .accounts({
                  earnAuthority: $.earnAuthority.publicKey,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc();

              // Expect the last ext_index to be updated correctly on sync
              const expectedExtIndex = laterIndex.mul(ONE).div(nextIndex);

              await $.expectExtGlobalState({
                yieldConfig: {
                  lastMIndex: laterIndex,
                  lastExtIndex: expectedExtIndex,
                  timestamp: $.currentTime(),
                },
              });
            });
          });
        });

        describe("claim_for unit tests", () => {
          // test cases
          // [X] given the earn authority does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the earn authority does sign the transaction
          //   [X] given the wrong ext_mint account is provided
          //     [X] it reverts with an error (could be various depending on the account)
          //   [X] given the wrong earn manager account is provided for an earner
          //     [X] it reverts with a ConstraintSeeds error
          //   [X] given the wrong token account is provided for the M vault
          //     [X] it reverts with a ConstraintAssociated error
          //   [X] given the earn manager token account does not match the token account stored on the earn manager account
          //     [X] it reverts with an InvalidAccount error
          //   [X] given the earner does not have a recipient token account defined
          //     [X] given the user token account does not match the one defined on the earner account
          //       [X] it reverts with an InvalidAccount error
          //     [X] given the user token account matches the one defined on the earner account
          //       [X] it mints yield to the user token account
          //   [X] given the earner does have a recipient token account defined
          //     [X] given the user token account does not match the recipient token account
          //       [X] it reverts with an InvalidAccount error
          //     [X] given the user token account matches the recipient token account
          //       [X] it mints yield to the recipient token account
          //   [X] given the accounts are all correct
          //     [X] given the earner's last claim index is greater than or equal to the current global index
          //       [X] it reverts with an AlreadyClaimed error
          //     [X] given the earn manager has zero fee
          //       [X] it mints all of the rewards to the earner's token account
          //     [X] given the earn manager is not active and has a non-zero fee
          //       [X] it mints all of the rewards to the earner's token account
          //     [X] given the earn manager is active and has a non-zero fee
          //       [ ] given the earn manager's fee token account is closed
          //         [X] it mints all of the rewards to the earner's token account
          //       [X] given the fee on the current yield rounds to zero
          //         [X] it mints all of the rewards to the earner's token account
          //       [X] given the fee does not round to zero
          //         [X] it mints the fee to the earn manager's token account and the remaining rewards
          //             to the earner's token account

          beforeEach(async () => {
            // Sync the latest index from the M earn program to have yield to claim
            await $.sync();

            // Add earner two as an earner after the sync so it does not have any yield to claim
            await $.addEarner(earnManagerOne, earnerTwo.publicKey);
          });

          // given the earn authority does not sign the transaction
          // it reverts with a NotAuthorized error
          test("Earn authority does not sign the transaction - reverts", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.nonAdmin.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the wrong ext mint account is provided
          // it reverts with a InvalidAccount error
          test("Ext mint account is invalid - reverts", async () => {
            const wrongMint = PublicKey.unique();
            if (wrongMint.equals($.extMint.publicKey)) return;

            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert
            await $.expectSystemError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extMint: wrongMint,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
            );
          });

          // given the wrong earn manager account is provided for an earner
          // it reverts with a ConstraintSeeds error
          test("Earn manager account is invalid - reverts", async () => {
            // Add another earn manager
            await $.addEarnManager(earnManagerTwo.publicKey, new BN(0));

            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt send the transaction
            // Expect revert
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerTwo.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given the M vault token account is not the M vault's ATA
          // it reverts with a ConstraintAssociated error
          test("M Vault token account is invalid - reverts", async () => {
            // Create a non-ATA token account for the M vault
            const { tokenAccount: invalidMVaultTokenAccount } =
              await $.createTokenAccount($.mMint.publicKey, $.getMVault());

            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert with a ConstraintAssociated error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  vaultMTokenAccount: invalidMVaultTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "ConstraintAssociated",
            );
          });

          // given the earn manager token account does not match token account stored on the earn manager account
          // it reverts with an InvalidAccount error
          test("Earn manager token account is invalid - reverts", async () => {
            // Create a new token account for the earn manager that doesn't match the one stored
            const { tokenAccount: invalidEarnManagerTokenAccount } =
              await $.createTokenAccount(
                $.extMint.publicKey,
                earnManagerOne.publicKey,
                $.useToken2022ForExt,
              );

            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert with an InvalidAccount error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: invalidEarnManagerTokenAccount,
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the earner does not have a recipient token account defined
          // given the user token account does not match the user token account on the earner account
          // it reverts with an InvalidAccount error
          test("Earner has no recipient account, token account doesn't match - reverts", async () => {
            // Create a new token account for the earner that doesn't match the one stored
            const { tokenAccount: invalidUserTokenAccount } =
              await $.createTokenAccount(
                $.extMint.publicKey,
                earnerOne.publicKey,
                $.useToken2022ForExt,
              );

            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const balance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Attempt to send the transaction
            // Expect revert with an InvalidAccount error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: invalidUserTokenAccount,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the earner does not have a recipient token account defined
          // given the user token account matches
          // it mints the yield to the user token account
          test("Earner has no recipient account, token account matches - success", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerOneATA);

            // Check that the last claim index and the last claim timestamp are the initial values
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Get the initial balance for the earner ata
            const initialBalance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Send the instruction
            await $.ext.methods
              .claimFor(initialBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount: earnerOneATA,
                earnManagerTokenAccount: await $.getATA(
                  $.extMint.publicKey,
                  earnManagerOne.publicKey,
                  $.useToken2022ForExt,
                ),
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();
            // Calculate the expected new balance
            // Note: earn manager fee is 0, so it all goes to the earner
            const expectedBalance = initialBalance.mul(newExtIndex).div(ONE);

            // Check the new balance matches the expected balance
            await $.expectTokenBalance(
              earnerOneATA,
              expectedBalance,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Check the earner account is updated
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          test("Earner has recipient account, token account does not match - reverts", async () => {
            // Set the earner's recipient account to the yield recipients ATA
            const yieldRecipient = new Keypair();
            const yieldRecipientATA = await $.getATA(
              $.extMint.publicKey,
              yieldRecipient.publicKey,
              $.useToken2022ForExt,
            );
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerOneATA);
            await $.setRecipient(earnerOne, earnerAccount, yieldRecipientATA);

            // Attempt to send the transaction
            // Expect revert with an InvalidAccount error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(
                  await $.getTokenBalance(earnerOneATA, $.useToken2022ForExt),
                )
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount,
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerOneATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "InvalidAccount",
            );
          });

          test("Earner has recipient account, token account matches - success", async () => {
            // Set the earner's recipient account to the yield recipients ATA
            const yieldRecipient = new Keypair();
            const yieldRecipientATA = await $.getATA(
              $.extMint.publicKey,
              yieldRecipient.publicKey,
              $.useToken2022ForExt,
            );
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerOneATA);
            await $.setRecipient(earnerOne, earnerAccount, yieldRecipientATA);

            // Check that the last claim index and the last claim timestamp are the initial values
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Get the initial balance for the earner ata
            const initialBalance = await $.getTokenBalance(
              earnerOneATA,
              $.useToken2022ForExt,
            );

            // Send the instruction
            await $.ext.methods
              .claimFor(initialBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount: yieldRecipientATA,
                earnManagerTokenAccount: await $.getATA(
                  $.extMint.publicKey,
                  earnManagerOne.publicKey,
                  $.useToken2022ForExt,
                ),
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate the expected yield
            // Note: earn manager fee is 0, so it all goes to the yield recipient
            const expectedYield = initialBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(initialBalance);

            // Check the ata balance didn't change but the yield recipient received the yield
            await $.expectTokenBalance(
              earnerOneATA,
              initialBalance,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            await $.expectTokenBalance(
              yieldRecipientATA,
              expectedYield,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Check the earner account is updated
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          // given all accounts are correct
          // given the earner's yield has been claimed up to the current index
          // it reverts with an AlreadyClaimed error
          test("Earner yield already claimed up to current index - reverts", async () => {
            // Setup the instruction to claim for earner two
            // earnerTwo was added after the sync, so its lastClaimIndex should equal the current index
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTwoATA);
            const balance = await $.getTokenBalance(
              earnerTwoATA,
              $.useToken2022ForExt,
            );

            // Verify that the earner's last claim index is equal to the current global index
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: await $.getCurrentExtIndex(),
              lastClaimTimestamp: $.currentTime(),
            });

            // Attempt to send the transaction
            // Expect an AlreadyClaimed error
            await $.expectAnchorError(
              $.ext.methods
                .claimFor(balance)
                .accountsPartial({
                  earnAuthority: $.earnAuthority.publicKey,
                  earnerAccount,
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  userTokenAccount: earnerTwoATA,
                  earnManagerTokenAccount: await $.getATA(
                    $.extMint.publicKey,
                    earnManagerOne.publicKey,
                    $.useToken2022ForExt,
                  ),
                  extTokenProgram: $.extTokenProgram,
                })
                .signers([$.earnAuthority])
                .rpc(),
              "AlreadyClaimed",
            );
          });

          // given all the accounts are correct
          // given the earn manager has zero fee
          // it mints all the yield to the earner's recipient account
          test("Earn manager fee is zero - success", async () => {
            const userTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(userTokenAccount);

            const earnManagerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earner's token account
            const earnerStartBalance = await $.getTokenBalance(
              userTokenAccount,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earn manager's token account
            const earnManagerStartBalance = await $.getTokenBalance(
              earnManagerTokenAccount,
              $.useToken2022ForExt,
            );

            // Confirm the earn manager fee is zero
            await $.expectEarnManagerState(
              $.getEarnManagerAccount(earnManagerOne.publicKey),
              {
                feeBps: new BN(0),
              },
            );

            // Confirm the starting earner account state
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Send the transaction
            await $.ext.methods
              .claimFor(earnerStartBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount,
                earnManagerTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate expected rewards (balance * (global_index / last_claim_index) - balance)
            const expectedRewards = earnerStartBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(earnerStartBalance);

            // Verify the expected token balance changes
            await $.expectTokenBalance(
              userTokenAccount,
              earnerStartBalance.add(expectedRewards),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            await $.expectTokenBalance(
              earnManagerTokenAccount,
              earnManagerStartBalance,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Verify the earner account was updated with the new claim index and claim timestamp
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          // given all the accounts are correct
          // given the earn manager fee is not zero and earn manager is not active
          // it mints all the yield to the earner's recipient account
          test("Earn manager fee is non-zero, earn manager inactive - success", async () => {
            // Set the earn manager fee to a non-zero value
            await $.configureEarnManager(earnManagerOne, new BN(1000));

            // Remove the earn manager
            await $.removeEarnManager(earnManagerOne.publicKey);
            const userTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(userTokenAccount);

            const earnManagerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earner's token account
            const earnerStartBalance = await $.getTokenBalance(
              userTokenAccount,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earn manager's token account
            const earnManagerStartBalance = await $.getTokenBalance(
              earnManagerTokenAccount,
              $.useToken2022ForExt,
            );

            // Confirm the earn manager fee is non-zero and inactive
            await $.expectEarnManagerState(
              $.getEarnManagerAccount(earnManagerOne.publicKey),
              {
                feeBps: new BN(1000),
                isActive: false,
              },
            );

            // Confirm the starting earner account state
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Send the transaction
            await $.ext.methods
              .claimFor(earnerStartBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount,
                earnManagerTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate expected rewards (balance * (global_index / last_claim_index) - balance)
            const expectedRewards = earnerStartBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(earnerStartBalance);

            // Verify the expected token balance changes
            await $.expectTokenBalance(
              userTokenAccount,
              earnerStartBalance.add(expectedRewards),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            await $.expectTokenBalance(
              earnManagerTokenAccount,
              earnManagerStartBalance,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Verify the earner account was updated with the new claim index and claim timestamp
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          // given all the accounts are correct
          // given the earn manager fee is not zero and earn manager is active
          // given the earn manager token account is closed
          // it mints all the yield to the earner's recipient account
          test("Earn manager fee is non-zero, earn manager active, earn manager token account closed - success", async () => {
            // Set the earn manager fee to a non-zero value
            await $.configureEarnManager(earnManagerOne, new BN(1000));
            const userTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(userTokenAccount);

            const earnManagerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Close the earn manager token account
            await $.closeTokenAccount(
              earnManagerOne,
              earnManagerTokenAccount,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earner's token account
            const earnerStartBalance = await $.getTokenBalance(
              userTokenAccount,
              $.useToken2022ForExt,
            );

            // Confirm the earn manager fee is non-zero and inactive
            await $.expectEarnManagerState(
              $.getEarnManagerAccount(earnManagerOne.publicKey),
              {
                feeBps: new BN(1000),
                isActive: true,
              },
            );

            // Confirm the starting earner account state
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Send the transaction
            await $.ext.methods
              .claimFor(earnerStartBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount,
                earnManagerTokenAccount, // This will be closed, so it should not affect the claim
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate expected rewards (balance * (global_index / last_claim_index) - balance)
            const expectedRewards = earnerStartBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(earnerStartBalance);

            // Verify the expected token balance changes
            await $.expectTokenBalance(
              userTokenAccount,
              earnerStartBalance.add(expectedRewards),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Verify the earner account was updated with the new claim index and claim timestamp
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          // given all the accounts are correct
          // given the earn manager fee is not zero and earn manager is active
          // given the fee amount rounds to zero
          // it mints all the yield to the earner's recipient account
          test("Earn manager fee is non-zero, earn manager active, fee amount rounds to zero - success", async () => {
            // Set a very small fee (1 bps = 0.01%)
            await $.configureEarnManager(earnManagerOne, new BN(1));
            const userTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(userTokenAccount);

            const earnManagerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner starting balance (this is used to compare later)
            const earnerStartBalance = await $.getTokenBalance(
              userTokenAccount,
              $.useToken2022ForExt,
            );

            // Get the earn manager token account starting balance
            const earnManagerStartBalance = await $.getTokenBalance(
              earnManagerTokenAccount,
              $.useToken2022ForExt,
            );

            // Confirm the earn manager fee is non-zero and active
            await $.expectEarnManagerState(
              $.getEarnManagerAccount(earnManagerOne.publicKey),
              {
                feeBps: new BN(1),
                isActive: true,
              },
            );

            // Confirm the starting earner account state
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Send the transaction
            // We use a smaller balance for the yield calculation here to make the fee round to zero
            const snapshotBalance = new BN(10000);
            await $.ext.methods
              .claimFor(snapshotBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount,
                earnManagerTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate expected rewards (balance * (new_index / last_claim_index) - balance)
            const expectedRewards = snapshotBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(snapshotBalance);

            // Verify the expected token balance changes
            // Since fee rounds to zero, all rewards go to the earner
            await $.expectTokenBalance(
              userTokenAccount,
              earnerStartBalance.add(expectedRewards),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            await $.expectTokenBalance(
              earnManagerTokenAccount,
              earnManagerStartBalance,
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Verify the earner account was updated with the new claim index and claim timestamp
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });

          // given all the accounts are correct
          // given the earn manager fee is not zero and earn manager is active
          // given the fee amount is not zero
          // it mints the fee amount to the earn manager token account
          // it mints the yield minus the fee amount to the earner's recipient account
          test("Earn manager fee is non-zero, earn manager active, fee amount not zero - success", async () => {
            // Configure the earn manager account with a 1% fee
            const feeBps = new BN(100);
            await $.configureEarnManager(earnManagerOne, feeBps);
            const userTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(userTokenAccount);

            const earnManagerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earner's token account
            const earnerStartBalance = await $.getTokenBalance(
              userTokenAccount,
              $.useToken2022ForExt,
            );

            // Get the current balance of the earn manager's token account
            const earnManagerStartBalance = await $.getTokenBalance(
              earnManagerTokenAccount,
              $.useToken2022ForExt,
            );

            // Confirm the earn manager fee is 1%
            await $.expectEarnManagerState(
              $.getEarnManagerAccount(earnManagerOne.publicKey),
              {
                feeBps,
                isActive: true,
              },
            );

            // Confirm the starting earner account state
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: ONE,
              lastClaimTimestamp: startTime,
            });

            // Send the transaction
            const snapshotBalance = await $.getTokenBalance(
              await $.getATA(
                $.extMint.publicKey,
                earnerOne.publicKey,
                $.useToken2022ForExt,
              ),
              $.useToken2022ForExt,
            );
            await $.ext.methods
              .claimFor(snapshotBalance)
              .accountsPartial({
                earnAuthority: $.earnAuthority.publicKey,
                earnerAccount,
                earnManagerAccount: $.getEarnManagerAccount(
                  earnManagerOne.publicKey,
                ),
                userTokenAccount,
                earnManagerTokenAccount,
                extTokenProgram: $.extTokenProgram,
              })
              .signers([$.earnAuthority])
              .rpc();

            const newExtIndex = await $.getCurrentExtIndex();

            // Calculate expected rewards (balance * (global_index / last_claim_index) - balance)
            const expectedRewards = snapshotBalance
              .mul(newExtIndex)
              .div(ONE)
              .sub(snapshotBalance);

            // Calculate the fee amount (1% of rewards)
            const feeAmount = expectedRewards.mul(feeBps).div(new BN(10000));

            // Calculate the amount that should go to the earner
            const earnerAmount = expectedRewards.sub(feeAmount);

            // Verify the expected token balance changes
            await $.expectTokenBalance(
              userTokenAccount,
              earnerStartBalance.add(earnerAmount),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );
            await $.expectTokenBalance(
              earnManagerTokenAccount,
              earnManagerStartBalance.add(feeAmount),
              Comparison.Equal,
              undefined,
              $.useToken2022ForExt,
            );

            // Verify the earner account was updated with the new claim index and claim timestamp
            await $.expectEarnerState(earnerAccount, {
              lastClaimIndex: newExtIndex,
              lastClaimTimestamp: $.currentTime(),
            });
          });
        });
      });

      describe("earn_manager instruction tests", () => {
        const earnManagerOne = new Keypair();
        const earnManagerTwo = new Keypair();
        const nonEarnManager = new Keypair();
        const earnerOne = new Keypair();
        const earnerTwo = new Keypair();

        beforeEach(async () => {
          // Airdrop SOL to the earn managers and earners to pay for transactions
          for (const account of [
            earnManagerOne,
            earnManagerTwo,
            nonEarnManager,
            earnerOne,
            earnerTwo,
          ]) {
            $.svm.airdrop(account.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
          }

          // Initialize the program
          await $.initializeExt(
            [$.admin.publicKey, $.wrapAuthority.publicKey],
            undefined,
          );

          // Add an earn manager
          await $.addEarnManager(earnManagerOne.publicKey, new BN(0));

          // Add an earner
          await $.addEarner(earnManagerOne, earnerOne.publicKey);
        });

        describe("add_earner unit tests", () => {
          // test cases
          // [X] given signer does not have an earn manager account initialized
          //   [X] it reverts with an account not initialized error
          // [X] given signer has an earn manager account initialized
          //   [X] given earn manager account is not active
          //     [X] it reverts with a NotAuthorized error
          //   [X] given earn manager account is active
          //     [X] given the earner already has an earner account
          //       [X] it reverts with an account already initialized error
          //     [X] given the earner does not already have an earner account
          //       [X] given user token account is for the wrong token mint
          //         [X] it reverts with an address constraint error
          //       [X] given user token account authority does not match the user pubkey
          //         [X] it reverts with an address constraint error
          //       [X] given the user token account is for the correct token mint and the authority is the user pubkey
          //         [X] it creates the earner account
          //         [X] it sets the user to the provided pubkey
          //         [X] it sets the user_token_account to the provided token account
          //         [X] it sets the earner is_active flag to true
          //         [X] it sets the earn_manager to the provided earn manager pubkey
          //         [X] it sets the last_claim_index to the current index
          //         [X] it sets the last_claim_timestamp to the current timestamp

          // given signer does not have an earn manager account initialized
          // it reverts with an account not initialized error
          test("Signer earn manager account not initialized - reverts", async () => {
            // Get the ATA for earner two
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to add earner without an initialized earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .addEarner(earnerTwo.publicKey)
                .accounts({
                  signer: nonEarnManager.publicKey,
                  userTokenAccount: earnerTwoATA,
                })
                .signers([nonEarnManager])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is not active
          // it reverts with a NotActive error
          test("Signer's earn manager account not active - reverts", async () => {
            // Get the ATA for earner two
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Remove the earn manager one's account (set it to inactive)
            await $.removeEarnManager(earnManagerOne.publicKey);

            // Attempt to add earner with an inactive earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .addEarner(earnerTwo.publicKey)
                .accounts({
                  signer: earnManagerOne.publicKey,
                  userTokenAccount: earnerTwoATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "NotActive",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given earner already has an earner account
          // it reverts with an account already initialized error
          test("Earner account already initialized - reverts", async () => {
            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to add earner with an already initialized earner account
            await $.expectSystemError(
              $.ext.methods
                .addEarner(earnerOne.publicKey)
                .accounts({
                  signer: earnManagerOne.publicKey,
                  userTokenAccount: earnerOneATA,
                })
                .signers([earnManagerOne])
                .rpc(),
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given the earner does not already have an earner account
          // given user token account is for the wrong token mint
          // it reverts with an token mint constraint error
          test("User token account is for the wrong token mint - reverts", async () => {
            // Create a new mint for the user token account
            const wrongMint = new Keypair();
            await $.createMint(
              wrongMint,
              $.nonAdmin.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );

            // Get the ATA for earner two on the wrong mint
            const earnerTwoATA = await $.getATA(
              wrongMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to add earner with user token account for wrong token mint
            await $.expectAnchorError(
              $.ext.methods
                .addEarner(earnerTwo.publicKey)
                .accounts({
                  signer: earnManagerOne.publicKey,
                  userTokenAccount: earnerTwoATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given the earner does not already have an earner account
          // given user token account authority does not match the user pubkey
          // it reverts with an address constraint error
          test("User token account authority does not match user pubkey - reverts", async () => {
            // Get the ATA for random user (not the same as the user)
            const randomATA = await $.getATA(
              $.extMint.publicKey,
              $.nonAdmin.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to add earner with user token account for wrong token mint
            await $.expectAnchorError(
              $.ext.methods
                .addEarner(earnerTwo.publicKey)
                .accounts({
                  signer: earnManagerOne.publicKey,
                  userTokenAccount: randomATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "ConstraintTokenOwner",
            );
          });

          test("Add earner (non ATA) - success", async () => {
            const { tokenAccount } = await $.createTokenAccount(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
              true,
            );

            const earnerAccount = $.getEarnerAccount(tokenAccount);

            // Add earner two to the earn manager's list
            await $.ext.methods
              .addEarner(earnerTwo.publicKey)
              .accounts({
                signer: earnManagerOne.publicKey,
                userTokenAccount: tokenAccount,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earner account was initialized correctly
            await $.expectEarnerState(earnerAccount, {
              earnManager: earnManagerOne.publicKey,
              lastClaimIndex: ONE,
              lastClaimTimestamp: $.currentTime(),
              user: earnerTwo.publicKey,
              userTokenAccount: tokenAccount,
            });
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given the earner does not already have an earner account
          // given user token account is for the correct token mint and the authority is the signer
          // it creates the earner account
          // it sets the earner is_active flag to true
          // it sets the earn_manager to the provided earn manager pubkey
          // it sets the last_claim_index to the current index
          // it sets the last_claim_timestamp to the current time
          test("Add earner ata - success", async () => {
            // Get the ATA for earner two
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Add earner one to the earn manager's list
            await $.ext.methods
              .addEarner(earnerTwo.publicKey)
              .accounts({
                signer: earnManagerOne.publicKey,
                userTokenAccount: earnerTwoATA,
              })
              .signers([earnManagerOne])
              .rpc();

            const earnerAccount = $.getEarnerAccount(earnerTwoATA);

            // Verify the earner account was initialized correctly
            await $.expectEarnerState(earnerAccount, {
              earnManager: earnManagerOne.publicKey,
              lastClaimIndex: ONE,
              lastClaimTimestamp: $.currentTime(),
              user: earnerTwo.publicKey,
              userTokenAccount: earnerTwoATA,
            });
          });
        });

        describe("remove_earner unit tests", () => {
          // test cases
          // [X] given signer does not have an earn manager account initialized
          //   [X] it reverts with an account not initialized error
          // [X] given signer has an earn manager account initialized
          //   [X] given earn manager account is not active
          //     [X] it reverts with a NotAuthorized error
          //   [X] given earn manager account is active
          //     [X] given the earner account does not have an earn manager
          //       [X] it reverts with a NotAuthorized error
          //     [X] given the earner account has an earn manager
          //       [X] given the earner's earn manager is not the signer
          //         [X] it reverts with a NotAuthorized error
          //       [X] given the earner's earn manager is the signer
          //         [X] the earner account is closed and the signer refunded the rent

          // given signer does not have an earn manager account initialized
          // it reverts with an account not initialized error
          test("Signer earn manager account not initialized - reverts", async () => {
            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to remove earner without an initialized earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .removeEarner()
                .accountsPartial({
                  signer: nonEarnManager.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([nonEarnManager])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is not active
          // it reverts with a NotActive error
          test("Signer's earn manager account not active - reverts", async () => {
            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Remove the earn manager account (set it to inactive)
            await $.removeEarnManager(earnManagerOne.publicKey);

            // Attempt to remove earner with an inactive earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .removeEarner()
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([earnManagerOne])
                .rpc(),
              "NotActive",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given the earner account has an earn manager
          // given the earner's earn manager is not the signer
          // it reverts with a NotAuthorized error
          test("Earner's earn manager is not signer - reverts", async () => {
            // Add earner manager two
            await $.addEarnManager(earnManagerTwo.publicKey, new BN(100));

            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to remove earner with the wrong earn manager
            await $.expectAnchorError(
              $.ext.methods
                .removeEarner()
                .accountsPartial({
                  signer: earnManagerTwo.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([earnManagerTwo])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given signer has an earn manager account initialized
          // given earn manager account is active
          // given the earner account has an earn manager
          // given the earner's earn manager is the signer
          // it closes the earner account and refunds the rent
          test("Earner's earn manager is signer - success", async () => {
            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerOneATA);

            // Remove the earner account
            await $.ext.methods
              .removeEarner()
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                earnerAccount,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earner account was closed
            $.expectAccountEmpty(earnerAccount);
          });
        });

        describe("transfer_earner unit tests", () => {
          // test cases
          // [X] given the earner does not have an account initialized
          //   [X] it reverts with an AccountNotInitialized error
          // [X] given the to earn manager does not have an account initialized
          //   [X] it reverts with an AccountNotInitialized error
          // [X] given the from earn manager does not sign the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the from earn manager does sign the transaction
          //   [X] given the from earn manager is not active
          //     [X] it reverts with a NotActive error
          //   [X] given the to earn manager is not active
          //     [X] it reverts with a NotActive error
          //   [X] given all the accounts are correct and earn managers are active
          //     [X] it updates the earner's earn manager to the "to earn manager"
          const nonEarnerOne = new Keypair();

          beforeEach(async () => {
            // Add second earn manager to have someone to transfer to
            await $.addEarnManager(earnManagerTwo.publicKey, new BN(100));
          });

          // given the earner does not have an account initialized
          // it reverts with an AccounbtNotInitialized error
          test("earner account not initialized - reverts", async () => {
            const nonEarnerOneATA = await $.getATA(
              $.extMint.publicKey,
              nonEarnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to transfer earner without an initialized account
            await $.expectAnchorError(
              $.ext.methods
                .transferEarner(earnManagerTwo.publicKey)
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  earnerAccount: $.getEarnerAccount(nonEarnerOneATA),
                })
                .signers([earnManagerOne])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given the to earn manager does not have an account initialized
          // it reverts with an AccountNotInitialized error
          test("to_earn_manager account not initialized - reverts", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to transfer earner to a non-initialized earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .transferEarner(nonEarnManager.publicKey)
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([earnManagerOne])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given the from earn manager does not sign the transaction
          // it reverts with a NotAuthorized error
          test("from earn manager does not sign transaction - reverts", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to transfer earner with a non-authorized signer
            await $.expectAnchorError(
              $.ext.methods
                .transferEarner(earnManagerTwo.publicKey)
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                  fromEarnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given the from earn manager does sign the transaction
          // given the from earn manager is not active
          // it reverts with a NotActive
          test("from earn manager is not active - reverts", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Remove the earn manager account (set it to inactive)
            await $.removeEarnManager(earnManagerOne.publicKey);

            // Attempt to transfer earner with an inactive earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .transferEarner(earnManagerTwo.publicKey)
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([earnManagerOne])
                .rpc(),
              "NotActive",
            );
          });

          // given the from earn manager signs the transaction
          // given the to earn manager is not active
          // it reverts with a NotActive error
          test("to earn manager is not active - reverts", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Remove the to earn manager account (set it to inactive)
            await $.removeEarnManager(earnManagerTwo.publicKey);

            // Attempt to transfer earner with an inactive to earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .transferEarner(earnManagerTwo.publicKey)
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  earnerAccount: $.getEarnerAccount(earnerOneATA),
                })
                .signers([earnManagerOne])
                .rpc(),
              "NotActive",
            );
          });

          // given the from earn manager signs the transaction
          // given the accounts are correct and the earn managers are active
          // it updates the earner's earn manager to the "to earn manager"
          test("transfer_earner - success", async () => {
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerOneATA);

            // Confirm the earner's earn manager is currently earnManagerOne
            await $.expectEarnerState(earnerAccount, {
              earnManager: earnManagerOne.publicKey,
            });

            // Transfer the earner from earn manager one to earn manager two
            await $.ext.methods
              .transferEarner(earnManagerTwo.publicKey)
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                earnerAccount,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earner account was updated
            await $.expectEarnerState(earnerAccount, {
              earnManager: earnManagerTwo.publicKey,
            });
          });
        });

        describe("configure_earn_manager unit tests", () => {
          // test cases
          // [X] given the earn manager account does not match the signer
          //   [X] it reverts with an address constraint error
          // [X] given the earn manager account matches the signer
          //   [X] given the fee basis points is greater than 100_00
          //     [X] it reverts with an InvalidParam error
          //   [X] given the fee basis points is less than or equal to 100_00
          //     [X] given the fee_token_account is for the wrong token mint
          //       [X] it reverts with an address constraint error
          //     [X] given the fee_token_account is for the correct token mint
          //       [X] given the earn manager account has not been initialized
          //         [X] it reverts with an AccountNotInitialized error
          //       [X] given the earn manager account has been initialized
          //         [X] given the fee_bps is null and the fee_token_account is null
          //           [X] nothing is updated
          //         [X] given the fee_bps is null and the fee_token_account is not null
          //           [X] it updates the fee_token_account to the provided token account
          //         [X] given the fee_bps is not null and the fee_token_account is null
          //           [X] it updates the fee_bps to the provided value
          //         [X] given the fee_bps is not null and the fee_token_account is not null
          //           [X] it updates the fee_bps to the provided value
          //           [X] it updates the fee_token_account to the provided token account

          // given the earn manager account does not match the signer
          // it reverts with a seeds constraint error
          test("Earn manager account does not match signer - reverts", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to configure earn manager with non-matching account
            await $.expectAnchorError(
              $.ext.methods
                .configureEarnManager(new BN(100))
                .accountsPartial({
                  signer: nonEarnManager.publicKey,
                  globalAccount: $.getExtGlobalAccount(),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  feeTokenAccount: earnManagerOneATA,
                })
                .signers([nonEarnManager])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given the earn manager account matches the signer
          // given the earn manager account is not initialized
          // it reverts with an AccountNotInitialized error
          test("Earn manager account not initialized - reverts", async () => {
            // Get the ATA for earn manager two
            const earnManagerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to configure earn manager that hasn't been initialized
            await $.expectAnchorError(
              $.ext.methods
                .configureEarnManager(new BN(0))
                .accountsPartial({
                  signer: earnManagerTwo.publicKey,
                  globalAccount: $.getExtGlobalAccount(),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerTwo.publicKey,
                  ),
                  feeTokenAccount: earnManagerTwoATA,
                })
                .signers([earnManagerTwo])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given the earn manager account matches the signer
          // given the fee basis points is greater than 100_00
          // it reverts with an InvalidParam error
          test("Fee basis points > 10000 - reverts", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            const feeBps = new BN(randomInt(10001, 2 ** 48 - 1));

            // Attempt to configure earn manager with invalid fee basis points
            await $.expectAnchorError(
              $.ext.methods
                .configureEarnManager(feeBps)
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  globalAccount: $.getExtGlobalAccount(),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  feeTokenAccount: earnManagerOneATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "InvalidParam",
            );
          });

          // given the earn manager account matches the signer
          // given the provided merkle proof for the signer is valid
          // given the fee basis points is less than or equal to 100_00
          // given the fee_token_account is for the wrong token mint
          // it reverts with a constraint token mint error
          test("Fee token account for wrong mint - reverts", async () => {
            // Create a new token mint
            const wrongMint = new Keypair();
            await $.createMint(
              wrongMint,
              $.nonAdmin.publicKey,
              $.admin.publicKey,
              $.useToken2022ForExt,
            );

            // Get the ATA for earn manager one with the wrong mint
            const wrongATA = await $.getATA(
              wrongMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Attempt to configure earn manager with invalid fee token account
            await $.expectAnchorError(
              $.ext.methods
                .configureEarnManager(new BN(100))
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  globalAccount: $.getExtGlobalAccount(),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  feeTokenAccount: wrongATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given the earn manager accounts matches the signer
          // given the provided merkle proof for the signer is valid
          // given the fee basis points is less than or equal to 100_00
          // given the fee_token_account is frozen
          // it reverts with an InvalidAccount error
          test("fee_token_account is frozen - reverts", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Freeze the token account
            await $.freezeTokenAccount(
              earnManagerOneATA,
              $.extMint.publicKey,
              $.admin,
              $.useToken2022ForExt,
            );

            // Attempt to configure earn manager with frozen fee token account
            await $.expectAnchorError(
              $.ext.methods
                .configureEarnManager(new BN(100))
                .accountsPartial({
                  signer: earnManagerOne.publicKey,
                  globalAccount: $.getExtGlobalAccount(),
                  earnManagerAccount: $.getEarnManagerAccount(
                    earnManagerOne.publicKey,
                  ),
                  feeTokenAccount: earnManagerOneATA,
                })
                .signers([earnManagerOne])
                .rpc(),
              "InvalidAccount",
            );
          });

          // given the earn manager account matches the signer
          // given the earn manager account already exists
          // given both the fee_bps and fee_token_account are null
          // nothing is updated
          test("Both fee bps and fee token account are null - success", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Confirm the earn manager account has already been created
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: earnManagerOneATA,
            });

            // Send the instruction
            await $.ext.methods
              .configureEarnManager(null)
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                globalAccount: $.getExtGlobalAccount(),
                earnManagerAccount: earnManagerAccount,
                feeTokenAccount: null,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earn manager account is created and updated
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: earnManagerOneATA,
            });
          });

          // given the earn manager account matches the signer
          // given the earn manager account already exists
          // given the fee_bps is not null and the fee_token_account is null
          // it updates the fee_bps to the provided value
          test("Fee bps not null, fee token account null - success", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Confirm the earn manager account has already been created
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: earnManagerOneATA,
            });

            const newFee = new BN(randomInt(0, 10000));

            // Send the instruction
            await $.ext.methods
              .configureEarnManager(newFee)
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                globalAccount: $.getExtGlobalAccount(),
                earnManagerAccount: earnManagerAccount,
                feeTokenAccount: null,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earn manager account is created and updated
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: newFee,
              feeTokenAccount: earnManagerOneATA,
            });
          });

          // given the earn manager account matches the signer
          // given the earn manager account already exists
          // given the fee_bps is null and the fee_token_account is not null
          // it updates the fee_token_account to the provided token account
          test("Fee bps null, fee token account not null - success", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Use the ATA for a different address to change the fee token account to
            // it's easier than creating a manual token account
            const newFeeTokenAccount = await $.getATA(
              $.extMint.publicKey,
              nonEarnManager.publicKey,
              $.useToken2022ForExt,
            );

            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Confirm the earn manager account has already been created
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: earnManagerOneATA,
            });

            // Send the instruction
            await $.ext.methods
              .configureEarnManager(null)
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                globalAccount: $.getExtGlobalAccount(),
                earnManagerAccount: earnManagerAccount,
                feeTokenAccount: newFeeTokenAccount,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earn manager account is created and updated
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: newFeeTokenAccount,
            });
          });

          // given the earn manager account matches the signer
          // given the earn manager account already exists
          // given both the fee_bps and fee_token_account are not null
          // it updates the fee_bps to the provided value
          // it updates the fee_token_account to the provided token account
          test("Both fee bps and fee token account are not null - success", async () => {
            // Get the ATA for earn manager one
            const earnManagerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnManagerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Use the ATA for a different address to change the fee token account to
            // it's easier than creating a manual token account
            const newFeeTokenAccount = await $.getATA(
              $.extMint.publicKey,
              nonEarnManager.publicKey,
              $.useToken2022ForExt,
            );

            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Confirm the earn manager account has already been created
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: new BN(0),
              feeTokenAccount: earnManagerOneATA,
            });

            const newFee = new BN(randomInt(0, 10000));

            // Send the instruction
            await $.ext.methods
              .configureEarnManager(newFee)
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                globalAccount: $.getExtGlobalAccount(),
                earnManagerAccount: earnManagerAccount,
                feeTokenAccount: newFeeTokenAccount,
              })
              .signers([earnManagerOne])
              .rpc();

            // Verify the earn manager account is created and updated
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: true,
              feeBps: newFee,
              feeTokenAccount: newFeeTokenAccount,
            });
          });
        });

        describe("remove_orphaned_earner unit tests", () => {
          // test cases
          // [X] given the earner account is not initialized
          //   [X] it reverts with an account not initialized error
          // [X] given the earn manager account is not initialized
          //   [X] it reverts with an account not initialized error
          // [X] given the earn manager account does not match the one on the earner account
          //   [X] it reverts with a ConstraintSeeds error
          // [X] given all the accounts are valid
          //   [X] given the earner has an earn manager
          //     [X] given the earn manager account is active
          //       [X] it reverts with a Active error
          //     [X] given the earn manager account is not active
          //       [X] it closes the earner account and refunds the rent to the signer

          beforeEach(async () => {
            // Add another earn manager
            await $.addEarnManager(earnManagerTwo.publicKey, new BN(0));

            // Add an earner under the new earn manager
            await $.addEarner(earnManagerTwo, earnerTwo.publicKey);

            // Remove earn manager two so that earner two is orphaned
            await $.removeEarnManager(earnManagerTwo.publicKey);
          });

          // given the earner account is not initialized
          // it reverts with an account not initialized error
          test("Earner account is not initialized - reverts", async () => {
            // Calculate the ATA for non earner one, but don't create it
            const nonInitATA = getAssociatedTokenAddressSync(
              $.extMint.publicKey,
              nonEarnManager.publicKey,
              true,
              $.extTokenProgram,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            );

            // Get the earner account PDA
            const earnerAccount = $.getEarnerAccount(nonInitATA);

            // Get the earn manager account PDA
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Attempt to remove orphaned earner with uninitialized token account
            await $.expectAnchorError(
              $.ext.methods
                .removeOrphanedEarner()
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: earnerAccount,
                  earnManagerAccount: earnManagerAccount,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given the earn manager account is not initialized
          // it reverts with an account not initialized error
          test("Earn manager account is not initialized - reverts", async () => {
            // Get the ATA for earner two
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner account PDA
            const earnerAccount = $.getEarnerAccount(earnerTwoATA);

            // Get the earn manager account PDA for the non-earn manager
            const earnManagerAccount = $.getEarnManagerAccount(
              nonEarnManager.publicKey,
            );

            // Attempt to remove orphaned earner with uninitialized earn manager account
            await $.expectAnchorError(
              $.ext.methods
                .removeOrphanedEarner()
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: earnerAccount,
                  earnManagerAccount: earnManagerAccount,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "AccountNotInitialized",
            );
          });

          // given all the accounts are valid
          // given the earner has an earn manager
          // given the earn manager account is active
          // it reverts with an Active error
          test("Earn manager account is active - reverts", async () => {
            // Get the ATA for earner one
            const earnerOneATA = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner account PDA
            const earnerAccount = $.getEarnerAccount(earnerOneATA);

            // Get the earn manager account PDA
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Attempt to remove orphaned earner with an active earn manager
            await $.expectAnchorError(
              $.ext.methods
                .removeOrphanedEarner()
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: earnerAccount,
                  earnManagerAccount: earnManagerAccount,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "Active",
            );
          });

          // given the earn manager account does not match the earner's earn manager
          // it reverts with a ConstraintSeeds error
          test("Invalid earn manager account - reverts", async () => {
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner account PDA
            const earnerAccount = $.getEarnerAccount(earnerTwoATA);

            // Get the wrong earn manager account PDA (earnManagerOne instead of earnManagerTwo)
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerOne.publicKey,
            );

            // Attempt to remove orphaned earner with the wrong earn manager account
            // expect revert with ConstraintSeeds error
            await $.expectAnchorError(
              $.ext.methods
                .removeOrphanedEarner()
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: earnerAccount,
                  earnManagerAccount: earnManagerAccount,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "ConstraintSeeds",
            );
          });

          // given all the accounts are valid
          // given the earner has an earn manager
          // given the earn manager account is not active
          // it closes the earner account and refunds the rent to the signer
          test("Remove orphaned earner - success", async () => {
            // Get the ATA for earnerTwo
            const earnerTwoATA = await $.getATA(
              $.extMint.publicKey,
              earnerTwo.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner and earn manager account PDAs
            const earnerAccount = $.getEarnerAccount(earnerTwoATA);
            const earnManagerAccount = $.getEarnManagerAccount(
              earnManagerTwo.publicKey,
            );

            // Confirm that the account is active and has the correct earn manager
            await $.expectEarnerState(earnerAccount, {
              earnManager: earnManagerTwo.publicKey,
            });

            // Confirm that the earn manager account is not active
            await $.expectEarnManagerState(earnManagerAccount, {
              isActive: false,
            });

            // Remove the orphaned earner
            await $.ext.methods
              .removeOrphanedEarner()
              .accountsPartial({
                signer: $.nonAdmin.publicKey,
                earnerAccount: earnerAccount,
                earnManagerAccount: earnManagerAccount,
              })
              .signers([$.nonAdmin])
              .rpc();

            // Verify the earner account was closed
            $.expectAccountEmpty(earnerAccount);
          });
        });
      });

      describe("earner instruction tests", () => {
        let startRecipientAccount: PublicKey;
        const earnManagerOne = new Keypair();
        const earnerOne = new Keypair();
        const yieldRecipient = new Keypair();
        const nonEarnerOne = new Keypair();

        beforeEach(async () => {
          // Airdrop SOL to the earn managers and earners to pay for transactions
          for (const account of [
            earnManagerOne,
            earnerOne,
            yieldRecipient,
            nonEarnerOne,
          ]) {
            $.svm.airdrop(account.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
          }

          // Initialize the program
          await $.initializeExt(
            [$.admin.publicKey, $.wrapAuthority.publicKey],
            undefined,
          );

          // Add an earn manager
          await $.addEarnManager(earnManagerOne.publicKey, new BN(0));

          // Add an earner under the earn manager
          await $.addEarner(earnManagerOne, earnerOne.publicKey);

          // Set the earners recipient token account initially to the non earner one ATA
          // This way we can tell when we set it back to None
          startRecipientAccount = await $.getATA(
            $.extMint.publicKey,
            nonEarnerOne.publicKey,
            $.useToken2022ForExt,
          );
          const earnerATA = await $.getATA(
            $.extMint.publicKey,
            earnerOne.publicKey,
            $.useToken2022ForExt,
          );
          const earnerAccount = $.getEarnerAccount(earnerATA);
          await $.setRecipient(earnerOne, earnerAccount, startRecipientAccount);
        });

        describe("set_recipient unit tests", () => {
          // test cases
          // [X] given neither the earner or earn manager signs the transaction
          //   [X] it reverts with a NotAuthorized error
          // [X] given the recipient token account is None
          //   [X] given the earner signs the transaction
          //     [X] it updates the earner's recipient token account to None (defaults to user token account)
          //   [X] given the earn manager signs the transaction
          //     [X] it updates the earner's recipient token account to None (defaults to user token account)
          // [X] given a recipient token account is provided
          //   [X] given the recipient token account is for the wrong mint
          //     [X] it reverts with a ConstraintTokenMint error
          //   [X] given the recipient token account is valid
          //     [X] given the earner signs the transaction
          //       [X] it updates the earner's recipient token account to the provided value
          //     [X] given the earn manager signs the transaction
          //       [X] it updates the earner's recipient token account to the provided value

          // given the new recipient token account is None
          // given the earner signers the transaction
          // it updates the recipient account to None
          test("Earner signs, new recipient token account is None (default) - success", async () => {
            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Check the starting value
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: startRecipientAccount,
            });

            // Send the instruction
            await $.ext.methods
              .setRecipient()
              .accountsPartial({
                signer: earnerOne.publicKey,
                earnerAccount: earnerAccount,
                recipientTokenAccount: null,
              })
              .signers([earnerOne])
              .rpc();

            // Check that the recipient token account was updated
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: undefined,
            });
          });

          // given the new recipient token account is None
          // given the earn manager signs the transaction
          // it updates the recipient account to None
          test("Earn manager signs, new recipient token account is None (default) - success", async () => {
            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Check the starting value
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: startRecipientAccount,
            });

            // Send the instruction
            await $.ext.methods
              .setRecipient()
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                earnerAccount: earnerAccount,
                recipientTokenAccount: null,
              })
              .signers([earnManagerOne])
              .rpc();

            // Check that the recipient token account was updated
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: undefined,
            });
          });

          // given the transaction is not signed by the earner or the earn manager
          // it reverts with a NotAuthorized error
          test("Neither earner nor earn manager signs the transaction - reverts", async () => {
            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Send the instruction
            // Expect revert with a NotAuthorized error
            await $.expectAnchorError(
              $.ext.methods
                .setRecipient()
                .accountsPartial({
                  signer: $.nonAdmin.publicKey,
                  earnerAccount: earnerAccount,
                  recipientTokenAccount: null,
                })
                .signers([$.nonAdmin])
                .rpc(),
              "NotAuthorized",
            );
          });

          // given a recipient token account is provided
          // given the recipient token account is for the wrong mint
          // it reverts with a ConstraintTokenMint error
          test("Recipient token account is for the wrong mint - reverts", async () => {
            // Create an ATA for the wrong mint (M mint instead of EXT mint)
            const wrongMintATA = await $.getATA(
              $.mMint.publicKey,
              earnerOne.publicKey,
            );

            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Attempt to send the transaction
            // Expect a ConstraintTokenMint error
            await $.expectAnchorError(
              $.ext.methods
                .setRecipient()
                .accountsPartial({
                  signer: earnerOne.publicKey,
                  earnerAccount: earnerAccount,
                  recipientTokenAccount: wrongMintATA,
                })
                .signers([earnerOne])
                .rpc(),
              "ConstraintTokenMint",
            );
          });

          // given a recipient token account is provided
          // given the recipient token account is valid
          // given the earner signs the transaction
          // it updates the earner's recipient token account to the provided token account
          test("Earner signs, new recipient token account provided - success", async () => {
            // Get the ATA for the recipient (use yieldRecipient as the recipient)
            const recipientATA = await $.getATA(
              $.extMint.publicKey,
              yieldRecipient.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Send the instruction
            await $.ext.methods
              .setRecipient()
              .accountsPartial({
                signer: earnerOne.publicKey,
                earnerAccount: earnerAccount,
                recipientTokenAccount: recipientATA,
              })
              .signers([earnerOne])
              .rpc();

            // Check that the recipient token account was updated correctly
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: recipientATA,
            });
          });

          // given a recipient token account is provided
          // given the recipient token account is validr
          // given the earn manager signs the transaction
          // it updates the earner's recipient token account to the provided token account
          test("Earn manager signs, new recipient token account provided - success", async () => {
            // Get the ATA for the recipient (using yieldRecipient as the recipient)
            const recipientATA = await $.getATA(
              $.extMint.publicKey,
              yieldRecipient.publicKey,
              $.useToken2022ForExt,
            );

            // Get the earner account
            const earnerTokenAccount = await $.getATA(
              $.extMint.publicKey,
              earnerOne.publicKey,
              $.useToken2022ForExt,
            );
            const earnerAccount = $.getEarnerAccount(earnerTokenAccount);

            // Send the instruction
            await $.ext.methods
              .setRecipient()
              .accountsPartial({
                signer: earnManagerOne.publicKey,
                earnerAccount: earnerAccount,
                recipientTokenAccount: recipientATA,
              })
              .signers([earnManagerOne])
              .rpc();

            // Check that the recipient token account was updated correctly
            await $.expectEarnerState(earnerAccount, {
              recipientTokenAccount: recipientATA,
            });
          });
        });
      });
    }
  });
}
