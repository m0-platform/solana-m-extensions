// external dependencies
use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::spl_token_2022::state::AccountState,
    token_interface::{Mint, Token2022, TokenAccount, TokenInterface},
};

// local dependencies
use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::{
        conversion::{
            amount_to_principal_down, multiplier_to_index, principal_to_amount_down,
            principal_to_amount_up, sync_index,
        },
        token::mint_tokens,
    },
};
use earn::utils::conversion::get_scaled_ui_config;

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        has_one = admin @ ExtError::NotAuthorized,
        has_one = m_mint @ ExtError::InvalidMint,
        has_one = ext_mint @ ExtError::InvalidMint,
        bump = global_account.bump,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    #[account(mint::token_program = m_token_program)]
    pub m_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, mint::token_program = ext_token_program)]
    pub ext_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: This account is validated by the seed, it stores no data
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump = global_account.ext_mint_authority_bump,
    )]
    pub ext_mint_authority: AccountInfo<'info>,

    /// CHECK: There is no data in this account, it is validated by the seed
    #[account(
        seeds = [M_VAULT_SEED],
        bump = global_account.m_vault_bump,
    )]
    pub m_vault: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = m_mint,
        associated_token::authority = m_vault,
        associated_token::token_program = m_token_program,
    )]
    pub vault_m_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Allowing the admin to specify the recipient account is more flexible
    /// so the authority of this token account is not checked
    #[account(
        mut,
        token::mint = ext_mint,
        token::token_program = ext_token_program,
    )]
    pub recipient_ext_token_account: InterfaceAccount<'info, TokenAccount>,

    pub m_token_program: Program<'info, Token2022>,
    pub ext_token_program: Interface<'info, TokenInterface>,
}

impl ClaimFees<'_> {
    pub fn handler(ctx: Context<Self>) -> Result<()> {
        let accounts = ctx.accounts;
        claim_excess(
            &mut accounts.global_account,
            &accounts.m_mint,
            &mut accounts.ext_mint,
            &accounts.ext_mint_authority,
            &accounts.vault_m_token_account,
            &accounts.recipient_ext_token_account,
            &accounts.ext_token_program,
        )
    }
}

fn claim_excess<'info>(
    global_account: &mut Account<'info, ExtGlobalV2>,
    m_mint: &InterfaceAccount<'info, Mint>,
    ext_mint: &mut InterfaceAccount<'info, Mint>,
    ext_mint_authority: &AccountInfo<'info>,
    vault_m_token_account: &InterfaceAccount<'info, TokenAccount>,
    recipient_ext_token_account: &InterfaceAccount<'info, TokenAccount>,
    ext_token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    // Do not allow claiming fees if the vault M token account is not approved as an earner (i.e. frozen)
    if vault_m_token_account.state != AccountState::Initialized {
        return err!(ExtError::VaultFrozen);
    }

    // Sync the index before allowing any collateral withdrawals
    let signer_bump = global_account.ext_mint_authority_bump;
    let ext_index: u64 = sync_index(
        ext_mint,
        global_account,
        m_mint,
        vault_m_token_account,
        ext_mint_authority,
        &[&[MINT_AUTHORITY_SEED, &[signer_bump]]],
        ext_token_program,
    )?;

    // Calculate the required collateral, rounding down to be conservative
    // This amount will always be greater than what is required in the check_solvency function
    // since it allows a rounding error of up to 2e-6
    let required_m = principal_to_amount_up(ext_mint.supply, ext_index)?;

    // Get the scaled UI config for the M mint to convert principal in the vault to M units
    let m_config = get_scaled_ui_config(m_mint)?;
    let m_index = multiplier_to_index(m_config.new_multiplier.into())?;

    // Excess M is the amount of M in the vault above the amount needed to fully collateralize the extension
    // We round down to be conservative with the current balance
    let vault_m = principal_to_amount_down(vault_m_token_account.amount, m_index)?;

    let excess = vault_m
        .checked_sub(required_m)
        .ok_or(ExtError::InsufficientCollateral)?; // This shouldn't underflow, but we check for safety

    let excess_principal = amount_to_principal_down(excess, ext_index)?;

    // Only transfer a positive amount of excess
    if excess_principal > 0 {
        mint_tokens(
            recipient_ext_token_account,
            excess_principal,
            ext_mint,
            ext_mint_authority,
            &[&[
                MINT_AUTHORITY_SEED,
                &[global_account.ext_mint_authority_bump],
            ]],
            ext_token_program,
        )?;

        emit!(FeesClaimed {
            recipient_token_account: recipient_ext_token_account.key(),
            amount: excess,
            principal: excess_principal,
        });
    }

    Ok(())
}

#[event]
pub struct FeesClaimed {
    pub recipient_token_account: Pubkey,
    pub amount: u64,
    pub principal: u64,
}
