# FloorPoV 🎮

> **Smart WoW Gameplay Recording with Automatic Event Markers**

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/RobDeFlop/FloorPoV)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)]()

FloorPoV is a desktop application that records your World of Warcraft gameplay while automatically detecting and marking important events like player deaths, boss encounters, kills, and interrupts directly on the video timeline. Perfect for analyzing Mythic+ runs, raid progression, and PvP matches.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎯 **Smart Event Markers** | Automatically detects player deaths, kills, interrupts, dispels, and boss encounters |
| 🎥 **High-Quality Recording** | FFmpeg-powered capture with H.264/MP4 output and quality presets |
| ⌨️ **Manual Markers** | Add custom markers during gameplay with configurable hotkeys (F9-F12) |
| 📊 **Combat Log Integration** | Real-time WoW combat log parsing for accurate event tracking |
| ⚡ **Performance Optimized** | Lightweight recording that won't impact your gameplay performance |
| 🎵 **System Audio Capture** | Optional desktop/game audio recording via WASAPI loopback |
| 🗂️ **Organized Library** | Browse recordings by game mode (Mythic+, Raid, PvP) with metadata |

## 🚀 Quick Start

### Prerequisites
- Windows 10/11
- [FFmpeg](https://ffmpeg.org/download.html) (place `ffmpeg.exe` in `src-tauri/bin/`)

### Installation
1. Clone the repository
```bash
git clone https://github.com/RobDeFlop/FloorPoV.git
cd FloorPoV
```

2. Install dependencies
```bash
bun install
```

3. Run the application
```bash
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
| **Screen Capture** | FFmpeg Desktop Duplication (ddagrab) |
| **Audio Capture** | WASAPI system loopback |
| **Hotkeys** | tauri-plugin-global-shortcut |
| **Storage** | tauri-plugin-store |

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

## 🎮 Use Cases

- **Mythic+ Analysis**: Review deaths and interrupts to improve dungeon runs
- **Raid Progression**: Analyze boss encounters and player performance
- **PvP Improvement**: Study key moments in arena and battlegrounds
- **Content Creation**: Easily find highlights for streaming and videos

## 📋 Requirements

- Windows 10/11
- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 18+
- [Bun](https://bun.sh/)
- FFmpeg executable

## 🤝 Contributing

Contributions are welcome! Please check the [issues page](https://github.com/RobDeFlop/FloorPoV/issues) for current development priorities.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.
