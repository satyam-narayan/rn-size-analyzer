import { join } from 'node:path';
import type {
  AndroidAnalysis,
  AndroidBuildConfig,
  AndroidSdkConfig,
  Issue,
} from '../../types';
import { isFile, readTextIfExists } from '../../utils/fs';
import { issue } from '../issue';

function firstMatch(text: string | undefined, patterns: RegExp[]): string | undefined {
  if (!text) return undefined;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function boolFromGradle(text: string | undefined, key: string): boolean | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(`${key}\\s*[:=]\\s*(true|false)`, 'i'));
  if (!match) return undefined;
  return match[1].toLowerCase() === 'true';
}

function parseAbiFilters(text: string | undefined): string[] {
  if (!text) return [];
  const match = text.match(/abiFilters\s+([^\n]+)/);
  if (!match) return [];
  return [...match[1].matchAll(/["']([a-z0-9_-]+)["']/g)].map((m) => m[1]);
}

function parseBuildTypes(text: string | undefined): string[] {
  if (!text) return [];
  const types = new Set<string>();
  for (const match of text.matchAll(/^\s*(debug|release|staging|qa|beta)\s*\{/gm)) {
    types.add(match[1]);
  }
  return [...types];
}

function resolveGradleBool(text: string | undefined, pattern: RegExp): boolean | undefined {
  if (!text) return undefined;
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  const raw = match[1];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const fromVar = text.match(new RegExp(`(?:def\\s+)?${raw}\\s*=\\s*(true|false)`));
  if (!fromVar) return undefined;
  return fromVar[1] === 'true';
}

export function parseAndroidProject(root: string): AndroidAnalysis {
  const appGradle =
    readTextIfExists(join(root, 'android', 'app', 'build.gradle')) ??
    readTextIfExists(join(root, 'android', 'app', 'build.gradle.kts'));
  const rootGradle =
    readTextIfExists(join(root, 'android', 'build.gradle')) ??
    readTextIfExists(join(root, 'android', 'build.gradle.kts'));
  const props = readTextIfExists(join(root, 'android', 'gradle.properties'));
  const manifest = readTextIfExists(
    join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  );
  const wrapper = readTextIfExists(
    join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'),
  );

  const detected = Boolean(appGradle || rootGradle || props);
  if (!detected) {
    return {
      detected: false,
      missingReason: 'No Android Gradle project found under android/.',
      issues: [],
    };
  }

  const combined = [appGradle, rootGradle, props].filter(Boolean).join('\n');
  const sdk: AndroidSdkConfig = {
    compileSdk: firstMatch(combined, [
      /compileSdk(?:Version)?\s*=?\s*["']?(\d+)/,
      /compileSdkVersion\s+(\d+)/,
    ]),
    targetSdk: firstMatch(combined, [
      /targetSdk(?:Version)?\s*=?\s*["']?(\d+)/,
      /targetSdkVersion\s+(\d+)/,
    ]),
    minSdk: firstMatch(combined, [
      /minSdk(?:Version)?\s*=?\s*["']?(\d+)/,
      /minSdkVersion\s+(\d+)/,
    ]),
    ndkVersion: firstMatch(combined, [/ndkVersion\s*=?\s*["']([^"']+)["']/]),
  };

  const minifyEnabled = resolveGradleBool(
    appGradle,
    /buildTypes[\s\S]*release[\s\S]*minifyEnabled\s+([A-Za-z0-9_]+)/,
  );
  const shrinkResources = resolveGradleBool(
    appGradle,
    /buildTypes[\s\S]*release[\s\S]*shrinkResources\s+([A-Za-z0-9_]+)/,
  );
  const debuggableRelease = resolveGradleBool(
    appGradle,
    /buildTypes[\s\S]*release[\s\S]*debuggable\s+([A-Za-z0-9_]+)/,
  );

  const signingConfigPresent =
    /signingConfigs\s*\{/.test(appGradle ?? '') ||
    isFile(join(root, 'android', 'app', 'debug.keystore')) ||
    /storeFile/.test(appGradle ?? '');

  const build: AndroidBuildConfig = {
    hermesEnabled: boolFromGradle(props, 'hermesEnabled'),
    newArchEnabled: boolFromGradle(props, 'newArchEnabled'),
    minifyEnabled,
    shrinkResources,
    debuggable: debuggableRelease,
    abiFilters: parseAbiFilters(appGradle),
    signingConfigPresent,
    r8OrProguardConfigured:
      minifyEnabled === true || isFile(join(root, 'android', 'app', 'proguard-rules.pro')),
    gradleVersion: firstMatch(wrapper, [/gradle-(\d+\.\d+(?:\.\d+)?)-/]),
    buildTypes: parseBuildTypes(appGradle),
    sourceFiles: [
      'android/build.gradle',
      'android/app/build.gradle',
      'android/gradle.properties',
      'android/app/src/main/AndroidManifest.xml',
    ].filter((rel) => isFile(join(root, rel))),
  };

  const issues: Issue[] = [];

  if (build.hermesEnabled === false) {
    issues.push(
      issue({
        severity: 'warning',
        title: 'Hermes appears disabled on Android',
        description:
          'Hermes typically reduces JS runtime size and improves startup compared with JSC. This is a configuration observation, not a measured size delta.',
        evidence: ['android/gradle.properties hermesEnabled=false (or equivalent)'],
        platform: 'android',
        affected: 'android/gradle.properties',
        recommendation: 'Confirm whether Hermes is intentionally disabled for this app.',
        confidence: 'high',
        category: 'build',
        id: 'android-hermes-disabled',
      }),
    );
  }

  if (build.minifyEnabled === false) {
    issues.push(
      issue({
        severity: 'warning',
        title: 'R8/ProGuard minifyEnabled is false for release',
        description:
          'Release minification is not enabled in the parsed Gradle configuration. Impact on APK/AAB size is not measured here.',
        evidence: ['android/app/build.gradle release minifyEnabled false'],
        platform: 'android',
        affected: 'android/app/build.gradle',
        recommendation: 'Review release minifyEnabled / shrinkResources before shipping.',
        confidence: 'high',
        category: 'release',
        id: 'android-minify-off',
      }),
    );
  }

  if (build.debuggable === true) {
    issues.push(
      issue({
        severity: 'critical',
        title: 'Release build type is marked debuggable',
        description:
          'A debuggable release configuration is a release/security concern. Verify this is not used for production artifacts.',
        evidence: ['android/app/build.gradle release { debuggable true }'],
        platform: 'android',
        affected: 'android/app/build.gradle',
        recommendation: 'Set debuggable false for production release builds.',
        confidence: 'high',
        category: 'security',
        id: 'android-debuggable-release',
      }),
    );
  }

  const abi = build.abiFilters;
  if (abi.includes('x86') || abi.includes('x86_64')) {
    issues.push(
      issue({
        severity: 'info',
        title: 'x86/x86_64 ABIs are included in abiFilters',
        description:
          'x86 libraries increase native size and are rarely required for Play Store device delivery. Play App Bundles already generate ABI splits; packaging extra ABIs in universal APKs inflates size.',
        evidence: [`abiFilters: ${abi.join(', ')}`],
        platform: 'android',
        affected: 'android/app/build.gradle',
        recommendation:
          'If you ship an AAB, Play will generate ABI splits. For universal APKs, review whether x86 ABIs are required.',
        confidence: 'medium',
        category: 'size',
        id: 'android-x86-abi',
      }),
    );
  }

  if (sdk.targetSdk) {
    const target = Number(sdk.targetSdk);
    if (!Number.isNaN(target) && target < 34) {
      issues.push(
        issue({
          severity: 'warning',
          title: `targetSdk ${sdk.targetSdk} may be below current Play requirements`,
          description:
            'Google Play target API requirements change over time. This tool does not query Play Console; verify against current Play policy.',
          evidence: [`targetSdk=${sdk.targetSdk}`],
          platform: 'android',
          affected: 'android/app/build.gradle',
          recommendation: 'Confirm the current Play target API level before release.',
          confidence: 'medium',
          category: 'release',
          id: 'android-target-sdk',
        }),
      );
    }
  }

  const manifestPackage = firstMatch(manifest, [/package="([^"]+)"/]);
  const applicationId = firstMatch(appGradle, [/applicationId\s+["']([^"']+)["']/]);

  return {
    detected: true,
    sdk,
    build,
    manifestPackage,
    applicationId,
    issues,
  };
}
