import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { PackageManager, ProjectKind, ProjectOverview } from '../types';
import { isDirectory, isFile, readJsonIfExists, readTextIfExists } from '../utils/fs';

export interface DetectedProject {
  overview: ProjectOverview;
  packageJson?: Record<string, unknown>;
  isReactNative: boolean;
  invalidReason?: string;
}

function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function hasReactNative(pkg: Record<string, unknown> | undefined): boolean {
  if (!pkg) return false;
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.peerDependencies as Record<string, string> | undefined) ?? {}),
  };
  return Boolean(deps['react-native'] || deps['expo'] || deps['react-native-web']);
}

function detectKind(root: string, pkg: Record<string, unknown> | undefined): ProjectKind {
  const deps = {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg?.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  if (deps.expo || existsSync(join(root, 'app.json')) || existsSync(join(root, 'app.config.js'))) {
    if (deps.expo) return 'expo';
  }
  if (deps['react-native']) return 'bare';
  return 'unknown';
}

function gradleBoolean(root: string, key: string): boolean | undefined {
  const props = readTextIfExists(join(root, 'android', 'gradle.properties'));
  if (!props) return undefined;
  const match = props.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'im'));
  if (!match) return undefined;
  return match[1] === 'true';
}

function podfileHermes(root: string): boolean | undefined {
  const podfile = readTextIfExists(join(root, 'ios', 'Podfile'));
  if (!podfile) return undefined;
  if (/:hermes_enabled\s*=>\s*true/i.test(podfile) || /hermes_enabled\s*=\s*true/i.test(podfile)) {
    return true;
  }
  if (/:hermes_enabled\s*=>\s*false/i.test(podfile)) return false;
  if (/:hermes_enabled\s*=>\s*flags\[:hermes_enabled\]/i.test(podfile)) {
    return true;
  }
  return undefined;
}

export function detectAndroid(root: string): boolean {
  return (
    isFile(join(root, 'android', 'build.gradle')) ||
    isFile(join(root, 'android', 'build.gradle.kts')) ||
    isFile(join(root, 'android', 'settings.gradle')) ||
    isFile(join(root, 'android', 'settings.gradle.kts'))
  );
}

export function detectIos(root: string): boolean {
  const iosDir = join(root, 'ios');
  if (!isDirectory(iosDir)) return false;
  if (isFile(join(iosDir, 'Podfile'))) return true;
  try {
    return readdirSync(iosDir).some(
      (name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'),
    );
  } catch {
    return false;
  }
}

export function detectProject(cwd: string): DetectedProject {
  const packageJsonPath = join(cwd, 'package.json');
  const packageJson = readJsonIfExists<Record<string, unknown>>(packageJsonPath);
  const androidDetected = detectAndroid(cwd);
  const iosDetected = detectIos(cwd);
  const isRn = hasReactNative(packageJson) || androidDetected || iosDetected;
  const name =
    (typeof packageJson?.name === 'string' && packageJson.name) ||
    cwd.split(/[\\/]/).filter(Boolean).pop() ||
    'unknown';

  const deps = {
    ...((packageJson?.dependencies as Record<string, string> | undefined) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string> | undefined) ?? {}),
  };

  const hermesGradle = gradleBoolean(cwd, 'hermesEnabled');
  const hermesPod = podfileHermes(cwd);
  const newArch =
    gradleBoolean(cwd, 'newArchEnabled') ?? gradleBoolean(cwd, 'newArchEnabled'.toLowerCase());

  const overview: ProjectOverview = {
    name,
    root: cwd,
    reactNativeVersion: deps['react-native'],
    nodeVersion: process.version,
    packageManager: detectPackageManager(cwd),
    kind: detectKind(cwd, packageJson),
    androidDetected,
    iosDetected,
    hermesEnabled: hermesGradle ?? hermesPod,
    newArchEnabled: newArch,
  };

  if (!packageJson && !androidDetected && !iosDetected) {
    return {
      overview,
      packageJson,
      isReactNative: false,
      invalidReason:
        'No React Native project detected. Expected package.json with react-native/expo, or android/ / ios/ native projects.',
    };
  }

  return { overview, packageJson, isReactNative: isRn };
}

export function artifactKind(
  filePath: string,
): 'apk' | 'aab' | 'ipa' | 'app' | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.apk')) return 'apk';
  if (lower.endsWith('.aab')) return 'aab';
  if (lower.endsWith('.ipa')) return 'ipa';
  if (lower.endsWith('.app')) return 'app';
  return undefined;
}
