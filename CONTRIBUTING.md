# Contributing to FloorPoV

Thanks for contributing to FloorPoV. Please keep changes focused, explain the reason for non-obvious decisions, and run the relevant checks before opening a pull request.

## Commit messages

FloorPoV uses [Conventional Commits](https://www.conventionalcommits.org/). Each commit must use this format:

```text
<type>(<optional-scope>): <imperative description>
```

The subject must be lowercase, must not end with a period, and must be no longer than 72 characters. Use English for commit messages so they remain consistent across the project.

Allowed types:

| Type | Use for |
| --- | --- |
| `feat` | A new user-facing capability |
| `fix` | A bug fix |
| `docs` | Documentation-only changes |
| `refactor` | Structural changes without behavior changes |
| `perf` | Performance improvements |
| `test` | Adding or changing tests |
| `build` | Build system or dependency changes |
| `ci` | Continuous integration changes |
| `chore` | Maintenance that does not fit another type |
| `revert` | Reverting an earlier commit |

Use a short, lowercase scope when it adds useful context. Common scopes include `recording`, `combat-log`, `wcl`, `ui`, `release`, and `deps`.

Good examples:

```text
feat(recording): add automatic raid recording
fix(wcl): preserve live upload state after restart
docs(readme): clarify beta installation steps
refactor(combat-log): split event parsing into modules
test(combat-log): cover encounter start events
chore(release): bump version to 0.1.8-beta
```

Avoid vague or past-tense subjects:

```text
fix: stuff
fixed the uploader
updates
```

Use a commit body when the reason for the change is important or cannot fit in the subject. Separate it from the subject with a blank line. Reference issues in a footer when useful, for example `Refs #42`.

For breaking changes, add `!` after the type or scope and explain the migration in a `BREAKING CHANGE:` footer:

```text
feat(api)!: replace the legacy upload request

BREAKING CHANGE: callers must use the new upload request format
```

The local `commit-msg` hook runs automatically after `bun install`. Pull requests also run the same validation in GitHub Actions.

To validate a range manually:

```powershell
bun run commitlint -- --from <base-sha> --to <head-sha> --verbose
```

## Branches and pull requests

Use a branch prefix that describes the change:

- `feat/<short-description>`
- `fix/<short-description>`
- `refactor/<short-description>`
- `chore/<short-description>`
- `docs/<short-description>`
- `test/<short-description>`
- `build/<short-description>` or `ci/<short-description>`

Keep pull requests focused and include:

- A short summary of the user-visible or technical change.
- Validation steps and their results.
- Screenshots or recordings for relevant UI changes.
- Any known limitations or follow-up work.

See [AGENTS.md](AGENTS.md) and the [coding guidelines](docs/coding-guidelines.md) for repository-specific engineering rules.
