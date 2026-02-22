# Floorpov

A desktop app for recording WoW gameplay with markers on important events. Recording uses an FFmpeg backend focused on primary monitor capture.

## Features

- Primary monitor or specific window capture via FFmpeg
- Optional system audio capture (loopback)
- Quality preset and FPS controls
- Optional recording diagnostics mode
- Combat log markers (player deaths, kills)
- Manual markers via hotkey
- H.264/MP4 output

## Settings Overview

- **Quality Preset**: controls target recording bitrate profile (higher uses more disk space).
- **Frame Rate**: target output capture rate (`30` or `60` FPS).
- **System Audio**: enables desktop/game audio capture.
- **Recording Diagnostics**: writes per-second FFmpeg/audio pipeline logs for troubleshooting.
- **Microphone**: not available in the current FFmpeg-only recorder path.
- **Capture Source**: choose primary monitor or a specific window.

## Requirements

- Windows 10/11
- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 18+
- [Bun](https://bun.sh/)

## Setup

1. Place `ffmpeg.exe` at `src-tauri/bin/ffmpeg.exe`.
2. Install dependencies and run the app:

```bash
bun install
bun run tauri dev
```

## Development Commands

```bash
# Frontend only
bun run dev
bun run build

# Full Tauri app (frontend + backend)
bun run tauri dev
bun run tauri build

# Type checking
bunx tsc --noEmit

# Rust lint/format/check
cd src-tauri
cargo check
cargo clippy
cargo fmt --check
cargo test
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Tailwind CSS, Vite |
| Backend | Tauri 2, Rust |
| Capture | FFmpeg screen capture |
| Recording | FFmpeg (H.264/MP4) |
| Hotkeys | tauri-plugin-global-shortcut |

## License

MIT
