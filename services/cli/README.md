# Extension CLI

Deployment and management CLI for M extensions and the Swap Facility. Two entry points:

- **`main.ts`** — onchain management: mint creation, extension initialization, whitelisting, metadata.
- **`deploy.ts`** — program lifecycle: build, deploy, upgrade, IDL, build verification.

Run `--help` on either for the full command list; every command has a description.

## Setup

Credentials are injected from 1Password (`mzerolabs.1password.com`) via `op run` — no keys on disk. Install the [`op` CLI](https://developer.1password.com/docs/cli/) and sign in once.

| Script | Env file | Network |
| --- | --- | --- |
| `pnpm cli:dev` / `pnpm deploy:dev` | `.env.dev` | devnet |
| `pnpm cli:prod` / `pnpm deploy:prod` | `.env.prod` | mainnet |

The `.env.*` files (repo root) contain `op://` secret references resolved at runtime plus plain config (`NETWORK`, `LOOKUP_TABLE`, `EXT_NAME`, …). Keypair env vars resolve to JSON secret-key arrays.

Additional requirements:

- **`deploy.ts`** needs a `devnet-keypair.json` in the repo root (deploy/upgrade fee payer) and Docker (Anchor verifiable builds).
- **`main.ts`** loads IDLs from `target/` — run `make build-programs` first.

## Transaction signing: direct vs Squads

Every state-changing command routes through one rule:

- **`SQUADS_MULTISIG` unset** (devnet): the transaction is signed by `PAYER_KEYPAIR` and sent.
- **`SQUADS_MULTISIG` set** (mainnet, see `.env.prod`): the transaction is **not sent** — it is printed base64/base58-serialized with the multisig as fee payer/authority, to be imported into Squads, approved, and executed there.

Exceptions: `update-swap-lut` always sends directly; `update-mint` (Token2022 path) and `extend-program`/`close-buffers` always require `SQUADS_MULTISIG`.

## Commands — `main.ts` (`pnpm cli:dev|cli:prod`)

| Command | Purpose | Key env vars |
| --- | --- | --- |
| `print-extensions` | Print extension program addresses from 1Password keypairs | (reads `op://` paths directly) |
| `create-ext-mint` | Create the extension's mint (Token2022 + chosen extensions, or legacy via `--legacy-program`); mint authority = extension's `mint_authority` PDA | `PAYER_KEYPAIR`, `EXT_MINT_KEYPAIR`, `EXT_PROGRAM_KEYPAIR` |
| `create-vault-m-ata` | Create the `$M` ATA owned by the extension's `m_vault` PDA | `PAYER_KEYPAIR`, `EXT_PROGRAM_KEYPAIR` |
| `create-ata` | Create a Token2022 ATA for any mint/owner | `PAYER_KEYPAIR` |
| `initialize-ext` | Initialize the extension program (`-v no-yield\|scaled-ui`); wrap authorities default to swap router, portal, admin | `PAYER_KEYPAIR`, `EXT_MINT_KEYPAIR`, `EXT_PROGRAM_KEYPAIR` |
| `migrate-ext` | Run `migrate_m` to upgrade a V1 extension to the V2 layout | `PAYER_KEYPAIR`, `<extension>` |
| `initialize-ext-swap` | Initialize the Swap Facility global account | `PAYER_KEYPAIR` |
| `add-wrap-authority` | Add wrap authorities on an extension | `PAYER_KEYPAIR`, `<extension>` |
| `reset-swap-authority` | Reset the Swap Facility whitelists (`reset_whitelists`) | `PAYER_KEYPAIR` |
| `whitelist-swap-unwrapper` | Whitelist unwrapper authorities on the Swap Facility | `PAYER_KEYPAIR` |
| `whitelist-extensions` | Whitelist extension programs on the Swap Facility | `PAYER_KEYPAIR` |
| `remove-whitelisted-extensions` | Remove extensions from the Swap Facility whitelist | `PAYER_KEYPAIR` |
| `update-swap-lut` | Create/extend the address lookup table with common swap accounts | `PAYER_KEYPAIR`, extension keypairs, `LOOKUP_TABLE` |
| `update-mint` | Update token metadata (name/symbol/URI/custom field) | `EXT_MINT_KEYPAIR`, `PAYER_KEYPAIR`, `SQUADS_MULTISIG` |
| `set-yield-recipient` | Set a crank earner's yield recipient token account (signer = earn manager) | `PAYER_KEYPAIR`, `<extension>` |

`<extension>` means the command takes `-e <name>` naming an env var that holds the program keypair (`M0_WM`, `USDK`, `USDKY`, `USDP`, `XO`).

**Note:** the extension-program → mint mapping used by `whitelist-extensions`, `migrate-ext`, and `update-swap-lut` is hardcoded in `main.ts` (`mints`). Add new extensions there.

## Commands — `deploy.ts` (`pnpm deploy:dev|deploy:prod`)

| Command | Purpose | Notes |
| --- | --- | --- |
| `deploy-program` | Verifiable-build a variant (`-t`) for an extension (`-e`) and deploy it | Temporarily rewrites `declare_id!` to the extension's program ID; `wm` feature is auto-added for the wM program ID |
| `upgrade-program` | Write a buffer and upgrade the program; with `-a` transfers buffer authority to the multisig instead (Squads executes the upgrade) | `-m` adds the `migrate` feature, `-s` targets `ext_swap`, `-b` skips the build |
| `transfer-upgrade-auth` | Transfer a program's upgrade authority to `SQUADS_MULTISIG` | Irreversible from the CLI keypair's perspective |
| `set-idl` | Build and `anchor idl init`/`upgrade` the onchain IDL | `-i` for first-time init, `-s` for `ext_swap` |
| `extend-program` | Emit a serialized `ExtendProgram` transaction sized for a new binary (+5%) | Requires `SQUADS_MULTISIG`; output goes to Squads |
| `close-buffers` | Emit a serialized transaction closing all multisig-owned deploy buffers | Refunds rent to `-r <recipient>` |
| `verify-build` | Compare on-chain program hash against a local verifiable build | ✅/❌ result; use after deploys/upgrades |
| `verify-pda-txn` | Export the `solana-verify` PDA transaction for a commit hash | For the public verified-builds registry |
| `submit-verify-job` | Submit a `solana-verify` remote verification job | Uploader = `SQUADS_MULTISIG` |

## Safety

- `cli:prod` / `deploy:prod` target **mainnet**. Program upgrades, authority transfers, and whitelist changes take effect immediately once the Squads transaction executes.
- The `deploy:*` scripts run `op` with `--no-masking` — secrets may appear in terminal output. Don't run them in shared/recorded sessions.
- Always run `verify-build` after a deploy or upgrade to confirm the on-chain binary matches the source.

## Files

- `token-extensions.ts` — instruction builders for Token2022 extensions not yet covered by `@solana/spl-token` (confidential transfer, scaled-UI config).
- `example_token_metadata.json` — example of the offchain JSON document the token URI (`EXT_URI`) should point to (host it e.g. on IPFS).
