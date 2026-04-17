# Bundled Node Runtime (Not Tracked in Git)

FloorPoV uses a private Node runtime to execute the WarcraftLogs parser harness.
The runtime is bundled into app resources at build time, but the binary is not committed to git.

## Why this setup

- Users do not need to install Node.
- Repository size stays small.
- Build remains reproducible by pinning version + SHA256 checksums.

## Runtime config

Pinned runtime metadata lives in:

- `build/node-runtime.json`

For now, the project includes `win-x64` metadata.

## Fetch command

Run before Tauri build:

```powershell
bun run prepare:node-runtime
```

This script:

1. Downloads the pinned Node archive.
2. Verifies archive SHA256.
3. Extracts `node.exe`.
4. Verifies `node.exe` SHA256.
5. Places runtime at:

- `src-tauri/bin/node/win-x64/node.exe`

## Git tracking

The runtime directory is ignored by git:

- `src-tauri/bin/node/`

Only scripts and metadata are tracked.

## Build integration

The Tauri bundle already includes `src-tauri/bin` resources (`tauri.conf.json`), so the fetched runtime is packaged automatically.

## Updating Node version

1. Pick an exact Node version.
2. Update `build/node-runtime.json` with new URLs + checksums.
3. Re-run `bun run prepare:node-runtime`.
4. Validate upload flow and app build.
