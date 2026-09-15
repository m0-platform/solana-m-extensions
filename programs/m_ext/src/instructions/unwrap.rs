use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount, TokenInterface};

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::{
        conversion::{
            amount_to_principal_down, amount_to_principal_up, multiplier_to_index, sync_index,
        },
        token::{burn_tokens, transfer_tokens_from_program},
    },
};

#[derive(Accounts)]
pub struct Unwrap<'info> {
    pub token_authority: Signer<'info>,

    // Will be set if a whitelisted authority is signing for a user
    pub unwrap_authority: Option<Signer<'info>>,

    #[account(mint::token_program = m_token_program)]
    pub m_mint: InterfaceAccount<'info, Mint>,

    #[account(mut, mint::token_program = ext_token_program)]
    pub ext_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        bump = global_account.bump,
        has_one = m_mint @ ExtError::InvalidAccount,
        has_one = ext_mint @ ExtError::InvalidAccount,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    /// CHECK: This account is validated by the seed, it stores no data
    #[account(
        seeds = [M_VAULT_SEED],
        bump = global_account.m_vault_bump,
    )]
    pub m_vault: AccountInfo<'info>,

    /// CHECK: This account is validated by the seed, it stores no data
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump = global_account.ext_mint_authority_bump,
    )]
    pub ext_mint_authority: AccountInfo<'info>,

    #[account(
        mut,
        token::mint = m_mint,
        token::token_program = m_token_program,
        // authority of the to token account is not checked to allow unwrap + send
    )]
    pub to_m_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = m_mint,
        associated_token::authority = m_vault,
        associated_token::token_program = m_token_program,
    )]
    pub vault_m_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = ext_mint,
        token::token_program = ext_token_program,
        // signer must be the authority of the from token account or delegated by the owner
        // this is checked by the token program
    )]
    pub from_ext_token_account: InterfaceAccount<'info, TokenAccount>,

    // we have duplicate entries for the token2022 program since the interface needs to be consistent
    // but we want to leave open the possibility that either may not have to be token2022 in the future
    pub m_token_program: Program<'info, Token2022>,
    pub ext_token_program: Interface<'info, TokenInterface>,
}

impl Unwrap<'_> {
    pub fn validate(&self, amount: u64) -> Result<()> {
        let auth = match &self.unwrap_authority {
            Some(auth) => auth.key,
            None => self.token_authority.key,
        };

        // Ensure the caller is authorized to wrap
        if !self.global_account.wrap_authorities.contains(auth) {
            return err!(ExtError::NotAuthorized);
        }

        if amount == 0 {
            return err!(ExtError::InvalidAmount);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(amount))]
    pub fn handler(ctx: Context<Self>, amount: u64) -> Result<()> {
        let authority_seeds: &[&[&[u8]]] = &[&[
            MINT_AUTHORITY_SEED,
            &[ctx.accounts.global_account.ext_mint_authority_bump],
        ]];

        // If necessary, sync the index between M and Ext tokens
        // Return the current value to use for conversions
        let ext_index: u64 = sync_index(
            &mut ctx.accounts.ext_mint,
            &mut ctx.accounts.global_account,
            &ctx.accounts.m_mint,
            &ctx.accounts.vault_m_token_account,
            &ctx.accounts.ext_mint_authority,
            authority_seeds,
            &ctx.accounts.ext_token_program,
        )?;
        // Round the burned ext principal up so its value always covers the M released (Immunefi #92952)
        let ext_principal = amount_to_principal_up(amount, ext_index)?;

        // Get the current multiplier for the m_mint
        let m_scaled_ui_config =
            earn::utils::conversion::get_scaled_ui_config(&ctx.accounts.m_mint)?;
        let m_index: u64 = multiplier_to_index(m_scaled_ui_config.new_multiplier.into())?;

        // Calculate the principal amount of m tokens
        // from the amount of ext tokens to unwrap
        let m_principal: u64 = amount_to_principal_down(amount, m_index)?;

        // Confirm principal amounts are not zero
        require_gt!(m_principal, 0, ExtError::InvalidAmount);
        require_gt!(ext_principal, 0, ExtError::InvalidAmount);

        // Burn the amount of ext tokens from the user
        burn_tokens(
            &ctx.accounts.from_ext_token_account,            // from
            ext_principal,                                   // amount
            &ctx.accounts.ext_mint,                          // mint
            &ctx.accounts.token_authority.to_account_info(), // authority
            &ctx.accounts.ext_token_program,                 // token program
        )?;

        // Transfer the amount of m tokens from the m vault to the user
        transfer_tokens_from_program(
            &ctx.accounts.vault_m_token_account, // from
            &ctx.accounts.to_m_token_account,    // to
            m_principal,                         // amount
            &ctx.accounts.m_mint,                // mint
            &ctx.accounts.m_vault,               // authority
            &[&[M_VAULT_SEED, &[ctx.accounts.global_account.m_vault_bump]]], // authority seeds
            &ctx.accounts.m_token_program,       // token program
        )?;

        Ok(())
    }
}
