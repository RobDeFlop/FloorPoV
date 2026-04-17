# WarcraftLogs Upload Implementation Plan

## Goal

Add a dedicated WarcraftLogs upload experience to FloorPoV with:

- a separate Sidebar section and page for upload,
- Rust-native upload logic (no Python uploader integration),
- the same auth flow and endpoint contract used by the official desktop client behavior,
- progress, cancellation, and clear error handling.

## Scope

### In scope (v1)

- New Sidebar section and app view: `WarcraftLogs -> Upload`.
- New frontend page for upload inputs, progress, and result URL.
- Rust uploader module for login, parser bootstrap, report creation, segment upload, and report termination.
- Node-based parser bridge for running parser JavaScript fetched from WarcraftLogs.
- Cancel support for running uploads.

### Out of scope (v1)

- Persisting passwords in settings.
- Replacing Node parser runtime with an embedded JS engine.
- Multi-upload queue management.
- OAuth/token-based login flow (if introduced later by WarcraftLogs).

## Architecture Summary

### Frontend

- Add new `AppView` value: `"warcraftlogs"`.
- Add Sidebar block with a dedicated nav button for upload.
- Render a new page component for upload form and progress display.
- Invoke Tauri commands for start/cancel/latest-log-path.
- Listen to backend upload events and map to UI state.

### Backend

- Add a new module tree: `src-tauri/src/wcl_upload/`.
- Implement HTTP client logic in Rust (`reqwest`) with cookie/session reuse.
- Implement parser bridge by spawning Node and sending JSON commands over stdin/stdout.
- Parse log in batches and upload report segments.
- Emit progress events to frontend and support cancellation via shared task state.

## Sidebar and Navigation Changes

## Files to change

- `src/types/ui.ts`
- `src/components/app/Sidebar.tsx`
- `src/components/app/Layout.tsx`

## Planned updates

1. Extend `AppView`:
   - from: `"main" | "settings" | "debug" | GameMode`
   - to: `"main" | "settings" | "debug" | "warcraftlogs" | GameMode`
2. Add a new Sidebar block labeled `WarcraftLogs` with an `Upload` button.
3. Add a new view branch in `Layout.tsx` that renders `WarcraftLogsUploadPage`.

## Frontend Page Plan

## New file

- `src/components/warcraftlogs/WarcraftLogsUploadPage.tsx`

## UI sections

1. **Account**
   - Email
   - Password (never persisted)
2. **Upload Options**
   - Region (`US=1`, `EU=2`, `KR=3`, `TW=4`, `CN=5`)
   - Visibility (`Public=0`, `Private=1`, `Unlisted=2`)
   - Guild ID (optional)
3. **Log Source**
   - Read-only path + browse file button
   - `Use latest WoW log` button (calls backend helper)
4. **Upload Progress**
   - Status line
   - Progress bar
   - Scrollable log output
   - `Cancel` while running
5. **Result**
   - Final report URL
   - Copy/open actions

## Frontend behavior rules

- Disable form fields during upload.
- Prevent duplicate uploads while one is active.
- Clear previous result when starting a new upload.
- Show recoverable errors inline (invalid login, no fights, parser failure, network timeout).

## Backend Module Plan

## New module tree

```text
src-tauri/src/wcl_upload/
|- mod.rs
|- types.rs
|- client.rs
|- parser_bridge.rs
`- uploader.rs
```

## Responsibility split

- `types.rs`: shared DTOs (command payloads, progress events, enums).
- `client.rs`: HTTP session, retry policy, endpoint calls.
- `parser_bridge.rs`: Node child process lifecycle + command protocol.
- `uploader.rs`: orchestration, batching, zip creation, cancellation checks, event emission.
- `mod.rs`: Tauri command entry points and shared upload task registry.

## Tauri command surface

1. `start_wcl_upload(payload) -> { reportUrl: string, reportCode: string }`
2. `cancel_wcl_upload() -> ()`
3. `get_latest_combat_log_path(wowFolder?: string) -> string | null`

## Event names

- `wcl-upload-progress`
- `wcl-upload-complete`
- `wcl-upload-error`

## Protocol and Endpoint Flow

All requests target `https://www.warcraftlogs.com`.

1. Login
   - `POST /desktop-client/log-in`
   - JSON body: `{ email, password, version }`
   - Persist session cookies in the same HTTP client instance.
2. Parser bootstrap
   - `GET /desktop-client/parser?id=1&ts=...&gameContentDetectionEnabled=false&metersEnabled=false&liveFightDataEnabled=false`
   - Extract:
     - embedded `gamedataCode` script block,
     - parser JS asset URL (`parser-warcraft...js`),
     - `parserVersion`.
   - `GET` parser JS asset URL.
3. Parser execution (Node bridge)
   - initialize harness with `{ gamedataCode, parserCode }`.
   - parse log lines in batches.
   - collect fights and master info for upload payloads.
4. Report lifecycle
   - `POST /desktop-client/create-report`
   - `POST /desktop-client/set-report-master-table/{reportCode}`
   - `POST /desktop-client/add-report-segment/{reportCode}`
   - `POST /desktop-client/terminate-report/{reportCode}`

## Upload Algorithm

1. Validate input file path and non-empty credentials.
2. Read log as streaming lines and process in batches (`100000` lines target batch size).
3. For each batch:
   - send lines to parser,
   - collect fights,
   - skip upload for empty-fight batches,
   - on first non-empty batch, create report.
4. Collect master info; upload master table only if assigned ID tuple changed.
5. Build fights payload string and upload as segment zip.
6. Track and apply `nextSegmentId` from response.
7. After all batches, terminate report and emit completion with report URL.
8. If no fights were ever found, return user-facing error.

## Multipart/ZIP Details

- Build zip payloads in Rust (`zip` crate), single entry `log.txt`.
- Use multipart form bodies matching endpoint expectations:
  - master table: `segmentId`, `isRealTime=false`, file part `logfile`.
  - segment: `parameters` JSON string + file part `logfile`.

## Cancellation Plan

- Track active upload task in shared app state.
- `cancel_wcl_upload` triggers cancellation token.
- Orchestrator checks token between major steps and before each network call.
- On cancel:
  - stop parsing loop,
  - kill parser child process,
  - emit `wcl-upload-error` with cancelled state/message.

## Settings and Persistence

### Persist (optional in v1, recommended)

- Remember last used:
  - email,
  - region,
  - visibility,
  - guild id.

### Do not persist

- Password.

If persistence is added, extend `RecordingSettings` types in:

- `src/types/settings.ts`
- `src/contexts/SettingsContext.tsx`

## Error Handling Strategy

Map backend errors into clear frontend messages:

- authentication failure,
- parser bootstrap failure,
- parser runtime failure,
- no fights found,
- network/server retry exhausted,
- upload cancelled.

Use retry/backoff for `429` and `5xx` responses.

## Dependencies

Add to `src-tauri/Cargo.toml` (exact versions to be finalized during implementation):

- `reqwest` with cookie and json support
- `regex`
- `zip`
- `thiserror` (optional but recommended)

Node.js is required at runtime for parser execution in v1.

## Milestones

1. **Milestone 1: Backend protocol spike**
   - Verify login + parser page fetch + parser JS fetch with Rust client.
2. **Milestone 2: Parser bridge and local parsing**
   - Implement Node bridge and validate fight extraction on sample logs.
3. **Milestone 3: Full report upload flow**
   - Implement create/master/segment/terminate end-to-end.
4. **Milestone 4: Frontend page + sidebar integration**
   - Add new app view and complete upload UX.
5. **Milestone 5: Hardening**
   - Cancellation, retries, structured errors, QA pass.

## Test Plan

### Unit tests (Rust)

- parser page extraction regex/parsing
- payload builder formatting
- zip output structure
- retry logic behavior
- error mapping

### Manual integration tests

1. Successful upload with known-good combat log.
2. Invalid credentials path.
3. Log file with no fights.
4. Cancel in-progress upload.
5. Large log performance and memory behavior.

## Acceptance Criteria

- Sidebar shows dedicated `WarcraftLogs` section with `Upload` navigation.
- Upload page can start an upload and display streaming progress.
- Rust backend performs login, parser bootstrap, report creation, segment upload, and termination without calling Python.
- Final report URL is returned and displayed on success.
- Cancellation works and leaves app in recoverable state.
- Password is not persisted in app settings.

## Future Enhancements

- Replace Node parser runtime with embedded JS engine.
- Persist credentials in OS keychain (not plain store).
- Add upload history linked to recording metadata.
- Add optional auto-upload workflow after recording finalization.
