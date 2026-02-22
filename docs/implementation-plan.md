# Implementation Plan

## Project Goal

Floorpov records WoW gameplay with markers on important events (player deaths, kills, and manual markers). The current recorder is FFmpeg-based and supports both primary monitor and specific window capture.

## Tech Stack

| Layer | Technology |
|---|---|
| Capture | FFmpeg (`ddagrab`) |
| Recording | FFmpeg (H.264/MP4) |
| Preview Encoding | Not used in current FFmpeg-only path |
| Hotkeys | `tauri-plugin-global-shortcut` |
| Combat Log | File watcher + regex parsing (mocked initially) |
| Audio | WASAPI system loopback (microphone later phase) |

## Planned File Structure

```text
src-tauri/
|- Cargo.toml
`- src/
   |- lib.rs          # Tauri commands + module exports
   |- recording.rs    # FFmpeg recording orchestration
   `- combat_log.rs   # Combat log parsing (mocked initially)

src/
|- contexts/
|  |- VideoContext.tsx
|  |- RecordingContext.tsx
|  `- MarkerContext.tsx
|- components/
|  |- VideoPlayer.tsx
|  |- Timeline.tsx
|  |- RecordingControls.tsx
|  `- Settings.tsx
|- types/
|  `- events.ts
`- data/
   `- mockEvents.ts
```

## Phase 1: Capture Infrastructure

### Backend

1. Keep FFmpeg available at `src-tauri/bin/ffmpeg.exe` and bundle it via Tauri resources.
2. Build `src/recording.rs` around FFmpeg process orchestration:
   - `start_recording` and `stop_recording`
   - Primary monitor or specific window capture
   - Optional system audio loopback
   - Emit `recording-finalized` and `recording-stopped`
3. Register recording and settings commands in `src-tauri/src/lib.rs`.

### Frontend

1. Build `src/contexts/RecordingContext.tsx` for recording state and lifecycle.
2. Build `src/components/RecordingControls.tsx`:
   - Recording toggle
   - Recording timer
3. Update `src/components/VideoPlayer.tsx` for playback-first UX.

## Phase 2: Settings and UX Polish

1. Expand settings UI:
   - Quality presets
   - Frame rate
   - Audio toggles
   - Output folder
   - Combat log path
2. Persist settings with `tauri-plugin-store`.
3. Improve UX:
   - Recording status indicator
   - Capture selection feedback
   - Better error messages and recovery behavior

## Phase 3: Marker System

### Backend

1. Create `src-tauri/src/combat_log.rs`:
   - `CombatEvent` model
   - Mock event emitter first
   - `start_combat_watch` and `stop_combat_watch`
   - Emit `combat-event`
2. Add manual marker hotkey command/event flow.

### Frontend

1. Build `src/contexts/MarkerContext.tsx`.
2. Update timeline and event panels to consume real marker context instead of mocks.

## Event Flow

```text
[Start Recording]
      |
      v
[FFmpeg Process]
      |
      v
 output video file

[Combat Log Watch]
      |
      v
 combat-event --> MarkerContext --> Timeline markers
```

## Default Settings

| Setting | Value |
|---|---|
| Video codec | H.264 |
| Frame rate | 30 fps |
| Bitrate | 8 Mbps (High) |
| Container | MP4 |
| Audio | System audio loopback (microphone deferred) |
| Preview | Removed in FFmpeg-only mode |
| Output folder | `%USERPROFILE%/Videos/Floorpov/` |

## Implementation Order

1. Backend recording module with FFmpeg process orchestration.
2. Frontend recording context and controls.
3. Frontend settings and persistence.
4. Backend combat event source (mock first).
5. Frontend marker context and timeline integration.
6. Manual marker hotkeys.

## Current Decisions

- Default capture source: primary monitor (specific window is optional).
- Output folder default: `%USERPROFILE%/Videos/Floorpov/`.
- Combat log parser: mocked first, then real parser.
