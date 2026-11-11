// Hand this extension's mint over to an M0 V2 Issuer Gateway deployment.
// One-shot in effect: after it runs the program no longer holds the mint
// authority, so a second call fails inside the token program. The V2 side
// must run `adopt_stablecoin` first. The target account is required to be a
// gateway `Stablecoin` in `AdoptionPending`. `complete_adoption` verifies the
// end state after the remaining authorities move off-chain.
//
// In order: verify the derived target, sync the ext index so holders keep the
// yield the vault earned, move the mint authority (and the Scaled UI Amount
// authority when the mint has one), wrap the whole $M vault into wM and close
// the vault, clear `wrap_authorities`. The empty list and the closed vault stop
// any later wrap or unwrap.
//
// The vault $M leaves as wM because $M accounts start frozen and the portal
// does not bridge $M. The wM lands in an account owned by the pinned
// `RECIPIENT`, who bridges it to close the issuer's V1 position. The wrap goes
// through `ext_swap`, whose `SwapGlobal` is already a wM wrap authority, so the
// cutover needs no change to wM's wrap list.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
    InstructionData,
};
use anchor_spl::{
    token_2022::{
        close_account, set_authority, spl_token_2022::instruction::AuthorityType, CloseAccount,
        SetAuthority,
    },
    token_interface::{Mint, Token2022, TokenAccount, TokenInterface},
};
use spl_token_2022::extension::ExtensionType;

use crate::{
    errors::ExtError,
    state::{ExtGlobalV2, EXT_GLOBAL_SEED, MINT_AUTHORITY_SEED, M_VAULT_SEED},
    utils::conversion::{
        get_mint_extensions, multiplier_to_index, principal_to_amount_up, sync_index,
    },
};

// The gateway `Stablecoin` wire facts this instruction checks. Pinned here the
// way other foreign layouts are. The source of truth is
// m0-v2/svm/crates/state/src/stablecoin.rs.
const STABLECOIN_SEED: &[u8] = b"stablecoin";
const STABLECOIN_DISCRIMINATOR: u8 = 2;
const STABLECOIN_ACCOUNT_VERSION: u8 = 1;
const MINT_ORIGIN_OFFSET: usize = 5;
const MINT_ORIGIN_ADOPTION_PENDING: u8 = 1;
const MINT_OFFSET: usize = 10;

// The issuer's gateway program id. Each issuer deploys its own gateway, so
// each cutover sets this line and ships its own binary. The admin never
// supplies it. This value is the test gateway.
const GATEWAY_PROGRAM_ID: Pubkey = pubkey!("EDKMBb8e1DyCZtUrczZeJgxWgMU2nLBCuK31XzPnXWu3");

// The issuer wallet that must own the account receiving the wrapped vault. Set
// with the gateway id for each cutover, so a stolen admin key cannot redirect
// the vault. This value is the test recipient.
const RECIPIENT: Pubkey = pubkey!("8dDyonHjmXBUpTy6hkWd4CbKHLeqkimv4SpR1ZqK2G3t");

// wM, the extension the vault is wrapped into.
const WM_PROGRAM_ID: Pubkey = pubkey!("wMXX1K1nca5W4pZr1piETe78gcAVVrEFi9f4g46uXko");

// ext_swap, the swap facility that wraps $M into a whitelisted extension.
const EXT_SWAP_PROGRAM_ID: Pubkey = pubkey!("MSwapi3WhNKMUGm9YrxGhypgUEt7wYQH3ZgG32XoWzH");

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
    pub global_account: Box<Account<'info, ExtGlobalV2>>,

    #[account(mut, mint::token_program = ext_token_program)]
    pub ext_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Validated by the seed. Signs the authority moves.
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
    pub m_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Validated by the seed. Signs the wrap and the vault close.
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
    pub vault_m_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, mint::token_program = wm_token_program)]
    pub wm_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The issuer's account that receives the wrapped vault.
    #[account(
        mut,
        token::mint = wm_mint,
        token::authority = RECIPIENT,
        token::token_program = wm_token_program,
    )]
    pub recipient_wm_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Pinned by address. wM runs this program's code at another id,
    /// so no program type exists for it.
    #[account(address = WM_PROGRAM_ID @ ExtError::InvalidAccount)]
    pub wm_program: UncheckedAccount<'info>,
    /// CHECK: wM's `ExtGlobalV2`. `Account<ExtGlobalV2>` would refuse it,
    /// because wM owns it, not this program. wM's wrap checks its seed and
    /// bump and binds `m_mint` and `wm_mint` to it.
    #[account(mut)]
    pub wm_global: UncheckedAccount<'info>,
    /// CHECK: wM's data-free vault PDA. wM's wrap checks its seed.
    pub wm_m_vault: UncheckedAccount<'info>,
    /// CHECK: wM's data-free mint authority PDA. wM's wrap checks its seed.
    pub wm_mint_authority: UncheckedAccount<'info>,
    /// CHECK: wM's $M vault ATA. wM's wrap checks the ATA derivation.
    #[account(mut)]
    pub wm_vault_m_token_account: UncheckedAccount<'info>,

    /// CHECK: Pinned by address. Its crate depends on this one, so no program
    /// type exists for it here.
    #[account(address = EXT_SWAP_PROGRAM_ID @ ExtError::InvalidAccount)]
    pub ext_swap_program: UncheckedAccount<'info>,
    /// CHECK: ext_swap's `SwapGlobal`, the wrap authority wM lists. ext_swap's
    /// wrap checks its seed and that wM is whitelisted.
    pub swap_global: UncheckedAccount<'info>,

    pub m_token_program: Program<'info, Token2022>,
    pub ext_token_program: Interface<'info, TokenInterface>,
    pub wm_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl Handoff<'_> {
    fn validate(&self) -> Result<()> {
        // The account must be a live `Stablecoin` in `AdoptionPending` bound to
        // this mint, so the authority never moves to an unverified target.
        let data = self.stablecoin.try_borrow_data()?;
        if data.len() < MINT_OFFSET + 32
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
        let mint_authority_seeds: &[&[&[u8]]] = &[&[
            MINT_AUTHORITY_SEED,
            &[ctx.accounts.global_account.ext_mint_authority_bump],
        ]];

        // Credit holders the yield the vault earned, or the wrap below sends it
        // to the recipient. A scaled-ui build updates the multiplier, which only
        // this program's PDA can sign, so it runs before that authority moves.
        // Other builds return at once.
        sync_index(
            &mut ctx.accounts.ext_mint,
            &mut ctx.accounts.global_account,
            &ctx.accounts.m_mint,
            &ctx.accounts.vault_m_token_account,
            &ctx.accounts.ext_mint_authority,
            mint_authority_seeds,
            &ctx.accounts.ext_token_program,
        )?;

        // Move the mint authority to the verified Stablecoin PDA.
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.ext_token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.ext_mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.ext_mint.to_account_info(),
                },
                mint_authority_seeds,
            ),
            AuthorityType::MintTokens,
            Some(ctx.accounts.stablecoin.key()),
        )?;

        // A Scaled UI Amount mint hands over its multiplier authority too. The
        // CPI fails, and the whole handoff with it, if this program's PDA does
        // not hold that authority. anchor-spl's `set_authority` wraps a Token-2022
        // build that predates this authority type, so the instruction is built here.
        if get_mint_extensions(&ctx.accounts.ext_mint)?.contains(&ExtensionType::ScaledUiAmount) {
            invoke_signed(
                &spl_token_2022::instruction::set_authority(
                    &ctx.accounts.ext_token_program.key(),
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
                mint_authority_seeds,
            )?;
        }

        // Wrap the whole vault: holders hold ext tokens, never $M, so the vault
        // is the only $M account in the system. `wrap` takes an $M amount and
        // floors it back to principal at the same index, so rounding the amount
        // up returns exactly the vault principal and the close below sees zero.
        let vault_seeds: &[&[&[u8]]] =
            &[&[M_VAULT_SEED, &[ctx.accounts.global_account.m_vault_bump]]];
        let vault_principal = ctx.accounts.vault_m_token_account.amount;
        if vault_principal > 0 {
            let m_index = multiplier_to_index(
                earn::utils::conversion::get_scaled_ui_config(&ctx.accounts.m_mint)?
                    .new_multiplier
                    .into(),
            )?;
            let amount = principal_to_amount_up(vault_principal, m_index)?;

            // ext_swap's `wrap`: the vault PDA signs as the $M owner and
            // `SwapGlobal` signs as wM's wrap authority. The metas follow
            // ext_swap's `Wrap` order. Its `wrap_authority` is omitted, which
            // Anchor encodes as the called program's id.
            let a = &ctx.accounts;
            let accounts = vec![
                AccountMeta::new_readonly(a.m_vault.key(), true),
                AccountMeta::new_readonly(EXT_SWAP_PROGRAM_ID, false),
                AccountMeta::new_readonly(a.swap_global.key(), false),
                AccountMeta::new(a.wm_global.key(), false),
                AccountMeta::new(a.wm_mint.key(), false),
                AccountMeta::new_readonly(a.m_mint.key(), false),
                AccountMeta::new(a.vault_m_token_account.key(), false),
                AccountMeta::new(a.recipient_wm_token_account.key(), false),
                AccountMeta::new_readonly(a.wm_m_vault.key(), false),
                AccountMeta::new_readonly(a.wm_mint_authority.key(), false),
                AccountMeta::new(a.wm_vault_m_token_account.key(), false),
                AccountMeta::new_readonly(a.wm_token_program.key(), false),
                AccountMeta::new_readonly(a.m_token_program.key(), false),
                AccountMeta::new_readonly(a.wm_program.key(), false),
                AccountMeta::new_readonly(a.system_program.key(), false),
            ];
            invoke_signed(
                &Instruction {
                    program_id: EXT_SWAP_PROGRAM_ID,
                    accounts,
                    // ext_swap's `wrap(amount)` shares this crate's name and
                    // arguments, so the encoded data is identical.
                    data: crate::instruction::Wrap { amount }.data(),
                },
                &[
                    a.m_vault.to_account_info(),
                    a.ext_swap_program.to_account_info(),
                    a.swap_global.to_account_info(),
                    a.wm_global.to_account_info(),
                    a.wm_mint.to_account_info(),
                    a.m_mint.to_account_info(),
                    a.vault_m_token_account.to_account_info(),
                    a.recipient_wm_token_account.to_account_info(),
                    a.wm_m_vault.to_account_info(),
                    a.wm_mint_authority.to_account_info(),
                    a.wm_vault_m_token_account.to_account_info(),
                    a.wm_token_program.to_account_info(),
                    a.m_token_program.to_account_info(),
                    a.wm_program.to_account_info(),
                    a.system_program.to_account_info(),
                ],
                vault_seeds,
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

        // Tombstone: no key may wrap or unwrap again.
        ctx.accounts.global_account.wrap_authorities = vec![];

        Ok(())
    }
}
