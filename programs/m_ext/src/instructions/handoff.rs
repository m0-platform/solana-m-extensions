// Hand this extension's mint over to an M0 V2 Issuer Gateway deployment.
// One-shot in effect: after it runs the program no longer holds the mint
// authority, so a second call fails inside the token program. The V2 side
// must run `adopt_stablecoin` first — the target account is required to be a
// gateway `Stablecoin` in `AdoptionPending`; `complete_adoption` verifies the
// end state after the remaining authorities move off-chain.
//
// In order: gate (admin + solvency), verify the derived target, move the mint
// authority (and the Scaled UI Amount authority when the mint has one), sweep
// the $M vault to the treasury and close it, clear `wrap_authorities`
// (wrap/unwrap are already dead without the mint authority; the empty list is
// defense).

use anchor_lang::{
    prelude::*,
    solana_program::{program::invoke_signed, program_option::COption},
};
use anchor_spl::{
    token_2022::{
        close_account, set_authority, spl_token_2022::instruction::AuthorityType, CloseAccount,
        SetAuthority,
    },
    token_interface::{Mint, Token2022, TokenAccount},
};
use spl_token_2022::extension::{scaled_ui_amount::ScaledUiAmountConfig, ExtensionType};

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::{conversion::get_mint_extensions, token::transfer_tokens_from_program},
};
use earn::utils::conversion::{
    get_scaled_ui_config, principal_to_amount_down, principal_to_amount_up,
};

// The gateway `Stablecoin` wire facts this instruction checks. Pinned here the
// way other foreign layouts are; the source of truth is
// m0-v2/svm/crates/state/src/stablecoin.rs.
const STABLECOIN_SEED: &[u8] = b"stablecoin";
const STABLECOIN_DISCRIMINATOR: u8 = 2;
const STABLECOIN_ACCOUNT_VERSION: u8 = 1;
const MINT_ORIGIN_OFFSET: usize = 5;
const MINT_ORIGIN_ADOPTION_PENDING: u8 = 1;
const MINT_OFFSET: usize = 10;

// The issuer's gateway program id, fixed at build time (`GATEWAY_PROGRAM_ID`).
// Each issuer deploys its own gateway, so the id is pinned per upgrade binary
// instead of being accepted from the admin.
const GATEWAY_PROGRAM_ID: Pubkey = Pubkey::from_str_const(env!("GATEWAY_PROGRAM_ID"));

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

    /// CHECK: The gateway `Stablecoin` PDA under the pinned gateway id, never
    /// a raw address. Its bytes are verified in `validate`.
    #[account(
        owner = GATEWAY_PROGRAM_ID @ ExtError::InvalidAccount,
        seeds = [STABLECOIN_SEED, ext_mint.key().as_ref()],
        seeds::program = GATEWAY_PROGRAM_ID,
        bump,
    )]
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
    // The ext mint's Scaled UI Amount config, when it has one.
    fn ext_scaled_ui_config(&self) -> Result<Option<ScaledUiAmountConfig>> {
        if !get_mint_extensions(&self.ext_mint)?.contains(&ExtensionType::ScaledUiAmount) {
            return Ok(None);
        }
        Ok(Some(get_scaled_ui_config(&self.ext_mint)?))
    }

    fn validate(&self) -> Result<()> {
        // The gateway's complete_adoption requires the freeze authority to
        // arrive at its PDA. If it sits at this program's own PDA, nothing can
        // ever move it — refuse before the irreversible sweep.
        if self.ext_mint.freeze_authority
            == COption::Some(self.ext_mint_authority.key())
        {
            return err!(ExtError::FreezeAuthorityUnreachable);
        }

        // Solvency: vault $M covers the outstanding ext supply (the migrate_m
        // check). Both sides convert their principal through the multiplier in
        // force NOW, the vault rounded down and the supply owed rounded up. A
        // mint without Scaled UI Amount is 1:1 with its principal. A scheduled
        // future multiplier must not value an irreversible sweep.
        let now = Clock::get()?.unix_timestamp;
        let in_force = |config: &ScaledUiAmountConfig| -> f64 {
            if now >= i64::from(config.new_multiplier_effective_timestamp) {
                config.new_multiplier.into()
            } else {
                config.multiplier.into()
            }
        };
        let vault_m_amount = principal_to_amount_down(
            self.vault_m_token_account.amount,
            in_force(&get_scaled_ui_config(&self.m_mint)?),
        )?;
        let ext_supply_amount = match self.ext_scaled_ui_config()? {
            Some(config) => principal_to_amount_up(self.ext_mint.supply, in_force(&config))?,
            None => self.ext_mint.supply,
        };
        if vault_m_amount < ext_supply_amount {
            return err!(ExtError::InsufficientCollateral);
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

    #[access_control(ctx.accounts.validate())]
    pub fn handler(ctx: Context<Self>) -> Result<()> {
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

        // A Scaled UI Amount mint hands over its multiplier authority too. The
        // CPI fails, and the whole handoff with it, if this program's PDA does
        // not hold that authority. anchor-spl's `set_authority` wraps a Token-2022
        // build that predates this authority type, so the instruction is built here.
        if ctx.accounts.ext_scaled_ui_config()?.is_some() {
            invoke_signed(
                &spl_token_2022::instruction::set_authority(
                    &ctx.accounts.m_token_program.key(),
                    &ctx.accounts.ext_mint.key(),
                    Some(&ctx.accounts.stablecoin.key()),
                    spl_token_2022::instruction::AuthorityType::ScaledUiAmount,
                    &ctx.accounts.ext_mint_authority.key(),
                    &[],
                )?,
                &[
                    ctx.accounts.ext_mint.to_account_info(),
                    ctx.accounts.ext_mint_authority.to_account_info(),
                ],
                &[&[
                    MINT_AUTHORITY_SEED,
                    &[ctx.accounts.global_account.ext_mint_authority_bump],
                ]],
            )?;
        }

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
