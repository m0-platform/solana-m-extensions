// Hand this extension's mint over to an M0 V2 Issuer Gateway deployment.
// One-shot in effect: after it runs the program no longer holds the mint
// authority, so a second call fails inside the token program. The V2 side
// must run `adopt_stablecoin` first — the target account is required to be a
// gateway `Stablecoin` in `AdoptionPending`; `complete_adoption` verifies the
// end state after the remaining authorities move off-chain.
//
// In order: gate (admin + solvency), verify the derived target, move the mint
// authority, sweep the $M vault to the treasury and close it, clear
// `wrap_authorities` (wrap/unwrap are already dead without the mint
// authority; the empty list is defense).

use anchor_lang::{prelude::*, solana_program::program_option::COption};
use anchor_spl::{
    token_2022::{
        close_account, set_authority, spl_token_2022::instruction::AuthorityType, CloseAccount,
        SetAuthority,
    },
    token_interface::{Mint, Token2022, TokenAccount},
};

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::token::transfer_tokens_from_program,
};
use earn::utils::conversion::{get_scaled_ui_config, principal_to_amount_down};

// The gateway `Stablecoin` wire facts this instruction checks. Pinned here the
// way other foreign layouts are; the source of truth is
// m0-v2/svm/crates/state/src/stablecoin.rs.
const STABLECOIN_SEED: &[u8] = b"stablecoin";
const STABLECOIN_DISCRIMINATOR: u8 = 2;
const STABLECOIN_ACCOUNT_VERSION: u8 = 1;
const MINT_ORIGIN_OFFSET: usize = 5;
const MINT_ORIGIN_ADOPTION_PENDING: u8 = 1;
const MINT_OFFSET: usize = 10;

#[derive(Accounts)]
pub struct Handoff<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        bump = global_account.bump,
        has_one = admin @ ExtError::NotAuthorized,
        has_one = ext_mint @ ExtError::InvalidAccount,
        has_one = m_mint @ ExtError::InvalidAccount,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    #[account(mut, mint::token_program = m_token_program)]
    pub ext_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated by the seed; signs the mint-authority transfer.
    #[account(
        seeds = [MINT_AUTHORITY_SEED],
        bump = global_account.ext_mint_authority_bump,
    )]
    pub ext_mint_authority: AccountInfo<'info>,

    /// CHECK: Validated in the instruction — the gateway `Stablecoin` PDA
    /// derived from the `gateway_program` argument, never a raw address.
    pub stablecoin: AccountInfo<'info>,

    #[account(mint::token_program = m_token_program)]
    pub m_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated by the seed; signs the vault sweep and close.
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

    /// The M0 treasury account the swept $M lands in; M0 redeems it off-program.
    #[account(
        mut,
        token::mint = m_mint,
        token::token_program = m_token_program,
    )]
    pub treasury_m_token_account: InterfaceAccount<'info, TokenAccount>,

    pub m_token_program: Program<'info, Token2022>,
}

impl Handoff<'_> {
    fn validate(&self, gateway_program: &Pubkey) -> Result<()> {
        // The gateway's complete_adoption requires the freeze authority to
        // arrive at its PDA. If it sits at this program's own PDA, nothing can
        // ever move it — refuse before the irreversible sweep.
        if self.ext_mint.freeze_authority
            == COption::Some(self.ext_mint_authority.key())
        {
            return err!(ExtError::FreezeAuthorityUnreachable);
        }

        // Solvency: vault $M covers the outstanding ext supply (the migrate_m
        // check). $M is scaled-ui, so the vault principal converts through the
        // multiplier in force NOW — a scheduled future multiplier must not
        // value an irreversible sweep.
        let m_scaled_ui_config = get_scaled_ui_config(&self.m_mint)?;
        let now = Clock::get()?.unix_timestamp;
        let multiplier: f64 =
            if now >= i64::from(m_scaled_ui_config.new_multiplier_effective_timestamp) {
                m_scaled_ui_config.new_multiplier.into()
            } else {
                m_scaled_ui_config.multiplier.into()
            };
        let vault_m_amount =
            principal_to_amount_down(self.vault_m_token_account.amount, multiplier)?;
        if vault_m_amount < self.ext_mint.supply {
            return err!(ExtError::InsufficientCollateral);
        }

        // The target is derived, never accepted: the gateway's
        // `["stablecoin", ext_mint]` PDA for the id passed in.
        let (expected, _) = Pubkey::find_program_address(
            &[STABLECOIN_SEED, self.ext_mint.key().as_ref()],
            gateway_program,
        );
        if self.stablecoin.key() != expected || self.stablecoin.owner != gateway_program {
            return err!(ExtError::InvalidAccount);
        }

        // The account must be a live `Stablecoin` in `AdoptionPending` bound to
        // this mint, so the authority never moves to an unverified target.
        let data = self.stablecoin.try_borrow_data()?;
        if data.len() <= MINT_OFFSET + 32
            || data[0] != STABLECOIN_DISCRIMINATOR
            || data[1] != STABLECOIN_ACCOUNT_VERSION
            || data[MINT_ORIGIN_OFFSET] != MINT_ORIGIN_ADOPTION_PENDING
            || data[MINT_OFFSET..MINT_OFFSET + 32] != self.ext_mint.key().to_bytes()
        {
            return err!(ExtError::InvalidAccount);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(&gateway_program))]
    pub fn handler(ctx: Context<Self>, gateway_program: Pubkey) -> Result<()> {
        let _ = gateway_program; // consumed by validate

        // Move the mint authority to the verified Stablecoin PDA.
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.m_token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.ext_mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.ext_mint.to_account_info(),
                },
                &[&[
                    MINT_AUTHORITY_SEED,
                    &[ctx.accounts.global_account.ext_mint_authority_bump],
                ]],
            ),
            AuthorityType::MintTokens,
            Some(ctx.accounts.stablecoin.key()),
        )?;

        // Sweep the whole $M unwind: holders hold ext tokens, never $M, so the
        // vault is the only $M account in the system.
        let vault_seeds: &[&[&[u8]]] =
            &[&[M_VAULT_SEED, &[ctx.accounts.global_account.m_vault_bump]]];
        let vault_principal = ctx.accounts.vault_m_token_account.amount;
        if vault_principal > 0 {
            transfer_tokens_from_program(
                &ctx.accounts.vault_m_token_account,
                &ctx.accounts.treasury_m_token_account,
                vault_principal,
                &ctx.accounts.m_mint,
                &ctx.accounts.m_vault,
                vault_seeds,
                &ctx.accounts.m_token_program,
            )?;
        }
        close_account(CpiContext::new_with_signer(
            ctx.accounts.m_token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_m_token_account.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(),
                authority: ctx.accounts.m_vault.to_account_info(),
            },
            vault_seeds,
        ))?;

        // Tombstone: wrap/unwrap already fail without the mint authority.
        ctx.accounts.global_account.wrap_authorities = vec![];

        Ok(())
    }
}
