# AGENTS.md - Floorpov Project Guidelines

## Project Overview

Floorpov is a Tauri 2 desktop application with a React 19 + TypeScript frontend and Rust backend.

## Build Commands

```bash
# Frontend only
npm run dev          # Start Vite dev server on port 1420
npm run build        # TypeScript compile + Vite production build
npm run preview      # Preview production build

# Full Tauri app (frontend + backend)
npm run tauri dev        # Run Tauri in development mode
npm run tauri build      # Build production Tauri app
npm run tauri build -- --debug  # Build with debug symbols
```

### Running a Single Test

**No test framework is currently configured.** To add tests:

```bash
# Install Vitest for unit tests
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom

# Add to package.json scripts:
# "test": "vitest",
# "test:run": "vitest run",
# "test:ui": "vitest --ui"

# Run a single test file
npx vitest run src/App.test.tsx

# Run tests matching a pattern
npx vitest run --grep "greet"
```

For Rust tests:

```bash
cd src-tauri
cargo test              # Run all tests
cargo test greet        # Run tests matching "greet"
cargo test --lib        # Run library tests only
```

## Linting & Type Checking

```bash
# TypeScript type checking (part of build)
npx tsc --noEmit        # Type check without emitting
npx tsc --noEmit --watch # Watch mode

# Rust
cd src-tauri
cargo clippy            # Lint Rust code
cargo fmt --check       # Check formatting
cargo fmt              # Auto-format
```

## Code Style Guidelines

### TypeScript/JavaScript

**Formatting:**

- Use 2 spaces for indentation
- Use single quotes for strings
- Use semicolons
- Max line length: 100 characters
- Enable format on save in your editor

**Imports:**

- Order imports: external libs → internal modules → CSS/assets
- Use path aliases if configured (check tsconfig.json paths)
- Prefer named imports: `import { useState } from "react"`
- Default imports for components: `import App from "./App"`

**Types:**

- Use explicit types for function parameters and return values
- Use `interface` for object shapes, `type` for unions/aliases
- Avoid `any`, use `unknown` when type is truly unknown
- Enable strict mode in tsconfig.json

**Naming:**

- Components: PascalCase (e.g., `App.tsx`, `GreetingCard.tsx`)
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE
- Files: kebab-case (except components)

**React Patterns:**

- Use functional components with hooks
- Destructure props: `function App({ title }: AppProps)`
- Use early returns for conditionals
- Avoid inline object styles, use CSS modules or classes

**Error Handling:**

- Use try/catch for async operations
- Provide user-friendly error messages
- Log errors appropriately (console.error for dev, proper logging in production)

### Rust

**Formatting:**

- Run `cargo fmt` before committing
- Follow standard Rust formatting conventions
- 4 spaces for indentation

**Naming:**

- Functions/variables: snake_case
- Structs/Enums: PascalCase
- Traits: PascalCase (often with -able suffix)
- Constants: UPPER_SNAKE_CASE

**Code Organization:**

- Keep functions small and focused
- Use modules to organize code
- Place tests in `tests/` directory or inline with `#[cfg(test)]`

**Error Handling:**

- Use `Result<T, E>` for fallible operations
- Avoid `.unwrap()` in production code
- Use `?` operator for error propagation
- Provide meaningful error messages

**Tauri Specific:**

- Tauri commands use `#[tauri::command]` attribute
- Use `invoke()` from `@tauri-apps/api/core` to call Rust commands
- Keep command handlers simple, delegate to service functions

## Project Structure

```
Floorpov/
├── src/                    # React frontend
│   ├── assets/            # Static assets (images, etc.)
│   ├── App.tsx            # Main app component
│   ├── main.tsx           # Entry point
│   └── *.css              # Stylesheets
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── lib.rs         # Library entry, Tauri commands
│   │   └── main.rs        # Binary entry point
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
├── package.json           # Node dependencies
├── tsconfig.json          # TypeScript config
├── vite.config.ts         # Vite configuration
└── AGENTS.md              # This file
```

## Common Patterns

### Adding a New Tauri Command

1. Define command in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn my_command(arg: String) -> Result<String, String> {
    Ok(format!("Processed: {}", arg))
}
```

1. Add to invoke handler:

```rust
.invoke_handler(tauri::generate_handler![greet, my_command])
```

1. Call from TypeScript:

```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke<string>("my_command", { arg: "value" });
```

### Adding a New Component

1. Create `src/components/MyComponent.tsx`:

```typescript
interface MyComponentProps {
  title: string;
  onClick: () => void;
}

export function MyComponent({ title, onClick }: MyComponentProps) {
  return <button onClick={onClick}>{title}</button>;
}
```

1. Import and use in parent:

```typescript
import { MyComponent } from "./components/MyComponent";
```

## Editor Setup

**VS Code recommended extensions:**

- Tauri (official)
- ESLint
- Prettier
- Rust Analyzer (for src-tauri)

**Settings to add to .vscode/settings.json:**

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  }
}
```

## Developer Instructions

### Comments

- Explain **why**, never what the code does
- Write comments as permanent documentation, not changelog entries
- Avoid alarmist language (e.g., "CRITICAL:", "IMPORTANT FIX:", "NOTE:")
- No organizational comments (e.g., "// Section: imports", "// Helpers")
- No section dividers (e.g., "// ====", "// ---")
- Remove comments when code is removed during refactors
- If code needs a comment to be understood, refactor instead

### General

- No speculative dead code
- No placeholder metadata
- No AI-filler patterns
