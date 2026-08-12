# local-expo-build

[![npm version](https://img.shields.io/npm/v/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![npm downloads](https://img.shields.io/npm/dm/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![license](https://img.shields.io/npm/l/local-expo-build.svg)](https://github.com/nikhild64/local-expo-build/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/local-expo-build.svg)](https://nodejs.org/)

Build Expo apps locally without waiting for cloud queues. `local-expo-build` gives Expo projects a simple CLI and optional localhost browser UI for producing signed Android `.aab` / `.apk` artifacts, with experimental iOS `.ipa` support on macOS.

## Why use it?

- **Local Android release builds on Windows, macOS, and Linux.** This fills the Windows gap left by `eas build --local`.
- **No EAS account required for the build itself.** EAS is optional for project linking, credential fetch, and version sync.
- **Signing setup included.** Import, generate, fetch, or rehydrate Android keystores and keep Gradle credentials in sync.
- **Beginner-friendly setup.** `doctor` detects missing config and offers guided fixes.
- **Two workflows.** Run one-off builds with `npx`, or scaffold editable build scripts into your project.
- **Optional local UI.** Start builds, run Doctor, and manage keystores from a localhost-only browser interface.

## Install

Use it without installing:

```bash
npx local-expo-build --help
```

Or install globally:

```bash
npm install -g local-expo-build
local-expo-build --help
```

## Quick start

From the root of your Expo project:

```bash
npx local-expo-build doctor
npx local-expo-build build android --aab
```

The successful build output includes the absolute artifact path and file size.

Prefer a guided setup with reusable project scripts?

```bash
npx local-expo-build init
npm run build:android:aab
npm run build:android:apk
```

Running `local-expo-build` with no command inside an Expo project starts the `init` wizard automatically.

## Local browser UI

```bash
cd <your-expo-project>
npx local-expo-build ui
```

The UI runs only on `127.0.0.1` and helps you:

- review environment checks in the **Doctor** tab;
- fix missing Android package, EAS link, `eas.json`, and signing setup;
- upload, import, generate, fetch, or rehydrate keystores;
- start APK/AAB builds and watch live logs;
- scaffold reusable npm scripts from the browser.

Options:

```bash
npx local-expo-build ui --port 3847 --no-open --logs
```

![local-expo-build UI setup flow](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/setup_init.png)

## Common commands

| Command | Purpose |
| --- | --- |
| `local-expo-build` | Start `init` inside an Expo project, or print usage elsewhere. |
| `local-expo-build init` | Run setup checks, configure signing, and add build scripts. |
| `local-expo-build doctor` | Check the environment and offer interactive fixes. |
| `local-expo-build ui` | Launch the localhost browser UI. |
| `local-expo-build build android --aab` | Build a signed Android App Bundle. |
| `local-expo-build build android --apk` | Build a signed Android APK. |
| `local-expo-build keystore setup` | Choose a keystore setup method interactively. |
| `local-expo-build keystore import` | Register an existing Android keystore. |
| `local-expo-build keystore create` | Generate a new Android keystore with `keytool`. |
| `local-expo-build keystore fetch` | Open EAS credentials flow to download signing credentials. |
| `local-expo-build keystore rehydrate` | Recreate local signing config from `credentials.json` and a `.jks`. |
| `local-expo-build build ios` | Build an iOS `.ipa` on macOS. Experimental. |
| `local-expo-build update-scripts` | Refresh scaffolded build scripts to the CLI-bundled version. |

Global flags: `--cwd <path>`, `--verbose`, `--dry-run`, `--no-update-check`, `--yes-update`.

Android build options:

```bash
local-expo-build build android [--apk|--aab] [--profile <name>] \
  [--clean] [--no-bump] [--no-sync] [--no-prebuild] [--debug]
```

iOS build options:

```bash
local-expo-build build ios [--method <app-store|ad-hoc|development|enterprise>] \
  [--scheme <name>] [--configuration <name>] [--team-id <id>] \
  [--profile-name <name>] [--bundle-id <id>] [--clean] [--no-bump] [--no-prebuild]
```

## Requirements

### All platforms

- Node.js 20 or newer.
- Expo project dependencies installed in the app you want to build.
- `eas-cli` only when you want EAS project linking, credential download, or version sync.

### Android

- JDK 17 recommended.
- Android SDK installed.
- `ANDROID_HOME` configured.
- `keytool` available on `PATH`.

### iOS (experimental)

- macOS.
- Xcode 14+ and Command Line Tools.
- Apple Developer account for distribution signing.
- Distribution `.p12` and provisioning profile installed locally.

Run this any time to verify your machine:

```bash
npx local-expo-build doctor
```

## Android signing

`local-expo-build` supports four Android keystore paths:

| Source | Best for | What it does |
| --- | --- | --- |
| Rehydrate | Existing `credentials.json` and `.jks` on disk | Recreates `keystore.properties` without asking for passwords again. |
| Existing keystore | Teams with a shared `.jks` | Copies or references the keystore and writes Gradle signing config. |
| Generate new | New apps | Creates a new release keystore with `keytool`. |
| Fetch from EAS | Apps already using EAS credentials | Downloads existing signing credentials through EAS and binds them locally. |

Sensitive files are added to `.gitignore` automatically:

- `keystore.properties`
- `credentials.json`
- Android keystore files such as `*.jks`

> **Important:** Back up generated keystore passwords outside the project. If you lose the signing key or password for a published app, you may be unable to ship updates with the same signing identity.

## Scaffold mode

`init` adds two npm scripts to your Expo app:

```json
{
  "scripts": {
    "build:android:apk": "node scripts/build.js apk",
    "build:android:aab": "node scripts/build.js aab"
  }
}
```

It also writes readable build helper files under `scripts/`. Commit those scripts if you want the build pipeline to be editable by your project team.

Skip prompts for CI or custom setup:

```bash
npx local-expo-build init --no-doctor --no-keystore --no-build
```

## Runner mode

Runner mode does not add files to your project. Use it when you want one command per build:

```bash
npx local-expo-build build android --aab
npx local-expo-build build android --apk --profile production
```

Use `--dry-run` to preview the pipeline without making build changes:

```bash
npx local-expo-build --dry-run build android --aab
```

## iOS support

The iOS pipeline is experimental and macOS-only. It runs Expo prebuild, detects the generated Xcode workspace and scheme, writes export options, then calls `xcodebuild archive` and `xcodebuild -exportArchive`.

Example:

```bash
npx local-expo-build build ios --method app-store \
  --team-id ABCDE12345 \
  --bundle-id com.yourcompany.yourapp \
  --profile-name "Your Profile Name"
```

You are still responsible for importing the `.p12` into Keychain and installing the provisioning profile before building.

## How it compares

| Feature | EAS cloud build | EAS local build | `expo run` | `local-expo-build` |
| --- | --- | --- | --- | --- |
| Runs on your machine | No | Yes | Yes | Yes |
| Android local build on Windows | Yes, in cloud | No | Debug only | Yes |
| Signed Android `.aab` / `.apk` | Yes | Yes | No | Yes |
| Signed iOS `.ipa` | Yes | Yes | No | Experimental |
| Uses EAS build quota | Yes | No | No | No |
| Requires EAS account | Yes | Yes | No | Optional |
| Requires `eas.json` | Yes | Yes | No | No |
| Editable per-project pipeline | No | No | No | Yes, with scaffold mode |

Use EAS cloud or EAS local build when you want the official fully managed Expo build service. Use `local-expo-build` when you need Windows-friendly local Android release builds, optional EAS integration, or an editable local pipeline.

## Files created or updated

| Path | Purpose | Commit? |
| --- | --- | --- |
| `scripts/*.js` | Scaffolded Android build pipeline. | Yes, if using scaffold mode. |
| `package.json` | Adds `build:android:apk` and `build:android:aab` scripts. | Yes. |
| `app.json` | May receive `expo.android.package` or EAS project ID through guided fixes. | Yes. |
| `eas.json` | Optional EAS build profile config. | Yes. |
| `keystore.properties` | Local Gradle signing secrets. | No. |
| `credentials.json` | Local EAS-compatible credential pointer and secrets. | No. |
| `android/app/*.jks` | Android signing key. | No. |

## Troubleshooting

### Gradle cannot find the keystore

Run:

```bash
npx local-expo-build keystore rehydrate
```

If you do not have `credentials.json`, import or create a keystore instead:

```bash
npx local-expo-build keystore import
npx local-expo-build keystore create
```

### `eas credentials` fails before opening

Make sure the project is linked and has EAS build config:

```bash
eas init
eas build:configure --platform android
```

Then retry:

```bash
npx local-expo-build keystore fetch
```

### Missing `expo.android.package`

Run Doctor and accept the suggested fix:

```bash
npx local-expo-build doctor
```

For dynamic config files, add the value manually:

```json
{
  "expo": {
    "android": {
      "package": "com.yourcompany.yourapp"
    }
  }
}
```

### Play Console rejects the artifact

Check the two most common causes:

1. The `versionCode` was already uploaded. Avoid `--no-sync` unless you manage version codes yourself.
2. The artifact was signed with a different keystore than the app already uses in Play Console.

## Development

```bash
npm install
npm run build
npm test
```

To test the package in another Expo app:

```bash
npm run build
npm pack
cd ../my-test-app
npm install ../local-expo-build/local-expo-build-<version>.tgz
npx local-expo-build doctor
```

## Roadmap

- iOS credential setup flow.
- iOS `buildNumber` / `CFBundleVersion` bumping.
- TestFlight and App Store Connect upload helpers.
- Symbol upload helpers for Android mapping files and iOS dSYM files.
- CI preset generation.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and conventions.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Nikhil Dhawan

---

Not affiliated with Expo, EAS, Apple, or Google. Expo and EAS are trademarks of 650 Industries, Inc.
