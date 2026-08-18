import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Confidence,
  DependencyAnalysis,
  DependencyGraph,
  DependencyNode,
  NativeLibrary,
  PackageManager,
  Platform,
} from '../../types';
import { isDirectory, isFile, readJsonIfExists, readTextIfExists } from '../../utils/fs';
import { issue } from '../issue';
import { parsePodfileLock } from '../ios/project';

const KNOWN_NATIVE_HINTS = [
  'android',
  'ios',
  'react-native.config.js',
  'react-native.config.ts',
];

function packageManagerOf(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function listDirectDeps(pkg: Record<string, unknown> | undefined): Record<string, string> {
  return {
    ...((pkg?.dependencies as Record<string, string> | undefined) ?? {}),
  };
}

function detectPlatforms(pkgDir: string): { platforms: Platform[]; native: boolean } {
  const android = isDirectory(join(pkgDir, 'android')) || isFile(join(pkgDir, 'android', 'build.gradle'));
  const ios =
    isDirectory(join(pkgDir, 'ios')) ||
    Boolean(
      isDirectory(pkgDir) &&
        readdirSync(pkgDir).some((name) => name.endsWith('.podspec')),
    );
  const nativeHint = KNOWN_NATIVE_HINTS.some((hint) => existsSync(join(pkgDir, hint)));
  const native = android || ios || nativeHint;
  if (android && ios) return { platforms: ['android', 'ios'], native };
  if (android) return { platforms: ['android'], native };
  if (ios) return { platforms: ['ios'], native };
  if (native) return { platforms: ['shared'], native };
  return { platforms: ['shared'], native: false };
}

function countLockPackages(root: string, manager: PackageManager): number | undefined {
  if (manager === 'npm') {
    const lock = readJsonIfExists<{ packages?: Record<string, unknown> }>(
      join(root, 'package-lock.json'),
    );
    if (lock?.packages) {
      return Math.max(0, Object.keys(lock.packages).length - 1);
    }
  }
  if (manager === 'yarn') {
    const lock = readTextIfExists(join(root, 'yarn.lock'));
    if (!lock) return undefined;
    return [...lock.matchAll(/^"?[^"\n]+@/gm)].length;
  }
  if (manager === 'pnpm') {
    const lock = readTextIfExists(join(root, 'pnpm-lock.yaml'));
    if (!lock) return undefined;
    const packages = lock.match(/^packages:/m);
    if (!packages) return undefined;
    return [...lock.matchAll(/^\s{2}[/'"]/gm)].length;
  }
  return undefined;
}

export function guessPackageForNativeLib(libName: string, nodes: DependencyNode[]): {
  name?: string;
  confidence: Confidence;
  note: string;
} {
  const stem = libName.replace(/^lib/, '').replace(/\.so$/, '').toLowerCase();
  const compact = stem.replace(/[-_]/g, '');

  for (const node of nodes) {
    const pkg = node.name.replace(/^@[^/]+\//, '').toLowerCase();
    const pkgCompact = pkg.replace(/[-_]/g, '');
    if (stem.includes(pkgCompact) || pkgCompact.includes(compact) || compact.includes(pkgCompact)) {
      if (pkgCompact.length >= 4) {
        return {
          name: node.name,
          confidence: 'medium',
          note: 'Attribution estimated from native library name vs npm package name. Requires verification.',
        };
      }
    }
  }
  return {
    confidence: 'unknown',
    note: 'Could not confidently attribute this binary.',
  };
}

export function applyNativeAttribution(
  libraries: NativeLibrary[],
  nodes: DependencyNode[],
): NativeLibrary[] {
  const attributed = libraries.map((lib) => {
    const guess = guessPackageForNativeLib(lib.name, nodes.filter((n) => n.native));
    return {
      ...lib,
      attributedPackage: guess.name,
      attributionConfidence: guess.confidence,
      attributionNote: guess.note,
    };
  });

  const bytesByPkg = new Map<string, number>();
  for (const lib of attributed) {
    if (!lib.attributedPackage) continue;
    bytesByPkg.set(
      lib.attributedPackage,
      (bytesByPkg.get(lib.attributedPackage) ?? 0) + lib.uncompressedBytes,
    );
  }
  for (const node of nodes) {
    const bytes = bytesByPkg.get(node.name);
    if (bytes) {
      node.androidBytes = (node.androidBytes ?? 0) + bytes;
      node.attributionConfidence = 'medium';
      node.warnings.push('Android native size is attribution estimated from .so names.');
    }
  }
  return attributed;
}

function nodeModulesPackageDir(root: string, name: string): string {
  return join(root, 'node_modules', ...name.split('/'));
}

export function analyzeDependencies(
  root: string,
  packageJson: Record<string, unknown> | undefined,
): DependencyAnalysis {
  const pkg = packageJson ?? readJsonIfExists<Record<string, unknown>>(join(root, 'package.json'));
  const direct = listDirectDeps(pkg);
  const manager = packageManagerOf(root);
  const nodes: DependencyNode[] = [];
  const graph: DependencyGraph = { root: String(pkg?.name ?? 'app'), edges: [] };

  for (const [name, version] of Object.entries(direct)) {
    const dir = nodeModulesPackageDir(root, name);
    const installed = isDirectory(dir);
    const meta = installed
      ? detectPlatforms(dir)
      : { platforms: ['shared'] as Platform[], native: false };
    const nested = installed
      ? readJsonIfExists<{ dependencies?: Record<string, string> }>(join(dir, 'package.json'))
      : undefined;
    const deps = Object.keys(nested?.dependencies ?? {});
    const filesContributed: string[] = [];
    if (installed) {
      if (isDirectory(join(dir, 'android'))) filesContributed.push(`${name}/android`);
      if (isDirectory(join(dir, 'ios'))) filesContributed.push(`${name}/ios`);
    }
    nodes.push({
      name,
      version,
      platforms: meta.platforms,
      native: meta.native,
      attributionConfidence: 'unknown',
      dependents: [],
      dependencies: deps.slice(0, 40),
      filesContributed,
      warnings: installed ? [] : ['Package is listed in package.json but not present in node_modules.'],
      recommendations: meta.native
        ? ['Review whether all native components of this dependency are required in release builds.']
        : [],
    });
    graph.edges.push({ from: graph.root, to: name, kind: 'npm' });
    for (const child of deps.slice(0, 20)) {
      graph.edges.push({ from: name, to: child, kind: 'npm' });
    }
  }

  const lock = readTextIfExists(join(root, 'ios', 'Podfile.lock'));
  if (lock) {
    for (const pod of parsePodfileLock(lock).slice(0, 80)) {
      graph.edges.push({ from: 'ios-pods', to: pod.name, kind: 'pod' });
    }
  }

  const androidOnly = nodes.filter((n) => n.platforms.length === 1 && n.platforms[0] === 'android').map((n) => n.name);
  const iosOnly = nodes.filter((n) => n.platforms.length === 1 && n.platforms[0] === 'ios').map((n) => n.name);
  const crossPlatform = nodes
    .filter((n) => n.platforms.includes('android') && n.platforms.includes('ios'))
    .map((n) => n.name);

  const outdatedLocal: DependencyAnalysis['outdatedLocal'] = [];
  for (const node of nodes) {
    const dir = nodeModulesPackageDir(root, node.name);
    const installedPkg = readJsonIfExists<{ version?: string }>(join(dir, 'package.json'));
    if (node.version && installedPkg?.version && installedPkg.version !== node.version.replace(/^[^\d]*/, '')) {
      if (!node.version.includes(installedPkg.version)) {
        outdatedLocal.push({
          name: node.name,
          current: installedPkg.version,
          note: `package.json specifies "${node.version}"; installed node_modules version is ${installedPkg.version}.`,
        });
      }
    }
  }

  const issues = [];
  const heavyNative = nodes.filter((n) => n.native);
  if (heavyNative.length >= 8) {
    issues.push(
      issue({
        severity: 'info',
        title: `${heavyNative.length} direct dependencies appear to include native code`,
        description:
          'Native modules often dominate Android/iOS binary size. This count is based on package folders (android/, ios/, podspec), not measured binary size.',
        evidence: heavyNative.slice(0, 12).map((n) => n.name),
        platform: 'shared',
        recommendation:
          'Prioritize native modules in size reviews. Map .so/framework sizes back to these packages after analyzing a release artifact.',
        confidence: 'medium',
        category: 'dependencies',
        id: 'deps-many-native',
      }),
    );
  }

  const missingNative = nodes.filter((n) => n.warnings.length > 0);
  if (missingNative.length > 0) {
    issues.push(
      issue({
        severity: 'info',
        title: 'Some dependencies are not installed locally',
        description:
          'Platform/native detection is limited when node_modules is missing. Run a package install for more accurate results.',
        evidence: missingNative.slice(0, 10).map((n) => n.name),
        recommendation: 'Install dependencies, then re-run the analyzer.',
        confidence: 'high',
        category: 'dependencies',
        id: 'deps-not-installed',
      }),
    );
  }

  return {
    totalDirect: nodes.length,
    totalTransitive: countLockPackages(root, manager),
    packageManager: manager,
    nodes,
    nativeModules: nodes.filter((n) => n.native),
    androidOnly,
    iosOnly,
    crossPlatform,
    outdatedLocal,
    graph,
    issues,
  };
}

export function nodeModuleSizeIfPresent(root: string, name: string): number | undefined {
  const dir = nodeModulesPackageDir(root, name);
  if (!isDirectory(dir)) return undefined;
  let total = 0;
  const stack = [dir];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const current = stack.pop();
    if (!current) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      visited += 1;
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else total += st.size;
      } catch {
        continue;
      }
    }
  }
  return total;
}
