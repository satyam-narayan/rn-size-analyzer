import { extname } from 'node:path';
import { statSync } from 'node:fs';
import type { AssetAnalysis, AssetEntry, FontEntry, Issue } from '../../types';
import { hashFile, isVendorRel, rel, walkFiles } from '../../utils/fs';
import { formatBytes } from '../../utils/size';
import { issue } from '../issue';
import { detectUsage, loadReferenceFiles } from './usage';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.heic', '.bmp']);
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);

const ASSET_ROOT_HINTS = [
  'assets',
  'src',
  'app',
  'android/app/src/main/res',
  'android/app/src/main/assets',
  'ios',
];

function kindOf(ext: string): AssetEntry['kind'] {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (FONT_EXT.has(ext)) return 'font';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

function familyGuess(fileName: string): string {
  return fileName.replace(/\.(ttf|otf|ttc|woff2?)$/i, '').replace(/[-_]/g, ' ');
}

function recommendationFor(entry: AssetEntry): string | undefined {
  if (entry.usage === 'unused') {
    return 'No static reference found. Confirm there is no dynamic require/import, then delete this file if unused.';
  }
  if (entry.kind === 'image' && entry.bytes > 500 * 1024) {
    return 'Large image. Consider WebP/HEIF or resolution-appropriate variants. Potential savings: UNKNOWN without re-encoding.';
  }
  if (entry.kind === 'font' && entry.bytes > 1024 * 1024) {
    return 'Large font file. Review unused weights/glyphs. Potential savings: UNKNOWN.';
  }
  if (entry.kind === 'video' && entry.bytes > 2 * 1024 * 1024) {
    return 'Large video asset. Confirm whether this should be bundled vs streamed. Potential savings: UNKNOWN.';
  }
  return undefined;
}

export function analyzeAssets(root: string): AssetAnalysis {
  const files = walkFiles(root, {
    extensions: new Set([...IMAGE_EXT, ...FONT_EXT, ...VIDEO_EXT]),
    maxFiles: 4000,
  }).filter((file) => {
    const relative = rel(root, file);
    if (isVendorRel(relative)) return false;
    return ASSET_ROOT_HINTS.some((hint) => relative.startsWith(hint) || relative.includes(`/${hint}/`));
  });

  const entries: AssetEntry[] = [];
  const hashes = new Map<string, string[]>();
  const fonts: FontEntry[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      continue;
    }
    const relative = rel(root, file);
    const entry: AssetEntry = {
      path: relative,
      bytes,
      kind: kindOf(ext),
      extension: ext,
      potentiallyUnused: false,
      usage: 'unknown',
      usedIn: [],
      usageConfidence: 'unknown',
      usageNote: 'Usage not scanned yet.',
      recommendation: undefined,
    };
    entries.push(entry);

    if (entry.kind === 'font') {
      fonts.push({
        path: relative,
        familyGuess: familyGuess(relative.split('/').pop() ?? relative),
        bytes,
        potentiallyUnused: false,
      });
    }

    if (bytes > 0 && bytes < 15 * 1024 * 1024) {
      try {
        const digest = hashFile(file);
        const list = hashes.get(digest) ?? [];
        list.push(relative);
        hashes.set(digest, list);
      } catch {
        // skip unreadable files
      }
    }
  }

  const duplicates: AssetAnalysis['duplicates'] = [];
  for (const [hash, paths] of hashes) {
    if (paths.length < 2) continue;
    const bytes = entries.find((e) => e.path === paths[0])?.bytes ?? 0;
    duplicates.push({ hash: hash.slice(0, 12), paths, bytes });
    for (const path of paths.slice(1)) {
      const dup = entries.find((e) => e.path === path);
      if (dup) dup.duplicateOf = paths[0];
    }
  }

  const sources = loadReferenceFiles(root);
  const usageByPath = detectUsage(entries, sources);
  for (const entry of entries) {
    const usage = usageByPath.get(entry.path);
    if (usage) {
      entry.usage = usage.usage;
      entry.usedIn = usage.usedIn;
      entry.usageConfidence = usage.confidence;
      entry.usageNote = usage.note;
      entry.potentiallyUnused = usage.usage === 'unused';
    }
    entry.recommendation = recommendationFor(entry);
    const font = fonts.find((item) => item.path === entry.path);
    if (font) font.potentiallyUnused = entry.potentiallyUnused;
  }

  const issues: Issue[] = [];
  const large = entries.filter((e) => e.bytes >= 1024 * 1024);
  for (const entry of large.slice(0, 8)) {
    issues.push(
      issue({
        severity: entry.bytes >= 3 * 1024 * 1024 ? 'warning' : 'info',
        title: `Large ${entry.kind} asset: ${entry.path.split('/').pop()}`,
        description: `${entry.path} is ${formatBytes(entry.bytes)}. This is a measured file size, not a guaranteed download/install impact.`,
        evidence: [entry.path, formatBytes(entry.bytes)],
        platform: entry.path.startsWith('android/')
          ? 'android'
          : entry.path.startsWith('ios/')
            ? 'ios'
            : 'shared',
        affected: entry.path,
        estimatedImpactBytes: entry.bytes,
        estimatedImpactLabel: 'Source file size (not store download size)',
        recommendation: entry.recommendation ?? 'Review whether this asset is needed at this resolution.',
        confidence: 'measured',
        category: 'assets',
        id: `asset-large-${entry.path}`,
      }),
    );
  }

  const unused = entries.filter((entry) => entry.usage === 'unused');
  const unusedBytes = unused.reduce((sum, entry) => sum + entry.bytes, 0);
  if (unused.length > 0) {
    issues.push(
      issue({
        severity: unusedBytes >= 1024 * 1024 ? 'warning' : 'info',
        title: `${unused.length} asset file(s) have no static reference`,
        description:
          'These files were not found in JS/TS/XML/native source as require, import, or resource names. Dynamic paths can still use them. Verify before deleting.',
        evidence: unused
          .slice()
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 12)
          .map((entry) => `${entry.path} (${formatBytes(entry.bytes)})`),
        estimatedImpactBytes: unusedBytes,
        estimatedImpactLabel: 'Source file size if deleted (not store download size)',
        recommendation:
          'Search the repo for the filename, then delete only files you confirm are unused.',
        confidence: 'medium',
        category: 'assets',
        id: 'assets-unused',
      }),
    );
  }

  if (duplicates.length > 0) {
    const extra = duplicates.reduce((s, d) => s + d.bytes * (d.paths.length - 1), 0);
    issues.push(
      issue({
        severity: 'info',
        title: `${duplicates.length} duplicate asset content group(s) detected`,
        description:
          'Identical file content was detected by SHA-256. Duplicate filenames in Android density buckets can be expected and are not necessarily waste.',
        evidence: duplicates.slice(0, 5).map((d) => d.paths.join(' | ')),
        estimatedImpactBytes: extra,
        estimatedImpactLabel: 'Duplicate source bytes (may not equal packaged size)',
        recommendation: 'Verify whether duplicates are intentional (density variants vs true copies).',
        confidence: 'high',
        category: 'assets',
        id: 'assets-duplicates',
      }),
    );
  }

  const totalBytes = entries.reduce((s, e) => s + e.bytes, 0);
  const largest = [...entries].sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes,
    unusedBytes,
    usedCount: entries.filter((entry) => entry.usage === 'used').length,
    unusedCount: unused.length,
    unknownCount: entries.filter((entry) => entry.usage === 'unknown').length,
    entries,
    largest,
    duplicates,
    fonts,
    issues,
  };
}
