# FloorPoV Coding Guidelines

This document expands on `AGENTS.md` with naming examples and practical guidance.

## Naming Principles

- Prefer names that describe intent over names that describe implementation details.
- Use concise names when context is obvious.
- Keep names stable when they are part of an external contract.

## TypeScript and React Naming

Prefer:

- `unsubscribe` instead of `fn`
- `recordingItem` instead of `obj`
- `eventList` instead of `arr`
- `canvasCtx` when it is clearly a canvas rendering context

Allowed professional abbreviations when context is clear:

- `idx`
- `config`
- `canvasCtx`
- short closure variables like `e` in `catch (e)` or small callbacks

Avoid abbreviations that make readers guess intent.

## Rust Naming

Prefer clear names for long-lived variables and public-facing APIs.

Allowed domain abbreviations:

- channel names like `*_tx` and `*_rx`
- platform terms like `hwnd`
- established systems/API terms

Short names like `e` are acceptable in small, obvious closures.

## Contract-Bound Names

Do not rename serialized or external contract fields without a coordinated migration.

Examples:

- frontend/backend payload fields such as `file_path`, `size_bytes`, `created_at`
- persisted settings fields
- platform/API names like `hwnd`

If you want cleaner local naming, map contract fields into local variables at the boundary.
