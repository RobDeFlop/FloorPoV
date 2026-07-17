# FloorPoV

> Windows desktop recording and combat-log analysis for World of Warcraft.

[![Latest release](https://img.shields.io/github/v/release/RobDeFlop/FloorPoV?include_prereleases&label=release)](https://github.com/RobDeFlop/FloorPoV/releases)
[![Release workflow](https://github.com/RobDeFlop/FloorPoV/actions/workflows/release.yml/badge.svg)](https://github.com/RobDeFlop/FloorPoV/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/license-GPLv3-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](https://github.com/RobDeFlop/FloorPoV/releases)

FloorPoV records World of Warcraft gameplay and places important combat events on the video timeline. Use it to review Mythic+ runs, raid progression, and PvP matches.

This project is currently in beta and supports Windows 10 and Windows 11.

![Video analysis screenshot](https://i.imgur.com/SEQw9I9.jpeg)
![Log analysis screenshot](https://i.imgur.com/UwLeCqT.png)

## Features

- Automatic event markers for player deaths, kills, interrupts, dispels, and boss encounters.
- Manual timeline markers with configurable global hotkeys.
- Automatic recording when Mythic+, raid, or PvP combat begins.
- FFmpeg-based H.264/MP4 recording with hardware encoder support when available.
- Optional desktop and game audio capture through WASAPI loopback.
- Recording library organized by Mythic+, raid, and PvP game modes.
- WarcraftLogs one-shot combat-log uploads and live logging.
- Sidecar `.meta.json` files that preserve event metadata for later playback.

## Download and install

Download the latest Windows installer from the [GitHub Releases page](https://github.com/RobDeFlop/FloorPoV/releases), then run the installer.

FloorPoV bundles the Node.js parser runtime and FFmpeg. End users do not need to install Node.js or FFmpeg separately.

After installation:

1. Open FloorPoV and select your World of Warcraft folder in **Settings**.
2. Make sure WoW is producing a `Logs\WoWCombatLog*.txt` file before using combat detection, automatic recording, or live WarcraftLogs upload.
3. Configure your recording, audio, and manual-marker hotkey settings.

Beta releases may contain unfinished features or regressions. Please report reproducible problems through the [issue tracker](https://github.com/RobDeFlop/FloorPoV/issues).

## How it works

FloorPoV records your screen or selected window while monitoring the WoW combat log. Matching events are emitted as markers and saved with the recording:

- **Kills and deaths** — jump directly to important combat moments.
- **Boss encounters** — review raid progression and encounter timing.
- **Interrupts and dispels** — analyze key moments in Mythic+ and PvP.
- **Manual markers** — flag any moment with a global hotkey.
- **WarcraftLogs** — upload an existing combat log or start a live upload.

## Development

### Technology

| Layer | Technology |
| --- | --- |
| Desktop framework | Tauri 2 with a Rust backend |
| Frontend | React 19, TypeScript, Tailwind CSS, and Vite |
| Screen capture | FFmpeg Desktop Duplication (`ddagrab`) |
| Audio capture | WASAPI system loopback |

### Prerequisites

For local development, use Windows 10 or Windows 11 with:

- [Bun](https://bun.sh/)
- [Rust](https://rustup.rs/)
- PowerShell

The preparation scripts download the pinned Windows Node.js and FFmpeg binaries into `src-tauri/bin/`. They are required before running or building the Tauri application, but do not need to be installed globally.

### Run locally

From PowerShell:

```powershell
git clone https://github.com/RobDeFlop/FloorPoV.git
Set-Location FloorPoV

bun install
bun run prepare:node-runtime
bun run prepare:ffmpeg
bun run tauri dev
```

### Development commands

```powershell
# Frontend development
bun run dev
bun run build
bunx tsc --noEmit

# Full Tauri application
bun run tauri dev
bun run tauri build

# Rust checks
Set-Location src-tauri
cargo check
cargo clippy
cargo fmt --check
cargo test
```

### Runtime and release documentation

- [Bundled Node.js runtime](docs/node-runtime-bundling.md)
- [Bundled FFmpeg binary](docs/ffmpeg.md)
- [Release checklist](docs/release-checklist.md)
- [Coding guidelines](docs/coding-guidelines.md)

The GitHub release workflow builds the Windows NSIS installer and updater artifacts. See the [release checklist](docs/release-checklist.md) before publishing a beta release.

## Contributing

Bug reports, feature requests, and pull requests are welcome. Please check the [open issues](https://github.com/RobDeFlop/FloorPoV/issues) before starting work and follow the repository's [contribution guide](CONTRIBUTING.md) and [coding guidelines](docs/coding-guidelines.md).

## License

FloorPoV is licensed under the [GNU General Public License v3.0](LICENSE).
