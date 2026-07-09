# Architecture

Reference for the `m_ext` and `ext_swap` programs. For protocol-level context see the
[M0 docs on Solana](https://docs.m0.org/protocol/solana) and
[Extensions](https://docs.m0.org/protocol/extensions).

## System Context

```
Ethereum (hub: $M index + earner approvals)
    │  Wormhole
    ▼
┌─ solana-m repo ──────────────────────────────────────┐
│  portal ──► earn ──► $M mint (Token2022 ScaledUiAmount) │
└──────────────────────────────────────────────────────┘
    │  wrap / unwrap (CPI-able by anyone on the wrap-authority list)
    ▼
┌─ this repo ──────────────────────────────────────────┐
│  m_ext   — one deployment per extension (wM, USDK, …) │
│  ext_swap — singleton router for 1:1 extension swaps  │
└──────────────────────────────────────────────────────┘
```

**Repo boundary:** the portal, earn program, and the `$M` token live in
[solana-m](https://github.com/m0-foundation/solana-m). This repo only contains the extension
framework (`m_ext`) and the swap router (`ext_swap`).

**One program, many deployments:** every extension is a separate deployment of `m_ext` under its
own program ID, compiled with the feature flags for its yield variant. PDA seeds are constants, so
each deployment derives its own global/vault/mint-authority PDAs.

## Why V2

In M v1 the `$M` token on Solana distributed yield via an offchain crank. In V2, `$M` is a
Token2022 mint with the `ScaledUiAmount` extension — yield accrues by multiplier updates bridged
from Ethereum, fully onchain. For extensions this meant:

- `m_ext` handles a rebasing `$M` as underlying; existing extensions migrate via `migrate_m`.
- The former `ext_earn` program (wM, in solana-m) was folded into `m_ext` as the **crank** variant.
- crank and no-yield ext mints may use the legacy SPL Token program instead of Token2022.
- Admin transfer is a two-step process (`transfer_admin` → `accept_admin`).
- `ext_swap` handles the rebasing `$M` and no longer requires ATAs for user token accounts.

## Yield Variants

| Feature flag | Ext token behavior | Yield destination |
| --- | --- | --- |
| `no-yield` (default) | 1:1 with `$M`, non-rebasing | Admin claims vault excess via `claim_fees` |
| `scaled-ui` | Rebasing via Token2022 `ScaledUiAmount` | All holders, minus optional `fee_bps` claimed by admin |
| `crank` | 1:1 with `$M`, non-rebasing | Registered earners, distributed per-account by the earn authority |
| `wm` = `crank` + `migrate` | As crank | wM only — adds V1 (`ext_earn`) → V2 migration |

Exactly one of `no-yield` / `scaled-ui` / `crank` must be enabled; this is enforced at compile
time in `programs/m_ext/src/lib.rs`. `migrate` + `crank` is only valid as `wm`, because wM is the
only crank extension with a V1 to migrate from.

**How yield flows per variant:**

- **no-yield** — the vault's `$M` rebases up while ext supply stays fixed; the surplus
  (vault value − ext supply) is minted to the admin's fee token account on `claim_fees`.
- **scaled-ui** — `sync` (permissionless) recomputes the ext multiplier from the `$M` multiplier:
  `new_ext_index = last_ext_index * (new_m_index / last_m_index)^(1 - fee_on_yield)`
  ([derivation](https://gist.github.com/Oighty/89dd1288a0a7fb53eb6f0314846cb746)). The fee
  accumulates as vault surplus and is claimed via `claim_fees`. `wrap`/`unwrap` call the same sync
  internally, so the multiplier is always fresh when tokens move.
- **crank** — the earn authority calls `sync` to snapshot the `$M` index, then `claim_for` per
  earner, minting `balance * (global_index / earner_last_claim_index) - balance` to the earner
  (or their configured recipient). The earner's earn manager takes `fee_bps` of the claim if
  active. Collateralization is checked on every claim: minting never exceeds vault value.

## Instruction Matrix — `m_ext`

| Instruction | Variants | Caller |
| --- | --- | --- |
| `initialize` | all (args differ: scaled-ui adds `fee_bps`, crank adds `earn_authority`) | admin |
| `wrap` / `unwrap` | all | wrap-authority list (directly, or co-signing for a user) |
| `add_wrap_authority` / `remove_wrap_authority` | all | admin |
| `transfer_admin` / `revoke_admin_transfer` | all | admin |
| `accept_admin` | all | pending admin |
| `claim_fees` | no-yield, scaled-ui | admin |
| `set_fee` | scaled-ui | admin |
| `sync` | scaled-ui | **permissionless** |
| `sync` | crank | earn authority |
| `claim_for` | crank | earn authority |
| `set_earn_authority` | crank | admin |
| `add_earn_manager` / `remove_earn_manager` | crank | admin |
| `add_earner` / `remove_earner` / `transfer_earner` | crank | earn manager (active) |
| `configure_earn_manager` | crank | earn manager |
| `set_recipient` | crank | earner or their earn manager |
| `remove_orphaned_earner` | crank | **permissionless** (only if earn manager inactive) |
| `migrate_m` | migrate (incl. wm) | admin |

Note the same instruction name can differ per variant: scaled-ui `sync` updates the ext mint
multiplier (anyone may call); crank `sync` only snapshots the `$M` index/timestamp into
`YieldConfig` for subsequent `claim_for` calls.

## Instruction Matrix — `ext_swap`

| Instruction | Feature | Caller |
| --- | --- | --- |
| `initialize_global` | — | admin |
| `whitelist_extension` / `remove_whitelisted_extension` | — | admin |
| `whitelist_unwrapper` / `remove_whitelisted_unwrapper` | — | admin |
| `reset_whitelists` | migrate | admin |
| `swap` | — | anyone (both extensions must be whitelisted) |
| `wrap` / `unwrap` | — | anyone / whitelisted unwrappers |

`swap` CPIs `from_ext.unwrap` → `to_ext.wrap`, routing `$M` through the router's own token
account. The router's global PDA acts as the default wrap/unwrap authority, so every swappable
extension must include it in its `wrap_authorities` list.

## PDA Reference

| Account | Seeds | Program | Created by | Notes |
| --- | --- | --- | --- | --- |
| `ExtGlobalV2` | `["global"]` | m_ext | `initialize` | Per-extension config: admin, mints, `YieldConfig`, wrap authorities |
| M vault authority | `["m_vault"]` | m_ext | derived | Data-less signer; owns the vault's `$M` ATA |
| Ext mint authority | `["mint_authority"]` | m_ext | derived | Data-less signer; mint/burn authority for the ext mint |
| `Earner` | `["earner", user_token_account]` | m_ext (crank) | `add_earner` | Closed by `remove_earner` / `remove_orphaned_earner` |
| `EarnManager` | `["earn_manager", manager_pubkey]` | m_ext (crank) | `add_earn_manager` | `is_active = false` after removal; orphans its earners |
| `SwapGlobal` | `["global"]` | ext_swap | `initialize_global` | Admin + whitelisted extensions/unwrappers |

Seeds are per-deployment: derive against the specific extension's program ID.

## Test Programs

Unit tests run on [litesvm](https://github.com/LiteSVM/litesvm) against pre-built binaries in
`tests/programs/`, produced by `make build-test-programs` (which temporarily rewrites
`declare_id!` in `m_ext/src/lib.rs` and reverts it afterwards):

| Binary | Build | Program ID |
| --- | --- | --- |
| `ext_a.so` | default features (`no-yield`) | `3joDhmLtHLrSBGfeAe1xQiv3gjikes3x8S4N3o6Ld8zB` |
| `ext_b.so` | `scaled-ui` | `HSMnbWEkB7sEQAGSzBPeACNUCXC9FgNeeESLnHtKfoy3` |
| `ext_c.so` | default features + a sed-injected `dummy_account` in `wrap.rs` (exercises wrap interfaces with extra accounts) | `81gYpXqg8ZT9gdkFSe35eqiitqBWqVfYwDwVfXuk8Xfw` |

These program IDs are test-only. Rebuild after changing `m_ext` instruction code, otherwise the
TypeScript tests keep running against stale binaries.
