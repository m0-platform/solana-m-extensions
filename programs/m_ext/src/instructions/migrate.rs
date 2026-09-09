// This instruction is optionally included when an extension needs to be upgraded from a previous version.
// It handles three cases for the M v2 migration:
// 1. Migrating wM from the legacy ext_earn program to the new m_ext "crank" variant, which involves a layout change
// 2. Migrating existing scaled-ui m_ext programs to the new M v2 variant, which involves adding a yield variant in the yield config
// 3. Migrating existing no-yield m_ext programs to the new M v2 variant, which involves adding a yield variant in the yield config
// All versions require resizing the global account to increase the space for the yield variant variable.

use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use anchor_spl::{
    token_2022::spl_token_2022::state::AccountState,
    token_interface::{Mint, Token2022, TokenAccount},
};
use cfg_if::cfg_if;
use spl_token_2022::extension::ExtensionType;

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, YieldConfig, YieldVariant, EXT_GLOBAL_SEED, M_VAULT_SEED},
};
use earn::{
    state::{EarnGlobal, GLOBAL_SEED as EARN_GLOBAL_SEED},
    utils::conversion::{get_mint_extensions, get_scaled_ui_config, principal_to_amount_down},
    ID as EARN_PROGRAM,
};

// Note: we have already ensured that the "migrate" feature is enabled when including this instruction
// Therfore, we only need to consider valid feature configurations here
cfg_if! {
    if #[cfg(feature = "wm")] {
        declare_program!(ext_earn);
        use ext_earn::accounts::ExtGlobal as ExtGlobalV1;
    } else if #[cfg(feature = "scaled-ui")] {
        declare_program!(m_ext_v1_scaled_ui);
        use m_ext_v1_scaled_ui::accounts::ExtGlobal as ExtGlobalV1;
    } else if #[cfg(feature = "no-yield")] {
        declare_program!(m_ext_v1_no_yield);
        use m_ext_v1_no_yield::accounts::ExtGlobal as ExtGlobalV1;
    }
}

/// Resizes and rewrites the V1 global account into the [`ExtGlobalV2`] layout and points the
/// extension at the V2 `$M` mint. See the module header above for the three supported
/// migration paths. Admin-only; requires the new vault `$M` ATA to exist, be thawed, and
/// cover the outstanding ext supply.
#[derive(Accounts)]
pub struct MigrateM<'info> {
    /// Note: this account is mutable to pay for the resize operation
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: This account is validated in the instruction
    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        bump,
    )]
    pub global_account: AccountInfo<'info>,

    #[account(
        seeds = [EARN_GLOBAL_SEED],
        seeds::program = EARN_PROGRAM,
        bump = m_earn_global_account.bump
    )]
    pub m_earn_global_account: Account<'info, EarnGlobal>,

    #[account(
        mint::token_program = m_token_program,
        mint::decimals = ext_mint.decimals,
        address = m_earn_global_account.m_mint,
    )]
    pub new_m_mint: InterfaceAccount<'info, Mint>,

    pub ext_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: This account is just a signer and is checked by the seeds
    #[account(
        seeds = [M_VAULT_SEED],
        bump,
    )]
    pub m_vault: UncheckedAccount<'info>,

    /// Note: this account must be created and thawed before the migration.
    #[account(
        associated_token::mint = new_m_mint,
        associated_token::authority = m_vault,
        associated_token::token_program = m_token_program,
        constraint = new_vault_m_token_account.state == AccountState::Initialized @ ExtError::InvalidAccount,
    )]
    pub new_vault_m_token_account: InterfaceAccount<'info, TokenAccount>,

    pub m_token_program: Program<'info, Token2022>,

    pub system_program: Program<'info, System>,
}

impl MigrateM<'_> {
    fn validate(&self) -> Result<()> {
        // deserialize the old global account and validate
        let old_global = {
            let data = &mut self.global_account.try_borrow_mut_data()?;
            let mut data_slice: &[u8] = &data;
            ExtGlobalV1::try_deserialize(&mut data_slice)?
        };

        if old_global.ext_mint != self.ext_mint.key() {
            return err!(ExtError::InvalidMint);
        }
        if old_global.admin != self.admin.key() {
            return err!(ExtError::NotAuthorized);
        }

        // Confirm that the new M mint has the ScaledUiAmount extension enabled
        let extensions = get_mint_extensions(&self.new_m_mint)?;

        if !extensions.contains(&ExtensionType::ScaledUiAmount) {
            return err!(ExtError::InvalidMint);
        }

        // Confirm that the new vault M token account has enough M to cover the outstanding supply of the extension
        let m_scaled_ui_config = get_scaled_ui_config(&self.new_m_mint)?;
        let new_vault_m_amount = principal_to_amount_down(
            self.new_vault_m_token_account.amount,
            m_scaled_ui_config.new_multiplier.into(),
        )?;

        // Get the supply of the extension, accounting for a scaled-ui conversion if necessary
        let ext_supply_amount;
        cfg_if! {
            if #[cfg(feature = "scaled-ui")] {
                let ext_scaled_ui_config = get_scaled_ui_config(&self.ext_mint)?;
                ext_supply_amount = principal_to_amount_down(
                    self.ext_mint.supply,
                    ext_scaled_ui_config.new_multiplier.into(),
                )?;
            } else {
                ext_supply_amount = self.ext_mint.supply;
            }
        };

        if new_vault_m_amount < ext_supply_amount {
            return err!(ExtError::InsufficientCollateral);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate())]
    pub fn handler(ctx: Context<Self>) -> Result<()> {
        // deserialize the old global account
        let old_global = {
            let data = &ctx.accounts.global_account.try_borrow_mut_data()?;
            let mut data_slice: &[u8] = &data;
            ExtGlobalV1::try_deserialize(&mut data_slice)?
        };

        // Create the new yield config based on the feature configuration and currently stored values
        let yield_config: YieldConfig;

        cfg_if! {
            if #[cfg(feature = "wm")] {
                yield_config = YieldConfig {
                    yield_variant: YieldVariant::Crank,
                    earn_authority: old_global.earn_authority,
                    last_m_index: old_global.index,
                    last_ext_index: old_global.index, // we set the extension index to the same as the M index since V1 used the same one
                    timestamp: old_global.timestamp,
                };
            } else if #[cfg(feature = "scaled-ui")] {
                yield_config = YieldConfig {
                    yield_variant: YieldVariant::ScaledUi,
                    fee_bps: old_global.yield_config.fee_bps,
                    last_m_index: old_global.yield_config.last_m_index,
                    last_ext_index: old_global.yield_config.last_ext_index,
                };
            } else if #[cfg(feature = "no-yield")] {
                yield_config = YieldConfig {
                    yield_variant: YieldVariant::NoYield,
                };
            }
        };

        // Resize the global account to accommodate the new yield config
        // We need to take into account the current number of wrap authorities
        let new_size = ExtGlobalV2::size(old_global.wrap_authorities.len());
        let account_info = ctx.accounts.global_account.to_account_info();
        account_info.realloc(new_size, false)?;

        // Send lamports to the global account to cover the resize cost
        let rent_exempt_lamports = Rent::get().unwrap().minimum_balance(new_size).max(1);
        let top_up_lamports = rent_exempt_lamports.saturating_sub(account_info.lamports());

        if top_up_lamports > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: account_info,
                    },
                ),
                top_up_lamports,
            )?;
        }

        // Create the new layout and
        // update the m_mint and m_earn_global_account fields
        let new_global = ExtGlobalV2 {
            admin: old_global.admin,
            pending_admin: None,
            ext_mint: old_global.ext_mint,
            m_mint: ctx.accounts.new_m_mint.key(),
            m_earn_global_account: ctx.accounts.m_earn_global_account.key(),
            bump: old_global.bump,
            m_vault_bump: old_global.m_vault_bump,
            ext_mint_authority_bump: old_global.ext_mint_authority_bump,
            yield_config,
            wrap_authorities: old_global.wrap_authorities.clone(),
        };

        // Write the new global account data
        let data = &mut ctx.accounts.global_account.try_borrow_mut_data()?;
        let slice: &mut [u8] = &mut *data;

        slice[..8].copy_from_slice(&ExtGlobalV2::DISCRIMINATOR);
        let mut remaining_slice = &mut slice[8..];
        new_global.serialize(&mut remaining_slice)?;

        Ok(())
    }
}
