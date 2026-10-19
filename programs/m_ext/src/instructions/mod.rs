pub mod claim_config;
pub mod claim_fees;
pub mod initialize;
pub mod manage_wrap_authority;
pub mod transfer_admin;
pub mod unwrap;
pub mod wrap;

pub use claim_config::*;
pub use claim_fees::*;
pub use initialize::*;
pub use manage_wrap_authority::*;
pub use transfer_admin::*;
pub use unwrap::*;
pub use wrap::*;

cfg_if::cfg_if!(
    if #[cfg(feature = "scaled-ui")] {
        pub mod scaled_ui;
        pub use scaled_ui::*;
    } else if #[cfg(feature = "crank")] {
        pub mod crank;
        pub use crank::*;
    }
);

// Only add migrate instruction if upgrading a program from M v1
cfg_if::cfg_if!(
    if #[cfg(feature = "migrate")] {
        pub mod migrate;
        pub use migrate::*;
    }
);
