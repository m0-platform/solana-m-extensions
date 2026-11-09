use anchor_lang::prelude::*;

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED},
};

#[derive(Accounts)]
pub struct AddWrapAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        has_one = admin @ ExtError::NotAuthorized,
        bump = global_account.bump,
        realloc = ExtGlobalV2::size(global_account.wrap_authorities.len() + 1),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    pub system_program: Program<'info, System>,
}

impl AddWrapAuthority<'_> {
    // This instruction allows the admin to add a wrap authority to the global account.
    // The new wrap authority must not already exist in the list.

    pub fn validate(&self, new_wrap_authority: Pubkey) -> Result<()> {
        // Validate that the new wrap authority is not already in the list
        if self
            .global_account
            .wrap_authorities
            .contains(&new_wrap_authority)
        {
            return err!(ExtError::InvalidParam);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(new_wrap_authority))]
    pub fn handler(ctx: Context<Self>, new_wrap_authority: Pubkey) -> Result<()> {
        // Update the wrap authority at the specified index
        ctx.accounts
            .global_account
            .wrap_authorities
            .push(new_wrap_authority);

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RemoveWrapAuthority<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [EXT_GLOBAL_SEED],
        has_one = admin @ ExtError::NotAuthorized,
        bump = global_account.bump,
    )]
    pub global_account: Account<'info, ExtGlobalV2>,

    pub system_program: Program<'info, System>,
}

impl RemoveWrapAuthority<'_> {
    // This instruction allows the admin to remove a wrap authority from the global account.
    // The wrap authority must exist in the list.

    pub fn validate(&self, wrap_authority: Pubkey) -> Result<()> {
        // Validate that the wrap authority exists in the list
        if !self
            .global_account
            .wrap_authorities
            .contains(&wrap_authority)
        {
            return err!(ExtError::InvalidParam);
        }

        Ok(())
    }

    #[access_control(ctx.accounts.validate(wrap_authority))]
    pub fn handler(ctx: Context<Self>, wrap_authority: Pubkey) -> Result<()> {
        // Remove the specified wrap authority
        ctx.accounts
            .global_account
            .wrap_authorities
            .retain(|&x| !x.eq(&wrap_authority));

        // Reallocate the account to remove the empty space without erasing the other data
        let new_size = ExtGlobalV2::size(ctx.accounts.global_account.wrap_authorities.len());
        ctx.accounts
            .global_account
            .to_account_info()
            .resize(new_size)?;

        // Refund excess lamports to the admin
        let current_lamports = ctx.accounts.global_account.to_account_info().lamports();
        let required_lamports = Rent::get()?.minimum_balance(new_size);
        let excess_lamports = current_lamports.saturating_sub(required_lamports);
        if excess_lamports > 0 {
            **ctx
                .accounts
                .global_account
                .to_account_info()
                .lamports
                .borrow_mut() -= excess_lamports;
            **ctx.accounts.admin.to_account_info().lamports.borrow_mut() += excess_lamports;
        }

        Ok(())
    }
}
