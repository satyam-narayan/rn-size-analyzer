import { basename } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameworkEntry, IosArtifactAnalysis, Issue } from '../../types';
import { isDirectory, isFile } from '../../utils/fs';
import { listZipEntries } from '../../utils/zip';
import { formatBytes } from '../../utils/size';
import { issue } from '../issue';

function walkApp(appPath: string, prefix = ''): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(appPath);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(appPath, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (isDirectory(full)) {
      out.push(...walkApp(full, rel));
    } else if (isFile(full)) {
      out.push({ path: rel, bytes: statSync(full).size });
    }
  }
  return out;
}

function hermesLikely(path: string): boolean {
  return /hermes/i.test(path) || /\.hbc$/i.test(path) || /main\.jsbundle$/i.test(path);
}

function toArtifactFromFiles(
  kind: 'ipa' | 'app',
  filePath: string,
  archiveBytes: number,
  files: Array<{ path: string; bytes: number }>,
): IosArtifactAnalysis {
  const frameworks: FrameworkEntry[] = [];
  const assets: IosArtifactAnalysis['assets'] = [];
  let jsBundle: IosArtifactAnalysis['jsBundle'];
  let appBinaryBytes: number | undefined;
  let appBinaryName: string | undefined;

  for (const file of files) {
    const path = file.path.replace(/\\/g, '/');
    if (/\.framework\//.test(path) || /\.xcframework\//.test(path)) {
      const fw = path.match(/([^/]+\.(?:framework|xcframework))/);
      if (fw) {
        const existing = frameworks.find((f) => f.name === fw[1]);
        if (existing) existing.bytes += file.bytes;
        else {
          frameworks.push({
            name: fw[1],
            path: path.slice(0, path.indexOf(fw[1]) + fw[1].length),
            bytes: file.bytes,
            attributionConfidence: 'unknown',
            attributionNote: 'Not yet attributed to an npm package.',
          });
        }
      }
    }

    if (/(main\.jsbundle|index\.ios\.bundle|index\.bundle|\.hbc)$/i.test(path)) {
      jsBundle = { path, bytes: file.bytes, hermesLikely: hermesLikely(path) };
    }

    if (/\.(png|jpg|jpeg|gif|webp|heic|pdf|mp4|ttf|otf|ttc)$/i.test(path)) {
      assets.push({ label: path, bytes: file.bytes });
    }

    const payloadApp = path.match(/^Payload\/([^/]+)\.app\/([^/]+)$/);
    if (payloadApp && payloadApp[1] === payloadApp[2]) {
      appBinaryBytes = file.bytes;
      appBinaryName = payloadApp[2];
    }
  }

  return {
    kind,
    filePath,
    archiveBytes,
    uncompressedBytes: files.reduce((s, f) => s + f.bytes, 0),
    appBinaryBytes,
    appBinaryName,
    frameworks: frameworks.sort((a, b) => b.bytes - a.bytes),
    jsBundle,
    assets: assets.sort((a, b) => b.bytes - a.bytes).slice(0, 50),
    thinningNote:
      'IPA/archive size is not the App Store download size. App Store thinning delivers device-specific slices. This tool does not query App Store Connect.',
  };
}

export function analyzeIosArtifact(filePath: string): {
  artifact: IosArtifactAnalysis;
  issues: Issue[];
} {
  const kind = filePath.toLowerCase().endsWith('.ipa') ? 'ipa' : 'app';
  let files: Array<{ path: string; bytes: number }>;
  let archiveBytes: number;

  if (kind === 'app' && isDirectory(filePath)) {
    archiveBytes = walkApp(filePath).reduce((s, f) => s + f.bytes, 0);
    files = walkApp(filePath);
  } else {
    archiveBytes = statSync(filePath).size;
    files = listZipEntries(filePath).map((e) => ({
      path: e.name,
      bytes: e.uncompressedSize,
    }));
  }

  const artifact = toArtifactFromFiles(kind, filePath, archiveBytes, files);
  const issues: Issue[] = [
    issue({
      severity: 'info',
      title: 'IPA/app size is not the App Store download size',
      description: artifact.thinningNote,
      evidence: [`Archive size: ${formatBytes(archiveBytes)}`],
      platform: 'ios',
      affected: filePath,
      recommendation:
        'Use App Store Connect file sizes / TestFlight for authoritative thinned download numbers.',
      confidence: 'high',
      category: 'size',
      id: 'ios-ipa-not-download',
    }),
  ];

  const fwTotal = artifact.frameworks.reduce((s, f) => s + f.bytes, 0);
  if (fwTotal > 15 * 1024 * 1024) {
    issues.push(
      issue({
        severity: 'warning',
        title: `Embedded frameworks are large (${basename(filePath)})`,
        description:
          'Framework/XCFramework payloads measured from archive entries. This is not an App Store thinned size.',
        evidence: [`Framework uncompressed total: ${formatBytes(fwTotal)}`],
        platform: 'ios',
        affected: filePath,
        estimatedImpactBytes: fwTotal,
        estimatedImpactLabel: 'Uncompressed frameworks in this archive',
        recommendation: 'Review unused pods/frameworks and whether bitcode/arch slices are expected.',
        confidence: 'measured',
        category: 'size',
        id: 'ios-frameworks-large',
      }),
    );
  }

  return { artifact, issues };
}
