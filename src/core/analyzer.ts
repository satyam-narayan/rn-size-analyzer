import { basename, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type {
  AnalyzeOptions,
  AndroidAnalysis,
  IosAnalysis,
  ProjectAnalysis,
  SizeAnalysis,
} from '../types';
import { loadConfig, isIgnored } from '../utils/config';
import { createProgress, type ProgressLogger } from '../utils/progress';
import { parseAndroidProject, analyzeAndroidArtifact } from './android';
import { parseIosProject, analyzeIosArtifact } from './ios';
import { analyzeDependencies, applyNativeAttribution } from './dependencies';
import { analyzeAssets } from './assets';
import { analyzeJsBundle } from './js-bundle';
import { analyzeUnusedJs } from './js-unused';
import { analyzePerformance } from './performance';
import { analyzeSecurity } from './security';
import { analyzeRelease } from './release';
import { compareArtifacts } from './comparison';
import { buildRecommendations } from './optimization';
import { computeHealth } from './health-score';
import { findBuildArtifacts, resolveExplicitArtifact } from './artifact-finder';
import { formatBytes } from '../utils/size';
import type { FoundArtifact } from './artifact-finder';
import { detectProject } from './project-detector';
import { resetIssueIds, sortIssues } from './issue';
import { TOOL_VERSION } from '../version';

function emptyAndroid(reason: string): AndroidAnalysis {
  return { detected: false, missingReason: reason, issues: [] };
}

function emptyIos(reason: string): IosAnalysis {
  return { detected: false, missingReason: reason, issues: [], pods: [] };
}

function sizeFromArtifact(bytes: number, compressed?: number, notes: string[] = []): SizeAnalysis {
  return {
    totalBytes: bytes,
    compressedBytes: compressed,
    breakdown: [],
    notes,
  };
}

function attachAndroidArtifact(
  android: AndroidAnalysis,
  artifactPath: string,
  dependencies: ReturnType<typeof analyzeDependencies>,
  jsBundle: ReturnType<typeof analyzeJsBundle>,
): AndroidAnalysis {
  const result = analyzeAndroidArtifact(artifactPath);
  const next: AndroidAnalysis = {
    ...android,
    detected: true,
    artifact: result.artifact,
    size: sizeFromArtifact(result.artifact.archiveBytes, result.artifact.archiveBytes, [
      result.artifact.estimatedDeviceSpecificNote,
    ]),
    issues: [...android.issues, ...result.issues],
  };
  next.artifact!.nativeLibraries = applyNativeAttribution(
    next.artifact!.nativeLibraries,
    dependencies.nodes,
  );
  if (next.artifact?.jsBundle) {
    jsBundle.found = true;
    jsBundle.path = next.artifact.jsBundle.path;
    jsBundle.bytes = next.artifact.jsBundle.bytes;
    jsBundle.hermesLikely = next.artifact.jsBundle.hermesLikely;
    jsBundle.issues = jsBundle.issues.filter((item) => item.id !== 'js-bundle-missing');
    jsBundle.notes = [
      `JS bundle measured from ${next.artifact.kind.toUpperCase()} entry ${next.artifact.jsBundle.path} (${formatBytes(next.artifact.jsBundle.bytes)} uncompressed).`,
    ];
  }
  return next;
}

function attachIosArtifact(
  ios: IosAnalysis,
  artifactPath: string,
  jsBundle: ReturnType<typeof analyzeJsBundle>,
): IosAnalysis {
  const result = analyzeIosArtifact(artifactPath);
  const next: IosAnalysis = {
    ...ios,
    detected: true,
    artifact: result.artifact,
    size: sizeFromArtifact(result.artifact.archiveBytes, result.artifact.archiveBytes, [
      result.artifact.thinningNote,
    ]),
    issues: [...ios.issues, ...result.issues],
  };
  if (next.artifact?.jsBundle) {
    jsBundle.found = true;
    jsBundle.path = next.artifact.jsBundle.path;
    jsBundle.bytes = next.artifact.jsBundle.bytes;
    jsBundle.hermesLikely = next.artifact.jsBundle.hermesLikely;
    jsBundle.issues = jsBundle.issues.filter((item) => item.id !== 'js-bundle-missing');
    jsBundle.notes = [
      `JS bundle measured from ${next.artifact.kind.toUpperCase()} entry ${next.artifact.jsBundle.path} (${formatBytes(next.artifact.jsBundle.bytes)} uncompressed).`,
    ];
  }
  return next;
}

export async function analyzeProject(options: AnalyzeOptions): Promise<ProjectAnalysis> {
  resetIssueIds();
  const cwd = resolve(options.cwd);
  const config = loadConfig(cwd, options.config);
  const progress: ProgressLogger = createProgress(options.silent);

  const platform = options.platform ?? 'all';
  const target = options.target ? resolve(cwd, options.target) : undefined;
  const explicit = target ? resolveExplicitArtifact(cwd, target) : undefined;
  const discovered = findBuildArtifacts(cwd, platform);

  const androidArtifact: FoundArtifact | undefined =
    explicit && (explicit.kind === 'apk' || explicit.kind === 'aab')
      ? explicit
      : platform === 'ios'
        ? undefined
        : discovered.android;
  const iosArtifact: FoundArtifact | undefined =
    explicit && (explicit.kind === 'ipa' || explicit.kind === 'app')
      ? explicit
      : platform === 'android'
        ? undefined
        : discovered.ios;

  progress.step('Detecting React Native project');
  const detected = detectProject(cwd);

  progress.step('Detecting Android project', detected.overview.androidDetected);
  progress.step('Detecting iOS project', detected.overview.iosDetected);
  if (androidArtifact) progress.step(`Found Android artifact ${basename(androidArtifact.path)}`);
  if (iosArtifact) progress.step(`Found iOS artifact ${basename(iosArtifact.path)}`);

  progress.step('Analyzing dependencies');
  const dependencies = analyzeDependencies(cwd, detected.packageJson);

  progress.step('Analyzing assets');
  const assets = analyzeAssets(cwd);

  progress.step('Analyzing JS bundle');
  const jsBundle = analyzeJsBundle(cwd);
  progress.step('Finding unused JS components and functions');
  const jsUnused = analyzeUnusedJs(cwd);

  let android =
    platform === 'ios'
      ? emptyAndroid('Skipped (ios command).')
      : detected.overview.androidDetected
        ? parseAndroidProject(cwd)
        : emptyAndroid('Android project not detected.');
  let ios =
    platform === 'android'
      ? emptyIos('Skipped (android command).')
      : detected.overview.iosDetected
        ? parseIosProject(cwd)
        : emptyIos('iOS project not detected.');

  if (androidArtifact) {
    progress.step(`Analyzing Android ${androidArtifact.kind.toUpperCase()}`);
    android = attachAndroidArtifact(android, androidArtifact.path, dependencies, jsBundle);
  } else if (platform !== 'ios') {
    progress.step(
      'Analyzing Android project',
      android.detected,
      android.detected ? 'no AAB/APK found, using project config' : android.missingReason,
    );
  }

  if (iosArtifact) {
    progress.step(`Analyzing iOS ${iosArtifact.kind.toUpperCase()}`);
    ios = attachIosArtifact(ios, iosArtifact.path, jsBundle);
  } else if (platform !== 'android') {
    progress.step(
      'Analyzing iOS project',
      ios.detected,
      ios.detected ? 'no IPA found, using project config' : ios.missingReason,
    );
  }

  progress.step('Running performance static checks');
  const performance = analyzePerformance(cwd);
  progress.step('Running security static checks');
  const security = analyzeSecurity(cwd);
  progress.step('Building release checklist');
  const release = analyzeRelease({
    android,
    ios,
    security,
    hermesEnabled: detected.overview.hermesEnabled,
    platform,
  });

  const { recommendations, extraIssues } = buildRecommendations({
    nativeModules: dependencies.nativeModules,
    issues: [...android.issues, ...ios.issues, ...dependencies.issues],
  });

  const allIssues = sortIssues(
    [
      ...android.issues,
      ...ios.issues,
      ...dependencies.issues,
      ...assets.issues,
      ...jsBundle.issues,
      ...jsUnused.issues,
      ...performance.issues,
      ...security.issues,
      ...release.issues,
      ...extraIssues,
    ].filter((issue) => !isIgnored(config, issue.id)),
  );

  if (!detected.isReactNative && !androidArtifact && !iosArtifact) {
    allIssues.unshift({
      id: 'project-not-rn',
      severity: 'warning',
      title: 'Directory does not look like a typical React Native project',
      description: detected.invalidReason ?? 'React Native markers were weak or missing.',
      evidence: [`cwd=${cwd}`],
      platform: 'shared',
      recommendation: 'Run the CLI from the React Native app root with analyze, analyze android, or analyze ios.',
      confidence: 'medium',
      category: 'build',
    });
  }

  const overview = {
    ...detected.overview,
    hermesEnabled:
      detected.overview.hermesEnabled ??
      android.build?.hermesEnabled ??
      ios.build?.hermesEnabled,
    newArchEnabled:
      detected.overview.newArchEnabled ??
      android.build?.newArchEnabled ??
      ios.build?.newArchEnabled,
  };

  if (android.artifact) {
    android.size = {
      totalBytes: android.artifact.archiveBytes,
      compressedBytes: android.artifact.archiveBytes,
      breakdown: [
        { label: `${android.artifact.kind.toUpperCase()} on-disk`, bytes: android.artifact.archiveBytes },
        ...android.artifact.packed.map((row) => ({
          label: `${row.label} (packed)`,
          bytes: row.compressedBytes,
          compressedBytes: row.compressedBytes,
          note: `uncompressed ${row.uncompressedBytes}`,
        })),
      ],
      notes: [android.artifact.estimatedDeviceSpecificNote],
    };
  }

  if (ios.artifact) {
    ios.size = {
      totalBytes: ios.artifact.archiveBytes,
      compressedBytes: ios.artifact.archiveBytes,
      breakdown: [
        { label: ios.artifact.kind.toUpperCase(), bytes: ios.artifact.archiveBytes },
        { label: 'App binary', bytes: ios.artifact.appBinaryBytes ?? 0 },
        {
          label: 'Frameworks (uncompressed)',
          bytes: ios.artifact.frameworks.reduce((s, f) => s + f.bytes, 0),
        },
        { label: 'JS bundle', bytes: ios.artifact.jsBundle?.bytes ?? 0 },
        { label: 'Assets (listed)', bytes: ios.artifact.assets.reduce((s, a) => s + a.bytes, 0) },
      ],
      notes: [ios.artifact.thinningNote],
    };
  }

  progress.step('Generating report');

  return {
    overview,
    analyzedPlatform: platform,
    health: computeHealth(allIssues),
    issues: allIssues,
    recommendations,
    android,
    ios,
    dependencies,
    assets,
    jsBundle,
    jsUnused,
    performance,
    security,
    release,
    generatedAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
  };
}

export async function analyzeAndroidOnly(options: AnalyzeOptions): Promise<ProjectAnalysis> {
  return analyzeProject({ ...options, platform: 'android' });
}

export async function analyzeIosOnly(options: AnalyzeOptions): Promise<ProjectAnalysis> {
  return analyzeProject({ ...options, platform: 'ios' });
}

export { compareArtifacts };

export function artifactFileSize(filePath: string): number {
  return statSync(filePath).size;
}
