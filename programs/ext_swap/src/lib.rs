#![allow(unexpected_cfgs)]

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
        ctx: Context<'info, Swap<'info>>,
        amount: u64,
        remaining_accounts_split_idx: u8,
    ) -> Result<()> {
        Swap::handler(ctx, amount, remaining_accounts_split_idx as usize)
    }

    pub fn wrap<'info>(ctx: Context<'info, Wrap<'info>>, amount: u64) -> Result<()> {
        Wrap::handler(ctx, amount)
    }

    pub fn unwrap<'info>(ctx: Context<'info, Unwrap<'info>>, amount: u64) -> Result<()> {
        Unwrap::handler(ctx, amount)
    }
}
