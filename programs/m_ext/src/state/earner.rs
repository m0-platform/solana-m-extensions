use anchor_lang::prelude::*;

#[constant]
pub const EARNER_SEED: &[u8] = b"earner";

/// Per-user yield state (crank variant). PDA: `["earner", user_token_account]`, created by
/// an earn manager via `add_earner`, closed via `remove_earner`/`remove_orphaned_earner`.
/// `claim_for` pays out yield accrued since `last_claim_index` to `recipient_token_account`
/// if set (see `set_recipient`), otherwise to `user_token_account`.
#[account]
#[derive(InitSpace)]
pub struct Earner {
    pub last_claim_index: u64,
    pub last_claim_timestamp: u64,
    pub bump: u8,
    pub user: Pubkey,
    pub user_token_account: Pubkey,
    pub earn_manager: Pubkey,
    pub recipient_token_account: Option<Pubkey>,
}
