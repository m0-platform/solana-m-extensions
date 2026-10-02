use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

use crate::{
    constants::ANCHOR_DISCRIMINATOR_SIZE,
    errors::ExtError,
    state::{ClaimConfig, ExtGlobalV2, CLAIM_CONFIG_SEED, EXT_GLOBAL_SEED},
};

#[derive(Accounts)]
pub struct SetClaimConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [EXT_GLOBAL_SEED],
        has_one = admin @ ExtError::NotAuthorized,
        bump = global_account.bump,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    #[account(
        init_if_needed,
        payer = admin,
        space = ANCHOR_DISCRIMINATOR_SIZE + ClaimConfig::INIT_SPACE,
        seeds = [CLAIM_CONFIG_SEED],
        bump
    )]
    pub claim_config: Account<'info, ClaimConfig>,

    #[account(
        token::mint = global_account.ext_mint,
        token::token_program = ext_token_program,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,

    pub ext_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl SetClaimConfig<'_> {
    pub fn handler(ctx: Context<Self>, claim_authority: Pubkey) -> Result<()> {
        ctx.accounts.claim_config.set_inner(ClaimConfig {
            claim_authority,
            recipient_token_account: ctx.accounts.recipient_token_account.key(),
            bump: ctx.bumps.claim_config,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RemoveClaimConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [EXT_GLOBAL_SEED],
        has_one = admin @ ExtError::NotAuthorized,
        bump = global_account.bump,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    #[account(
        mut,
        close = admin,
        seeds = [CLAIM_CONFIG_SEED],
        bump = claim_config.bump,
    )]
    pub claim_config: Account<'info, ClaimConfig>,
}

impl RemoveClaimConfig<'_> {
    pub fn handler(_ctx: Context<Self>) -> Result<()> {
        Ok(())
    }
}
