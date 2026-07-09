pub const ANCHOR_DISCRIMINATOR_SIZE: usize = 8;

/// Yield indices are the Token2022 ScaledUiAmount f64 multiplier scaled by 1e12 and stored
/// as u64. 1e12 preserves more precision than the multiplier updates require (~1e-16 error
/// from f64 powf) while keeping index math comfortably within u64/u128 bounds.
/// An index of 1_000_000_000_000 therefore means a multiplier of 1.0.
pub const INDEX_SCALE_F64: f64 = 1e12f64;
pub const INDEX_SCALE_U64: u64 = 1_000_000_000_000u64;

/// Basis point scale: 10_000 bps = 100% (1 bps = 0.01%).
pub const ONE_HUNDRED_PERCENT_U64: u64 = 100_00u64;
pub const ONE_HUNDRED_PERCENT_F64: f64 = 1e4f64;
