#![allow(unexpected_cfgs)]
//! # Extension Swap Program
//!
//! Singleton router for swapping 1:1 (by `$M` value) between whitelisted M extensions.
//! `swap` CPIs `from_ext::unwrap` -> `to_ext::wrap`, routing the `$M` through a token account
//! owned by the [`state::SwapGlobal`] PDA. That PDA is also the default wrap/unwrap authority
//! for the CPIs, so every swappable extension must include it in its wrap-authority list
//! (or the caller passes their own authority).
//!
//! The standalone `wrap`/`unwrap` instructions route between `$M` and a single extension:
//! `wrap` is open to anyone, `unwrap` requires a whitelisted unwrapper.

pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use instructions::*;

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "M0 Swap Program",
    project_url: "https://m0.org/",
    contacts: "email:security@m0.xyz",
    policy: "https://github.com/m0-foundation/solana-m/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/m0-foundation/solana-extensions/tree/main/programs/ext_swap",
    auditors: "Asymmetric Research,Adevar Labs,OtterSec,Halborn"
}

declare_id!("MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH");

#[program]
pub mod ext_swap {
    use super::*;

    pub fn initialize_global<'info>(ctx: Context<InitializeGlobal>) -> Result<()> {
        InitializeGlobal::handler(ctx)
    }

    pub fn whitelist_extension<'info>(ctx: Context<WhitelistExt>) -> Result<()> {
        WhitelistExt::handler(ctx)
    }

    pub fn remove_whitelisted_extension<'info>(
        ctx: Context<RemoveWhitelistedExt>,
        ext_program: Pubkey,
    ) -> Result<()> {
        RemoveWhitelistedExt::handler(ctx, ext_program)
    }

    pub fn whitelist_unwrapper<'info>(
        ctx: Context<WhitelistUnwrapper>,
        authority: Pubkey,
    ) -> Result<()> {
        WhitelistUnwrapper::handler(ctx, authority)
    }

    pub fn remove_whitelisted_unwrapper<'info>(
        ctx: Context<RemoveWhitelistedUnwrapper>,
        authority: Pubkey,
    ) -> Result<()> {
        RemoveWhitelistedUnwrapper::handler(ctx, authority)
    }

    #[cfg(feature = "migrate")]
    pub fn reset_whitelists(ctx: Context<ResetWhitelists>) -> Result<()> {
        ResetWhitelists::handler(ctx)
    }

    pub fn swap<'info>(
        ctx: Context<'_, '_, '_, 'info, Swap<'info>>,
        amount: u64,
        remaining_accounts_split_idx: u8,
    ) -> Result<()> {
        Swap::handler(ctx, amount, remaining_accounts_split_idx as usize)
    }

    pub fn wrap<'info>(ctx: Context<'_, '_, '_, 'info, Wrap<'info>>, amount: u64) -> Result<()> {
        Wrap::handler(ctx, amount)
    }

    pub fn unwrap<'info>(
        ctx: Context<'_, '_, '_, 'info, Unwrap<'info>>,
        amount: u64,
    ) -> Result<()> {
        Unwrap::handler(ctx, amount)
    }
}
