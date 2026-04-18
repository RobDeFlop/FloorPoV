# Release Checklist

This checklist documents how to publish Windows installers with GitHub Actions.

## 1) Prepare release version

Update the version in all three files:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Use the same semantic version value in all files (for example `0.1.1`).

## 2) Validate locally

Run these commands from the repo root:

```powershell
bun install
bun run build
bun run prepare:node-runtime
bun run tauri build -- --bundles nsis,msi
```

Confirm installer files exist:

- `src-tauri/target/release/bundle/nsis/*.exe`
- `src-tauri/target/release/bundle/msi/*.msi`

## 3) Commit release version bump

```powershell
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "release: v0.1.1"
```

Use the version you are releasing in the commit message.

## 4) Create and push release tag

```powershell
git tag -a v0.1.1 -m "v0.1.1"
git push origin main
git push origin v0.1.1
```

The `v*` tag triggers `.github/workflows/release.yml`.

## 5) Verify GitHub Actions run

In GitHub:

1. Open **Actions** and confirm the **Release** workflow succeeds.
2. Open **Releases** and verify `v0.1.1` contains:
   - NSIS installer (`.exe`)
   - MSI installer (`.msi`)

## 6) Publish notes

Add release notes with:

- Key user-facing changes
- Breaking changes or migration notes
- Known issues (if any)

## Troubleshooting

- If the workflow cannot upload assets, confirm the run was started by a tag push and repo Actions permissions allow writing contents.
- If build fails for missing bundled Node runtime, verify the `prepare:node-runtime` step completed.
- If users report Windows SmartScreen warnings, add code signing for production releases.
