use anchor_lang::prelude::*;
use cfg_if::cfg_if;

#[constant]
pub const EXT_GLOBAL_SEED: &[u8] = b"global";

/// Per-extension global config. PDA: `["global"]`, created once by `initialize`.
/// Holds the admin, the mint pair, the variant-specific [`YieldConfig`], and the list of
/// accounts allowed to call `wrap`/`unwrap`. Resized on wrap-authority changes.
#[account]
pub struct ExtGlobalV2 {
    pub admin: Pubkey,                 // can update config values
    pub pending_admin: Option<Pubkey>, // pending admin for two-step admin transfer
    pub ext_mint: Pubkey,
    pub m_mint: Pubkey,
    pub m_earn_global_account: Pubkey,
    pub bump: u8,
    pub m_vault_bump: u8,
    pub ext_mint_authority_bump: u8,
    pub yield_config: YieldConfig,     // variant specific state
    pub wrap_authorities: Vec<Pubkey>, // accounts permissioned to wrap/unwrap the ext_mint
}

impl ExtGlobalV2 {
    pub fn size(wrap_authorities: usize) -> usize {
        8 + // discriminator
        32 + // admin
        1 + 32 + // pending_admin (Option<Pubkey>)
        32 + // ext_mint
        32 + // m_mint
        32 + // m_earn_global_account
        1 + // bump
        1 + // m_vault_bump
        1 + // ext_mint_authority_bump
        YieldConfig::space() + // yield_config
        4 + // length of wrap_authorities vector
        wrap_authorities * 32 // each Pubkey is 32 bytes
    }
}

#[constant]
pub const MINT_AUTHORITY_SEED: &[u8] = b"mint_authority";

#[constant]
pub const M_VAULT_SEED: &[u8] = b"m_vault";

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
#[repr(u8)]
pub enum YieldVariant {
    NoYield,
    ScaledUi,
    Crank,
}

// YieldConfig is the variant-specific portion of ExtGlobalV2; its layout differs per build:
// - scaled-ui: fee on yield + the last synced M/ext index pair (the ext index lags M by the fee)
// - crank:     the earn authority + last synced indices/timestamp that claims are paid against
// - no-yield:  no state beyond the variant tag
cfg_if! {
    if #[cfg(feature = "scaled-ui")] {
        #[derive(AnchorSerialize, AnchorDeserialize, Clone)]
        pub struct YieldConfig {
            pub yield_variant: YieldVariant, // variant of yield config
            pub fee_bps: u64, // fee in basis points
            pub last_m_index: u64, // last m index
            pub last_ext_index: u64, // last ext index
        }

        impl YieldConfig {
            pub fn space() -> usize {
                1 + // yield_variant
                8 + // fee_bps
                8 + // last_m_index
                8 // last_ext_index
            }
        }
    } else if #[cfg(feature = "crank")] {
       #[derive(AnchorSerialize, AnchorDeserialize, Clone)]
        pub struct YieldConfig {
            pub yield_variant: YieldVariant,   // variant of yield config
            pub earn_authority: Pubkey,        // address that can distribute yield
            pub last_m_index: u64,             // most recent m index that has been synced
            pub last_ext_index: u64,           // most recent ext index that yield can be distributed for
            pub timestamp: u64,                // timestamp of the most recent index update
        }

        impl YieldConfig {
            pub fn space() -> usize {
                1 + // yield_variant
                32 + // earn_authority
                8 + // last_m_index
                8 + // last_ext_index
                8 // timestamp
            }
        }

        pub mod earner;
        pub mod earn_manager;

        pub use earner::*;
        pub use earn_manager::*;
    } else {
        #[derive(AnchorSerialize, AnchorDeserialize, Clone)]
        pub struct YieldConfig {
            pub yield_variant: YieldVariant, // variant of yield config
        }

        impl YieldConfig {
            pub fn space() -> usize {
                1 // yield_variant
            }
        }
    }
}
