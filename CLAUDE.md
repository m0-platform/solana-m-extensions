# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains Solana programs for M0 stablecoin extensions. The `m_ext` program implements different yield distribution variants of an M0 Extension (stablecoin backed by $M). The `ext_swap` program enables 1:1 swaps between whitelisted M extensions.

## Build Commands

```bash
# Build all program variants
make build-programs

# Build test programs (used for unit tests with specific program IDs)
make build-test-programs

# Run tests (TypeScript unit tests + Rust tests)
make test-programs

# Run just TypeScript tests
pnpm jest --preset ts-jest --verbose tests/unit/**.test.ts

# Run just Rust tests
cargo test

# Run a single test file
pnpm jest tests/unit/m_ext.test.ts

# Lint/format
pnpm lint
pnpm lint:fix
```

## Required Toolchain

- Anchor CLI: 0.31.1 (via `avm`)
- Solana: 2.1.0
- pnpm for Node.js package management

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system context, the instruction × variant matrix (including which signer each instruction requires), the PDA reference, and the yield flow per variant.

### Programs

**m_ext** (`programs/m_ext/`) - M Extension program with compile-time yield distribution variants:
- Feature flags control variant: `no-yield` (default), `scaled-ui`, `crank`
- Only ONE yield feature can be enabled at build time (enforced at compile time)
- `migrate` feature enables V1 to V2 migration logic
- `wm` feature combines `crank` + `migrate` for the wM extension

**ext_swap** (`programs/ext_swap/`) - Swap router for converting between M extensions:
- Whitelisted extensions can be swapped 1:1
- Uses CPI to call m_ext's wrap/unwrap instructions

### Key State Accounts

- `ExtGlobalV2` - Per-extension global config (admin, mints, yield config, wrap authorities)
- `YieldConfig` - Variant-specific state, struct differs based on feature flag
- `EarnManager` / `Earner` - Crank variant only, for manual yield distribution

### Feature Flag Implications

When modifying instruction code, check which features it applies to via `#[cfg(feature = "...")]` guards. The build produces different programs:
- Default: `no-yield` variant
- `--features scaled-ui --no-default-features`: Rebasing via Token2022 scaled UI
- `--features crank --no-default-features`: Manual yield distribution via cranking
- `--features wm --no-default-features`: wM extension (crank + migrate)

### Tests

Tests use `litesvm` for fast local execution. Test programs in `tests/programs/` are pre-built with specific program IDs: `ext_a.so` (no-yield), `ext_b.so` (scaled-ui), `ext_c.so` (no-yield with an extra injected account in `wrap`). After changing `m_ext` instruction code, rebuild them with `make build-test-programs` — otherwise the TypeScript tests run against stale binaries.

The test harness in `tests/unit/ext_test_harness.ts` provides utilities for setting up test environments with M token infrastructure.

### CLI Service

`services/cli/` contains deployment and management scripts. Requires 1Password for credential injection:
```bash
pnpm cli:dev    # Run CLI with devnet credentials
pnpm cli:prod   # Run CLI with mainnet credentials
```

See [services/cli/README.md](services/cli/README.md) for setup (1Password, `.env` files, `devnet-keypair.json`), the full command reference, and the Squads multisig transaction flow.
