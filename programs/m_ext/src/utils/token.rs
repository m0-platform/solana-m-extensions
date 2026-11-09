// external dependencies
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, mint_to, transfer_checked, Burn, Mint, MintTo, Token2022, TokenAccount, TokenInterface,
    TransferChecked,
};

pub fn transfer_tokens_from_program<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    authority_seeds: &[&[&[u8]]],
    token_program: &Program<'info, Token2022>,
) -> Result<()> {
    // Build the arguments for the transfer instruction
    let transfer_options = TransferChecked {
        from: from.to_account_info(),
        to: to.to_account_info(),
        mint: mint.to_account_info(),
        authority: authority.clone(),
    };
    let cpi_context =
        CpiContext::new_with_signer(token_program.key(), transfer_options, authority_seeds);

    // Call the transfer instruction
    transfer_checked(cpi_context, amount, mint.decimals)?;

    Ok(())
}

pub fn transfer_tokens<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    token_program: &Program<'info, Token2022>,
) -> Result<()> {
    // Build the arguments for the transfer instruction
    let transfer_options = TransferChecked {
        from: from.to_account_info(),
        to: to.to_account_info(),
        mint: mint.to_account_info(),
        authority: authority.clone(),
    };
    let cpi_context = CpiContext::new(token_program.key(), transfer_options);

    // Call the transfer instruction
    transfer_checked(cpi_context, amount, mint.decimals)?;

    Ok(())
}

// Convenience functions to mint and burn tokens from a program using a PDA signer

pub fn mint_tokens<'info>(
    to: &InterfaceAccount<'info, TokenAccount>,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    authority_seeds: &[&[&[u8]]],
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    // Build the arguments for the mint instruction
    let mint_options = MintTo {
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: authority.clone(),
    };

    let cpi_context =
        CpiContext::new_with_signer(token_program.key(), mint_options, authority_seeds);

    // Call the mint instruction
    mint_to(cpi_context, amount)?;

    Ok(())
}

pub fn burn_tokens<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    amount: u64,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    // Build the arguments for the burn instruction
    let burn_options = Burn {
        mint: mint.to_account_info(),
        from: from.to_account_info(),
        authority: authority.clone(),
    };

    let cpi_context = CpiContext::new(token_program.key(), burn_options);

    // Call the burn instruction
    burn(cpi_context, amount)?;

    Ok(())
}
