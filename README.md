# local-expo-build

> Build signed Expo Android apps on your own machine. Windows, macOS, and Linux supported.

[![npm version](https://img.shields.io/npm/v/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![npm downloads](https://img.shields.io/npm/dm/local-expo-build.svg)](https://www.npmjs.com/package/local-expo-build)
[![license](https://img.shields.io/npm/l/local-expo-build.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/local-expo-build.svg)](https://nodejs.org/)

local-expo-build turns an Expo project into a signed Android APK or AAB without waiting for an EAS cloud build. It handles Expo prebuild, Gradle compatibility, versioning, release signing, and artifact discovery in one repeatable workflow.

Android is stable. Local iOS IPA builds are experimental and require macOS.

## Why use it?

- Build locally on Windows, macOS, or Linux.
- Produce a signed AAB for Google Play or a signed APK for direct installation.
- Keep control of your keystore and build scripts.
- Use EAS when you want it, without requiring an EAS cloud build for the local pipeline.
- Run the same workflow from a terminal, a local browser UI, or scripts committed to your project.

## Quick start

From the root of an Expo project:

~~~bash
npx local-expo-build init
~~~

The setup wizard checks your environment, helps configure the Android package and release keystore, and adds two npm scripts to your project. Then build the artifact you need:

~~~bash
# Google Play upload
npm run build:android:aab

# Direct device installation or testing
npm run build:android:apk
~~~

The finished artifact is written under android/app/build/outputs/ and the CLI prints its absolute path and size when the build completes.

### One-off build without scaffolding

Use runner mode when you do not want init to add files or scripts to your project:

~~~bash
npx local-expo-build doctor
npx local-expo-build build android --aab
~~~

Use --apk instead of --aab for an APK.

### Install globally

npx is enough for most projects. To keep the command available globally:

~~~bash
npm install --global local-expo-build
local-expo-build init
~~~

## What the build does

For a release Android build, the CLI normally:

1. Checks the local toolchain and Expo configuration.
2. Runs Expo prebuild and applies the Gradle version required by the detected Expo SDK.
3. Bumps the app version and, when available, gets the next Android versionCode from EAS.
4. Restores or configures the release keystore and injects the Gradle signing configuration.
5. Runs assembleRelease for an APK or bundleRelease for an AAB.
6. Optionally syncs the new versionCode back to EAS.
7. Prints the final artifact path and size.

The pipeline is designed to recover the keystore after expo prebuild --clean, which can otherwise remove files under android/.

## Choose a workflow

### Scaffold mode — recommended for repeated builds

~~~bash
npx local-expo-build init
npm run build:android:aab
~~~

init adds an editable scripts/ build pipeline and these entries to package.json:

~~~json
{
  "scripts": {
    "build:android:apk": "node scripts/build.js apk",
    "build:android:aab": "node scripts/build.js aab"
  }
}
~~~

The generated scripts are yours to review and customize. Refresh them later with:

~~~bash
npx local-expo-build update-scripts
~~~

### Runner mode — no project files added

~~~bash
npx local-expo-build build android --aab
~~~

Runner mode is useful for one-off builds or when you prefer not to commit the generated pipeline.

### Browser UI

~~~bash
npx local-expo-build ui
~~~

The UI runs on 127.0.0.1 and provides:

- Environment Doctor checks and guided fixes.
- Android APK/AAB builds with live logs.
- Keystore import, generation, EAS fetch, and rehydration.
- EAS project linking and eas.json setup when needed.
- A scaffold action equivalent to init.

Useful options:

~~~bash
npx local-expo-build ui --port 3847 --no-open --logs
~~~

--logs mirrors safe server and build output to the terminal. Credential-like values and large base64 values are redacted.

#### UI screenshots

The UI guides you from setup through a completed release build:

![Setup wizard and scaffold flow](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/setup_init.png)

![Doctor showing environment issues and guided fixes](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/doctor-issues.png)

![Doctor showing a ready-to-build environment](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/doctor-all-ok.png)

![Keystore management and EAS credential actions](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/keystore-tab.png)

![Android build in progress with live logs](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/build-progress.png)

![Completed build with the generated artifact path](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/build-done.png)

## Requirements

### All platforms

- Node.js 20 or newer.
- An Expo project with dependencies installed: npm install, pnpm install, or yarn.

### Android builds

- JDK 17 is recommended for Expo SDK 55.
- Android SDK with ANDROID_HOME configured.
- keytool on PATH, included with the JDK.
- eas-cli is optional. It is only needed for EAS credential fetch, EAS project setup, or version-code synchronization.

Run this before your first build if you are unsure what is missing:

~~~bash
npx local-expo-build doctor
~~~

### iOS builds

- macOS only.
- Xcode 14 or newer with Command Line Tools.
- An Apple Developer account for distribution signing.
- A distribution certificate (.p12) and provisioning profile.

## Android signing

The first release build checks for a release keystore. If one is missing, the interactive setup can:

- Rehydrate an existing EAS credentials.json and .jks.
- Register an existing .jks file.
- Generate a new keystore with keytool.
- Fetch the project keystore through EAS.

Start the picker directly with:

~~~bash
npx local-expo-build keystore setup
~~~

Individual operations are also available:

~~~bash
npx local-expo-build keystore import       # use an existing .jks
npx local-expo-build keystore create       # generate a new keystore
npx local-expo-build keystore fetch        # download through EAS
npx local-expo-build keystore rehydrate    # restore from credentials.json
~~~

If credentials.json already references a downloaded keystore, rehydrate recreates keystore.properties and copies the keystore into android/app/ without asking for the passwords again.

### Keep signing files private

keystore.properties and credentials.json contain plaintext keystore passwords. The setup flow adds them, along with keystore files, to .gitignore. Never commit or share them. Back up the keystore and its passwords securely: losing the original signing key can prevent updates to an app already published on Google Play.

## Command reference

### Setup and diagnostics

~~~text
local-expo-build                          Run init inside an Expo project
local-expo-build init [options]           Scaffold scripts and run setup
local-expo-build doctor                   Check and optionally fix the environment
local-expo-build ui [options]             Launch the local browser UI
local-expo-build update-scripts [options] Refresh scaffolded scripts
~~~

init options:

~~~text
--force        Overwrite existing scaffolded scripts
--no-doctor    Skip pre-flight checks
--no-keystore  Skip interactive keystore setup
--no-build     Skip the post-setup build prompt
~~~

### Android

~~~bash
local-expo-build build android --aab
local-expo-build build android --apk
~~~

Common options:

~~~text
--aab                  Build a release AAB (default)
--apk                  Build a release APK
--profile <name>       EAS profile used for version-code lookup (default: production)
--clean                Run expo prebuild --clean
--no-clean             Skip the clean prebuild prompt
--no-bump              Skip version bumping
--no-sync              Do not sync versionCode back to EAS
--no-prebuild          Reuse the existing native project
--debug                Build a debug APK without release signing or EAS
--max-ram <ram>        Set Gradle/Node memory, for example 4g or 8g
~~~

For CI or other non-interactive environments, use explicit flags and skip setup prompts when appropriate:

~~~bash
npx local-expo-build init --no-doctor --no-keystore --no-build
npx local-expo-build --dry-run build android --aab
~~~

--dry-run shows the planned pipeline without running the build or writing project files.

![Dry-run output showing the planned build pipeline](https://raw.githubusercontent.com/nikhild64/local-expo-build/main/assets/screenshots/dryrun-build.png)

### iOS (experimental)

~~~bash
local-expo-build build ios --method app-store \
  --team-id ABCDE12345 \
  --bundle-id com.example.app \
  --profile-name "Your Distribution Profile"
~~~

Supported methods are app-store, ad-hoc, development, and enterprise. The scheme is detected automatically for the standard Expo prebuild output; use --scheme <name> when needed.

The iOS pipeline runs Expo prebuild, xcodebuild archive, and xcodebuild -exportArchive, producing an IPA under ios/build/export/. You must install the .p12 in Keychain Access and the provisioning profile in Xcode/macOS yourself. Uploading to TestFlight or the App Store is not included.

### Global options

These options can be used with the commands above:

~~~text
--cwd <path>       Run against a different Expo project directory
--verbose          Print additional diagnostic output
--dry-run          Preview actions without making changes
--no-update-check  Skip npm and scaffold update checks
--yes-update       Apply an available CLI update without prompting
~~~

Run npx local-expo-build --help or append --help to any command for the complete current help text.

## EAS: optional, not required

Local builds do not require an EAS account, eas.json, or an EAS cloud build. EAS is useful when you want to:

- Store and fetch a team keystore.
- Link the project and generate eas.json.
- Allocate the next versionCode and sync it back after a build.
- Submit a locally produced artifact using the rest of your EAS workflow.

For a project that already has a keystore on EAS:

~~~bash
npx local-expo-build keystore fetch
npx local-expo-build keystore rehydrate
npx local-expo-build build android --aab
~~~

If EAS is unavailable, the local keystore providers still work. Version-code synchronization is skipped with a warning when it cannot run; use --no-sync when managing versions yourself.

## Files created or updated

Depending on the workflow, the CLI may create or update:

~~~text
app.json                         expo.android.package and EAS project link
eas.json                         EAS build profile configuration, when configured
keystore.properties              Local Gradle signing configuration (private)
credentials.json                 EAS-compatible local credentials (private)
android/app/*.jks or *.p12       Release signing key (private)
scripts/                         Scaffolded, editable build pipeline
android/app/build/outputs/       Generated APK/AAB artifacts
~~~

The CLI adds sensitive signing files to .gitignore during setup. Review the changes before committing, especially if your project uses a custom app.config.* instead of app.json; dynamic config is read for checks but is not rewritten automatically.

## Troubleshooting

### The Android package is missing

Add an Android application ID to app.json, or run doctor and accept its fix:

~~~json
{
  "expo": {
    "android": {
      "package": "com.example.myapp"
    }
  }
}
~~~

### The keystore file is missing after prebuild

Rehydrate or re-import the signing key, then update the scaffolded scripts if this is an older project:

~~~bash
npx local-expo-build keystore rehydrate
npx local-expo-build init --force
~~~

### eas credentials fails

EAS credential commands need a linked project and usually eas.json. Run:

~~~bash
eas init
eas build:configure --platform android
npx local-expo-build keystore fetch
~~~

Or use keystore create or keystore import to stay entirely local.

### Google Play rejects the artifact

The most common causes are a reused versionCode or a different signing key. Avoid --no-sync unless you manage versioning yourself, and use the original release keystore for updates to an existing app.

## Development

~~~bash
npm install
npm test
npm run build
~~~

To test a local package in another Expo project:

~~~bash
npm run build
npm pack
npm install ../local-expo-build/local-expo-build-<version>.tgz
~~~

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and [LICENSE](LICENSE).

---

Not affiliated with Expo or Google. “Expo” and “EAS” are trademarks of 650 Industries, Inc. This project is independently maintained and uses EAS public APIs where selected features require them.
