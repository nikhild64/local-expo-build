# Changelog

All notable changes to `expo-local-build` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-06-28

### Added

- **Doctor as a setup wizard.** `doctor` now chains interactive auto-fixes for the
  most common blockers: missing `expo.android.package`, missing EAS link
  (`eas init`), missing `eas.json` (`eas build:configure`), and missing keystore
  setup. Each step is gated on the previous outcome and the check rows are
  mutated in place so the exit code reflects the post-fix state.
- **Dynamic config (`app.config.{js,ts,cjs,mjs}`) support.** `doctor`'s
  `Android package` and `EAS project linked` checks now read the resolved
  Expo config via `npx expo config --json --type public`, falling back to
  `app.json` for static projects. Per-process cache keeps the cost down.
- **`keystore rehydrate --move` flag.** Deletes the source `.jks` after a
  successful copy into `android/app/` (default is to leave the source as a
  prebuild-survivable backup).
- **Root `.jks` backup for `keystore create` / `keystore import`.** Both
  providers now also place the `.jks` at project root (gitignored via `*.jks`).
  Closes the data-loss hole where `expo prebuild --clean` would leave a
  freshly-generated keystore with no recoverable source.
- **Single-script orchestrator (`scripts/build.js`).** Replaces the long
  `&&`-chained npm scripts with a single Node entry point. `package.json` now
  carries `"build:android:apk": "node scripts/build.js apk"` instead of a
  multi-step shell pipeline. Prints numbered progress and a total time.
- **Build artifact path + size printed at the end of every build.** Runner
  mode and scaffold mode both surface the absolute path so you always know
  where the APK / AAB landed.
- **Subtle contextual disclaimers** ("Local build · saves an EAS cloud build
  credit · first run is slowest ~5 min") at the top of `build`, `init`, and
  the build orchestrator. One dim line, not repeated mid-pipeline.
- **`keystore import` auto-detects matching `credentials.json`.** When the
  user points at a `.jks` and a `credentials.json` exists describing the
  same file (matched by absolute path OR sha1 content hash), the password +
  alias prompts are skipped and the values are reused. Falls back to the
  full prompt flow when no match — so this is purely an opt-in shortcut.
- **`--dry-run` honored by `build android`** (runner mode) and the scaffolded
  `scripts/build.js` orchestrator. Prints every step's command + cwd without
  executing them. Useful for screenshots, sanity-checking the pipeline order,
  and CI plan-mode.
- **Pre-flight `doctor` in `init`.** `npx expo-local-build init` now runs
  `doctor` first and only proceeds with scaffolding once the environment is
  healthy. Use `--no-doctor` to skip.
- **Keystore `rehydrate` provider.** New `keystore rehydrate` subcommand (also
  surfaced in the `keystore setup` picker when applicable) binds an existing
  `credentials.json` + `.jks` pair to `keystore.properties` and copies the
  `.jks` into `android/app/`. No password re-entry.
- **`credentials.json` scaffolder.** `ensureKeystore` now writes/maintains
  `credentials.json` at project root from the same source as
  `keystore.properties`, and gitignores it.
- **Build artifact path printed at the end of every build.** Both runner mode
  and scaffolded `npm run build:android:*` now print the absolute path and size
  of the produced APK / AAB.
- **`.jks` recovery in `setup-signing`.** If `expo prebuild --clean` wipes
  `android/app/<storeFile>`, the build chain restores it from a stable source
  (`credentials.json` keystorePath, `credentials/android/`, project root)
  before invoking Gradle. Both `src/core/setupSigning.ts` and
  `templates/scripts/setup-signing.js` carry the recovery.
- New doctor checks: `Android package (app.json)` (critical), `EAS project
  linked` (yellow when half-linked), `keystore.properties`, `Signing keystore
  (.jks)`, `credentials.json (EAS)`. Suggestions block prints a numbered
  remediation list when anything is missing.

### Changed

- `keystore setup` picker now lists `Rehydrate from credentials.json` as the
  top, recommended option whenever a complete `credentials.json` + `.jks` are
  on disk.
- `fetchKeystoreFromEas` pre-flights both `expo.extra.eas.projectId` and
  `eas.json` and offers to run `eas init` / `eas build:configure` interactively
  before launching the EAS credentials menu.
- `.gitignore` entries created by `init` / `keystore setup` now include
  `credentials.json` alongside `keystore.properties` and `*.jks`.

### Fixed

- Builds failing with `validateSigningRelease > Keystore file not found` after
  `expo prebuild --clean` (or after accepting the "android project is malformed
  — reinitialize?" prompt). The keystore is now restored from a stable source
  before Gradle runs.
- Cryptic "credentials command failed" from `keystore fetch` on projects
  without `eas.json` or a linked EAS project. Replaced with a guided
  pre-flight.
- `templates/scripts/build.js` orchestrator was passing `shell: false` to
  `execSync` on Unix, which is undefined behavior. Now omits the option so
  Node uses the platform default (`/bin/sh` on Unix, `cmd.exe` on Windows).
  Fully cross-platform.

## [0.1.0]

Initial release. Local Expo Android APK/AAB pipeline with `prebuild`, Gradle
wrapper pinning, version bump, signing config injection, Gradle build, and EAS
versionCode sync.
