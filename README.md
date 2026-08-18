# rn-size-analyzer

React Native project, build, and release analysis for Android and iOS.

`rn-size-analyzer` is **not** only an APK/AAB size reporter. It inspects the React Native project, native configuration, dependencies, assets, optional build artifacts (APK/AAB/IPA), and static performance/security signals, then writes a **local one-page HTML dashboard**.

Install / run:

```bash
npx rn-size-analyzer
```

or:

```bash
npx rn-size-analyzer analyze
```

Report:

```text
./rn-size-report/index.html
```

JSON is also written to `./rn-size-report/report.json` for CI.

Reports are **local only**. They are not uploaded to npm. Add `rn-size-report/` to the app `.gitignore` so they are not committed to GitHub.

---

## What it does

The tool helps you answer:

1. Why the Android/iOS app is large
2. Which dependencies contribute to size
3. Which assets/resources contribute to size
4. What changed between releases
5. What can potentially be optimized
6. Whether release/build configuration looks risky
7. Android- and iOS-specific issues
8. React Native-specific issues
9. Conservative security/release warnings
10. A single dashboard of the important issues

Every finding follows **problem → evidence → impact → recommendation**.

The analyzer **does not invent measurements**. Estimates are labeled. Play Store / App Store download sizes are **not** claimed unless you supply device-specific artifacts or official store data (this tool does not query the stores).

---

## Installation

```bash
npm install -D rn-size-analyzer
# or
npx rn-size-analyzer
```

Requires Node.js 18.18+.

---

## Quick start

From a React Native app root:

```bash
npx rn-size-analyzer
# same as:
npx rn-size-analyzer analyze
```

That analyzes **both Android and iOS**. If a release AAB/APK or IPA is already on disk (for example `android/app/build/outputs/bundle/release/app-release.aab`), it is included automatically. If no artifact is found, the tool still analyzes project config (Gradle, Pods, dependencies, assets).

One platform only:

```bash
npx rn-size-analyzer android
npx rn-size-analyzer ios
# aliases also supported:
npx rn-size-analyzer analyze android
npx rn-size-analyzer analyze ios
```

Analyze a specific file (still analyzes the other platform on `analyze`):

```bash
npx rn-size-analyzer analyze app-release.aab
npx rn-size-analyzer analyze MyApp.ipa
npx rn-size-analyzer android app-release.aab
npx rn-size-analyzer ios MyApp.ipa
```

If you are running from a local cloned library build directly:

```bash
node /absolute/path/to/rn-size-analyzer/dist/cli/index.js analyze ios
node /absolute/path/to/rn-size-analyzer/dist/cli/index.js analyze android
```

JSON for CI:

```bash
npx rn-size-analyzer analyze --format json
```

---

## Commands

| Command | Purpose |
| --- | --- |
| `rn-size-analyzer` / `analyze` | Analyze Android **and** iOS; auto-detect AAB/APK and IPA |
| `analyze android` | Android-only alias (same behavior as `android`) |
| `analyze ios` | iOS-only alias (same behavior as `ios`) |
| `analyze <file>` | Use that artifact, and still analyze the other platform if present |
| `android` | Android only; auto-detect AAB/APK if no path is given |
| `ios` | iOS only; auto-detect IPA if no path is given |
| `compare <old> <new>` | Compare two artifacts |
| `check` | CI mode, non-zero exit on thresholds |
| `--version` / `--help` | Version and help |

Global flags:

```bash
--format terminal|html|json
--out <dir>          # default: rn-size-report
--open               # open the HTML dashboard
--cwd <dir>
--quiet
```

---

## Dashboard

The HTML report is self-contained (inline CSS/JS) and works without a server.

Open `rn-size-report/index.html`.

**Dashboard screenshot placeholder:** run the CLI against a project, then capture `rn-size-report/index.html` (Overview, health scores, and Top issues).

The overview includes:

- Project name, RN version, Node version, package manager
- Android / iOS detected, Hermes, New Architecture
- Health scores: overall, size, dependencies, assets, performance, security, build, release
- Top issues with severity, evidence, impact, recommendation, confidence
- Clickable dependency rows and a simple native-module graph

---

## Android analysis

Supported:

- Android Gradle project (`android/`)
- APK
- AAB

Inspected when present:

- APK/AAB archive size
- Native `.so` files and ABIs (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`)
- Resources / assets / fonts / images
- JS bundle inside the archive
- Gradle files, `gradle.properties`, `AndroidManifest.xml`
- R8/ProGuard `minifyEnabled`, ABI filters, signing config presence
- minSdk / targetSdk / compileSdk

Example breakdown (illustrative):

```text
Android
AAB: 135 MB
Device-specific APK: 41 MB   ← heuristic estimate, not Play Console
Native: 72 MB                ← uncompressed .so total
JS: 8 MB
Assets: 12 MB
```

### AAB vs APK vs Play download

- **AAB size** is the bundle you upload. It contains multiple splits.
- **APK size** is that specific APK file.
- **Device-specific delivery** is generated by Google Play (or `bundletool`).

This tool **never treats AAB size as Play Store download size**. When it can, it computes a **heuristic** “one ABI + shared files” compressed estimate and labels it as an estimate. For authoritative numbers use Play Console or `bundletool get-size`.

---

## iOS analysis

Supported:

- Xcode project/workspace + Podfile when present
- IPA
- `.app` directory

Inspected when present:

- IPA / `.app` size
- App binary (when identifiable as `Payload/App.app/App`)
- Frameworks / XCFrameworks
- JS bundle (`main.jsbundle` / Hermes `.hbc` when named that way)
- Assets, fonts
- CocoaPods (`Podfile`, `Podfile.lock`)
- Deployment target, architectures, signing-related Xcode keys

### IPA vs App Store delivery

IPA / archive size is **not** the App Store download size. App Store thinning delivers device-specific slices. This tool does not query App Store Connect. Use TestFlight / App Store Connect file sizes for authoritative thinned numbers.

---

## Dependencies

Reads `package.json` and lockfiles when present (`yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`) plus `Podfile.lock`.

Shows:

- Direct vs parsed transitive counts
- Native vs JS-only (from `android/`, `ios/`, podspec — requires `node_modules` for accuracy)
- Android-only / iOS-only / cross-platform when folders exist

**Native attribution:** `.so` names are matched to npm package names when possible (`libreactnativevideo.so` → `react-native-video`). That is **attribution estimated**. If matching fails, the report says it could not confidently attribute the binary. No invented mapping.

---

## Assets and fonts

Scans project `assets/`, `src/`, Android `res/`, and iOS trees (not `node_modules`).

Reports largest files, duplicate **content** (SHA-256), large fonts, and conservative recommendations. Unused detection is limited; items are labeled **potentially unused** only when that logic applies. Savings are **UNKNOWN** unless you re-encode and measure.

---

## JS bundle

If a packaged bundle is found in the tree or inside an artifact, its **file size** is reported. Hermes is inferred only from obvious filenames (`.hbc`). Per-module breakdown from source maps is **not** implemented in v0.1 (detected maps are noted as future work).

---

## Performance and security (static)

Not a runtime profiler.

Performance rules (conservative):

- `FlatList` without a nearby `keyExtractor`
- Optional list virtualization props missing
- Many `console.log` calls in one file

Security rules (pattern-based):

- AWS key / Google API key / PEM private key shapes
- `http://` literals, localhost, staging-like hosts

Uncertain matches are titled **Potential secret detected**, not “secret exposed”.

---

## Release checklist

Android and iOS checklists (Hermes, R8, signing presence, debuggable release, deployment target, leftover staging URLs). Overall: `READY` / `WARNING` / `NOT READY`.

The tool **never** modifies Gradle or CocoaPods configuration.

---

## Compare and CI

```bash
npx rn-size-analyzer compare old.aab new.aab
npx rn-size-analyzer check --max-increase 2MB
npx rn-size-analyzer check --json
```

`check` compares the current artifact to `rn-size-report/baseline.json` or `--baseline`.

Example failure:

```text
❌ BUILD FAILED
App size increased by 8.4 MB
Allowed increase: 2 MB
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | pass |
| 1 | threshold exceeded |
| 2 | analyzer error |
| 3 | invalid project/build |

### Configuration

`.rn-size-analyzer.json`:

```json
{
  "android": { "maxIncrease": "2MB", "maxSize": "50MB" },
  "ios": { "maxIncrease": "3MB" },
  "failOn": "error",
  "ignore": [],
  "rules": {}
}
```

`failOn`: `critical` | `error` | `warning` | `never`.

GitHub Actions and GitLab CI templates live in `templates/`.

---

## Programmatic API

```ts
import { analyzeProject } from 'rn-size-analyzer';

const analysis = await analyzeProject({ cwd: process.cwd(), silent: true });
```

---

## Limitations

- Does not build the app.
- Does not query Play Console or App Store Connect.
- Device-specific sizes are heuristics unless you provide a device APK.
- Native→npm attribution is name-based and may be wrong.
- Unused asset detection is intentionally weak in v0.1.
- Source-map module breakdown is not implemented.
- Does not automatically change project files.

---

## Architecture

```text
src/
  cli/           commands and report wiring
  core/
    android/     Gradle + APK/AAB
    ios/         Xcode/Pods + IPA
    dependencies/
    assets/
    js-bundle/
    performance/
    security/
    release/
    comparison/
    optimization/
  reporters/     terminal, HTML, JSON
  utils/
  types/
```

---

## Development

```bash
cd rn-size-analyzer
npm install
npm test
node dist/cli/index.js analyze --cwd tests/fixtures/sample-rn-project
```

---

## Contributing

1. Keep measurements honest; label estimates.
2. Do not add destructive default behavior.
3. Prefer small modules and unit tests around parsers.
4. Update README when behavior changes.
5. Run `npm test` before opening a PR.

MIT license.
