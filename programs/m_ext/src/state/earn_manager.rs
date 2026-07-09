use anchor_lang::prelude::*;

#[constant]
pub const EARN_MANAGER_SEED: &[u8] = b"earn_manager";

/// A yield distributor (crank variant). PDA: `["earn_manager", earn_manager]`, managed by the
/// admin via `add_earn_manager`/`remove_earn_manager`. Managers register earners and may take
/// `fee_bps` of each claim into `fee_token_account`. Removal sets `is_active = false` (the
/// account persists so its earners can still claim fee-free or be cleaned up as orphans).
#[account]
#[derive(InitSpace)]
pub struct EarnManager {
    pub earn_manager: Pubkey,
    pub is_active: bool,
    pub fee_bps: u64,
    pub fee_token_account: Pubkey,
    pub bump: u8,
}
