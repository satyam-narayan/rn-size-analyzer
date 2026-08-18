import { basename, dirname, extname } from 'node:path';
import { readFileSync } from 'node:fs';
import type { AssetEntry, Confidence } from '../../types';
import { isVendorRel, rel, walkFiles } from '../../utils/fs';

const REFERENCE_EXT = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.xml',
  '.java',
  '.kt',
  '.gradle',
  '.plist',
  '.m',
  '.mm',
  '.swift',
  '.storyboard',
  '.pbxproj',
  '.css',
  '.scss',
  '.html',
  '.rb',
]);

const GENERIC_STEMS = new Set([
  'icon',
  'logo',
  'image',
  'img',
  'bg',
  'background',
  'splash',
  'default',
  'close',
  'check',
  'arrow',
  'back',
  'next',
  'menu',
  'search',
  'user',
  'profile',
]);

export interface AssetUsage {
  usage: 'used' | 'unused' | 'unknown';
  usedIn: string[];
  confidence: Confidence;
  note: string;
}

interface SourceFile {
  rel: string;
  text: string;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function androidResourceName(fileName: string): string | undefined {
  const stem = fileName.replace(/\.[^.]+$/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(stem)) return undefined;
  return stem;
}

function isAndroidRes(path: string): boolean {
  return /(?:^|\/)android\/.*\/res\/(drawable|mipmap|raw)[^/]*\//i.test(path);
}

export function needlesFor(
  path: string,
  uniqueBasename: boolean,
  kind?: AssetEntry['kind'],
): string[] {
  const base = basename(path);
  const parent = basename(dirname(path));
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const needles = new Set<string>([path, base, `${parent}/${base}`]);

  if (path.startsWith('assets/')) needles.add(path.slice('assets/'.length));
  if (base.includes(' ')) needles.add(encodeURIComponent(base));

  if (kind === 'font' && stem.length >= 4) needles.add(stem);

  if (uniqueBasename && stem.length >= 8 && !GENERIC_STEMS.has(stem.toLowerCase())) {
    needles.add(stem);
  }

  if (isAndroidRes(path)) {
    const resource = androidResourceName(base);
    if (resource) {
      needles.add(`@drawable/${resource}`);
      needles.add(`@mipmap/${resource}`);
      needles.add(`@raw/${resource}`);
      needles.add(`R.drawable.${resource}`);
      needles.add(`R.mipmap.${resource}`);
      needles.add(`R.raw.${resource}`);
    }
  }

  return [...needles].filter((needle) => needle.length >= 4);
}

export function loadReferenceFiles(root: string): SourceFile[] {
  const files = walkFiles(root, { extensions: REFERENCE_EXT, maxFiles: 5000 });
  const out: SourceFile[] = [];
  for (const file of files) {
    const relative = rel(root, file);
    if (isVendorRel(relative)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      if (!text || text.length > 1_500_000) continue;
      out.push({ rel: relative, text });
    } catch {
      continue;
    }
  }
  return out;
}

export function detectUsage(
  entries: AssetEntry[],
  sources: SourceFile[],
): Map<string, AssetUsage> {
  const basenameCount = new Map<string, number>();
  for (const entry of entries) {
    const base = basename(entry.path);
    basenameCount.set(base, (basenameCount.get(base) ?? 0) + 1);
  }

  const result = new Map<string, AssetUsage>();
  for (const entry of entries) {
    const uniqueBasename = (basenameCount.get(basename(entry.path)) ?? 0) === 1;
    const needles = needlesFor(entry.path, uniqueBasename, entry.kind);
    const hits: string[] = [];
    let pathHit = false;

    for (const source of sources) {
      if (source.rel === entry.path) continue;
      let index = -1;
      let matched = '';
      for (const needle of needles) {
        index = source.text.indexOf(needle);
        if (index !== -1) {
          matched = needle;
          break;
        }
      }
      if (index === -1) continue;
      hits.push(`${source.rel}:${lineNumber(source.text, index)}`);
      if (matched.includes('/') || matched === entry.path) pathHit = true;
      if (hits.length >= 8) break;
    }

    if (hits.length === 0) {
      result.set(entry.path, {
        usage: 'unused',
        usedIn: [],
        confidence: 'medium',
        note: 'No static require/import/resource string matched this file. Dynamic paths can hide usage — search the repo before deleting.',
      });
      continue;
    }

    if (!uniqueBasename && !pathHit) {
      result.set(entry.path, {
        usage: 'unknown',
        usedIn: hits,
        confidence: 'low',
        note: 'Another file shares this name. The match may refer to a different copy.',
      });
      continue;
    }

    result.set(entry.path, {
      usage: 'used',
      usedIn: hits,
      confidence: pathHit || uniqueBasename ? 'high' : 'medium',
      note: `Static reference found in ${hits.length} file(s).`,
    });
  }
  return result;
}
