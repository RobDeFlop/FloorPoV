Place `ffmpeg.exe` in this directory for FloorPoV recording.

The WarcraftLogs upload flow also uses:

- `parser-harness.cjs` (Node runtime bridge used by the Rust uploader)
- `node/win-x64/node.exe` (bundled private Node runtime used by the parser bridge)

Expected path:

- `src-tauri/bin/ffmpeg.exe`
- `src-tauri/bin/parser-harness.cjs`
- `src-tauri/bin/node/win-x64/node.exe`

Notes:

- This binary is bundled into the app via `tauri.conf.json` resources.
- The current FFmpeg backend is used for Primary Monitor recording when system audio is disabled.
- `parser-harness.cjs` is bundled via the same resources path and executed by bundled Node runtime.
- `node.exe` is fetched during build and intentionally not committed to git.
