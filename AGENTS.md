# AGENTS.md - FloorPoV Contributor Guide

## Project Overview

FloorPoV is a Tauri 2 desktop application with a React 19 + TypeScript frontend and a Rust backend.

This file defines active engineering rules for contributors and coding agents.
For product planning and phased implementation details, see `docs/implementation-plan.md`.
For expanded naming examples, see `docs/coding-guidelines.md`.

## Command Reference

```bash
# Frontend only
bun run dev
bun run build
bun run preview

# Full Tauri app (frontend + backend)
bun run tauri dev
bun run tauri build
bun run tauri build -- --debug

# Type checking
bunx tsc --noEmit

# Rust lint/format/check
cd src-tauri
cargo check
cargo clippy
cargo fmt --check
cargo fmt
```

### Tests

No JS/TS test framework is configured in the repo right now.

If you add a test framework, document setup and commands in this file and in `package.json` scripts.

Rust tests:

```bash
cd src-tauri
cargo test
cargo test <pattern>
cargo test --lib
```

## Code Style

### TypeScript and React

- Use 2 spaces for indentation.
- Use double quotes for strings.
- Use semicolons.
- Keep line length reasonable, target 100 chars when possible.
- Don't create many small files. Implement functionality in existing files unless it is a new logical component.
- Prefer clear, intent-revealing names over terse names.
- Professional abbreviations are allowed when the context is obvious (for example `canvasCtx`, `idx`, `*_tx`, `*_rx`, `config`).
- Avoid unclear abbreviations and vague placeholders (for example `fn`, `obj`, `arr`) when a precise name improves readability (for example `unsubscribe`, `recordingItem`, `eventList`).
- In small, obvious closures, concise names like `e` for errors are acceptable.
- Prefer explicit types for public function params and return values.
- Use `interface` for object shapes, `type` for unions and aliases.
- Avoid `any`, prefer `unknown` when needed.
- Use functional components and hooks only.
- Destructure props in component signatures.
- Prefer early returns for conditional branches.
- Use async/await over chained promises.

Imports:

- Order imports: external packages -> internal modules -> styles/assets.
- Prefer named imports where natural.
- Keep import style consistent within a file.

Naming:

- Components and types: PascalCase.
- Functions and variables: camelCase.
- Constants: UPPER_SNAKE_CASE.
- Non-component files: kebab-case when practical.
- Keep API/platform contract names unchanged unless you are doing a coordinated migration (for example `file_path`, `created_at`, `hwnd`).

Tailwind:

- Prefer utility classes over custom CSS.
- Extract repeated utility sets into shared components or helpers.
- Use responsive prefixes for mobile-first behavior.
- Use arbitrary values only for one-off cases.

### Rust

- Run `cargo fmt` before committing Rust changes.
- Follow standard Rust naming conventions.
- Prefer clear variable names and avoid unclear abbreviations.
- Keep established systems abbreviations when they are standard for the domain (for example channel names like `*_tx` / `*_rx`, platform types, or API terms).
- Prefer `Result<T, E>` for fallible operations.
- Avoid `.unwrap()` in production code.
- Use `?` for propagation and return meaningful error messages.
- Prefer Tokio async primitives and avoid blocking work on async threads.
- Keep struct fields private by default; use `pub(crate)` for internal cross-module access and `pub` only for true API surface.
- Do not silently discard errors (`let _ = ...`) unless dropping the result is explicitly intentional and documented.
- Prefer `tracing` macros for backend logs over `println!`/`eprintln!`.
- Keep start/stop commands idempotent where practical, and make state transitions explicit.

Clippy enforcement:

- Configure these lints in `Cargo.toml` under `[lints.clippy]`:
  - `dbg_macro = "forbid"`
  - `todo = "forbid"`
  - `unimplemented = "forbid"`

### Tauri Patterns

- Mark command handlers with `#[tauri::command]`.
- Keep command handlers thin, delegate heavy logic to modules/services.
- Call commands from frontend via `invoke()` from `@tauri-apps/api/core`.
- Emit stable event names and keep payload shapes typed on the frontend.

## Reliability Rules (State and Async)

- Guard async UI actions against double clicks with a busy state.
- Do optimistic UI updates only when rollback/error behavior is defined.
- Treat event-driven state as eventually consistent, avoid race-prone assumptions.
- In start/stop flows, ensure each phase can be retried safely.
- Log failures with enough context to debug command/event ordering.
- Prefer idempotent stop operations when practical.

## Error Handling

- Use try/catch for async operations.
- Show user-friendly errors in UI flows.
- Keep detailed logs for development diagnostics.
- Avoid swallowing errors unless there is a clear fallback path.

## Comments and Documentation Style

- Explain why, not what.
- Write comments as durable documentation, not changelog notes.
- Avoid organizational comments and section dividers in code.
- Remove obsolete comments during refactors.
- If a block needs heavy commentary to be understood, refactor it.
- Add a short module-level `//!` doc comment to Rust files when it helps clarify module purpose.

Writing style for docs and comments:

- Use short, direct sentences.
- Use active voice.
- Prefer concrete language over vague claims.
- Avoid cliches, metaphors, and hype terms.

## Project Structure

```text
FloorPoV/
|- src/                    # React frontend
|- src-tauri/              # Rust backend
|- docs/                   # Project documentation
|  |- implementation-plan.md
|- package.json
|- tsconfig.json
|- vite.config.ts
`- AGENTS.md
```

## Roadmap

See `docs/implementation-plan.md` for phased implementation planning.
