# WarcraftLogs Rework Implementation Plan

## Goal

Rework the WarcraftLogs integration so a user can sign in once, restart FloorPoV, and upload
logs without manually signing in again. Use the existing OS keychain integration for durable
credentials and keep authenticated HTTP sessions in memory.

This plan starts with authentication and session ownership. The branch can then host additional
WarcraftLogs refactors without coupling them to the first milestone.

## Current State

- The frontend owns email, password, remember-login, saved-login, and upload state in one page.
- Saved credentials are stored in the OS keychain.
- Guild loading, regular uploads, and live uploads each create a new HTTP client and sign in again.
- Upload request payloads include authentication fields.
- A saved credential is treated as login state even though no authenticated session may exist.
- Most uploader orchestration is concentrated in `wcl_upload/core.rs`.

The current implementation protects stored passwords, but it does not provide a single source of
truth for the authenticated WarcraftLogs session.

## Scope

### Milestone 1

- Introduce an application-level WarcraftLogs authentication service.
- Restore authentication automatically from the OS keychain.
- Reuse an authenticated in-memory HTTP session.
- Remove the manual login requirement before each upload.
- Separate sign-out from deleting saved credentials.
- Expose a stable, typed authentication status to the frontend.

### Follow-up Work on This Branch

- Split the large uploader core into focused modules.
- Simplify the Tauri command contracts.
- Consolidate regular and live upload setup.
- Improve retry behavior, diagnostics, and test coverage.
- Prepare the integration for future WarcraftLogs features.

## Non-Goals

- Persisting WarcraftLogs cookies or session tokens on disk.
- Storing passwords in the Tauri settings store or frontend storage.
- Introducing OAuth unless WarcraftLogs provides and documents a suitable desktop flow.
- Changing combat log parsing behavior in the authentication milestone.
- Retrying an entire upload after an ambiguous network failure.

## Target User Flow

### First Login

1. The user enters their WarcraftLogs email and password.
2. The user can choose to remember the login in the OS keychain.
3. FloorPoV authenticates and stores the in-memory session.
4. The account section shows `Connected as <account>`.
5. Guild loading and uploads use the authenticated session without another login action.

### Application Restart

1. FloorPoV detects saved credentials during application startup.
2. It restores the WarcraftLogs session in the background.
3. The UI reports `Restoring session` until the attempt finishes.
4. A successful restore enables uploads without user interaction.
5. Invalid credentials return the UI to a sign-in form with a clear message.

### Session Expiry

1. A protected request reports an authentication failure.
2. FloorPoV performs one automatic reauthentication attempt using keychain credentials.
3. It retries only the failed request when doing so is safe.
4. If reauthentication fails, FloorPoV clears the in-memory session and requests a new login.

### Sign-Out and Forget

- `Sign out` clears the current in-memory session but retains keychain credentials.
- `Forget saved login` clears the session and removes all matching keychain entries.
- The UI must explain the difference before destructive credential removal.

## Target Architecture

### Backend Modules

Restructure `src-tauri/src/wcl_upload/` toward the following boundaries:

```text
wcl_upload/
|- auth.rs              # Keychain access and credential resolution
|- auth_service.rs      # Session lifecycle and authentication state
|- client.rs            # Authenticated WarcraftLogs HTTP client
|- commands.rs          # Thin Tauri command handlers
|- regular_upload.rs    # Regular upload orchestration
|- live_upload.rs       # Live upload orchestration
|- parser.rs            # Parser asset and bridge orchestration
|- events.rs            # Stable frontend event payloads
|- state.rs             # Active upload and cancellation state
|- types.rs             # Shared request, response, and domain types
|- validation.rs        # Input validation
`- mod.rs
```

Do not perform this entire move in one change. Extract modules only when their responsibilities
are covered by tests or verification steps.

### Authentication Service

Add a `WclAuthService` managed by Tauri application state. It owns the current authentication
state and an optional authenticated `WclSession`.

Suggested state model:

```rust
enum WclAuthState {
    SignedOut,
    CredentialsAvailable { email: String },
    Restoring { email: String },
    Authenticated { email: String, user_name: Option<String> },
    InvalidCredentials { email: String, message: String },
}
```

Requirements:

- Never expose a password through a serialized response or frontend event.
- Never hold a state mutex while performing network requests.
- Make concurrent restore requests converge on one authentication result.
- Clone the authenticated client handle for upload workers instead of sharing mutable request
  state.
- Clear the in-memory session when the associated credentials are removed.
- Log state transitions without logging credentials, cookies, or sensitive response bodies.

### HTTP Session

Keep the cookie-enabled `reqwest::blocking::Client` inside `WclSession`. Clones of the session
must share the same underlying client and cookie store.

Extend HTTP errors so callers can distinguish:

- authentication failure,
- rate limiting,
- retryable server failure,
- transport failure,
- invalid response data.

For `401` or `403`, reauthenticate once. Do not re-run the complete upload workflow. Retry only
the affected request when the server response confirms that authentication failed before the
operation was accepted.

### Frontend State

Move account lifecycle state out of `WarcraftLogsUploadPage` into a dedicated context or service.
The upload page should consume an account model instead of coordinating keychain checks itself.

Suggested frontend shape:

```ts
type WclAuthState =
  | { status: "signedOut"; savedEmail: string | null }
  | { status: "restoring"; email: string }
  | { status: "authenticated"; email: string; userName: string | null }
  | { status: "invalidCredentials"; email: string; message: string };
```

The provider should expose focused actions:

- `restoreSession()`
- `login(email, password, rememberLogin)`
- `signOut()`
- `forgetSavedLogin()`
- `refreshGuilds()`

The upload context should remain responsible for upload progress, cancellation, and results.

## Command Contract Changes

Introduce or normalize these commands:

1. `get_wcl_auth_status() -> WclAuthStatus`
2. `restore_wcl_session() -> WclAuthStatus`
3. `login_wcl(request) -> WclAuthStatus`
4. `sign_out_wcl() -> WclAuthStatus`
5. `forget_wcl_login() -> WclAuthStatus`
6. `fetch_wcl_guilds() -> FetchWclGuildsResponse`

After the frontend migration, remove authentication fields from regular and live upload payloads:

```text
email
password
useSavedLogin
rememberLogin
```

The backend must reject protected commands with a typed unauthenticated error when no session can
be restored.

## Implementation Phases

### Phase 1: Characterize Existing Behavior

- Add focused tests for email normalization and keychain lookup logic where the platform boundary
  can be isolated.
- Document the current command payloads and authentication transitions.
- Add an HTTP/session abstraction that can be replaced by a fake in tests.
- Verify the existing login, guild fetch, regular upload, and live upload paths manually.

### Phase 2: Add Central Authentication State

- Register `WclAuthService` as managed Tauri state.
- Move session creation and login orchestration into the service.
- Implement status, login, restore, sign-out, and forget operations.
- Preserve the existing keychain service and migrate legacy saved-email metadata as today.
- Add contextual tracing for authentication transitions and failures.

### Phase 3: Restore Sessions Automatically

- Trigger `restore_wcl_session` once from a globally mounted frontend auth provider.
- Show a non-blocking restoring state.
- Load guilds after successful authentication.
- Show the login form only when no usable credentials exist or restoration fails.
- Do not block unrelated FloorPoV screens while WarcraftLogs authentication is restored.

### Phase 4: Decouple Upload Commands from Credentials

- Make guild fetch, regular upload, and live upload obtain a session from `WclAuthService`.
- Remove credential resolution and explicit login calls from each upload path.
- Remove authentication fields from the TypeScript and Rust upload request types.
- Preserve upload busy-state and cancellation behavior.
- Ensure live uploads keep a valid session for their full lifetime.

### Phase 5: Simplify the Account UI

- Replace `Use saved login` with automatic session restoration.
- Keep `Remember login` only on the explicit login form.
- Add connected, restoring, expired, and signed-out states.
- Add separate `Sign out` and `Forget saved login` actions.
- Clear passwords from React state immediately after each login attempt.
- Keep errors user-friendly while preserving detailed backend logs.

### Phase 6: Split the Uploader Core

- Extract the HTTP client and authentication service first.
- Extract regular and live upload orchestration next.
- Move parser bootstrap logic after upload behavior is stable.
- Keep Tauri commands thin and preserve stable event names.
- Avoid unrelated parser or payload rewrites during file moves.

### Phase 7: Verification and Cleanup

- Remove obsolete commands, types, flags, and preference keys.
- Run frontend type checking and production build.
- Run Rust format, check, Clippy, and tests.
- Perform the manual acceptance scenarios below.
- Update the existing WarcraftLogs upload documentation to describe the new flow.

## Testing Strategy

### Rust Unit Tests

- Email matching is case-insensitive and trims whitespace.
- Saved credentials resolve only for the matching account.
- Restore without credentials returns `SignedOut`.
- Successful restore returns `Authenticated` and stores a session.
- Invalid saved credentials return `InvalidCredentials` without deleting them automatically.
- Sign-out clears only the in-memory session.
- Forget removes credentials and clears the session.
- Concurrent restore calls do not create conflicting session state.
- Authentication failure permits at most one reauthentication attempt.

Keychain and HTTP access should be behind small traits so tests can use in-memory fakes without
touching a developer's OS credential store or the WarcraftLogs service.

### Frontend Verification

No frontend test framework is configured. Until one is introduced, verify the auth provider with
TypeScript checks and manual application scenarios. If frontend unit tests are added, document the
framework and commands in `AGENTS.md` and `package.json`.

### Manual Acceptance Scenarios

1. Sign in with `Remember login`, upload a log, and upload a second log without signing in again.
2. Restart FloorPoV and upload using the automatically restored session.
3. Start and stop a live upload after automatic restoration.
4. Change the WarcraftLogs password externally and verify the expired-credentials state.
5. Recover from a temporary network failure without losing saved credentials.
6. Sign out and verify that saved credentials remain available for restoration.
7. Forget the saved login and verify that restart does not restore the account.
8. Switch to a different account and verify that guilds and account state do not leak.

## Validation Commands

```bash
bunx tsc --noEmit
bun run build

cd src-tauri
cargo fmt --check
cargo check
cargo clippy
cargo test
```

## Migration and Compatibility

- Continue reading the current keychain service and account names.
- Preserve the existing legacy saved-email migration until at least one stable release has shipped
  with the new authentication service.
- Read the existing remember-login preference during migration, then remove it once the new login
  form owns the choice directly.
- Change Rust and TypeScript command payloads in the same commit to keep the application buildable.
- Do not silently remove credentials when authentication fails. Only the explicit forget action
  may delete them.

## Suggested Commit Sequence

1. `test: characterize wcl credential resolution`
2. `refactor: add managed wcl authentication service`
3. `feat: restore wcl sessions from saved credentials`
4. `refactor: decouple wcl uploads from login payloads`
5. `frontend: simplify wcl account state and actions`
6. `refactor: split wcl upload orchestration modules`
7. `docs: update warcraftlogs authentication flow`

Each commit should compile independently and avoid mixing file moves with behavior changes where
practical.

## Definition of Done for the Authentication Milestone

- A remembered user can restart FloorPoV and upload without manually signing in again.
- Multiple uploads in one application session reuse the authenticated client.
- Passwords never enter frontend persistence or logs.
- Session expiry has one bounded recovery attempt and a clear fallback state.
- Sign-out and credential deletion are separate actions.
- Upload request types no longer contain credentials.
- Existing regular upload, live upload, guild selection, progress, and cancellation behavior still
  works.
- All validation commands pass.

## Future WarcraftLogs Work

Track later features as separate milestones in this document. Suitable candidates include upload
history, recording-to-report links, optional post-recording uploads, richer report metadata, and
queue management. Add each feature with its own scope, failure behavior, and acceptance criteria
instead of expanding the authentication milestone.
