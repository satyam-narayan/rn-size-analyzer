import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-test',
  'build',
  'Pods',
  'DerivedData',
  '.gradle',
  '.cxx',
  'coverage',
  'rn-size-report',
  '.expo',
  '.pnpm',
  'vendor',
]);

export function isVendorRel(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) => DEFAULT_IGNORE.has(part));
}

export function pathExists(filePath: string): boolean {
  return existsSync(filePath);
}

export function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

export function readTextIfExists(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, 'utf8');
}

export function readJsonIfExists<T>(filePath: string): T | undefined {
  const text = readTextIfExists(filePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function writeText(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

export function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, JSON.stringify(value, null, 2) + '\n');
}

export function fileSize(filePath: string): number {
  return statSync(filePath).size;
}

export function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export interface WalkOptions {
  ignoreDirNames?: Set<string>;
  maxFiles?: number;
  extensions?: Set<string>;
}

export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const ignore = options.ignoreDirNames ?? DEFAULT_IGNORE;
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current !== root && isVendorRel(rel(root, current))) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.rn-size-analyzer.json') {
        if (entry.isDirectory() || entry.isSymbolicLink()) continue;
      }
      const full = join(current, entry.name);
      const relative = rel(root, full);
      if (ignore.has(entry.name) || isVendorRel(relative)) continue;

      let directory = entry.isDirectory();
      if (!directory && entry.isSymbolicLink()) {
        directory = isDirectory(full);
      }
      if (directory) {
        stack.push(full);
        continue;
      }
      if (options.extensions) {
        const ext = entry.name.includes('.')
          ? `.${entry.name.split('.').pop()?.toLowerCase()}`
          : '';
        if (!options.extensions.has(ext)) continue;
      }
      results.push(full);
      if (options.maxFiles && results.length >= options.maxFiles) return results;
    }
  }
  return results;
}

export function hashFile(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function rel(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join('/');
}

export function resolveMaybe(cwd: string, candidate: string): string {
  return resolve(cwd, candidate);
}

export { join, resolve, dirname };
