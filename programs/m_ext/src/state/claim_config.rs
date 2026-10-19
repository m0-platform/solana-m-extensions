use anchor_lang::prelude::*;

#[constant]
pub const CLAIM_CONFIG_SEED: &[u8] = b"claim_config";

#[account]
#[derive(InitSpace)]
pub struct ClaimConfig {
    pub claim_authority: Pubkey,
    pub recipient_token_account: Pubkey,
    pub bump: u8,
}
