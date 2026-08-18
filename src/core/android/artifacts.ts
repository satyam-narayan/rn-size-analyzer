import { basename } from 'node:path';
import { statSync } from 'node:fs';
import type {
  AbiBreakdown,
  AndroidArtifactAnalysis,
  DeviceEstimate,
  NativeLibrary,
  PackedCategory,
  SizeBreakdown,
} from '../../types';
import { listZipEntries, sumEntries, type ZipEntry } from '../../utils/zip';
import { formatBytes } from '../../utils/size';
import { issue } from '../issue';
import type { Issue } from '../../types';

const ABI_NAMES = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64', 'armeabi'];

function isDir(name: string): boolean {
  return name.endsWith('/');
}

function abiFromPath(name: string): string | undefined {
  return ABI_NAMES.find((abi) => name.includes(`/lib/${abi}/`));
}

function isJsBundle(name: string): boolean {
  return (
    /(?:^|\/)(index\.android\.bundle|index\.bundle|main\.jsbundle|hermes.*\.hbc)$/i.test(name) ||
    /(?:^|\/)assets\/index\.android\.bundle$/i.test(name)
  );
}

function isNativeLib(name: string): boolean {
  return /(?:^|\/)lib\/[^/]+\/[^/]+\.so$/.test(name) || /(?:^|\/)base\/lib\/[^/]+\/[^/]+\.so$/.test(name);
}

function packedLabel(name: string): string {
  if (isNativeLib(name)) {
    const abi = abiFromPath(name);
    return abi ? `Native ${abi}` : 'Native other';
  }
  if (isJsBundle(name)) return 'JS bundle';
  if (/\.dex$/i.test(name)) return 'DEX (Java/Kotlin bytecode)';
  if (/(?:^|\/)(res|base\/res|resources\.arsc)\b/i.test(name)) return 'Resources';
  if (/(?:^|\/)(assets|base\/assets)\//i.test(name)) return 'Assets';
  return 'Other (manifest, protobuf, metadata, zip overhead)';
}

function categorize(entries: ZipEntry[]): {
  native: NativeLibrary[];
  jsBundle?: { path: string; bytes: number; compressedBytes: number; hermesLikely: boolean };
  assets: SizeBreakdown[];
  resources: SizeBreakdown[];
  dex: SizeBreakdown[];
  abis: string[];
  packed: PackedCategory[];
  nativeByAbi: AbiBreakdown[];
} {
  const native: NativeLibrary[] = [];
  const abis = new Set<string>();
  const assets: SizeBreakdown[] = [];
  const resources: SizeBreakdown[] = [];
  const dex: SizeBreakdown[] = [];
  const packedMap = new Map<string, PackedCategory>();
  const abiMap = new Map<string, AbiBreakdown>();
  let jsBundle: { path: string; bytes: number; compressedBytes: number; hermesLikely: boolean } | undefined;

  const addPacked = (label: string, compressed: number, uncompressed: number) => {
    const current = packedMap.get(label) ?? { label, compressedBytes: 0, uncompressedBytes: 0 };
    current.compressedBytes += compressed;
    current.uncompressedBytes += uncompressed;
    packedMap.set(label, current);
  };

  for (const entry of entries) {
    if (isDir(entry.name)) continue;
    const name = entry.name.replace(/\\/g, '/');
    addPacked(packedLabel(name), entry.compressedSize, entry.uncompressedSize);

    const soMatch = name.match(/(?:^|\/)lib\/([^/]+)\/([^/]+\.so)$/);
    const aabSoMatch = name.match(/(?:^|\/)base\/lib\/([^/]+)\/([^/]+\.so)$/);
    const match = soMatch ?? aabSoMatch;
    if (match) {
      const abi = match[1];
      abis.add(abi);
      native.push({
        name: match[2],
        path: name,
        abi,
        uncompressedBytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
        attributionConfidence: 'unknown',
        attributionNote: 'Not yet attributed to an npm package.',
      });
      const abiRow = abiMap.get(abi) ?? {
        abi,
        compressedBytes: 0,
        uncompressedBytes: 0,
        libraryCount: 0,
      };
      abiRow.compressedBytes += entry.compressedSize;
      abiRow.uncompressedBytes += entry.uncompressedSize;
      abiRow.libraryCount += 1;
      abiMap.set(abi, abiRow);
      continue;
    }

    if (isJsBundle(name)) {
      jsBundle = {
        path: name,
        bytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
        hermesLikely: /\.hbc$/i.test(name) || name.includes('hermes'),
      };
    }

    if (/(?:^|\/)(assets|base\/assets)\//i.test(name) && !isJsBundle(name)) {
      assets.push({
        label: name,
        bytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
      });
    }

    if (/(?:^|\/)(res|base\/res|resources\.arsc)\b/i.test(name)) {
      resources.push({
        label: name,
        bytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
      });
    }

    if (/\.dex$/i.test(name)) {
      dex.push({
        label: name,
        bytes: entry.uncompressedSize,
        compressedBytes: entry.compressedSize,
      });
    }
  }

  const packed = [...packedMap.values()].sort((a, b) => b.compressedBytes - a.compressedBytes);
  const nativeByAbi = [...abiMap.values()].sort((a, b) => b.compressedBytes - a.compressedBytes);
  return { native, jsBundle, assets, resources, dex, abis: [...abis], packed, nativeByAbi };
}

function estimateDeviceSpecific(
  kind: 'apk' | 'aab',
  entries: ZipEntry[],
  abis: string[],
): { estimate?: DeviceEstimate; note: string } {
  const preferredAbi =
    (abis.includes('arm64-v8a') && 'arm64-v8a') ||
    (abis.includes('armeabi-v7a') && 'armeabi-v7a') ||
    abis[0];

  if (!preferredAbi) {
    return {
      note:
        kind === 'aab'
          ? 'This tool does not know Play Store download size. No native ABIs were found to even run the ABI zip heuristic.'
          : 'This tool does not know Play Store download size. No native ABIs were found.',
    };
  }

  const otherAbis = ABI_NAMES.filter((abi) => abi !== preferredAbi);
  const shared = sumEntries(entries, (entry) => {
    const name = entry.name.replace(/\\/g, '/');
    if (isDir(name)) return false;
    return !abiFromPath(name);
  });
  const preferredNative = sumEntries(entries, (entry) => {
    const name = entry.name.replace(/\\/g, '/');
    if (isDir(name)) return false;
    return abiFromPath(name) === preferredAbi;
  });
  const otherNative = sumEntries(entries, (entry) => {
    const name = entry.name.replace(/\\/g, '/');
    if (isDir(name)) return false;
    const abi = abiFromPath(name);
    return Boolean(abi && otherAbis.includes(abi));
  });

  const estimate: DeviceEstimate = {
    method: 'abi-zip-heuristic',
    preferredAbi,
    includedCompressedBytes: shared.compressed + preferredNative.compressed,
    excludedOtherAbiCompressedBytes: otherNative.compressed,
    sharedCompressedBytes: shared.compressed,
    nativePreferredCompressedBytes: preferredNative.compressed,
    limitations: [
      'This is not Play Console / Play Store download size.',
      `Math used: compressed zip entries that are not ABI-specific (${formatBytes(shared.compressed)}) + compressed ${preferredAbi} .so files (${formatBytes(preferredNative.compressed)}).`,
      `Other ABIs were excluded from this heuristic (${formatBytes(otherNative.compressed)} compressed).`,
      'Play Store still splits languages, screen densities, texture formats, and feature modules. This heuristic keeps all of those.',
      'Play also uses its own delivery compression. Zip compressed size is not Play download size.',
      'If Play Console shows ~41 MB, that number is authoritative. This heuristic will usually be larger.',
    ],
  };

  return {
    estimate,
    note: estimate.limitations.join(' '),
  };
}

export function analyzeAndroidArtifact(filePath: string): {
  artifact: AndroidArtifactAnalysis;
  issues: Issue[];
} {
  const kind = filePath.toLowerCase().endsWith('.aab') ? 'aab' : 'apk';
  const archiveBytes = statSync(filePath).size;
  const entries = listZipEntries(filePath);
  const categorized = categorize(entries);
  const uncompressedBytes = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  const estimate = estimateDeviceSpecific(kind, entries, categorized.abis);

  const artifact: AndroidArtifactAnalysis = {
    kind,
    filePath,
    archiveBytes,
    uncompressedBytes,
    estimatedDeviceSpecificBytes: estimate.estimate?.includedCompressedBytes,
    estimatedDeviceSpecificNote: estimate.note,
    deviceEstimate: estimate.estimate,
    nativeLibraries: categorized.native,
    nativeByAbi: categorized.nativeByAbi,
    packed: categorized.packed,
    jsBundle: categorized.jsBundle,
    assets: categorized.assets.sort((a, b) => b.bytes - a.bytes).slice(0, 50),
    resources: categorized.resources.sort((a, b) => b.bytes - a.bytes).slice(0, 50),
    dex: categorized.dex,
    abis: categorized.abis,
  };

  const issues: Issue[] = [];
  const nativeTotalCompressed = categorized.native.reduce(
    (s, n) => s + (n.compressedBytes ?? n.uncompressedBytes ?? 0),
    0,
  );
  if (nativeTotalCompressed > 20 * 1024 * 1024) {
    issues.push(
      issue({
        severity: 'warning',
        title: `Native libraries are large (${basename(filePath)})`,
        description:
          'Native .so files occupy a substantial portion of this AAB based on zip entry sizes (not Play Store delivery).',
        evidence: [
          `Total zip-entry size of native .so files: ${formatBytes(nativeTotalCompressed)}`,
          `ABIs: ${categorized.abis.join(', ') || 'none'}`,
        ],
        platform: 'android',
        affected: filePath,
        estimatedImpactBytes: nativeTotalCompressed,
        estimatedImpactLabel: 'Native .so zip-entry total (not Play download size)',
        recommendation:
          'Review ABI configuration, unused native modules, and whether all codecs/engines in native dependencies are required.',
        confidence: 'measured',
        category: 'size',
        id: 'android-native-large',
      }),
    );
  }

  if (kind === 'aab') {
    issues.push(
      issue({
        severity: 'info',
        title: 'AAB size is not the Play Store download size',
        description:
          'An Android App Bundle contains multiple splits. Google Play generates device-specific APKs. This tool does not query Play Console and cannot report the store download size.',
        evidence: [`AAB archive size (on disk): ${formatBytes(archiveBytes)}`],
        platform: 'android',
        affected: filePath,
        recommendation:
          'Use Play Console / bundletool get-size to measure delivery size for specific devices when you need authoritative numbers.',
        confidence: 'high',
        category: 'size',
        id: 'android-aab-not-download',
      }),
    );
  }

  if (categorized.abis.includes('x86') || categorized.abis.includes('x86_64')) {
    const x86 = categorized.native
      .filter((n) => n.abi === 'x86' || n.abi === 'x86_64')
      .reduce((s, n) => s + (n.compressedBytes ?? n.uncompressedBytes ?? 0), 0);
    issues.push(
      issue({
        severity: 'info',
        title: 'Archive includes x86/x86_64 native libraries',
        description:
          'x86 native libraries increase archive size. Play App Bundles typically do not deliver them to ARM devices.',
        evidence: [`x86/x86_64 zip-entry total: ${formatBytes(x86)}`],
        platform: 'android',
        affected: filePath,
        estimatedImpactBytes: x86,
        estimatedImpactLabel: 'x86/x86_64 native .so zip-entry total in this archive',
        recommendation: 'If shipping an AAB, Play will split ABIs. For fat APKs, review whether x86 is required.',
        confidence: 'measured',
        category: 'size',
        id: 'android-artifact-x86',
      }),
    );
  }

  return { artifact, issues };
}
