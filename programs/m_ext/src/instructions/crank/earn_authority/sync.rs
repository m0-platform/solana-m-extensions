use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::state::AccountState,
    token_interface::{Mint, TokenAccount, ID as TOKEN_2022_ID},
};
use earn::utils::conversion::get_scaled_ui_config;

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, M_VAULT_SEED},
    utils::conversion::multiplier_to_index,
};

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        constraint = earn_authority.key() == global_account.yield_config.earn_authority @ ExtError::NotAuthorized,
    )]
    pub earn_authority: Signer<'info>,

    pub m_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        bump = global_account.bump,
        has_one = m_mint @ ExtError::InvalidAccount,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    /// CHECK: This account is validated by the seed, it stores no data
    #[account(
        seeds = [M_VAULT_SEED],
        bump = global_account.m_vault_bump,
    )]
    pub m_vault: UncheckedAccount<'info>,

    #[account(
        associated_token::mint = m_mint,
        associated_token::authority = m_vault,
        associated_token::token_program = TOKEN_2022_ID,
    )]
    pub vault_m_token_account: InterfaceAccount<'info, TokenAccount>,
}

impl Sync<'_> {
    /// Allows the earn authority to sync the index and timestamp with the latest values.
    /// It recalculates the index based on the current multiplier and updates the global account.
    /// The multiplier is scaled to a u64 index for storage.
    ///
    /// Crank variant: this only snapshots the indices into `YieldConfig` to open a new claim
    /// cycle for `claim_for` — the ext mint itself is untouched (ext tokens stay 1:1 with `$M`).
    /// Contrast with the scaled-ui `sync`, which is permissionless and pushes a new multiplier
    /// to the ext mint. The ext index only advances while the vault is an approved earner
    /// (token account thawed).

    pub fn handler(ctx: Context<Self>) -> Result<()> {
        // Convert the latest M multiplier to a u64 index
        let scaled_ui_config = get_scaled_ui_config(&ctx.accounts.m_mint)?;
        let current_multiplier: f64 = scaled_ui_config.new_multiplier.into();
        let timestamp: i64 = scaled_ui_config.new_multiplier_effective_timestamp.into();
        let current_index: u64 = multiplier_to_index(current_multiplier)?;

        // If the vault M token account is approved as an earner, calculate the new EXT index and update it
        if ctx.accounts.vault_m_token_account.state == AccountState::Initialized {
            // Calculate the new EXT index based on the last synced EXT index and the change in M index
            let last_ext_index = ctx.accounts.global_account.yield_config.last_ext_index;
            let last_m_index = ctx.accounts.global_account.yield_config.last_m_index;

            let new_ext_index = (last_ext_index as u128)
                .checked_mul(current_index as u128)
                .ok_or(ExtError::MathOverflow)?
                .checked_div(last_m_index as u128)
                .ok_or(ExtError::MathUnderflow)? as u64;

            ctx.accounts.global_account.yield_config.last_ext_index = new_ext_index;
        }

        // Update the M index and timestamp to the current values on the M mint
        ctx.accounts.global_account.yield_config.last_m_index = current_index;
        ctx.accounts.global_account.yield_config.timestamp = timestamp as u64;

        emit!(SyncIndexUpdate {
            m_index: ctx.accounts.global_account.yield_config.last_m_index,
            ext_index: ctx.accounts.global_account.yield_config.last_ext_index,
            ts: ctx.accounts.global_account.yield_config.timestamp,
        });

        Ok(())
    }
}

#[event]
pub struct SyncIndexUpdate {
    pub m_index: u64,
    pub ext_index: u64,
    pub ts: u64,
}
