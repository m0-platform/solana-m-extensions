use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use cfg_if::cfg_if;
use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};

use crate::{
    constants::{INDEX_SCALE_F64, INDEX_SCALE_U64},
    errors::ExtError,
    state::ExtGlobalV2,
};

cfg_if! {
    if #[cfg(feature = "scaled-ui")] {
        use anchor_lang::solana_program::program::invoke_signed;
        use anchor_spl::token_2022::spl_token_2022::state::AccountState;
        use spl_token_2022::extension::scaled_ui_amount::ScaledUiAmountConfig;
        use crate::constants::ONE_HUNDRED_PERCENT_F64;
    }
}

/// Syncs the extension's yield index with the latest `$M` multiplier and returns the current
/// ext index to use for conversions.
///
/// `scaled-ui`: recalculates the ext index from the `$M` multiplier (net of `fee_bps`) and,
/// if the vault is an approved earner (token account not frozen), pushes the new multiplier
/// to the ext mint via CPI. `no-yield`/`crank`: ext tokens are 1:1 with `$M`, so this is a
/// no-op returning `INDEX_SCALE_U64` (1.0).
#[allow(unused_variables)]
pub fn sync_index<'info>(
    ext_mint: &mut InterfaceAccount<'info, Mint>,
    ext_global_account: &mut Account<'info, ExtGlobalV2>,
    m_mint: &InterfaceAccount<'info, Mint>,
    vault_m_token_account: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    authority_seeds: &[&[&[u8]]],
    token_program: &Interface<'info, TokenInterface>,
) -> Result<u64> {
    cfg_if! {
        if #[cfg(feature = "scaled-ui")] {
            // Require the token program to be the token2022 program
            // We checked this on the Initialize instruction
            // but since we're CPIing into the provided program here,
            // and this could be used by any instruction
            // (which may not have checked ext_mint's token program),
            // we check again as a safety measure
            if token_program.key() != spl_token_2022::ID {
                return err!(ExtError::InvalidTokenProgram);
            }

            // Get the current M index, newly calculated Ext index, and timestamp from the M mint
            let (m_index, ext_index, timestamp): (u64, u64, u64) =
                get_latest_index_and_timestamp(ext_global_account, m_mint)?;

            // Compare against the current ext index, if the same, return early
            if ext_index == ext_global_account.yield_config.last_ext_index {
                return Ok(ext_global_account.yield_config.last_ext_index);
            }

            // Check if the vault m token account is approved as an M earner (i.e. not frozen)
            // If so, update the multiplier and return
            // If not, update the last M index to the latest and return the current multiplier
            if vault_m_token_account.state == AccountState::Initialized {
                let ext_multiplier: f64 = index_to_multiplier(ext_index)?;

                // Update the multiplier and timestamp in the mint account
                invoke_signed(
                    &spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier(
                        &token_program.key(),
                        &ext_mint.key(),
                        &authority.key(),
                        &[],
                        ext_multiplier,
                        timestamp as i64,
                    )?,
                    &[ext_mint.to_account_info(), authority.clone()],
                    authority_seeds,
                )?;

                // Reload the mint account so the new multiplier is reflected
                ext_mint.reload()?;

                // Update the last m index and last ext index in the global account
                ext_global_account.yield_config.last_m_index = m_index;
                ext_global_account.yield_config.last_ext_index = ext_index;

                return Ok(ext_index);
            } else {
                // Update the last M index to the latest and return the last ext index since it is not being updated
                ext_global_account.yield_config.last_m_index = m_index;
                return Ok(ext_global_account.yield_config.last_ext_index);
            }
        } else {
            // Ext tokens are 1:1 with M tokens and we don't need to sync this
            return Ok(INDEX_SCALE_U64);
        }
    }
}

// The `_down`/`_up` pairs below exist because rounding must always favor the protocol:
// round down what the program pays out (tokens minted/transferred to users), round up what
// it collects, so the vault can never become undercollateralized by rounding.

/// Converts a UI amount to principal (raw token units) at `index`, rounding down.
pub fn amount_to_principal_down(amount: u64, index: u64) -> Result<u64> {
    // If the index is 1, return the amount directly
    if index == INDEX_SCALE_U64 {
        return Ok(amount);
    }

    // Calculate the principal from the amount and index, rounding down
    let principal: u64 = (amount as u128)
        .checked_mul(INDEX_SCALE_U64 as u128)
        .ok_or(ExtError::MathOverflow)?
        .checked_div(index as u128)
        .ok_or(ExtError::MathUnderflow)?
        .try_into()?;

    Ok(principal)
}

/// Converts a UI amount to principal (raw token units) at `index`, rounding up.
pub fn amount_to_principal_up(amount: u64, index: u64) -> Result<u64> {
    // If the index is 1, return the amount directly
    if index == INDEX_SCALE_U64 {
        return Ok(amount);
    }

    // Calculate the principal from the amount and index, rounding up
    let index_128 = index as u128;
    let principal: u64 = (amount as u128)
        .checked_mul(INDEX_SCALE_U64 as u128)
        .ok_or(ExtError::MathOverflow)?
        .checked_add(
            index_128
                .checked_sub(1u128)
                .ok_or(ExtError::MathUnderflow)?,
        )
        .ok_or(ExtError::MathOverflow)?
        .checked_div(index_128)
        .ok_or(ExtError::MathUnderflow)?
        .try_into()?;

    Ok(principal)
}

/// Converts principal (raw token units) to a UI amount at `index`, rounding down.
pub fn principal_to_amount_down(principal: u64, index: u64) -> Result<u64> {
    // If the index is 1, return the principal directly
    if index == INDEX_SCALE_U64 {
        return Ok(principal);
    }

    // Calculate the amount from the principal and index, rounding down
    let amount: u64 = (index as u128)
        .checked_mul(principal as u128)
        .ok_or(ExtError::MathOverflow)?
        .checked_div(INDEX_SCALE_U64 as u128)
        .ok_or(ExtError::MathUnderflow)?
        .try_into()?;

    Ok(amount)
}

/// Converts principal (raw token units) to a UI amount at `index`, rounding up.
pub fn principal_to_amount_up(principal: u64, index: u64) -> Result<u64> {
    // If the index is 1, return the principal directly
    if index == INDEX_SCALE_U64 {
        return Ok(principal);
    }

    // Calculate the amount from the principal and index, rounding up
    let amount: u64 = (index as u128)
        .checked_mul(principal as u128)
        .ok_or(ExtError::MathOverflow)?
        .checked_add(
            (INDEX_SCALE_U64 as u128)
                .checked_sub(1u128)
                .ok_or(ExtError::MathUnderflow)?,
        )
        .ok_or(ExtError::MathOverflow)?
        .checked_div(INDEX_SCALE_U64 as u128)
        .ok_or(ExtError::MathUnderflow)?
        .try_into()?;

    Ok(amount)
}

pub fn multiplier_to_index(multiplier: f64) -> Result<u64> {
    let index: f64 = (INDEX_SCALE_F64 * multiplier).trunc();

    if index < 0.0 {
        err!(ExtError::MathUnderflow)
    } else if index > u64::MAX as f64 {
        err!(ExtError::MathOverflow)
    } else {
        // Convert the f64 index to u64
        Ok(index as u64)
    }
}

pub fn index_to_multiplier(index: u64) -> Result<f64> {
    Ok(index as f64 / INDEX_SCALE_F64)
}

pub fn get_mint_extensions<'info>(
    mint: &InterfaceAccount<'info, Mint>,
) -> Result<Vec<spl_token_2022::extension::ExtensionType>> {
    // Get the mint account data
    let account_info = mint.to_account_info();
    let mint_data = account_info.try_borrow_data()?;
    let mint_ext_data = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

    let extensions = mint_ext_data.get_extension_types()?;

    Ok(extensions)
}

cfg_if! {
    if #[cfg(feature = "scaled-ui")] {
        pub fn get_scaled_ui_config<'info>(
            mint: &InterfaceAccount<'info, Mint>,
        ) -> Result<ScaledUiAmountConfig> {
            // Get the mint account data with extensions
            let account_info = mint.to_account_info();
            let mint_data = account_info.try_borrow_data()?;
            let mint_ext_data = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

            // Get the scaled UI config extension
            let scaled_ui_config = mint_ext_data.get_extension::<ScaledUiAmountConfig>()?;

            Ok(*scaled_ui_config)
        }


        fn get_latest_index_and_timestamp<'info>(
            ext_global_account: &Account<'info, ExtGlobalV2>,
            m_mint: &InterfaceAccount<'info, Mint>,
        ) -> Result<(u64, u64, u64)> {
            let m_scaled_ui_config = get_scaled_ui_config(m_mint)?;

            let latest_m_index = multiplier_to_index(
                m_scaled_ui_config.new_multiplier.into(),
            )?;
            let cached_m_index = ext_global_account.yield_config.last_m_index;
            let timestamp: i64 = m_scaled_ui_config.new_multiplier_effective_timestamp.into();
            let latest_timestamp = timestamp as u64;
            let cached_ext_index = ext_global_account.yield_config.last_ext_index;

            // If no change, return early
            if latest_m_index == cached_m_index {
                return Ok((cached_m_index, cached_ext_index, latest_timestamp));
            }

            // Calculate the new ext index based on the latest m index and timestamp
            let new_ext_index = calculate_new_index(
                cached_ext_index,
                cached_m_index,
                latest_m_index,
                ext_global_account.yield_config.fee_bps
            )?;

            Ok((latest_m_index, new_ext_index, latest_timestamp))
        }

        fn calculate_new_index(
            last_ext_index: u64,
            last_m_index: u64,
            new_m_index: u64,
            fee_bps: u64,
        ) -> Result<u64> {
            // Confirm the inputs are in the expected domain.
            // These checks ensure that the resultant value is >= 1.0,
            // are allowable values to set as the Token2022 Scaled UI multiplier,
            // and the ext index is monotonically increasing.
            // While having the last ext index <= last m index isn't strictly necessary,
            // it arises naturally from our construction and provides a good sanity check.
            if last_ext_index < INDEX_SCALE_U64 ||
               last_m_index < last_ext_index ||
               new_m_index < last_m_index ||
               new_m_index > 100 * INDEX_SCALE_U64 || // we set a high, but finite upper bound on the index to ensure it (or the other indices) don't lead to overflow.
               fee_bps > 10000 {
                return err!(ExtError::InvalidInput);
            }

            // Calculate the new ext index from the formula:
            // new_ext_index = last_ext_index * ((new_m_index / last_m_index) ^ (1 - fee_on_yield))
            // The derivation of this formula is explained in this document: https://gist.github.com/Oighty/89dd1288a0a7fb53eb6f0314846cb746
            let m_increase_factor: u64 = (new_m_index as u128).checked_mul(INDEX_SCALE_U64 as u128).ok_or(ExtError::MathOverflow)?.checked_div(last_m_index as u128).ok_or(ExtError::MathUnderflow)?.try_into()?;

            // Calculate the increase factor for the ext index, if the fee is zero, then the increase factor is the same as M
            let ext_increase_factor = if fee_bps == 0 {
                m_increase_factor
            } else {
                // Calculate the increase factor for the ext index
                let fee_on_yield = fee_bps as f64 / ONE_HUNDRED_PERCENT_F64;
                // The precision of the powf operation is non-deterministic
                // However, the margin of error is ~10^-16, which is smaller than the 10^-12 precision
                // that we need for this use case. See: https://doc.rust-lang.org/std/primitive.f64.html#method.powf
                (((m_increase_factor as f64) / INDEX_SCALE_F64).powf(1.0f64 - fee_on_yield) * INDEX_SCALE_F64).floor() as u64
            };

            // Calculate the new extension index
            let new_ext_index: u64 = (last_ext_index as u128).checked_mul(ext_increase_factor as u128).ok_or(ExtError::MathOverflow)?.checked_div(INDEX_SCALE_U64 as u128).ok_or(ExtError::MathUnderflow)?.try_into()?;

            Ok(new_ext_index)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    cfg_if! {
        if #[cfg(feature = "scaled-ui")] {
            #[test]
            fn test_calculate_new_index_no_fee() {
                // cases (starting from 1.0):
                // no rounding
                let expected = 1125000000000u64;
                let result = calculate_new_index(1000000000000u64, 1000000000000u64, 1125000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round up -> truncates
                let expected = 1666666666666u64;
                let result = calculate_new_index(1000000000000u64, 1500000000000u64, 2500000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round down -> truncates
                let expected = 1333333333333u64;
                let result = calculate_new_index(1000000000000u64, 1500000000000u64, 2000000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // cases (starting from truncated value that would have rounded up):
                // no rounding
                let expected = 1749999999999u64; // off by one due to previous rounding
                let result = calculate_new_index(1666666666666u64, 2000000000000u64, 2100000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round up -> truncates
                let expected = 1777777777777u64;
                let result = calculate_new_index(1666666666666u64, 3000000000000u64, 3200000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round down -> truncates
                let expected = 2333333333332u64; // off by one due to previous rounding
                let result = calculate_new_index(1666666666666u64, 5000000000000u64, 7000000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // cases (starting from truncated value that would have rounded down)
                let expected = 1499999999999u64; // off by one due to previous rounding
                let result = calculate_new_index(1333333333333u64, 2000000000000u64, 2250000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round up -> truncates
                let expected = 1666666666666u64;
                let result = calculate_new_index(1333333333333u64, 2000000000000u64, 2500000000000u64, 0).unwrap();
                assert_eq!(result, expected);

                // would round down -> truncates
                let expected = 2333333333332u64;
                let result = calculate_new_index(1333333333333u64, 4000000000000u64, 7000000000000u64, 0).unwrap();
                assert_eq!(result, expected);
            }

            #[test]
            fn test_calculate_new_index_with_fee() {
                // there are three calculations here to test rounding behavior:
                // 1. m_increase_factor = new_m_multiplier / last_m_multiplier
                // 2. ext_increase_factor = m_increase_factor.powf(1.0 - fee_on_yield)
                // 3. new_ext_multiplier = last_ext_multiplier * ext_increase_factor
                // cases are listed with what the rounding behavior would be for each calculation
                // even though the rounding only happens when converting back to u64 for the final result
                // the basic expectation is that if there is a roundup anywhere in the sequence
                // the final result will be off by one to the downside due to truncation

                // cases:
                // Note: we can't reliably get examples that wouldn't round either direction for the 2nd equation since it is a fractional exponent
                // A
                //   1. no rounding
                //   2. rounds down
                //   3. no rounding
                let result = calculate_new_index(1000000000000u64, 10000000000u64, 11250000000u64, 2500).unwrap();
                let expected_actual = 1092356486341; // wolfram alpha: 1.092356486341477...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // B
                //   1. no rounding
                //   2. rounds down
                //   3. rounds down
                let result = calculate_new_index(1300000000000u64, 1500000000000u64, 1650000000000u64, 1500).unwrap();
                let expected_actual = 1409701411824; // wolfram alpha: 1.409701411824313...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // C
                //  1. no rounding
                //  2. rounds down
                //  3. would round up -> truncates
                let result = calculate_new_index(1200000000000u64, 1500000000000u64, 1650000000000u64, 1500).unwrap();
                let expected_actual = 1301262841684; // wolfram alpha: 1.301262841683981...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // D
                //  1. no rounding
                //  2. would round up -> truncates
                //  3. no rounding
                let result = calculate_new_index(1000000000000u64, 1500000000000u64, 1650000000000u64, 1000).unwrap();
                let expected_actual = 1089565684036; // wolfram alpha: 1.089565684035973...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // E
                //  1. no rounding
                //  2. would round up -> truncates
                //  3. rounds down
                let result = calculate_new_index(1200000000000u64, 1500000000000u64, 1650000000000u64, 1000).unwrap();
                let expected_actual = 1307478820843; // wolfram alpha: 1.307478820843168...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // F
                //  1. no rounding
                //  2. would round up -> truncates
                //  3. would round up -> truncates
                let result = calculate_new_index(1300000000000u64, 1500000000000u64, 1650000000000u64, 1000).unwrap();
                let expected_actual = 1416435389247; // wolfram alpha: 1.41643538924676614906538927073063715743660444837662580163175093387867947...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // G
                //  1. rounds down
                //  2. rounds down
                //  3. no rounding
                let result = calculate_new_index(1000000000000u64, 1125000000000u64, 1250000000000u64, 1000).unwrap();
                let expected_actual = 1099465842451; // wolfram alpha: 1.099465842451349...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // H
                //  1. rounds down
                //  2. rounds down
                //  3. rounds down
                let result = calculate_new_index(1100000000000u64, 1125000000000u64, 1250000000000u64, 1000).unwrap();
                let expected_actual = 1209412426696; // wolfram alpha: 1.209412426696484...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // I
                //  1. rounds down
                //  2. rounds down
                //  3. would round up -> truncates
                let result = calculate_new_index(1200000000000u64, 1125000000000u64, 1250000000000u64, 1000).unwrap();
                let expected_actual = 1319359010942; // wolfram alpha: 1.319359010941619...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // J
                //  1. rounds down
                //  2. would round up -> truncates
                //  3. no rounding
                let result = calculate_new_index(1000000000000u64, 1125000000000u64, 1250000000000u64, 2000).unwrap();
                let expected_actual = 1087942624846; // wolfram alpha: 1.087942624845529...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // K
                //  1. rounds down
                //  2. would round up -> truncates
                //  3. rounds down
                let result = calculate_new_index(1300000000000u64, 1125000000000u64, 1250000000000u64, 2000).unwrap();
                let expected_actual = 1414325412299; // wolfram alpha: 1.414325412299188...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // L
                //  1. rounds down
                //  2. would round up -> truncates
                //  3. would round up -> truncates
                let result = calculate_new_index(1200000000000u64, 1125000000000u64, 1250000000000u64, 2000).unwrap();
                let expected_actual = 1305531149815; // wolfram alpha: 1.305531149814635...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // M
                //  1. would round up -> truncates
                //  2. rounds down
                //  3. no rounding
                let result = calculate_new_index(1000000000000u64, 3000000000000u64, 3200000000000u64, 1000).unwrap();
                let expected_actual = 1059804724543; // wolfram alpha: 1.059804724543068...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // N
                //  1. would round up -> truncates
                //  2. rounds down
                //  3. rounds down
                let result = calculate_new_index(1400000000000u64, 3000000000000u64, 3200000000000u64, 1000).unwrap();
                let expected_actual = 1483726614360; // wolfram alpha: 1.483726614360295...
                let expected = expected_actual; // no error
                assert_eq!(result, expected);

                // O
                //  1. would round up -> truncates
                //  2. rounds down
                //  3. would round up -> truncates
                let result = calculate_new_index(1200000000000u64, 3000000000000u64, 3200000000000u64, 1000).unwrap();
                let expected_actual = 1271765669452; // wolfram alpha: 1.271765669451681...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // P
                //  1. would round up -> truncates
                //  2. would round up -> truncates
                //  3. no rounding
                let result = calculate_new_index(1000000000000u64, 3000000000000u64, 3200000000000u64, 2000).unwrap();
                let expected_actual = 1052986925779; // wolfram alpha: 1.052986925778570...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);

                // Q
                //  1. would round up -> truncates
                //  2. would round up -> truncates
                //  3. rounds down
                let result = calculate_new_index(1200000000000u64, 3000000000000u64, 3200000000000u64, 2000).unwrap();
                let expected_actual = 1263584310934; // wolfram alpha: 1.263584310934284...
                let expected = expected_actual;
                assert_eq!(result, expected);

                // R
                //  1. would round up -> truncates
                //  2. would round up -> truncates
                //  3. would round up -> truncates
                let result = calculate_new_index(1400000000000u64, 3000000000000u64, 3200000000000u64, 2000).unwrap();
                let expected_actual = 1474181696090; // wolfram alpha: 1.474181696089998...
                let expected = expected_actual - 1; // off by one due to truncation
                assert_eq!(result, expected);
            }
        }
    }
}
