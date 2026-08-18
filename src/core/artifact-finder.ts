import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isDirectory, isFile } from '../utils/fs';
import { artifactKind } from './project-detector';

export interface FoundArtifact {
  path: string;
  kind: 'apk' | 'aab' | 'ipa' | 'app';
}

export interface FoundArtifacts {
  android?: FoundArtifact;
  ios?: FoundArtifact;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.cxx',
  'intermediates',
  'Pods',
  'DerivedData',
  'rn-size-report',
  'dist-test',
  'coverage',
]);

function walk(root: string, extensions: Set<string>, maxFiles = 80): string[] {
  if (!isDirectory(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < maxFiles) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.name.toLowerCase().endsWith('.app') && extensions.has('.app')) {
          found.push(full);
          continue;
        }
        stack.push(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if ([...extensions].some((ext) => lower.endsWith(ext))) found.push(full);
    }
  }
  return found;
}

function scoreAndroid(filePath: string, projectRoot: string): number {
  const rel = relative(projectRoot, filePath).replace(/\\/g, '/').toLowerCase();
  if (rel.includes('/intermediates/')) return 1;
  if (rel.endsWith('.aab') && rel.includes('outputs/bundle/') && rel.includes('/release/')) return 100;
  if (rel.endsWith('.aab') && rel.includes('/release/')) return 90;
  if (rel.endsWith('.aab')) return 70;
  if (rel.endsWith('.apk') && rel.includes('outputs/apk/') && rel.includes('/release/')) return 60;
  if (rel.endsWith('.apk') && rel.includes('/release/')) return 50;
  if (rel.endsWith('.apk') && rel.includes('/debug/')) return 15;
  if (rel.endsWith('.apk')) return 20;
  return 0;
}

function scoreIos(filePath: string, projectRoot: string): number {
  const rel = relative(projectRoot, filePath).replace(/\\/g, '/').toLowerCase();
  if (rel.endsWith('.ipa') && rel.includes('/release/')) return 100;
  if (rel.endsWith('.ipa')) return 80;
  if (rel.endsWith('.app') && rel.includes('/release-iphoneos/')) return 50;
  if (rel.endsWith('.app')) return 20;
  return 0;
}

function pickBest(
  files: string[],
  projectRoot: string,
  score: (file: string, root: string) => number,
): string | undefined {
  let best: { path: string; score: number; mtime: number } | undefined;
  for (const file of files) {
    const value = score(file, projectRoot);
    if (value <= 0) continue;
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || value > best.score || (value === best.score && mtime > best.mtime)) {
      best = { path: file, score: value, mtime };
    }
  }
  return best?.path;
}

export function findBuildArtifacts(
  projectRoot: string,
  platform: 'android' | 'ios' | 'all' = 'all',
): FoundArtifacts {
  const androidRoots =
    platform === 'ios'
      ? []
      : [
          join(projectRoot, 'android', 'app', 'build', 'outputs'),
          join(projectRoot, 'android', 'app', 'release'),
          join(projectRoot, 'output'),
          join(projectRoot, 'outputs'),
          join(projectRoot, 'dist'),
          join(projectRoot, 'releases'),
          projectRoot,
        ];
  const iosRoots =
    platform === 'android'
      ? []
      : [
          join(projectRoot, 'ios'),
          join(projectRoot, 'output'),
          join(projectRoot, 'outputs'),
          join(projectRoot, 'dist'),
          join(projectRoot, 'releases'),
          projectRoot,
        ];

  const androidFiles = androidRoots.flatMap((root) => {
    if (root === projectRoot) {
      try {
        return readdirSync(projectRoot)
          .filter((name) => /\.(aab|apk)$/i.test(name))
          .map((name) => join(projectRoot, name));
      } catch {
        return [];
      }
    }
    return walk(root, new Set(['.aab', '.apk']));
  });

  const iosFiles = iosRoots.flatMap((root) => {
    if (root === projectRoot) {
      try {
        return readdirSync(projectRoot)
          .filter((name) => /\.(ipa|app)$/i.test(name))
          .map((name) => join(projectRoot, name));
      } catch {
        return [];
      }
    }
    return [
      ...walk(root, new Set(['.ipa'])),
      ...walk(root, new Set(['.app'])).filter((file) => isDirectory(file) || file.toLowerCase().endsWith('.app')),
    ];
  });

  const androidPath = pickBest(androidFiles, projectRoot, scoreAndroid);
  const iosPath = pickBest(iosFiles, projectRoot, scoreIos);
  const result: FoundArtifacts = {};
  if (androidPath) {
    const kind = artifactKind(androidPath);
    if (kind === 'apk' || kind === 'aab') result.android = { path: androidPath, kind };
  }
  if (iosPath) {
    const kind = artifactKind(iosPath);
    if (kind === 'ipa' || kind === 'app') result.ios = { path: iosPath, kind };
  }
  return result;
}

export function resolveExplicitArtifact(
  cwd: string,
  target: string,
): FoundArtifact | undefined {
  const abs = resolve(cwd, target);
  const kind = artifactKind(abs);
  if (!kind) return undefined;
  if (!isFile(abs) && !(kind === 'app' && isDirectory(abs))) return undefined;
  return { path: abs, kind };
}
