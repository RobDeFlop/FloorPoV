# FloorPoV

> **WoW Gameplay Recording and Combat-Log Analysis**

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/RobDeFlop/FloorPoV)
[![License](https://img.shields.io/badge/license-GPLv3-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)]()

FloorPoV is a desktop application that records your World of Warcraft gameplay while automatically detecting and marking important events like player deaths, boss encounters, kills, and interrupts directly on the video timeline. Perfect for analyzing Mythic+ runs, raid progression, and PvP matches.

![Video Analysis Screenshot](https://i.imgur.com/SEQw9I9.jpeg)
![Log Analysis Screenshot](https://i.imgur.com/UwLeCqT.png)

## ✨ Features

| Feature | Description |
|---------|-------------|
|  **Smart Event Markers** | Automatically detects player deaths, kills, interrupts, dispels, and boss encounters |
|  **High-Quality Recording** | FFmpeg-powered capture with H.264/MP4 output and quality presets |
|  **Manual Markers** | Add custom markers during gameplay with configurable hotkeys |
|  **Combat Log Integration** | Real-time WoW combat log parsing for accurate event tracking |
|  **Performance Optimized** | Lightweight recording that won't impact your gameplay performance |
|  **System Audio Capture** | Optional desktop/game audio recording via WASAPI loopback |
|  **Organized Library** | Browse recordings by game mode (Mythic+, Raid, PvP) with metadata |

## 🚀 Quick Start

### Prerequisites

- Windows 10/11

### Prepare bundled runtimes

From repo root, run:

```bash
bun run prepare:node-runtime
bun run prepare:ffmpeg
```

This downloads pinned Windows binaries into `src-tauri/bin/` for local and CI builds.

### Installation

1. Clone the repository

```bash
git clone https://github.com/RobDeFlop/FloorPoV.git
cd FloorPoV
```

1. Install dependencies

```bash
bun install
```

1. Run the application

```bash
bun run prepare:node-runtime
bun run prepare:ffmpeg
bun run tauri dev
```

## 📸 How It Works

FloorPoV simultaneously records your screen/window and monitors your WoW combat log file. When events occur, they're automatically marked on the recording timeline:

- **Kills & Deaths**: Instantly jump to combat moments
- **Boss Encounters**: Review raid progression with clear markers
- **Interrupts & Dispels**: Analyze key moments in Mythic+ and PvP
- **Manual Markers**: Mark custom moments with hotkeys

Each recording includes a metadata file (.meta.json) preserving all events for later playback.

## 🛠️ Development

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Desktop Framework** | Tauri 2 (Rust backend) |
| **Frontend** | React 19, TypeScript, Tailwind CSS, Vite |
| **Screen Capture** | via FFmpeg Desktop Duplication (DDAgrab) |
| **Audio Capture** | WASAPI system loopback |

### Development Commands

```bash
# Frontend only development
bun run dev
bun run build

# Full Tauri app (frontend + backend)
bun run tauri dev
bun run tauri build

# Type checking
bunx tsc --noEmit

# Rust development
cd src-tauri
cargo check
cargo clippy
cargo fmt --check
cargo test
```

### Release Process

See `docs/release-checklist.md` for the step-by-step installer release flow.

Runtime bundling details:

- `docs/node-runtime-bundling.md`
- `docs/ffmpeg.md`

## Use Cases

- **Mythic+ Analysis**: Review deaths and interrupts to improve dungeon runs
- **Raid Progression**: Analyze boss encounters and player performance
- **PvP Improvement**: Study key moments in arena and battlegrounds

## 📋 Requirements

- Windows 10/11
- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 18+
- [Bun](https://bun.sh/)
- FFmpeg executable

## 🤝 Contributing

Contributions are welcome! Please check the [issues page](https://github.com/RobDeFlop/FloorPoV/issues) for current development priorities.

## 📄 License

GNU General Public License v3.0 - see [LICENSE](LICENSE) file for details.
