import { basename } from 'node:path';
import { statSync } from 'node:fs';
import type { ComparisonAnalysis, ComparisonDelta } from '../../types';
import { listZipEntries, type ZipEntry } from '../../utils/zip';
import { percentChange, formatBytes } from '../../utils/size';
import { artifactKind } from '../project-detector';
import { issue } from '../issue';
import { isDirectory } from '../../utils/fs';
import { analyzeIosArtifact } from '../ios/artifacts';

function entryMap(entries: ZipEntry[]): Map<string, ZipEntry> {
  const map = new Map<string, ZipEntry>();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    map.set(entry.name.replace(/\\/g, '/'), entry);
  }
  return map;
}

function delta(label: string, before: number, after: number): ComparisonDelta {
  return {
    label,
    beforeBytes: before,
    afterBytes: after,
    deltaBytes: after - before,
    percentChange: percentChange(before, after),
  };
}

function categoryOf(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (/\.so$/i.test(p) || /\/lib\/(arm64-v8a|armeabi-v7a|x86|x86_64)\//.test(p)) return 'native';
  if (/\.framework\//.test(p) || /\.xcframework\//.test(p)) return 'frameworks';
  if (/(index\.android\.bundle|index\.bundle|main\.jsbundle|\.hbc)$/i.test(p)) return 'js-bundle';
  if (/\.(ttf|otf|ttc|woff2?)$/i.test(p)) return 'fonts';
  if (/\.(png|jpg|jpeg|webp|gif|mp4|svg)$/i.test(p)) return 'assets';
  if (/\/(res|assets|base\/res|base\/assets)\//.test(p)) return 'resources';
  return 'other';
}

export function compareArtifacts(oldPath: string, newPath: string): ComparisonAnalysis {
  const oldKind = artifactKind(oldPath) ?? (isDirectory(oldPath) ? 'app' : undefined);
  const newKind = artifactKind(newPath) ?? (isDirectory(newPath) ? 'app' : undefined);
  if (!oldKind || !newKind) {
    throw new Error(
      `compare requires .apk, .aab, .ipa, or .app artifacts. Received: ${basename(oldPath)}, ${basename(newPath)}`,
    );
  }
  if (oldKind !== newKind && !(oldKind === 'apk' && newKind === 'aab') && !(oldKind === 'aab' && newKind === 'apk')) {
    if (!((oldKind === 'ipa' || oldKind === 'app') && (newKind === 'ipa' || newKind === 'app'))) {
      throw new Error(`Cannot compare ${oldKind} with ${newKind}. Use two Android or two iOS artifacts.`);
    }
  }

  const platform =
    oldKind === 'apk' || oldKind === 'aab' || newKind === 'apk' || newKind === 'aab'
      ? 'android'
      : 'ios';

  let oldEntries: Map<string, { bytes: number }>;
  let newEntries: Map<string, { bytes: number }>;
  let oldTotal: number;
  let newTotal: number;

  if (platform === 'ios' && (isDirectory(oldPath) || isDirectory(newPath))) {
    const oldArt = analyzeIosArtifact(oldPath).artifact;
    const newArt = analyzeIosArtifact(newPath).artifact;
    oldTotal = oldArt.archiveBytes;
    newTotal = newArt.archiveBytes;
    oldEntries = new Map(oldArt.assets.map((a) => [a.label, { bytes: a.bytes }]));
    newEntries = new Map(newArt.assets.map((a) => [a.label, { bytes: a.bytes }]));
    for (const fw of oldArt.frameworks) oldEntries.set(fw.path, { bytes: fw.bytes });
    for (const fw of newArt.frameworks) newEntries.set(fw.path, { bytes: fw.bytes });
  } else {
    const oldZip = entryMap(listZipEntries(oldPath));
    const newZip = entryMap(listZipEntries(newPath));
    oldEntries = new Map([...oldZip].map(([k, v]) => [k, { bytes: v.uncompressedSize }]));
    newEntries = new Map([...newZip].map(([k, v]) => [k, { bytes: v.uncompressedSize }]));
    oldTotal = statSync(oldPath).size;
    newTotal = statSync(newPath).size;
  }

  const names = new Set([...oldEntries.keys(), ...newEntries.keys()]);
  const changed: ComparisonAnalysis['largestChangedFiles'] = [];
  const buckets = new Map<string, { before: number; after: number }>();

  for (const name of names) {
    const before = oldEntries.get(name)?.bytes ?? 0;
    const after = newEntries.get(name)?.bytes ?? 0;
    const cat = categoryOf(name);
    const bucket = buckets.get(cat) ?? { before: 0, after: 0 };
    bucket.before += before;
    bucket.after += after;
    buckets.set(cat, bucket);
    if (before !== after) {
      changed.push({ path: name, beforeBytes: before, afterBytes: after, deltaBytes: after - before });
    }
  }

  changed.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));

  const breakdown = [...buckets.entries()]
    .map(([label, v]) => delta(label, v.before, v.after))
    .sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));

  const likelyCauses: ComparisonAnalysis['likelyCauses'] = [];
  for (const file of changed.slice(0, 8)) {
    if (Math.abs(file.deltaBytes) < 50_000) continue;
    likelyCauses.push({
      title: `${file.path} changed by ${formatBytes(file.deltaBytes)}`,
      evidence: [`before=${formatBytes(file.beforeBytes)}`, `after=${formatBytes(file.afterBytes)}`],
      confidence: 'measured',
    });
  }

  const native = breakdown.find((b) => b.label === 'native' || b.label === 'frameworks');
  if (native && native.deltaBytes > 500_000) {
    likelyCauses.unshift({
      title: `Likely cause: ${native.label} grew by ${formatBytes(native.deltaBytes)}`,
      evidence: [`${native.label} before=${formatBytes(native.beforeBytes)} after=${formatBytes(native.afterBytes)}`],
      confidence: 'high',
    });
  }

  const total = delta('archive', oldTotal, newTotal);
  const issues = [];
  if (total.deltaBytes > 0) {
    issues.push(
      issue({
        severity: total.deltaBytes > 2 * 1024 * 1024 ? 'warning' : 'info',
        title: `App archive increased by ${formatBytes(total.deltaBytes)}`,
        description:
          'Archive file size change is measured. This is not Play Store / App Store download size unless those artifacts are device-specific APKs.',
        evidence: [
          `${oldPath} = ${formatBytes(oldTotal)}`,
          `${newPath} = ${formatBytes(newTotal)}`,
          `${total.percentChange.toFixed(1)}%`,
        ],
        platform,
        estimatedImpactBytes: total.deltaBytes,
        estimatedImpactLabel: 'Archive size delta',
        recommendation: 'Inspect the largest changed native libraries, frameworks, assets, and JS bundle.',
        confidence: 'measured',
        category: 'comparison',
        id: 'compare-increase',
      }),
    );
  }

  return {
    oldPath,
    newPath,
    platform,
    total,
    breakdown,
    largestChangedFiles: changed.slice(0, 40),
    likelyCauses: likelyCauses.slice(0, 10),
    issues,
  };
}
