import type { Issue, ProjectAnalysis, Severity } from '../types';
import { formatBytes, formatBytesExact, formatPercent } from '../utils/size';

const ICONS: Record<Severity, string> = {
  critical: '🔴',
  warning: '⚠',
  info: 'ℹ',
  passed: '✓',
};

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function section(title: string): void {
  line();
  line(title);
  line('─'.repeat(Math.min(40, title.length)));
}

export function printTerminal(analysis: ProjectAnalysis): void {
  const { overview, health, issues, android, ios, release } = analysis;
  line(`${overview.name}  ·  RN ${overview.reactNativeVersion ?? 'unknown'}  ·  ${overview.kind}`);
  line(
    `Android: ${overview.androidDetected ? 'yes' : 'no'}  ·  iOS: ${overview.iosDetected ? 'yes' : 'no'}  ·  Hermes: ${
      overview.hermesEnabled === undefined ? 'unknown' : overview.hermesEnabled
    }  ·  New Arch: ${overview.newArchEnabled === undefined ? 'unknown' : overview.newArchEnabled}`,
  );
  line(
    `Health ${health.overall}/100   size ${health.size}  deps ${health.dependencies}  assets ${health.assets}  perf ${health.performance}  security ${health.security}  build ${health.build}  release ${health.release}`,
  );

  if (android.artifact) {
    section('Android artifact');
    line(`File: ${android.artifact.filePath}`);
    line(`${android.artifact.kind.toUpperCase()} on-disk size: ${formatBytesExact(android.artifact.archiveBytes)}  ← matches Finder`);
    line(`Uncompressed zip contents: ${formatBytesExact(android.artifact.uncompressedBytes)}  ← not the file size`);
    line(`Play Store download size: unknown (this tool does not query Play Console)`);
    if (android.artifact.deviceEstimate) {
      const est = android.artifact.deviceEstimate;
      line(
        `ABI zip heuristic (NOT Play Store): ${formatBytesExact(est.includedCompressedBytes)} = shared ${formatBytes(est.sharedCompressedBytes)} + ${est.preferredAbi} native ${formatBytes(est.nativePreferredCompressedBytes)}`,
      );
      line(
        `This heuristic keeps all languages/densities and uses zip compression, so it is often much larger than Play Console (e.g. 41 MB).`,
      );
    }
    line('');
    line('Inside the file (compressed / uncompressed):');
    for (const row of android.artifact.packed) {
      line(`  ${row.label}: ${formatBytes(row.compressedBytes)} packed · ${formatBytes(row.uncompressedBytes)} uncompressed`);
    }
    line('');
    line('Native by ABI (packed / uncompressed):');
    for (const row of android.artifact.nativeByAbi) {
      line(`  ${row.abi}: ${formatBytes(row.compressedBytes)} packed · ${formatBytes(row.uncompressedBytes)} uncompressed (${row.libraryCount} libs)`);
    }
    line(`ABIs in this AAB/APK: ${android.artifact.abis.join(', ') || 'none'}`);
  } else if (android.detected) {
    section('Android project');
    line(
      `compileSdk=${android.sdk?.compileSdk ?? '?'} targetSdk=${android.sdk?.targetSdk ?? '?'} minSdk=${android.sdk?.minSdk ?? '?'}`,
    );
    line(`Hermes=${android.build?.hermesEnabled ?? 'unknown'} minify=${android.build?.minifyEnabled ?? 'unknown'}`);
  }

  if (ios.artifact) {
    section('iOS artifact');
    line(`File: ${ios.artifact.filePath}`);
    line(`${ios.artifact.kind.toUpperCase()} on-disk size: ${formatBytesExact(ios.artifact.archiveBytes)}`);
    line(`App binary: ${ios.artifact.appBinaryBytes ? formatBytes(ios.artifact.appBinaryBytes) : 'not identified'}`);
    line(`Frameworks: ${formatBytes(ios.artifact.frameworks.reduce((s, f) => s + f.bytes, 0))}`);
    line(`JS: ${ios.artifact.jsBundle ? formatBytes(ios.artifact.jsBundle.bytes) : 'not found'}`);
    line(ios.artifact.thinningNote);
  } else if (ios.detected) {
    section('iOS project');
    line(`deploymentTarget=${ios.build?.deploymentTarget ?? '?'} Hermes=${ios.build?.hermesEnabled ?? 'unknown'}`);
    line(`Pods parsed: ${ios.pods.length}`);
  }

  section(`Top issues (${issues.length})`);
  const top = issues.filter((i) => i.severity !== 'passed').slice(0, 12);
  if (top.length === 0) {
    line('No issues reported.');
  } else {
    for (const item of top) {
      printIssue(item);
    }
  }

  section(`Release: ${release.overall}`);
  if (analysis.comparison) {
    section('Comparison');
    const c = analysis.comparison.total;
    line(
      `${formatBytes(c.beforeBytes)} → ${formatBytes(c.afterBytes)}  (${formatBytes(c.deltaBytes)}, ${formatPercent(c.percentChange)})`,
    );
  }
}

function printIssue(item: Issue): void {
  line();
  line(`${ICONS[item.severity]} ${item.title}`);
  line(`  ${item.description}`);
  if (item.affected) line(`  Affected: ${item.affected}`);
  if (item.estimatedImpactLabel) line(`  Impact: ${item.estimatedImpactLabel}`);
  line(`  Recommendation: ${item.recommendation}`);
  line(`  Confidence: ${item.confidence}`);
}

export function printCheckFailure(message: string): void {
  process.stdout.write(`❌ BUILD FAILED\n${message}\n`);
}

export function printCheckPass(message: string): void {
  process.stdout.write(`✓ CHECK PASSED\n${message}\n`);
}
