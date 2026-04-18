# Bundled FFmpeg Binary (Not Tracked in Git)

FloorPoV uses a private FFmpeg binary for recording.
The binary is bundled into app resources at build time, but it is not committed to git.

## Why this setup

- Users do not need to install FFmpeg separately.
- Repository size stays small.
- Build remains reproducible by pinning version + SHA256 checksums.

## Config

Pinned FFmpeg metadata lives in:

- `build/ffmpeg.json`

The archive URL should point to a fixed GitHub release asset (for example `GyanD/codexffmpeg` tag `8.1`).

For now, the project includes `win-x64` metadata.

## Fetch command

Run before Tauri build:

```powershell
bun run prepare:ffmpeg
```

This script:

1. Downloads the pinned FFmpeg archive.
2. Verifies archive SHA256.
3. Extracts `ffmpeg.exe` from the archive.
4. Verifies `ffmpeg.exe` SHA256.
5. Places the binary at:

- `src-tauri/bin/ffmpeg.exe`

## Git tracking

The binary is ignored by git:

- `src-tauri/bin/ffmpeg.exe`

Only scripts and metadata are tracked.

## Build integration

The Tauri bundle already includes `src-tauri/bin` resources (`tauri.conf.json`), so the fetched binary is packaged automatically.

## Updating FFmpeg version

1. Pick an exact FFmpeg archive.
2. Update `build/ffmpeg.json` with new URL + checksums.
3. Re-run `bun run prepare:ffmpeg`.
4. Validate recording and app build.

## Current pinned version

- `8.1` essentials build (`win-x64`)
