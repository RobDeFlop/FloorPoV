# Implementation Plan

## Project Goal

Floorpov records WoW gameplay with markers on important events (player deaths, kills, and manual markers). Users can capture either the full monitor or a specific window, with live preview during recording.

## Tech Stack

| Layer | Technology |
|---|---|
| Capture | `windows-capture` 2.0 (Windows Graphics Capture API + DXGI Desktop Duplication) |
| Recording | `windows-capture::VideoEncoder` (H.264/MP4) |
| Preview Encoding | WIC JPEG via `ImageEncoder` from `windows-capture` |
| Hotkeys | `tauri-plugin-global-shortcut` |
| Combat Log | File watcher + regex parsing (mocked initially) |
| Audio | WASAPI or `windows-record` (later phase) |

## Planned File Structure

```text
src-tauri/
|- Cargo.toml
`- src/
   |- lib.rs          # Tauri commands + module exports
   |- capture.rs      # Preview capture (JPEG frames)
   |- recording.rs    # Video recording (H.264, audio later)
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
|- hooks/
|  `- usePreview.ts
|- types/
|  `- events.ts
`- data/
   `- mockEvents.ts
```

## Phase 1: Capture Infrastructure

### Backend

1. Add dependency to `Cargo.toml`:
   - `windows-capture = "2.0.0-alpha.7"`
2. Build `src/capture.rs`:
   - Preview capture handler implementing `GraphicsCaptureApiHandler`
   - Source selection support (`primary-monitor` and later window capture)
   - `start_preview`, `stop_preview`, `list_windows` commands
   - Emit `preview-frame` events with JPEG bytes
   - Emit `capture-stopped` lifecycle event
3. Build `src/recording.rs`:
   - `start_recording` and `stop_recording`
   - H.264/MP4 recording with `VideoEncoder`
   - Emit `recording-started` and `recording-stopped`
4. Register modules and commands in `src-tauri/src/lib.rs`.

### Frontend

1. Build `src/contexts/RecordingContext.tsx` for preview and recording state.
2. Build `src/components/RecordingControls.tsx`:
   - Source dropdown
   - Preview toggle
   - Recording toggle
   - Recording timer
3. Update `src/components/VideoPlayer.tsx`:
   - Canvas for live preview
   - Video element for playback
4. Build `src/hooks/usePreview.ts` to paint incoming frames on canvas.

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
[Capture Pipeline]
  |- preview-frame --> Frontend canvas draw
  `- recording pipeline --> output video file

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
| Audio | Deferred to later phase |
| Preview FPS | 30 |
| Preview quality | JPEG 85% |
| Output folder | `%USERPROFILE%/Videos/Floorpov/` |

## Implementation Order

1. Backend capture module (`capture.rs`) with preview.
2. Frontend recording context and preview rendering.
3. Backend recording module with MP4 output.
4. Frontend recording controls and source selector.
5. Frontend settings and persistence.
6. Backend combat event source (mock first).
7. Frontend marker context and timeline integration.
8. Manual marker hotkeys.
9. Audio capture support.

## Current Decisions

- Default capture source: primary monitor.
- Output folder default: `%USERPROFILE%/Videos/Floorpov/`.
- Window selection UX: dropdown list.
- Combat log parser: mocked first, then real parser.
