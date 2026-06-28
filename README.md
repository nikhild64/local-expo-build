# local-expo-build

> One-stop CLI for **local** Expo Android APK / AAB builds. Bypass EAS cloud builds, keep full control of signing, and stop waiting in queues.

[![npm version](https://img.shields.io/npm/v/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![npm downloads](https://img.shields.io/npm/dm/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![license](https://img.shields.io/npm/l/local-expo-build.svg)](https://github.com/nikhild64/local-expo-build/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/local-expo-build.svg)](https://nodejs.org/)

`local-expo-build` automates the painful parts of running `expo prebuild` + `gradlew bundleRelease` (or `xcodebuild archive`) yourself:

**Android (stable):**

- Detects your Expo SDK and pins the Gradle wrapper to a version that actually works (e.g. SDK 55 → Gradle 8.13, working around the `expo-manifests` `components.release` bug).
- Bumps your app version and pulls the next `versionCode` from EAS so Play Store ingest doesn't reject the upload.
- Injects a release `signingConfig` into the generated `android/app/build.gradle` from a `keystore.properties` you control.
- Scaffolds `credentials.json` from the same source so EAS submit / cloud builds can reuse your local JKS.
- Restores your `.jks` into `android/app/` if `expo prebuild --clean` wipes it (no more `validateSigningRelease > Keystore file not found`).
- Runs `gradlew assembleRelease` / `bundleRelease` and prints the absolute path + size of the produced artifact.
- Pushes the new `versionCode` back to EAS via GraphQL so `eas build` / `eas submit` stay in sync.

**iOS (experimental, macOS only — community-tested):**

- Orchestrates `xcodebuild archive` + `-exportArchive` for `.ipa` output.
- Auto-detects the workspace + scheme produced by `expo prebuild --platform ios`.
- Generates `export-options.plist` per build with sensible defaults for `app-store` / `ad-hoc` / `development` / `enterprise` distribution methods.
- Reads `.p12` + provisioning profile paths from `credentials.json` (same file format EAS downloads).

**`doctor` is a setup wizard, not just a health check.** It detects missing pieces (`expo.android.package`, EAS link, `eas.json`, keystore) and offers to fix each one interactively — `eas init`, `eas build:configure`, keystore picker (with one-prompt `rehydrate` from `credentials.json` when possible), all chained.

![local-expo-build init: doctor pre-flight + scaffolding in one command](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/setup_init.png)

Two modes:

- **Scaffold** _(recommended)_ — `npx local-expo-build init` drops reusable, committable scripts into your project; you run `npm run build:android:aab` from then on.
- **Runner** — `npx local-expo-build build android --aab`; one command, no files touched in your repo.

## Install

```bash
npm i -g local-expo-build
# or use it ad hoc
npx local-expo-build --help
```

## Quick start (recommended — scaffold mode)

```bash
cd <your-expo-project>
npx local-expo-build init
```

`init` runs `doctor` first as a pre-flight, walks you through any missing setup (EAS link, `eas.json`, keystore), then drops the build scripts and adds the `build:android:apk` / `build:android:aab` entries to your `package.json`. Then:

```bash
npm run build:android:aab     # release AAB → android/app/build/outputs/bundle/release/app-release.aab
npm run build:android:apk     # release APK → android/app/build/outputs/apk/release/app-release.apk
```

After the build finishes, the absolute path + size of the artifact is printed at the very end so you always know where it landed.

Skip the pre-flight in CI: `npx local-expo-build init --no-doctor --no-keystore`.

### Alternative — runner mode (no scaffold)

```bash
npx local-expo-build doctor                 # env + setup wizard
npx local-expo-build build android --aab    # full pipeline → .aab
```

Useful if you don't want any files committed to your repo and prefer to drive the whole pipeline from a single CLI call each time.

## Commands

```text
local-expo-build init [--force] [--no-keystore] [--no-doctor]
                                            Scaffold scripts + package.json entries
                                            (runs `doctor` first by default)

local-expo-build doctor                     Env check + interactive auto-fix wizard
                                            (eas init → eas build:configure →
                                             keystore setup)

# ── Android (stable) ──
local-expo-build build android [--apk|--aab] [--profile <name>]
                               [--clean] [--no-bump] [--no-sync] [--no-prebuild]
                                            Run the full Android pipeline → .aab|.apk

local-expo-build keystore setup             Interactive picker:
                                            rehydrate | existing | generate | EAS
local-expo-build keystore import            Register an existing .jks
local-expo-build keystore create            Generate a new keystore via keytool
local-expo-build keystore fetch             Open `eas credentials` to download a .jks
local-expo-build keystore rehydrate [--move]
                                            Bind credentials.json + .jks into
                                            keystore.properties (no password re-entry).

# ── iOS (experimental, macOS only) ──
local-expo-build build ios [--method <m>] [--scheme <s>] [--configuration <c>]
                            [--team-id <id>] [--profile-name <n>] [--bundle-id <id>]
                            [--clean] [--no-bump] [--no-prebuild]
                                            Run the full iOS pipeline → .ipa
                                            --method = app-store | ad-hoc |
                                                       development | enterprise

# ── Shared ──
local-expo-build update-scripts [-y|--yes]
                                            Refresh scaffolded scripts/*.js to the
                                            version bundled with this CLI.
```

Global flags: `--cwd <path>`, `--verbose`, `--dry-run`.

> **Dry-run** is wired into `build android` and the scaffolded orchestrator. Use it to preview the full pipeline (great for screenshots, sanity checks, CI plan-mode):
>
> ```bash
> npx local-expo-build --dry-run build android --aab    # runner mode
> npm run build:android:aab -- --dry-run                # scaffold mode (or: node scripts/build.js aab --dry-run)
> ```

![Dry-run output: the full 7-step build pipeline with no side effects](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/dryrun-build.png)

## How it compares

|  | `eas build` (cloud) | `npx expo run:android/ios` | `local-expo-build` |
| --- | --- | --- | --- |
| Runs locally | No | Yes | **Yes** |
| Produces a signed release `.aab` / `.apk` | Yes | No (debug) | **Yes (Android)** |
| Produces a signed release `.ipa` | Yes | No (debug) | **Yes (iOS, experimental, macOS only)** |
| Manages release signing config for you | Yes | No | **Yes** |
| Bumps `versionCode` from EAS automatically | Yes | No | **Yes (Android)** |
| Wait in cloud queue | Sometimes | Never | Never |
| Works offline | No | Yes | **Yes** (after first prebuild) |
| Needs `eas-cli` | Yes | No | Optional (only for version sync / EAS credentials fetch) |

If you're happy with cloud builds, use `eas build`. This CLI is for teams who want the EAS workflow (managed signing, synced `versionCode`) but the speed and control of building on their own machine.

## Keystore sources

When `keystore setup` runs (or when `doctor` / `init` prompt for it), you'll see one of these. **Rehydrate** appears at the top conditionally — only when a complete `credentials.json` + `.jks` are already on disk:

| Source | What happens |
| --- | --- |
| **Rehydrate** | Reads `credentials.json` + the `.jks` it points at, copies the `.jks` into `android/app/<basename>`, writes `keystore.properties`. **No password re-entry.** Ideal after `keystore fetch`. |
| **Existing .jks** | You point to a file + provide alias/passwords. Copied into `android/app/`. If a matching `credentials.json` is on disk (same path or same content hash), the password prompts are skipped — values reused automatically. |
| **Generate new** | Wizard runs `keytool -genkeypair` with sane defaults (RSA 2048, 10000d). |
| **EAS** | Opens `eas credentials` so you can download the project's current keystore from EAS. |

In every case, after the keystore is registered the CLI also writes a matching `credentials.json` at the project root and adds `keystore.properties`, `*.jks`, and `credentials.json` to `.gitignore`.

## Bringing your own keystore (EAS-managed flow)

The lowest-friction path from a brand-new clone to a buildable project when your team already has a keystore on EAS. This is what `doctor` will walk you through.

### 1. Fetch the keystore via EAS CLI

```bash
npx local-expo-build keystore fetch
# Pre-flight: if eas.json or projectId is missing, we'll offer
# to run `eas init` / `eas build:configure` before launching EAS.
```

EAS opens its interactive menu. Pick:

```text
✔ Which build profile do you want to configure?  ›  production
✔ What do you want to do?                        ›  Keystore: Manage everything needed to build your project
✔ What do you want to do?                        ›  Download existing keystore
✔ Display sensitive information?                  ›  Yes
✔ Go back
✔ What do you want to do?                        ›  credentials.json: Upload/Download credentials …
✔ What do you want to do?                        ›  Download credentials from EAS to credentials.json
✔ What do you want to do?                        ›  Exit
```

You now have:

- `<scope>__<project>.jks` at project root (from "Download existing keystore"),
- `credentials.json` at project root with all four required fields,
- `credentials/android/keystore.jks` (the file `credentials.json` actually references).

### 2. Bind everything in one step

```bash
npx local-expo-build keystore rehydrate
```

That copies the `.jks` referenced by `credentials.json` into `android/app/<basename>` and writes `keystore.properties` using the passwords already in `credentials.json` — **no re-typing**.

```text
✓ Copied credentials/android/keystore.jks → android/app/keystore.jks
✓ keystore.properties written from credentials.json (alias=6805615551f1…)
✓ Wrote credentials.json (keystorePath=android/app/keystore.jks)
```

### 3. Build

```bash
npm run build:android:aab        # scaffold mode
# or
npx local-expo-build build android --aab   # runner mode
```

> Tip: you can skip step 2 entirely — `doctor` detects the rehydrate state automatically and offers the same one-prompt fix inline.

## iOS (experimental, macOS only)

> **Status: community-tested.** The iOS pipeline ships behind an experimental banner because the maintainer develops on Windows and can't validate every build configuration. The code is built on Apple's documented `xcodebuild` interface and follows the same patterns as the Android side, but please [file issues](https://github.com/nikhild64/local-expo-build/issues) when you hit something — and PRs are very welcome.

### Prerequisites

iOS local builds are constrained by Apple and require all of:

- **macOS** (Xcode is macOS-only — Apple does not ship `xcodebuild` for Linux or Windows)
- **Xcode** 14+ with Command Line Tools (`xcode-select --install`)
- **Apple Developer account** ($99/yr — required for distribution signing certificates)
- **A distribution `.p12`** + **provisioning profile** installed in your keychain (drag the `.p12` into Keychain Access; double-click the `.mobileprovision` to install)

`local-expo-build doctor` checks for Xcode / `xcodebuild` automatically on macOS hosts and skips the checks elsewhere.

### Quick start (iOS)

```bash
# 1. Download credentials from EAS (same flow as Android)
npx local-expo-build keystore fetch
# In the EAS menu pick: iOS → Download credentials to credentials.json
# This produces:
#   - credentials.json with an `ios` section
#   - ios/certs/dist.p12  (distribution certificate)
#   - ios/certs/profile.mobileprovision  (provisioning profile)

# 2. (one-time, manual) Import the .p12 into your login keychain
#    and double-click the .mobileprovision file. Both go into ~/Library/...
#    Xcode does this automatically on double-click.

# 3. Build the .ipa
npx local-expo-build build ios --method app-store \
  --team-id ABCDE12345 \
  --bundle-id com.yourcompany.yourapp \
  --profile-name "Your Profile Name"
```

The build runs through these 5 steps:

```text
1/5 expo prebuild (ios)
2/5 bump version
3/5 detect Xcode workspace + credentials
4/5 xcodebuild archive
5/5 xcodebuild -exportArchive (method=app-store)

Build complete (.ipa, 14.3 MB):
  /path/to/your/app/ios/build/export/YourApp.ipa
```

Use `--dry-run` to preview the 5 steps without invoking xcodebuild.

### What the CLI does NOT handle (yet)

By design, the experimental iOS support keeps a tight scope so we don't ship untested Apple-keychain code that could leave your machine in a weird state. You're still responsible for:

- **Keychain `.p12` import.** Double-click the file in Finder, or `security import dist.p12 -k ~/Library/Keychains/login.keychain-db -P <password>`.
- **Provisioning profile install.** Double-click the `.mobileprovision`, or copy to `~/Library/MobileDevice/Provisioning Profiles/<UUID>.mobileprovision`.
- **TestFlight / App Store upload.** Use `xcrun altool --upload-app` or Apple's Transporter app after the `.ipa` is built.

These are on the roadmap (full `certs setup` flow + EAS cert fetch + TestFlight upload) for a future release once there's been enough community testing of the core build flow.

### iOS-specific files

| Path | Purpose | Gitignored? |
| --- | --- | --- |
| `credentials.json` → `ios` block | EAS local-credentials shape for iOS (`distributionCertificate.path/password`, `provisioningProfilePath`) | Yes (auto via the Android setup) |
| `ios/build/export-options.plist` | Regenerated per build with the chosen distribution method | No — derived per-build, safe to commit or gitignore as you prefer |
| `ios/build/<Scheme>.xcarchive` | Intermediate archive produced by `xcodebuild archive` | Yes (recommend adding `ios/build/` to `.gitignore`) |
| `ios/build/export/<Scheme>.ipa` | The final `.ipa` | Yes (recommend adding `ios/build/` to `.gitignore`) |

### Known caveats

- **Auto-detected scheme is the workspace basename.** Works for Expo's default prebuild output; pass `--scheme MyOtherScheme` if your project has multiple schemes.
- **Manual signing requires `--team-id`.** Without it, `xcodebuild` falls back to automatic signing, which only works for `development` builds if your Apple ID is logged into Xcode.
- **Multi-bundle apps not handled.** If your project has app extensions (widgets, watch app, share extension), each needs its own provisioning profile and the current `--profile-name` flag only sets one. File an issue with your `app.json` `extra.eas.build.experimental.ios.appExtensions` setup if you hit this.
- **No `bumpVersion` for iOS-specific `buildNumber`.** Today the bump step still updates `versionCode` in `android/app/build.gradle` (no-op on iOS-only builds). Expo's prebuild reads `expo.version` from `app.json` and writes it into `Info.plist`'s `CFBundleShortVersionString` — for `CFBundleVersion` (the iOS equivalent of `versionCode`) you currently need to manage that in `app.json` → `ios.buildNumber` manually. PRs to wire this up are welcome.

### How it works (iOS pipeline)

```text
expo prebuild --platform ios
  → (you import .p12 + provisioning profile manually, one-time)
  → bump app.json version                       (src/core/bumpVersion.ts)
  → detect ios/<Workspace>.xcworkspace          (src/core/ios/detect.ts)
  → read credentials.json `ios` section         (src/core/ios/credentials.ts)
  → write ios/build/export-options.plist        (src/core/ios/exportOptions.ts)
  → xcodebuild archive                          (src/core/ios/xcodebuild.ts)
  → xcodebuild -exportArchive → .ipa
```

## Files this CLI creates / touches

| Path | Purpose | Gitignored? |
| --- | --- | --- |
| `keystore.properties` (root) | Gradle release `signingConfig` source of truth: `storeFile`, `storePassword`, `keyAlias`, `keyPassword` | Yes (auto) |
| `credentials.json` (root) | EAS submit/cloud's local-credential pointer. Kept in sync with `keystore.properties`. | Yes (auto) |
| `android/app/<storeFile>` | The actual `.jks` that Gradle reads | Yes (`*.jks`, auto) |
| `eas.json` (root) | EAS build profile config (created by `eas build:configure`) | No — commit it |
| `app.json` → `expo.extra.eas.projectId` | EAS link (written by `eas init`) | No — commit it |
| `app.json` → `expo.android.package` | Android applicationId | No — commit it |
| `scripts/build.js` | (Scaffold mode only) single orchestrator entry point — what `npm run build:android:*` actually calls | No — commit it |
| `scripts/{pin-gradle,bump-version,setup-signing,sync-eas-version,print-artifact}.js` | (Scaffold mode only) per-step modules orchestrated by `build.js`; edit any one to customize that step for your project | No — commit them |

> **Security:** `keystore.properties` and `credentials.json` both contain plaintext keystore passwords. The CLI gitignores them automatically. **Don't commit them. Don't paste them into chat.** If you need them in CI, base64-encode and inject via secrets.

## Multi-SDK support

`local-expo-build` carries a small table of Gradle wrapper versions per SDK in [`src/core/pinGradle.ts`](src/core/pinGradle.ts):

```ts
export const GRADLE_PIN: Record<number, string | null> = {
  50: null,
  51: null,
  52: null,
  53: null,
  54: null,
  55: '8.13',   // expo-manifests components.release workaround
  56: null,
};
```

If your SDK isn't pinned, `pinGradle` is a no-op. Add a row + open a PR if a future SDK needs one.

## Requirements

**All platforms:**

- Node ≥ 20 (Node 18 reached EOL in April 2025)
- `eas-cli` is **optional** — only needed for EAS version sync, EAS credentials fetch, or doctor's `eas init` / `eas build:configure` auto-fixes

**Android builds (cross-platform):**

- JDK 17 (recommended for Expo SDK 55)
- Android SDK + `ANDROID_HOME` env var
- `keytool` on `PATH` (ships with the JDK)

**iOS builds (macOS only):**

- macOS (Apple does not ship `xcodebuild` for Linux or Windows)
- Xcode 14+ with Command Line Tools (`xcode-select --install`)
- Apple Developer account ($99/yr — for distribution signing certificates)

Run `local-expo-build doctor` to verify all of the above — iOS-specific checks are auto-skipped on non-macOS hosts.

## How it works (pipeline)

```text
expo prebuild --platform android
  → pin Gradle wrapper            (src/core/pinGradle.ts)
  → bump version + EAS code       (src/core/bumpVersion.ts)
  → ensure keystore               (src/core/keystore/*)
  → restore .jks into android/app (src/core/setupSigning.ts → ensureKeystoreInAndroidApp)
  → inject release signing        (src/core/setupSigning.ts)
  → write/sync credentials.json   (src/core/writeCredentialsJson.ts)
  → gradlew {assemble|bundle}Release
  → sync versionCode to EAS       (src/core/syncEasVersion.ts)
  → print artifact path + size    (templates/scripts/print-artifact.js)
```

The scaffolded `scripts/*.js` files mirror the same logic so they're vendorable and editable per-project.

### Doctor's auto-fix chain

```text
expo.android.package (app.json or app.config.*)  → prompt + write to app.json
EAS link (expo.extra.eas.projectId)              → offer `eas init`
eas.json                                          → offer `eas build:configure --platform android`
keystore.properties                               → offer keystore picker
                                                     ├─ credentials.json + .jks present  → rehydrate (no password re-entry)
                                                     └─ else                              → existing | generate | EAS
```

Each accepted step re-runs the affected checks in place. If everything ends up green, doctor exits 0; otherwise the remaining items are printed under **Suggested next steps to complete setup**.

Dynamic configs (`app.config.{js,ts,cjs,mjs}`) are supported: doctor shells out to `npx expo config --json --type public` and reads the resolved config. If the Expo CLI fails to resolve (e.g. you haven't `npm install`ed yet), the affected rows show a yellow warning instead of pretending. Auto-writes still target `app.json` only — we don't modify dynamic config files.

`init` runs the entire doctor chain as its pre-flight before scaffolding. Pass `--no-doctor` to skip.

Your `package.json` ends up with just two added lines, both pointing at the orchestrator:

```json
{
  "scripts": {
    "build:android:apk": "node scripts/build.js apk",
    "build:android:aab": "node scripts/build.js aab"
  }
}
```

The orchestrator (`scripts/build.js`) prints numbered progress (`▸ [3/7] bump version`, etc.) and a final total time. EAS version sync is treated as non-fatal — if your EAS login expires, the build still succeeds and you get a single warning line instead of a hard fail.

## Troubleshooting

### `validateSigningRelease > Keystore file '…/android/app/keystore.jks' not found`

This happens when `expo prebuild --clean` (or the "android project is malformed — reinitialize?" prompt) wipes `android/` between keystore setup and the Gradle build. The pipeline restores it automatically as of v0.2.0 — make sure your scaffolded `scripts/setup-signing.js` is up to date:

```bash
npx local-expo-build init --force
```

If the recovery itself fails, you'll get a clear list of paths it tried; the fix is usually:

```bash
npx local-expo-build keystore rehydrate     # if you have credentials.json
# or
npx local-expo-build keystore import <path-to-jks>
```

### `eas credentials failed: Command failed with exit code 1`

`eas credentials` refuses to start without `eas.json` and a linked `expo.extra.eas.projectId`. v0.2.0 pre-flights both and offers to run `eas init` / `eas build:configure` interactively. If you skipped those prompts, run them manually:

```bash
eas init
eas build:configure --platform android
```

Then re-run `npx local-expo-build keystore fetch`.

### `Missing expo.android.package in app.json`

Doctor catches this as a critical check and offers to write it for you with a sensible default derived from `expo.slug` or `expo.ios.bundleIdentifier`. If you're using `app.config.{js,ts}`, doctor can't statically write to it — add the field by hand:

```json
{
  "expo": {
    "android": {
      "package": "com.yourcompany.yourapp"
    }
  }
}
```

### "The android project is malformed, would you like to clear and reinitialize?"

This is `expo prebuild` detecting that our injected `signingConfigs.release` block doesn't match what it would generate fresh. Accepting it is safe — the build chain re-injects signing and the recovery step puts the `.jks` back before Gradle runs.

### `expo CLI (in project) not found` in doctor

You haven't installed deps in the target Expo project yet. Run `npm install` (or `pnpm install` / `yarn`) in the project root.

### Build artifact is signed but Play Console rejects it

Two common causes:

1. **`versionCode` already used.** The `--no-sync` flag suppresses pushing the new `versionCode` back to EAS — if you used it and Play sees the same code as a previous upload, it'll reject. Don't pass `--no-sync` unless you're managing versions manually.
2. **Different keystore than the one originally registered.** Play Store requires the *same* keystore for all updates to a published app. Use `keystore fetch` + `keystore rehydrate` to get back the original.

## Testing the CLI locally in another Expo app

Three iteration loops, fastest to most-realistic:

```bash
# 1. npm link — fastest dev loop
cd local-expo-build && npm run build && npm link
cd ../my-test-app && npm link local-expo-build
# now changes in local-expo-build (with `npm run dev` watching) are picked up
# on the next `npx local-expo-build ...` call from my-test-app.

# 2. npm pack — exactly what end users will install
cd local-expo-build && npm run build && npm pack
cd ../my-test-app && npm i ../local-expo-build/local-expo-build-0.2.0.tgz

# 3. Direct invocation — no install at all
cd local-expo-build && npm run build
node /abs/path/local-expo-build/bin/local-expo-build.js doctor --cwd /abs/path/my-test-app
```

## Roadmap

- [x] iOS local builds (experimental in v0.4.0 — awaiting community testing)
- [x] Auto-update `GRADLE_PIN` table from a hosted manifest (v0.3.0)
- [ ] `certs setup` interactive flow for iOS (.p12 import + provisioning profile install via `security` / Keychain Access automation)
- [ ] iOS `buildNumber` (CFBundleVersion) bump + EAS sync — parity with Android's `versionCode` flow
- [ ] TestFlight / App Store Connect upload (`xcrun altool` / `notarytool` wrapper)
- [ ] Symbol upload (`mapping.txt` → Play Console / Sentry; iOS `.dSYM` to Sentry)
- [ ] CI presets (`init --ci` that scaffolds a GitHub Actions / GitLab CI workflow with base64-encoded secrets)

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, code layout, and conventions.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Nikhil Dhawan

---

**Not affiliated with Expo or Google.** "Expo" and "EAS" are trademarks of 650 Industries, Inc. This project consumes EAS's public APIs (`api.expo.dev/graphql`, `eas-cli`) but is independently maintained.
