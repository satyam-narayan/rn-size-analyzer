/// <reference types="node" />
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { findBuildArtifacts } from '../../src/core/artifact-finder';
import { detectProject, artifactKind } from '../../src/core/project-detector';
import { parseAndroidProject } from '../../src/core/android/gradle';
import { analyzeAndroidArtifact } from '../../src/core/android/artifacts';
import { parseIosProject, parsePodfileLock } from '../../src/core/ios/project';
import { analyzeDependencies, guessPackageForNativeLib } from '../../src/core/dependencies';
import { analyzeAssets } from '../../src/core/assets';
import { analyzeUnusedJs } from '../../src/core/js-unused';
import { analyzeSecurity } from '../../src/core/security';
import { analyzePerformance } from '../../src/core/performance';
import { compareArtifacts } from '../../src/core/comparison';
import { analyzeProject, analyzeAndroidOnly, analyzeIosOnly } from '../../src/core/analyzer';
import { parseSize, formatBytes } from '../../src/utils/size';
import { listZipEntries } from '../../src/utils/zip';
import { renderHtml } from '../../src/reporters/html';
import { toJson } from '../../src/reporters/json';
import { TINY_PNG, writeZip } from '../helpers/zip';

const FIXTURE = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'sample-rn-project');

describe('size utils', () => {
  it('parses human sizes', () => {
    assert.equal(parseSize('2MB'), 2_000_000);
    assert.equal(parseSize('2MiB'), 2 * 1024 * 1024);
    assert.equal(parseSize('512KB'), 512_000);
    assert.match(formatBytes(2048), /2\.0 KB/);
    assert.equal(formatBytes(124_489_850), '124.5 MB');
  });
});

describe('artifact finder', () => {
  it('prefers a release AAB over a debug APK and finds an IPA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-find-'));
    mkdirSync(join(dir, 'android', 'app', 'build', 'outputs', 'bundle', 'release'), { recursive: true });
    mkdirSync(join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
    mkdirSync(join(dir, 'ios'), { recursive: true });
    const aab = join(dir, 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
    const apk = join(dir, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    const ipa = join(dir, 'ios', 'MyApp.ipa');
    writeFileSync(aab, 'aab');
    writeFileSync(apk, 'apk');
    writeFileSync(ipa, 'ipa');
    const found = findBuildArtifacts(dir);
    assert.equal(found.android?.kind, 'aab');
    assert.ok(found.android?.path.endsWith('app-release.aab'));
    assert.equal(found.ios?.kind, 'ipa');
    assert.ok(found.ios?.path.endsWith('MyApp.ipa'));
  });

  it('ignores intermediary Gradle AABs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-inter-'));
    mkdirSync(
      join(dir, 'android', 'app', 'build', 'intermediates', 'intermediary_bundle', 'release'),
      { recursive: true },
    );
    const aab = join(
      dir,
      'android',
      'app',
      'build',
      'intermediates',
      'intermediary_bundle',
      'release',
      'intermediary-bundle.aab',
    );
    writeFileSync(aab, 'aab');
    const found = findBuildArtifacts(dir);
    assert.equal(found.android, undefined);
  });
});

describe('project detection', () => {
  it('detects the sample React Native project', () => {
    const detected = detectProject(FIXTURE);
    assert.equal(detected.isReactNative, true);
    assert.equal(detected.overview.name, 'sample-rn-app');
    assert.equal(detected.overview.androidDetected, true);
    assert.equal(detected.overview.iosDetected, true);
    assert.equal(detected.overview.hermesEnabled, true);
    assert.equal(detected.overview.packageManager, 'yarn');
    assert.equal(detected.overview.reactNativeVersion, '0.76.5');
  });

  it('classifies artifacts by extension', () => {
    assert.equal(artifactKind('app-release.aab'), 'aab');
    assert.equal(artifactKind('app.apk'), 'apk');
    assert.equal(artifactKind('MyApp.ipa'), 'ipa');
  });
});

describe('android analyzer', () => {
  it('parses gradle configuration', () => {
    const android = parseAndroidProject(FIXTURE);
    assert.equal(android.detected, true);
    assert.equal(android.sdk?.compileSdk, '35');
    assert.equal(android.sdk?.targetSdk, '34');
    assert.equal(android.sdk?.minSdk, '24');
    assert.equal(android.build?.hermesEnabled, true);
    assert.equal(android.build?.minifyEnabled, false);
    assert.equal(android.build?.signingConfigPresent, true);
    assert.ok(android.build?.abiFilters.includes('x86'));
    assert.ok(android.issues.some((i) => i.id === 'android-minify-off'));
  });

  it('analyzes APK zip contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-apk-'));
    const apk = join(dir, 'app-release.apk');
    writeZip(apk, [
      { name: 'lib/arm64-v8a/libreactnativevideo.so', data: Buffer.alloc(1200, 1) },
      { name: 'lib/x86/libreactnativevideo.so', data: Buffer.alloc(800, 2) },
      { name: 'assets/index.android.bundle', data: Buffer.alloc(400, 3) },
      { name: 'res/drawable/icon.png', data: TINY_PNG },
      { name: 'classes.dex', data: Buffer.alloc(200, 4) },
    ]);
    const entries = listZipEntries(apk);
    assert.ok(entries.some((e) => e.name.endsWith('.so')));
    const result = analyzeAndroidArtifact(apk);
    assert.equal(result.artifact.kind, 'apk');
    assert.ok(result.artifact.abis.includes('arm64-v8a'));
    assert.equal(result.artifact.jsBundle?.bytes, 400);
    assert.ok(result.artifact.nativeLibraries.length >= 2);
    assert.ok(result.artifact.nativeByAbi.some((row) => row.abi === 'arm64-v8a'));
    assert.ok(result.artifact.packed.some((row) => row.label.startsWith('Native')));
  });

  it('analyzes AAB zip contents and warns AAB is not download size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-aab-'));
    const aab = join(dir, 'app-release.aab');
    writeZip(aab, [
      { name: 'base/lib/arm64-v8a/libhermes.so', data: Buffer.alloc(500, 1) },
      { name: 'base/assets/index.android.bundle', data: Buffer.alloc(100, 2) },
    ]);
    const result = analyzeAndroidArtifact(aab);
    assert.equal(result.artifact.kind, 'aab');
    assert.ok(result.issues.some((i) => i.id === 'android-aab-not-download'));
  });
});

describe('ios analyzer', () => {
  it('parses Podfile.lock and Xcode settings', () => {
    const ios = parseIosProject(FIXTURE);
    assert.equal(ios.detected, true);
    assert.equal(ios.build?.hermesEnabled, true);
    assert.equal(ios.build?.deploymentTarget, '15.1');
    assert.equal(ios.workspaceOrProject, 'ios/SampleApp.xcodeproj');
    assert.equal(ios.build?.bundleIdentifier, 'com.sample.app');
    assert.ok(ios.pods.some((p) => p.name === 'react-native-video'));
  });

  it('parses pod names from lockfile text', () => {
    const pods = parsePodfileLock('PODS:\n  - FirebaseCore (11.5.0)\n\nDEPENDENCIES:\n');
    assert.equal(pods[0]?.name, 'FirebaseCore');
    assert.equal(pods[0]?.version, '11.5.0');
  });
});

describe('security analyzer', () => {
  it('does not flag Firebase client keys or Apple plist DTD URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-sec-'));
    mkdirSync(join(dir, 'android', 'app'), { recursive: true });
    mkdirSync(join(dir, 'ios', 'SampleApp'), { recursive: true });
    writeFileSync(
      join(dir, 'android', 'app', 'google-services.json'),
      JSON.stringify({
        client: [{ api_key: [{ current_key: `AIza${'F'.repeat(35)}` }] }],
      }),
    );
    writeFileSync(
      join(dir, 'ios', 'GoogleService-Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>API_KEY</key><string>AIza${'I'.repeat(35)}</string>
</dict></plist>
`,
    );
    writeFileSync(
      join(dir, 'ios', 'SampleApp', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>Sample</string></dict></plist>
`,
    );
    const result = analyzeSecurity(dir);
    assert.equal(
      result.findings.some((item) => item.file.includes('google-services.json')),
      false,
    );
    assert.equal(
      result.findings.some((item) => item.file.includes('GoogleService-Info.plist')),
      false,
    );
    assert.equal(
      result.findings.some(
        (item) => item.file.includes('Info.plist') && item.ruleId === 'sec-http-url',
      ),
      false,
    );
  });

  it('still flags Google API keys and http URLs in application source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-sec-src-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'config.ts'),
      `export const KEY = 'AIza${'S'.repeat(35)}';\nexport const API = 'http://api.example.com/v1';\n`,
    );
    const result = analyzeSecurity(dir);
    assert.ok(result.findings.some((item) => item.ruleId === 'sec-google-api-key'));
    assert.ok(result.findings.some((item) => item.ruleId === 'sec-http-url'));
  });
});

describe('dependency analyzer', () => {
  it('reads direct dependencies from package.json', () => {
    const deps = analyzeDependencies(FIXTURE, undefined);
    assert.ok(deps.totalDirect >= 3);
    assert.ok(deps.nodes.some((n) => n.name === 'react-native-video'));
    const guess = guessPackageForNativeLib('libreactnativevideo.so', [
      {
        name: 'react-native-video',
        native: true,
        platforms: ['android', 'ios'],
        attributionConfidence: 'unknown',
        dependents: [],
        dependencies: [],
        filesContributed: [],
        warnings: [],
        recommendations: [],
      },
    ]);
    assert.equal(guess.name, 'react-native-video');
    assert.equal(guess.confidence, 'medium');
  });
});

describe('asset analyzer', () => {
  it('finds images, fonts, and duplicates', () => {
    mkdirSync(join(FIXTURE, 'assets'), { recursive: true });
    writeFileSync(join(FIXTURE, 'assets', 'hero.png'), TINY_PNG);
    writeFileSync(join(FIXTURE, 'assets', 'hero-copy.png'), TINY_PNG);
    mkdirSync(join(FIXTURE, 'android', 'app', 'src', 'main', 'res', 'drawable'), { recursive: true });
    writeFileSync(join(FIXTURE, 'android', 'app', 'src', 'main', 'res', 'drawable', 'icon.png'), TINY_PNG);
    const assets = analyzeAssets(FIXTURE);
    assert.ok(assets.entries.some((e) => e.path.endsWith('hero.png')));
    assert.ok(assets.fonts.some((f) => f.path.includes('CustomFont.ttf')));
    assert.ok(assets.duplicates.length >= 1);
  });

  it('marks referenced assets used and unreferenced assets unused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-assets-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'assets', 'used.png'), TINY_PNG);
    writeFileSync(join(dir, 'assets', 'orphan.png'), TINY_PNG);
    writeFileSync(
      join(dir, 'src', 'App.tsx'),
      `export const img = require('../assets/used.png');\n`,
    );
    const assets = analyzeAssets(dir);
    const used = assets.entries.find((entry) => entry.path.endsWith('used.png'));
    const orphan = assets.entries.find((entry) => entry.path.endsWith('orphan.png'));
    assert.equal(used?.usage, 'used');
    assert.ok(used?.usedIn.some((loc) => loc.includes('src/App.tsx')));
    assert.equal(orphan?.usage, 'unused');
    assert.equal(orphan?.usedIn.length, 0);
  });
});

describe('performance analyzer', () => {
  it('treats shared FlatList perf spreads as valid tuning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-perf-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'listPerf.ts'),
      `export const sharedListSettings = {
  windowSize: 10,
  maxToRenderPerBatch: 10,
  updateCellsBatchingPeriod: 50,
  initialNumToRender: 10,
  removeClippedSubviews: true,
};
`,
    );
    writeFileSync(
      join(dir, 'src', 'ImportedList.tsx'),
      `import React from 'react';
import { FlatList, Text } from 'react-native';
import { sharedListSettings } from './listPerf';

export function ImportedList({ data }: { data: Array<{ id: string }> }) {
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      {...sharedListSettings}
    />
  );
}
`,
    );
    writeFileSync(
      join(dir, 'src', 'LocalList.tsx'),
      `import React from 'react';
import { FlatList, Text } from 'react-native';

const LIST_PERF_PROPS = {
  windowSize: 8,
  removeClippedSubviews: true,
};

export function LocalList({ data }: { data: Array<{ id: string }> }) {
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      {...LIST_PERF_PROPS}
    />
  );
}
`,
    );
    writeFileSync(
      join(dir, 'src', 'AliasedList.tsx'),
      `import React from 'react';
import { FlatList, Text } from 'react-native';
import { paginationConfig } from '@/helpers/list';

export function AliasedList({ data }: { data: Array<{ id: string }> }) {
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      {...paginationConfig}
    />
  );
}
`,
    );
    mkdirSync(join(dir, 'src', 'helpers'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'helpers', 'list.ts'),
      `export const paginationConfig = {
  windowSize: 6,
  removeClippedSubviews: true,
  initialNumToRender: 8,
};
`,
    );
    writeFileSync(
      join(dir, 'src', 'RestList.tsx'),
      `import React from 'react';
import { FlatList, Text } from 'react-native';

export function RestList({ data, ...props }: { data: Array<{ id: string }> }) {
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      onEndReachedThreshold={0.4}
      onEndReached={() => undefined}
      ListFooterComponent={<Text>more</Text>}
      {...props}
    />
  );
}
`,
    );
    writeFileSync(
      join(dir, 'src', 'BareList.tsx'),
      `import React from 'react';
import { FlatList, Text } from 'react-native';

export function BareList({ data }: { data: Array<{ id: string }> }) {
  return (
    <FlatList
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <Text>{item.id}</Text>}
      onEndReachedThreshold={0.4}
      onEndReached={() => undefined}
      ListFooterComponent={<Text>more</Text>}
    />
  );
}
`,
    );
    const result = analyzePerformance(dir);
    const opts = result.findings.filter((item) => item.ruleId === 'perf-flatlist-opts');
    assert.equal(opts.some((item) => item.file.includes('ImportedList')), false);
    assert.equal(opts.some((item) => item.file.includes('LocalList')), false);
    assert.equal(opts.some((item) => item.file.includes('AliasedList')), false);
    assert.ok(opts.some((item) => item.file.includes('BareList')));
    assert.ok(opts.some((item) => item.file.includes('RestList')));
  });
});

describe('unused JS analyzer', () => {
  it('flags unused exports in reachable files and unimported modules separately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-js-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'index.js'),
      `import { Used } from './src/Used';\nexport function App() { return Used(); }\n`,
    );
    writeFileSync(
      join(dir, 'src', 'Used.js'),
      `export function Used() {\n  localUsed();\n  return 1;\n}\nexport function unusedFn() { return 2; }\nexport function UnusedComponent() { return null; }\nfunction localUsed() { return 4; }\nfunction localDead() { return 3; }\n`,
    );
    writeFileSync(join(dir, 'src', 'Orphan.js'), `export function Orphan() { return 1; }\n`);
    const result = analyzeUnusedJs(dir);
    const names = result.unusedInBytecode.map((item) => item.name);
    assert.ok(names.includes('unusedFn'));
    assert.ok(names.includes('UnusedComponent'));
    assert.ok(names.includes('localDead'));
    assert.ok(!names.includes('Used'));
    assert.ok(!names.includes('localUsed'));
    assert.ok(result.unusedInBytecode.every((item) => item.likelyInBytecode));
    assert.ok(result.unusedUnreachableModules.some((item) => item.file.endsWith('Orphan.js')));
    assert.ok(result.unusedUnreachableModules.every((item) => item.likelyInBytecode === false));
  });

  it('does not scan node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-nm-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), `import { Used } from './src/Used';\nexport function App() { return Used(); }\n`);
    writeFileSync(join(dir, 'src', 'Used.js'), `export function Used() { return 1; }\n`);
    writeFileSync(
      join(dir, 'node_modules', 'leftpad', 'index.js'),
      `export function unusedFromPackage() { return 1; }\n`,
    );
    const result = analyzeUnusedJs(dir);
    const files = [
      ...result.unusedInBytecode.map((item) => item.file),
      ...result.unusedUnreachableModules.map((item) => item.file),
    ];
    assert.equal(files.some((file) => file.includes('node_modules')), false);
    assert.equal(
      result.unusedInBytecode.some((item) => item.name === 'unusedFromPackage'),
      false,
    );
  });

  it('does not report unused details from workspace packages/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-pkg-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'react-native-geocam', 'src', 'utils'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), `import { Used } from './src/Used';\nexport function App() { return Used(); }\n`);
    writeFileSync(join(dir, 'src', 'Used.js'), `export function Used() { return 1; }\n`);
    writeFileSync(
      join(dir, 'packages', 'react-native-geocam', 'src', 'utils', 'format.js'),
      `export function formatCoordinate() { return '0,0'; }\nexport const GOOGLE_MAPS_API_KEY = 'x';\n`,
    );
    const result = analyzeUnusedJs(dir);
    const files = [
      ...result.unusedInBytecode.map((item) => item.file),
      ...result.unusedUnreachableModules.map((item) => item.file),
    ];
    assert.equal(files.some((file) => file.includes('packages/')), false);
    assert.equal(result.unusedInBytecode.some((item) => item.name === 'formatCoordinate'), false);
    assert.equal(result.unusedInBytecode.some((item) => item.name === 'GOOGLE_MAPS_API_KEY'), false);
  });

  it('only scans src/ or app/ and ignores root tooling files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-src-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'index.js'), `import { Used } from './src/Used';\nexport function App() { return Used(); }\n`);
    writeFileSync(join(dir, 'src', 'Used.js'), `export function Used() { return 1; }\nexport function unusedFn() { return 2; }\n`);
    writeFileSync(join(dir, '.eslintrc.js'), `module.exports = {};\nfunction unusedEslintRule() { return 1; }\n`);
    writeFileSync(join(dir, 'babel.config.js'), `module.exports = {};\nfunction unusedBabelHelper() { return 1; }\n`);
    writeFileSync(join(dir, 'metro.config.js'), `module.exports = {};\n`);
    const result = analyzeUnusedJs(dir);
    const files = [
      ...result.unusedInBytecode.map((item) => item.file),
      ...result.unusedUnreachableModules.map((item) => item.file),
    ];
    assert.ok(result.unusedInBytecode.some((item) => item.name === 'unusedFn'));
    assert.equal(files.some((file) => file.includes('eslintrc')), false);
    assert.equal(files.some((file) => file.includes('babel.config')), false);
    assert.equal(files.some((file) => file.includes('metro.config')), false);
    assert.equal(result.unusedInBytecode.some((item) => item.name === 'unusedEslintRule'), false);
  });

  it('does not scan unused JS when src/ and app/ are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-nosrc-'));
    writeFileSync(join(dir, '.eslintrc.js'), `function unusedEslintRule() { return 1; }\n`);
    writeFileSync(join(dir, 'index.js'), `export function App() { return 1; }\n`);
    const result = analyzeUnusedJs(dir);
    assert.equal(result.scannedFileCount, 0);
    assert.equal(result.unusedInBytecode.length, 0);
    assert.equal(result.unusedUnreachableModules.length, 0);
  });
});

describe('comparison', () => {
  it('reports archive growth and changed native files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnsa-cmp-'));
    const oldApk = join(dir, 'old.apk');
    const newApk = join(dir, 'new.apk');
    writeZip(oldApk, [{ name: 'lib/arm64-v8a/libfoo.so', data: Buffer.alloc(1000, 1) }]);
    writeZip(newApk, [
      { name: 'lib/arm64-v8a/libfoo.so', data: Buffer.alloc(1000, 1) },
      { name: 'lib/arm64-v8a/libreactnativevideo.so', data: Buffer.alloc(5000, 2) },
    ]);
    const comparison = compareArtifacts(oldApk, newApk);
    assert.equal(comparison.platform, 'android');
    assert.ok(comparison.total.deltaBytes > 0);
    assert.ok(comparison.largestChangedFiles.some((f) => f.path.includes('libreactnativevideo.so')));
  });
});

describe('html and json reporters', () => {
  it('renders a self-contained dashboard from a full analysis', async () => {
    const analysis = await analyzeProject({ cwd: FIXTURE, silent: true });
    const html = renderHtml(analysis);
    assert.match(html, /rn-size-analyzer/);
    assert.match(html, /Overall health score/);
    assert.match(html, /AAB size is not the Play Store download size/);
    assert.match(html, /ios\/SampleApp\.xcodeproj/);
    assert.match(html, /com\.sample\.app/);
    assert.match(html, /word-break: break-all/);
    assert.match(html, /com\.<wbr>sample\.<wbr>app/);
    assert.match(html, /list-card/);
    assert.match(html, /unique pods/);
    assert.match(html, /Usage is a static search/);
    assert.match(html, /Referenced from/);
    assert.match(html, /data-usage-filter="used"/);
    assert.match(html, /data-usage-filter="unused"/);
    assert.match(html, /data-usage-filter="unknown"/);
    assert.match(html, /JS unused/);
    assert.match(html, /Likely in bytecode/);
    assert.match(html, /Not in JS bundle/);
    assert.match(html, /data-goto-tab="security"/);
    assert.match(html, /\/ 100/);
    assert.match(html, /click for details/);
    assert.match(html, /These cards are scores, not issue counts/);
    assert.match(html, /\.js-unused-table th, \.js-unused-table td \{ overflow: hidden; \}/);
    assert.match(html, /\.js-unused-table \.cell-name code, \.js-unused-table \.cell-path code \{/);
    assert.doesNotMatch(html, /\.js-unused-table \.cell-name, \.js-unused-table \.cell-kind/);
    assert.doesNotMatch(html, /\d[\d,]* bytes/);
    const json = JSON.parse(toJson(analysis));
    assert.equal(json.overview.name, 'sample-rn-app');
    assert.ok(json.health.overall >= 0);
    assert.ok(Array.isArray(json.issues));
  });

  it('keeps IPA size findings on the iOS tab, not Android', async () => {
    const analysis = await analyzeProject({ cwd: FIXTURE, silent: true });
    analysis.issues.push(
      {
        id: 'android-native-large',
        severity: 'warning',
        title: 'Native libraries are large (app-release.aab)',
        description: 'Native .so files occupy a substantial portion of this AAB.',
        evidence: ['Total zip-entry size of native .so files: 21.8 MB'],
        platform: 'android',
        affected: 'app-release.aab',
        recommendation: 'Review ABI configuration.',
        confidence: 'measured',
        category: 'size',
      },
      {
        id: 'ios-frameworks-large',
        severity: 'warning',
        title: 'Embedded frameworks are large (UrjaMitraUserApp.ipa)',
        description: 'Framework/XCFramework payloads measured from archive entries.',
        evidence: ['Framework uncompressed total: 18.0 MB'],
        platform: 'ios',
        affected: 'UrjaMitraUserApp.ipa',
        recommendation: 'Review unused pods/frameworks.',
        confidence: 'measured',
        category: 'size',
      },
      {
        id: 'ios-ipa-not-download',
        severity: 'info',
        title: 'IPA/app size is not the App Store download size',
        description: 'IPA/archive size is not the App Store download size.',
        evidence: ['Archive size: 24.9 MB'],
        platform: 'ios',
        affected: 'UrjaMitraUserApp.ipa',
        recommendation: 'Use App Store Connect file sizes.',
        confidence: 'high',
        category: 'size',
      },
    );
    const html = renderHtml(analysis);
    const androidHtml = html.slice(html.indexOf('id="android"'), html.indexOf('id="ios"'));
    const iosHtml = html.slice(html.indexOf('id="ios"'), html.indexOf('id="deps"'));
    assert.match(androidHtml, /Native libraries are large \(app-release\.aab\)/);
    assert.doesNotMatch(androidHtml, /UrjaMitraUserApp\.ipa/);
    assert.doesNotMatch(androidHtml, /Embedded frameworks are large/);
    assert.doesNotMatch(androidHtml, /IPA\/app size is not the App Store download size/);
    assert.match(iosHtml, /Embedded frameworks are large \(UrjaMitraUserApp\.ipa\)/);
    assert.match(iosHtml, /IPA\/app size is not the App Store download size/);
  });

  it('hides the iOS tab on an Android-only analysis', async () => {
    const analysis = await analyzeAndroidOnly({ cwd: FIXTURE, silent: true });
    const html = renderHtml(analysis);
    assert.equal(analysis.analyzedPlatform, 'android');
    assert.match(html, /data-tab="android"/);
    assert.doesNotMatch(html, /data-tab="ios"/);
    assert.doesNotMatch(html, /<section class="panel" id="ios">/);
    assert.doesNotMatch(html, />iOS detected</);
    assert.doesNotMatch(html, /<h3>iOS<\/h3>/);
  });

  it('hides the Android tab on an iOS-only analysis', async () => {
    const analysis = await analyzeIosOnly({ cwd: FIXTURE, silent: true });
    const html = renderHtml(analysis);
    assert.equal(analysis.analyzedPlatform, 'ios');
    assert.match(html, /data-tab="ios"/);
    assert.doesNotMatch(html, /data-tab="android"/);
    assert.doesNotMatch(html, /<section class="panel" id="android">/);
    assert.doesNotMatch(html, />Android detected</);
    assert.doesNotMatch(html, /<h3>Android<\/h3>/);
  });

  it('wraps long unused JS names so they do not overflow into Kind', async () => {
    const analysis = await analyzeProject({ cwd: FIXTURE, silent: true });
    const longName = 'RegistrationPaymentTransactionItem.style.js';
    analysis.jsUnused.unusedUnreachableModules.push({
      name: longName,
      kind: 'module',
      file: 'src/role/um/components/registration/RegistrationPaymentTransactionItem.style.js',
      line: 1,
      inBundleGraph: false,
      likelyInBytecode: false,
      confidence: 'medium',
      evidence: ['No app import reaches this file.'],
      recommendation: 'Delete unused files after confirming they are not loaded dynamically.',
    });
    const html = renderHtml(analysis);
    const unusedHtml = html.slice(html.indexOf('id="js-unused"'), html.indexOf('id="perf"'));
    assert.match(unusedHtml, /RegistrationPaymentTransactionItem\.<wbr>style\.<wbr>js/);
    assert.match(unusedHtml, /title="RegistrationPaymentTransactionItem\.style\.js"/);
    assert.match(html, /overflow-wrap: anywhere/);
    assert.match(html, /word-break: break-word/);
  });
});
