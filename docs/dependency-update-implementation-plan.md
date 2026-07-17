# Implementierungsplan: Dependency-Update

## Ziel

Alle direkten Frontend- und Rust-Abhängigkeiten auf den zum Umsetzungszeitpunkt aktuellen, miteinander kompatiblen Stand bringen. Danach soll FloorPoV weiterhin als Tauri-2-Anwendung gebaut werden; Recording, Combat-Log-Watcher, Hotkeys, WASAPI-Audio und WarcraftLogs-Upload müssen funktionieren.

Der Plan gilt für den aktuellen Arbeitsstand vom 17.07.2026. Bereits vorhandene Änderungen im Arbeitsbaum, insbesondere im WarcraftLogs-Modul, werden nicht überschrieben und müssen vor dem Update separat nachvollzogen werden.

## Ausgangslage

- Frontend: React 19, TypeScript 6, Vite 8, Tailwind CSS 4, Bun als geplanter Paketmanager.
- Backend: Rust 1.93, Edition 2021, Tauri 2 und Tauri-Plugins 2.
- Lockfiles: `bun.lock` und zusätzlich `package-lock.json`; diese Doppelspur ist vor dem Update zu bereinigen.
- Der Frontend-Build läuft erfolgreich. Es gibt eine Vite-Warnung wegen eines JavaScript-Chunks über 500 kB.
- `cargo check` ist aktuell wegen nicht aufgelöster Imports/Funktionen im bereits geänderten `src-tauri/src/wcl_upload/core.rs` fehlerhaft. Das ist zuerst als Baseline-/Branchproblem zu behandeln, nicht als Dependency-Regression.
- Lokal aufgelöste direkte Rust-Versionen sind unter anderem Tauri 2.10.3, Reqwest 0.13.2, Tokio 1.52.1, Serde 1.0.228, Zip 8.5.1 und Windows-Sys 0.61.2. Diese Werte sind eine Bestandsaufnahme, keine Festlegung der Zielversion.

## Regeln für das Update

1. Bun ist der einzige Frontend-Paketmanager. `package.json` und `bun.lock` bleiben die maßgeblichen Dateien; `package-lock.json` wird entfernt, sofern keine CI- oder Release-Anweisung ihn ausdrücklich benötigt.
2. Rust-Abhängigkeiten werden ausschließlich über `Cargo.toml` und `src-tauri/Cargo.lock` gepflegt.
3. Major-Updates werden einzeln oder nach kompatiblen Ökosystem-Gruppen durchgeführt: Tauri, Vite/React/TypeScript, Tailwind, Visualisierung/UI, Netzwerk/Upload und Windows-/Audio-Stack.
4. Versionsstände werden unmittelbar vor der Umsetzung mit `bun outdated`, `bun info <paket> version` bzw. `cargo update --dry-run`/Registry-Metadaten geprüft. Keine Version wird nur aufgrund einer veralteten Dokumentation festgeschrieben.
5. Jede Update-Gruppe muss kompilieren, bevor die nächste Gruppe angefasst wird. Lockfile-Änderungen werden zusammen mit der zugehörigen Manifest-Änderung reviewbar gehalten.

## Phasen

### 0. Baseline und Arbeitsbaum sichern

- `git status --short` dokumentieren und die bestehenden WarcraftLogs-Änderungen einem eigenen Commit oder Patch zuordnen.
- Den aktuellen Frontend-Build, `bunx tsc --noEmit`, `cargo fmt --check`, `cargo check` und `cargo test --lib` ausführen.
- Die bestehenden Fehler in `wcl_upload/core.rs` durch Import-/Modulabgleich beheben oder klar als externen Vorfehler markieren. Ohne grüne Rust-Baseline sind Dependency-Regressionen nicht zuverlässig isolierbar.
- Eine kurze Versionsaufnahme in die Änderungsbeschreibung übernehmen: Bun, Node-Runtime, Rust/Cargo, Tauri CLI und verwendete FFmpeg-Binaries.

### 1. Paketmanager und Reproduzierbarkeit bereinigen

- Entscheiden und dokumentieren, dass `bun install --frozen-lockfile` der Frontend-Installationsschritt ist.
- `package-lock.json` aus dem Projekt entfernen, falls keine externe Pipeline ihn verwendet; CI und README auf Bun umstellen.
- CI-Prüfungen ergänzen: unverändertes Lockfile bei frozen Install, TypeScript-Build, Rust-Check und Rust-Tests.
- Node-/Bun-Annahmen der PowerShell-Skripte `scripts/fetch-ffmpeg.ps1` und `scripts/fetch-node-runtime.ps1` prüfen.

### 2. Frontend-Abhängigkeiten aktualisieren

- Zuerst Patch-/Minor-Updates für alle direkten Dependencies und DevDependencies einspielen, danach Major-Updates einzeln bewerten.
- Besonders prüfen: Tauri JS API und Plugins gemeinsam mit der Tauri CLI, `@vitejs/plugin-react` gemeinsam mit Vite/Rolldown, TypeScript zusammen mit `tsconfig*.json`, sowie Tailwind 4 mit `@tailwindcss/vite`.
- Nach jedem Gruppenupdate Code anpassen in `vite.config.ts` für Vite-/Plugin- und Node-Typänderungen, `src/services/tauri.ts` und Contexts für Tauri-API-/Event-Änderungen, Playback-/Event-/Gamemode-Komponenten für Recharts-/React-Typänderungen sowie `src/index.css` für Tailwind-Änderungen.
- `lucide-react`, `motion` und `sonner` auf geänderte Exporte, Animation-Lifecycle und Toast-Optionen prüfen.
- Den Vite-Chunk-Warnhinweis bewerten: bei unverändertem Verhalten zunächst als nicht blockierend dokumentieren, bei Zielsetzung Performance anschließend Playback-/Chart-Code per `import()` splitten.

### 3. Rust-/Tauri-Abhängigkeiten aktualisieren

- Tauri-Core, `tauri-build`, CLI und alle Tauri-Plugins als eine kompatible Gruppe aktualisieren; danach `src-tauri/tauri.conf.json`, Capabilities und Plugin-Registrierung in `src-tauri/src/lib.rs` prüfen.
- Tokio, Tracing, Serde/Serde JSON, Chrono, Regex und Lazy Static aktualisieren und die Async-/Serialisierungs-APIs kompilieren.
- Reqwest inklusive Rustls und Blocking-Feature aktualisieren. Anschließend `src-tauri/src/wcl_upload/core.rs` auf Client-, Multipart-, Cookie- und Response-API-Änderungen prüfen.
- `zip` aktualisieren und `make_zip_payload` inklusive `SimpleFileOptions`/Deflate-Verhalten testen.
- `notify` aktualisieren und `src-tauri/src/combat_log/watch.rs` auf EventKind-, Watcher- und Callback-Vertragsänderungen prüfen.
- `keyring` aktualisieren und die Login-Migration in `src-tauri/src/wcl_upload/auth.rs` unter Windows testen.
- `wasapi` und `windows-sys` zuletzt aktualisieren. Besonders prüfen: COM-Initialisierung, Audio-Thread-Lifecycle und alle Win32-Feature-Flags in `recording/audio_pipeline.rs` und `recording/window_capture.rs`.
- Unbenutzte direkte Dependencies entfernen und Feature-Flags minimieren; danach `cargo tree -e features` auf doppelte oder unerwartete Versionen prüfen.

### 4. Codeanpassungen und Sicherheitsprüfung

- Tauri-Commands, Events und Payloads auf stabile Namen und weiterhin camelCase-/Serde-Verträge prüfen.
- Start/Stop-Pfade für Recording und Combat-Log-Watcher auf idempotentes Verhalten, Task-Abbruch und Fehlerpropagation prüfen.
- WarcraftLogs-Authentifizierung darf keine Zugangsdaten loggen; Keyring-Fehler und Netzwerkfehler müssen nutzerverständlich zurückgegeben werden.
- CSP, Asset Protocol, Updater-Signatur und gebündelte Ressourcen nach Tauri-Updates mit einer Debug- und einer Release-Konfiguration testen.

### 5. Verifikation und Release

- Frontend: `bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun run build`.
- Rust: `cargo fmt --check`, `cargo check`, `cargo clippy`, `cargo test --lib` und `cargo test` im Verzeichnis `src-tauri`.
- Anwendung: `bun run tauri dev` und `bun run tauri build -- --debug`.
- Manuelle Smoke-Tests: App-Start, Einstellungen laden/speichern, Hotkey registrieren, primären Monitor/Fenster aufnehmen, Systemaudio aufnehmen, Segmentierung und Finalisierung, Combat-Log-Watcher starten/stoppen, Marker anzeigen, WarcraftLogs-Login/Logout/Upload und Updater-Artefakt.
- Einen sauberen Install-Test auf Windows durchführen und prüfen, dass FFmpeg, Node-Runtime, Icons, Updater-Konfiguration und Ressourcen im NSIS-Artefakt enthalten sind.
- Changelog/Release Notes mit direkten Dependency-Upgrades, erforderlichen Migrationen und bekannten Warnungen ergänzen.

## Erwartete Ergebnisartefakte

## Umsetzungsstand 17.07.2026

- Frontend-Abhängigkeiten aktualisiert: Tauri JS/CLI 2.11.x, React 19.2.7,
  TypeScript 7.0.2, Vite 8.1.5, Tailwind 4.3.3, Recharts 3.9.2, Motion
  12.42.2 und Lucide React 1.24.0.
- Rust-Lockfile aktualisiert: Tauri 2.11.5, Reqwest 0.13.4, Tokio 1.52.4,
  Regex 1.13.1, Serde JSON 1.0.150, Zip 8.6.0 und aktualisierte transitive
  Abhängigkeiten.
- Den veralteten NPM-Lockfile `package-lock.json` entfernt; Bun bleibt der
  einzige Frontend-Paketmanager.
- Tauri-2.11-Command-Migration in `src-tauri/src/combat_log/mod.rs`,
  `src-tauri/src/lib.rs` und `src-tauri/src/hotkey.rs` umgesetzt.
- `bunx tsc --noEmit`, `bun run build`, `cargo check`, `cargo fmt --check`,
  `cargo clippy` und 24 Rust-Unit-Tests sind erfolgreich.
- `bun run tauri build --debug` erzeugt das NSIS-Artefakt erfolgreich; der
  Prozess endet anschließend nur wegen fehlendem
  `TAURI_SIGNING_PRIVATE_KEY` für die Updater-Signatur.

- Aktualisierte `package.json` und `bun.lock`.
- Aktualisierte `src-tauri/Cargo.toml` und `src-tauri/Cargo.lock`.
- Angepasste Vite-, Tauri-, React-/UI- und Rust-Dateien nur dort, wo neue APIs oder strengere Compilerprüfungen es erfordern.
- Aktualisierte CI-/README-Anweisungen für Bun und Rust.
- Prüfprotokoll mit Baseline, Update-Gruppen, Testergebnissen und verbleibenden Warnungen.

## Abnahmekriterien

- Keine veralteten direkten Dependencies verbleiben ohne dokumentierte Begründung oder inkompatible Plattformrestriktion.
- `bun.lock` und `src-tauri/Cargo.lock` sind reproduzierbar und werden in CI frozen bzw. locked verwendet.
- TypeScript und Rust bauen fehlerfrei; Formatierung und Clippy sind grün.
- Die genannten Recording-, Audio-, Combat-Log-, Hotkey- und WarcraftLogs-Kernpfade funktionieren auf Windows.
- Keine bestehenden lokalen Änderungen wurden unbeabsichtigt überschrieben.

## Rollback

Jede Update-Gruppe wird separat committed. Bei einer Regression wird nur der letzte Gruppen-Commit zurückgenommen; die Baseline- und bereits validierten Gruppen bleiben erhalten. Lockfiles werden nie manuell auf ältere Einzelzeilen zurückeditiert, sondern durch die jeweilige Paketverwaltung reproduziert.
