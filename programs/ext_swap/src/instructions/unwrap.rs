use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use m_ext::cpi::accounts::Unwrap as ExtUnwrap;
use m_ext::state::{EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED};

use crate::errors::SwapError;
use crate::state::{SwapGlobal, GLOBAL_SEED};

#[derive(Accounts)]
pub struct Unwrap<'info> {
    pub signer: Signer<'info>,

    // Required if the swap program is not whitelisted on the extension
    // or if the signer is not authorized to unwrap
    pub unwrap_authority: Option<Signer<'info>>,

    /*
     * Global and Earner accounts
     */
    #[account(
        seeds = [GLOBAL_SEED],
        bump = swap_global.bump,
    )]
    pub swap_global: Box<Account<'info, SwapGlobal>>,
    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        seeds::program = from_ext_program.key(),
        bump,
    )]
    /// CHECK: CPI will validate the global account
    pub from_global: AccountInfo<'info>,

    /*
     * Mints
     */
    #[account(mut)]
    /// Validated by unwrap on the extension program
    pub from_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = m_token_program)]
    pub m_mint: Box<InterfaceAccount<'info, Mint>>,

    /*
     * Token Accounts
     */
    #[account(
        mut,
        token::mint = m_mint,
        token::token_program = m_token_program,
    )]
    pub m_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = from_mint,
        token::token_program = from_token_program,
    )]
    pub from_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
     * Authorities
     */
    #[account(
        seeds = [M_VAULT_SEED],
        seeds::program = from_ext_program.key(),
        bump,
    )]
    /// CHECK: account does not hold data
    pub from_m_vault_auth: AccountInfo<'info>,
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        seeds::program = from_ext_program.key(),
        bump,
    )]
    /// CHECK: account does not hold data
    pub from_mint_authority: AccountInfo<'info>,

    /*
     * Vaults
     */
    #[account(
        mut,
        associated_token::mint = m_mint,
        associated_token::authority = from_m_vault_auth,
        associated_token::token_program = m_token_program,
    )]
    pub from_m_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
     * Token Programs
     */
    pub from_token_program: Interface<'info, TokenInterface>,
    pub m_token_program: Interface<'info, TokenInterface>,

    /*
     * Programs
     */
    /// CHECK: checked against whitelisted extensions
    pub from_ext_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> Unwrap<'info> {
    fn validate(&self, amount: u64) -> Result<()> {
        if !self
            .swap_global
            .is_extension_whitelisted(self.from_ext_program.key)
        {
            return err!(SwapError::InvalidExtension);
        }

        let unwrap_authority = match &self.unwrap_authority {
            Some(auth) => auth.key,
            None => self.signer.key,
        };

        if !self
            .swap_global
            .whitelisted_unwrappers
            .contains(unwrap_authority)
        {
            return err!(SwapError::UnauthorizedUnwrapper);
        }

        if amount == 0 {
            return err!(SwapError::InvalidAmount);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(amount))]
    pub fn handler(ctx: Context<'info, Self>, amount: u64) -> Result<()> {
        // Set swap program as authority if none provided
        let unwrap_authority = match &ctx.accounts.unwrap_authority {
            Some(auth) => auth.to_account_info(),
            None => ctx.accounts.swap_global.to_account_info(),
        };

        m_ext::cpi::unwrap(
            CpiContext::new_with_signer(
                ctx.accounts.from_ext_program.key(),
                ExtUnwrap {
                    token_authority: ctx.accounts.signer.to_account_info(),
                    unwrap_authority: Some(unwrap_authority),
                    m_mint: ctx.accounts.m_mint.to_account_info(),
                    ext_mint: ctx.accounts.from_mint.to_account_info(),
                    global_account: ctx.accounts.from_global.to_account_info(),
                    m_vault: ctx.accounts.from_m_vault_auth.to_account_info(),
                    ext_mint_authority: ctx.accounts.from_mint_authority.to_account_info(),
                    to_m_token_account: ctx.accounts.m_token_account.to_account_info(),
                    vault_m_token_account: ctx.accounts.from_m_vault.to_account_info(),
                    from_ext_token_account: ctx.accounts.from_token_account.to_account_info(),
                    m_token_program: ctx.accounts.m_token_program.to_account_info(),
                    ext_token_program: ctx.accounts.from_token_program.to_account_info(),
                },
                &[&[GLOBAL_SEED, &[ctx.accounts.swap_global.bump]]],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
        )
    }
}
