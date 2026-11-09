use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use m_ext::cpi::accounts::{Unwrap, Wrap};
use m_ext::state::{EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED};

use crate::{
    errors::SwapError,
    state::{SwapGlobal, GLOBAL_SEED},
};

#[derive(Accounts)]
pub struct Swap<'info> {
    pub signer: Signer<'info>,

    // Required if the swap program is not whitelisted on the extension
    pub wrap_authority: Option<Signer<'info>>,
    pub unwrap_authority: Option<Signer<'info>>,

    /*
     * Program globals
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
    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        seeds::program = to_ext_program.key(),
        bump,
    )]
    /// CHECK: CPI will validate the global account
    pub to_global: AccountInfo<'info>,

    /*
     * Mints
     */
    #[account(mut)]
    /// Validated by unwrap on the extension program
    pub from_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    /// Validated by wrap on the extension program
    pub to_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = m_token_program)]
    pub m_mint: Box<InterfaceAccount<'info, Mint>>,

    /*
     * Token Accounts
     */
    #[account(
        mut,
        token::mint = from_mint,
        token::token_program = from_token_program,
    )]
    pub from_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = to_mint,
        token::token_program = to_token_program,
    )]
    pub to_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = m_mint,
        associated_token::authority = swap_global,
        associated_token::token_program = m_token_program,
    )]
    pub swap_m_account: Box<InterfaceAccount<'info, TokenAccount>>,

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
        seeds = [M_VAULT_SEED],
        seeds::program = to_ext_program.key(),
        bump,
    )]
    /// CHECK: account does not hold data
    pub to_m_vault_auth: AccountInfo<'info>,
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        seeds::program = from_ext_program.key(),
        bump,
    )]
    /// CHECK: account does not hold data
    pub from_mint_authority: AccountInfo<'info>,
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        seeds::program = to_ext_program.key(),
        bump,
    )]
    /// CHECK: account does not hold data
    pub to_mint_authority: AccountInfo<'info>,

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
    #[account(
        mut,
        associated_token::mint = m_mint,
        associated_token::authority = to_m_vault_auth,
        associated_token::token_program = m_token_program,
    )]
    pub to_m_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /*
     * Token Programs
     */
    pub from_token_program: Interface<'info, TokenInterface>,
    pub to_token_program: Interface<'info, TokenInterface>,
    pub m_token_program: Interface<'info, TokenInterface>,

    /*
     * Programs
     */
    /// CHECK: checked against whitelisted extensions
    pub from_ext_program: UncheckedAccount<'info>,
    /// CHECK: checked against whitelisted extensions
    #[account(constraint = to_ext_program.key() != from_ext_program.key())]
    pub to_ext_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> Swap<'info> {
    fn validate(
        &self,
        amount: u64,
        remaining_accounts: &[AccountInfo<'_>],
        remaining_accounts_split_idx: usize,
    ) -> Result<()> {
        for ext_program in [&self.from_ext_program, &self.to_ext_program] {
            if !self.swap_global.is_extension_whitelisted(ext_program.key) {
                return err!(SwapError::InvalidExtension);
            }
        }

        if remaining_accounts_split_idx > remaining_accounts.len() {
            return err!(SwapError::InvalidIndex);
        }

        if amount == 0 {
            return err!(SwapError::InvalidAmount);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(amount, ctx.remaining_accounts, remaining_accounts_split_idx))]
    pub fn handler(
        ctx: Context<'info, Self>,
        amount: u64,
        remaining_accounts_split_idx: usize,
    ) -> Result<()> {
        // Optional remaining accounts passed to the instructions
        let remaining_accounts = ctx.remaining_accounts;
        let (unwrap_remaining_accounts, wrap_remaining_accounts) =
            remaining_accounts.split_at(remaining_accounts_split_idx);

        // Set swap program as authority if none provided
        let unwrap_authority = match &ctx.accounts.unwrap_authority {
            Some(auth) => auth.to_account_info(),
            None => ctx.accounts.swap_global.to_account_info(),
        };

        // Unwrap a specific amount of extension token for M
        m_ext::cpi::unwrap(
            CpiContext::new_with_signer(
                ctx.accounts.from_ext_program.key(),
                Unwrap {
                    token_authority: ctx.accounts.signer.to_account_info(),
                    unwrap_authority: Some(unwrap_authority),
                    m_mint: ctx.accounts.m_mint.to_account_info(),
                    ext_mint: ctx.accounts.from_mint.to_account_info(),
                    global_account: ctx.accounts.from_global.to_account_info(),
                    m_vault: ctx.accounts.from_m_vault_auth.to_account_info(),
                    ext_mint_authority: ctx.accounts.from_mint_authority.to_account_info(),
                    to_m_token_account: ctx.accounts.swap_m_account.to_account_info(),
                    vault_m_token_account: ctx.accounts.from_m_vault.to_account_info(),
                    from_ext_token_account: ctx.accounts.from_token_account.to_account_info(),
                    m_token_program: ctx.accounts.m_token_program.to_account_info(),
                    ext_token_program: ctx.accounts.from_token_program.to_account_info(),
                },
                &[&[GLOBAL_SEED, &[ctx.accounts.swap_global.bump]]],
            )
            .with_remaining_accounts(unwrap_remaining_accounts.to_vec()),
            amount,
        )?;

        // Set swap program as authority if none provided
        let wrap_authority = match &ctx.accounts.wrap_authority {
            Some(auth) => auth.to_account_info(),
            None => ctx.accounts.swap_global.to_account_info(),
        };

        // Wrap the specified amount to the extension token
        m_ext::cpi::wrap(
            CpiContext::new_with_signer(
                ctx.accounts.to_ext_program.key(),
                Wrap {
                    token_authority: ctx.accounts.swap_global.to_account_info(),
                    wrap_authority: Some(wrap_authority),
                    m_mint: ctx.accounts.m_mint.to_account_info(),
                    ext_mint: ctx.accounts.to_mint.to_account_info(),
                    global_account: ctx.accounts.to_global.to_account_info(),
                    m_vault: ctx.accounts.to_m_vault_auth.to_account_info(),
                    ext_mint_authority: ctx.accounts.to_mint_authority.to_account_info(),
                    from_m_token_account: ctx.accounts.swap_m_account.to_account_info(),
                    vault_m_token_account: ctx.accounts.to_m_vault.to_account_info(),
                    to_ext_token_account: ctx.accounts.to_token_account.to_account_info(),
                    m_token_program: ctx.accounts.m_token_program.to_account_info(),
                    ext_token_program: ctx.accounts.to_token_program.to_account_info(),
                },
                &[&[GLOBAL_SEED, &[ctx.accounts.swap_global.bump]]],
            )
            .with_remaining_accounts(wrap_remaining_accounts.to_vec()),
            amount,
        )?;

        Ok(())
    }
}
