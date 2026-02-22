Place `ffmpeg.exe` in this directory for FloorPoV recording.

Expected path:

- `src-tauri/bin/ffmpeg.exe`

Notes:

- This binary is bundled into the app via `tauri.conf.json` resources.
- The current FFmpeg backend is used for Primary Monitor recording when system audio is disabled.
