# Changelog

All notable changes to `local-expo-build` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] — 2026-06-30

### Fixed

- **Bun / pnpm / yarn compatibility.** Expo CLI is now resolved from the
  project's `node_modules` instead of hardcoded `npx expo …` calls. Fixes
  scaffold mode (`scripts/build.js`) and runner mode (`build`, `doctor`,
  dynamic `app.config.*` resolution) for projects that don't use npm/npx.
- **`init` next-step hints** now match the detected package manager
  (`bun run`, `pnpm run`, `yarn`, or `npm run`).

### Added

- Scaffolded `scripts/resolve-project-bin.js` helper (copied on `init` /
  `update-scripts`).

## [0.4.1] — 2026-06-28

### Added

- **Interactive `--clean` prompt.** When you run `build android` / `build
  ios` (runner mode) or `npm run build:android:*` (scaffold mode) in an
  interactive terminal, the build asks once at the top whether to clean.
  Hint text explains when to say yes (Expo SDK upgrade, plugin change,
  "android project is malformed" / "MainActivity not found" errors).
  Default is **No** — most builds don't need clean, and forgetting to
  clean fails loud (errors) while forgetting NOT to clean wastes 1-2 min
  silently every time.
- **`--no-clean` flag** to skip the prompt and force no-clean. Useful when
  scripting / aliasing the build invocation.
- **Scaffold mode now honors `--clean` / `--no-clean`.** Previously these
  flags only worked in runner mode; the templated `scripts/build.js`
  silently ignored them. Now they're parsed from argv and propagated to
  `expo prebuild`. Pass via `npm run build:android:aab -- --clean`.

### Changed

- All templated scripts bumped to `v0.4.1` version stamp. Users on v0.4.0
  will see them as outdated when running `npx local-expo-build update-scripts`.

### Behavior in non-interactive environments

- CI / non-TTY: defaults to no-clean (unchanged from v0.4.0).
- `--dry-run`: defaults to no-clean (so the dry-run output is deterministic).
- Explicit `--clean` or `--no-clean` always wins, no prompt.

## [0.4.0] — 2026-06-28

### Added

- **iOS build support (EXPERIMENTAL, macOS only).** New `local-expo-build
  build ios` subcommand orchestrates `expo prebuild --platform ios` →
  `xcodebuild archive` → `xcodebuild -exportArchive` → signed `.ipa`. Five
  steps with the same numbered progress + dry-run support as the Android
  pipeline. Flags: `--method app-store|ad-hoc|development|enterprise`,
  `--scheme`, `--configuration`, `--team-id`, `--bundle-id`,
  `--profile-name`, `--clean`, `--no-bump`, `--no-prebuild`.
- **`src/core/ios/` module suite.** `xcodebuild.ts` (archive + export
  wrappers), `exportOptions.ts` (generates `export-options.plist` per
  build), `credentials.ts` (reads the `ios` section of `credentials.json`),
  `detect.ts` (auto-detects `ios/<Workspace>.xcworkspace`).
- **`assertMacOS` guard.** Every iOS code path hard-throws on non-Darwin
  hosts with an actionable message (no cryptic `command not found` for
  `xcodebuild`).
- **Loud experimental banner.** iOS commands print a yellow warning line
  before doing anything so users know to expect rough edges and to file
  issues. No opt-in flag required (would be annoying after the first run).
- **Doctor adds iOS prerequisite checks** on macOS (`xcodebuild`,
  `xcrun`). Non-macOS hosts get a single dim "skipped — iOS builds require
  macOS" row instead of failures.
- **14 new `node:test` cases** for the iOS-testable bits: plist
  generation, credentials.json parsing, workspace detection,
  `assertMacOS` guard. Total: 37 tests across 7 suites.

### Changed

- **README restructured** with platform-tab sections — Android (stable)
  and iOS (experimental) have separate Quick Start blocks, "Bringing your
  own credentials" walkthroughs, and file tables.
- **Comparison table + Roadmap updated** to reflect iOS support and to
  retire the closed items (iOS basic, remote `GRADLE_PIN` manifest).
- **Package keywords + description** now mention iOS / `.ipa` /
  `xcodebuild`.

### Known limitations of iOS support (read before reporting)

The iOS pipeline was implemented from Apple's documented `xcodebuild`
interface but **not validated on macOS by the maintainer** (Windows-only
dev environment). Code is correct in theory; please file issues with
your `eas-cli` version, `xcodebuild -version` output, and the failing
command if something doesn't work. Specifically not yet supported:

- Automated `.p12` keychain import (you double-click the file).
- Automated provisioning profile install (you double-click the file).
- TestFlight / App Store upload (use `xcrun altool` manually after the build).
- iOS-specific `CFBundleVersion` (buildNumber) bump.
- Multi-bundle apps (extensions / widgets / watch apps).

All of the above are on the roadmap for future releases.

## [0.3.0] — 2026-06-28

### Added

- **Live `GRADLE_PIN` manifest.** `pinGradle` now fetches the latest pin table
  from `manifest/gradle-pins.json` in the GitHub repo (3 s timeout, silent
  fallback to the bundled table). New Expo SDK shipping a problematic Gradle
  default → edit the manifest, commit, and every existing CLI user gets the
  new pin on their next build. No `npm publish` required.
- **`local-expo-build update-scripts` subcommand.** Diffs scaffolded
  `scripts/*.js` against the bundled templates by version stamp + content.
  Shows a table of up-to-date / outdated / missing scripts. Prompts before
  overwriting (or pass `--yes`). Honors `--dry-run`. Every scaffolded script
  now carries a `// Generated by local-expo-build vX.Y.Z` header.
- **Multi-strategy `signingConfigs.release` injection.** `setupSigning` now
  tries three strategies in order: exact-match → tolerant block-inject →
  synthesize new block inside `android { }`. Survives whitespace drift,
  comments, and even Expo dropping the default debug signing block from
  prebuild output.
- **`local-expo-build` test suite.** 23 tests across 5 suites using
  `node:test` (no new devDep). Covers gradle injection, buildType rewiring,
  EAS link detection, and rehydrate candidate matching — the bits that
  break first when Expo shifts. Run with `npm test`.
- **CI matrix:** 3 OS × 2 Node versions = 6 jobs per PR
  (ubuntu/macos/windows × Node 20/22). Catches Windows-specific regressions
  before users do.

### Changed

- **Node 20 minimum** (`engines.node`). Node 18 reached EOL in April 2025;
  bumping the floor lets us use native `fetch` for the manifest and
  `node:test` for the test suite without polyfills.
- Doctor's `Node` check now requires `>= 20` instead of `>= 18`.
- `pinGradle` is now async (was sync). The single internal caller in
  `build.ts` was updated.

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
- **Pre-flight `doctor` in `init`.** `npx local-expo-build init` now runs
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
