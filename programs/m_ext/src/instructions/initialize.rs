// external dependencies
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::state::AccountState,
    token_interface::{Mint, Token2022, TokenAccount, TokenInterface},
};
use cfg_if::cfg_if;
use earn::{
    state::{EarnGlobal, GLOBAL_SEED as EARN_GLOBAL_SEED},
    ID as EARN_PROGRAM,
};
use std::collections::HashSet;

// local dependencies
use crate::{
    errors::ExtError,
    state::{
        ExtGlobalV2, YieldConfig, YieldVariant, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED,
    },
};

// conditional dependencies
cfg_if! {
    if #[cfg(feature = "scaled-ui")] {
        use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
        use anchor_spl::token_2022::spl_token_2022::{self, extension::ExtensionType};
        use crate::{
            constants::{INDEX_SCALE_U64, ONE_HUNDRED_PERCENT_U64},
            utils::conversion::{sync_index, get_mint_extensions, get_scaled_ui_config, multiplier_to_index},
        };
    } else if #[cfg(feature = "crank")] {
        use earn::utils::conversion::get_scaled_ui_config;
        use crate::{
            constants::INDEX_SCALE_U64,
            utils::conversion::multiplier_to_index,
        };
    }
}

#[derive(Accounts)]
#[instruction(wrap_authorities: Vec<Pubkey>)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = ExtGlobalV2::size(
            wrap_authorities.len()
        ),
        seeds = [EXT_GLOBAL_SEED],
        bump
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    #[account(
        mint::token_program = m_token_program,
        address = m_earn_global_account.m_mint,
    )]
    pub m_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        mint::token_program = ext_token_program,
        mint::decimals = m_mint.decimals,
        constraint = ext_mint.supply == 0 @ ExtError::InvalidMint,
    )]
    pub ext_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated by the seeds, stores no data
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump
    )]
    pub ext_mint_authority: AccountInfo<'info>,

    /// CHECK: Validated by the seeds, stores no data
    #[account(
        seeds = [M_VAULT_SEED],
        bump
    )]
    pub m_vault: AccountInfo<'info>,

    // We require the vault m token account to be initialized and thawed to initialize the extension.
    // This ensures that it is permissioned to hold $M.
    #[account(
        associated_token::mint = m_mint,
        associated_token::authority = m_vault,
        associated_token::token_program = m_token_program,
        constraint = vault_m_token_account.state == AccountState::Initialized @ ExtError::InvalidAccount,
    )]
    pub vault_m_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [EARN_GLOBAL_SEED],
        seeds::program = EARN_PROGRAM,
        bump = m_earn_global_account.bump,
    )]
    pub m_earn_global_account: Account<'info, EarnGlobal>,

    pub m_token_program: Program<'info, Token2022>, // we have duplicate entries for the token2022 program bc the M token program could change in the future

    pub ext_token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

impl Initialize<'_> {
    // This instruction initializes the Scaled UI M extension for a given ext mint.
    // It sets up the global account, validates the mint and its authority,
    // and initializes the Scaled UI multiplier to 1.0.
    // The ext_mint must have a supply of 0 to start.
    // The wrap authorities are validated and stored in the global account.
    // The fee_bps is used by the scaled-ui variant. It is validated to be within the allowed range.
    // The earn_authority is only required for the crank variant.
    fn validate(&self, _fee_bps: Option<u64>, _earn_authority: Option<Pubkey>) -> Result<()> {
        // Validate the ext_mint_authority PDA is the mint authority for the ext mint
        let ext_mint_authority = self.ext_mint_authority.key();
        if self.ext_mint.mint_authority.unwrap_or_default() != ext_mint_authority {
            return err!(ExtError::InvalidMint);
        }

        // Validate that the ext mint has a freeze authority
        if self.ext_mint.freeze_authority.is_none() {
            return err!(ExtError::InvalidMint);
        }

        cfg_if! {
            if #[cfg(feature = "scaled-ui")] {
                // Validate that the ext token program is token2022
                if self.ext_token_program.key() != spl_token_2022::ID {
                    return err!(ExtError::InvalidTokenProgram);
                }

                // Validate that the ext mint has the ScaledUiAmount extension and
                // that the ext mint authority is the extension authority
                let extensions = get_mint_extensions(&self.ext_mint)?;

                if !extensions.contains(&ExtensionType::ScaledUiAmount) {
                    return err!(ExtError::InvalidMint);
                }

                let scaled_ui_config = get_scaled_ui_config(&self.ext_mint)?;
                if scaled_ui_config.authority != OptionalNonZeroPubkey(ext_mint_authority) {
                    return err!(ExtError::InvalidMint);
                }

                // Validate the fee_bps is within the allowed range
                if _fee_bps.unwrap_or(0) > ONE_HUNDRED_PERCENT_U64 {
                    return err!(ExtError::InvalidParam);
                }
            } else if #[cfg(feature = "crank")] {
                // Validate the earn authority is provided
                if _earn_authority.is_none() {
                    return err!(ExtError::InvalidParam);
                }
            }
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(fee_bps, earn_authority))]
    pub fn handler(
        ctx: Context<Initialize>,
        wrap_authorities: Vec<Pubkey>,
        fee_bps: Option<u64>,
        earn_authority: Option<Pubkey>,
    ) -> Result<()> {
        // Create hash set from wrap_authorities to ensure uniqueness
        let wrap_auth_set: HashSet<Pubkey> = wrap_authorities.clone().into_iter().collect();
        if wrap_auth_set.len() < wrap_authorities.len() {
            return err!(ExtError::InvalidParam);
        }

        // Create the yield config
        let yield_config: YieldConfig;
        cfg_if! {
            if #[cfg(feature = "scaled-ui")] {
                let m_scaled_ui_config = get_scaled_ui_config(&ctx.accounts.m_mint)?;
                let m_index: u64 = multiplier_to_index(m_scaled_ui_config.new_multiplier.into())?;
                yield_config = YieldConfig {
                    yield_variant: YieldVariant::ScaledUi,
                    fee_bps: fee_bps.unwrap_or(0),
                    last_m_index: m_index,
                    last_ext_index: INDEX_SCALE_U64, // we set the extension index to 1.0 initially
                };
            } else if #[cfg(feature = "crank")] {
               let m_scaled_ui_config = get_scaled_ui_config(&ctx.accounts.m_mint)?;
                let timestamp: i64 = m_scaled_ui_config.new_multiplier_effective_timestamp.into();
                let m_index: u64 = multiplier_to_index(m_scaled_ui_config.new_multiplier.into())?;

                yield_config = YieldConfig {
                    yield_variant: YieldVariant::Crank,
                    earn_authority: earn_authority.unwrap_or_default(),
                    last_m_index: m_index,
                    last_ext_index: INDEX_SCALE_U64, // we set the extension index to 1.0 initially
                    timestamp: timestamp as u64,
                };
            } else {
                yield_config = YieldConfig {
                    yield_variant: YieldVariant::NoYield,
                };
            }
        }

        // Initialize the ExtGlobalV2 account
        ctx.accounts.global_account.set_inner(ExtGlobalV2 {
            admin: ctx.accounts.admin.key(),
            pending_admin: None,
            ext_mint: ctx.accounts.ext_mint.key(),
            m_mint: ctx.accounts.m_mint.key(),
            m_earn_global_account: ctx.accounts.m_earn_global_account.key(),
            bump: ctx.bumps.global_account,
            m_vault_bump: ctx.bumps.m_vault,
            ext_mint_authority_bump: ctx.bumps.ext_mint_authority,
            yield_config,
            wrap_authorities,
        });

        // Set the ScaledUi multiplier to 1.0
        // We can do this by calling the sync_multiplier function
        // when the last_m_index equals the index on the m_earn_global_account
        // and having last_ext_index set to 1e12
        #[cfg(feature = "scaled-ui")]
        sync_index(
            &mut ctx.accounts.ext_mint,
            &mut ctx.accounts.global_account,
            &ctx.accounts.m_mint,
            &ctx.accounts.vault_m_token_account,
            &ctx.accounts.ext_mint_authority,
            &[&[MINT_AUTHORITY_SEED, &[ctx.bumps.ext_mint_authority]]],
            &ctx.accounts.ext_token_program,
        )?;

        Ok(())
    }
}
