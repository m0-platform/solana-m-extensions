use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::conversion::sync_index,
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, ID as TOKEN_2022_ID};

#[derive(Accounts)]
pub struct Sync<'info> {
    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        bump = global_account.bump,
        has_one = m_mint @ ExtError::InvalidMint,
        has_one = ext_mint @ ExtError::InvalidMint,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    pub m_mint: InterfaceAccount<'info, Mint>,

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

    #[account(
        mut,
        mint::token_program = ext_token_program,
    )]
    pub ext_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: This account is validated by the seed, it stores no data
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump = global_account.ext_mint_authority_bump,
    )]
    pub ext_mint_authority: AccountInfo<'info>,

    pub ext_token_program: Interface<'info, TokenInterface>,
}

impl Sync<'_> {
    /// Permissionless: recomputes the ext index from the latest `$M` multiplier (net of the
    /// yield fee) and pushes the resulting multiplier to the ext mint's ScaledUiAmount config.
    /// `wrap`/`unwrap` run the same sync internally, so calling this explicitly is only needed
    /// to refresh the multiplier between wraps. Contrast with the crank `sync`, which is
    /// earn-authority-gated and only snapshots indices for `claim_for`.

    pub fn handler(ctx: Context<Self>) -> Result<()> {
        // Sync the multiplier
        // This will update the multiplier on ext_mint
        // if it doesn't match the index on m_mint
        let signer_bump = ctx.accounts.global_account.ext_mint_authority_bump;
        sync_index(
            &mut ctx.accounts.ext_mint,
            &mut ctx.accounts.global_account,
            &ctx.accounts.m_mint,
            &ctx.accounts.vault_m_token_account,
            &ctx.accounts.ext_mint_authority,
            &[&[MINT_AUTHORITY_SEED, &[signer_bump]]],
            &ctx.accounts.ext_token_program,
        )?;

        Ok(())
    }
}
