import { join } from 'node:path';
import type { IosAnalysis, IosBuildConfig, Issue, PodSummary } from '../../types';
import { isDirectory, isFile, readTextIfExists } from '../../utils/fs';
import { issue } from '../issue';
import { readdirSync } from 'node:fs';

function findXcode(root: string): string | undefined {
  const ios = join(root, 'ios');
  if (!isDirectory(ios)) return undefined;
  const entries = readdirSync(ios);
  const workspace = entries.find((e) => e.endsWith('.xcworkspace'));
  if (workspace) return `ios/${workspace}`;
  const project = entries.find((e) => e.endsWith('.xcodeproj'));
  if (project) return `ios/${project}`;
  return undefined;
}

function parsePlistDeploymentTarget(pbx: string | undefined): string | undefined {
  if (!pbx) return undefined;
  return pbx.match(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([0-9.]+)/)?.[1];
}

function parsePodfilePlatform(podfile: string | undefined): string | undefined {
  if (!podfile) return undefined;
  return podfile.match(/platform\s+:ios,\s*['"]([0-9.]+)['"]/)?.[1];
}

function parseBundleIdentifier(pbx: string | undefined): string | undefined {
  if (!pbx) return undefined;
  const values = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)]
    .map((match) => match[1].replace(/["']/g, '').trim())
    .filter((value) => value && !value.includes('$'));
  return values[0];
}

function parseArchitectures(pbx: string | undefined): string[] {
  if (!pbx) return [];
  const match = pbx.match(/ARCHS\s*=\s*([^;]+);/);
  if (!match) {
    const extras = [...pbx.matchAll(/VALID_ARCHS\s*=\s*([^;]+);/g)].flatMap((m) =>
      m[1].replace(/"/g, '').trim().split(/\s+/),
    );
    return [...new Set(extras.filter(Boolean))];
  }
  return match[1]
    .replace(/"/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function parsePodfileLock(text: string): PodSummary[] {
  const pods: PodSummary[] = [];
  const podsSection = text.split(/^DEPENDENCIES:/m)[0] ?? text;
  for (const line of podsSection.split('\n')) {
    const match = line.match(/^\s{2}-\s+([^:(]+)\s*(?:\(([^)]+)\))?/);
    if (!match) continue;
    const name = match[1].trim();
    if (!name) continue;
    pods.push({ name, version: match[2]?.trim() });
  }
  return uniquePods(pods);
}

function uniquePods(pods: PodSummary[]): PodSummary[] {
  const seen = new Set<string>();
  const out: PodSummary[] = [];
  for (const pod of pods) {
    const key = `${pod.name}@${pod.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pod);
  }
  return out;
}

export function parseIosProject(root: string): IosAnalysis {
  const podfile = readTextIfExists(join(root, 'ios', 'Podfile'));
  const lock = readTextIfExists(join(root, 'ios', 'Podfile.lock'));
  const workspace = findXcode(root);
  const pbxCandidates = workspace
    ? [
        join(root, workspace.replace('.xcworkspace', '.xcodeproj'), 'project.pbxproj'),
        join(root, workspace, 'project.pbxproj'),
      ]
    : [];
  let pbx: string | undefined;
  for (const candidate of [
    ...pbxCandidates,
    join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'),
  ]) {
    pbx = readTextIfExists(candidate);
    if (pbx) break;
  }

  if (workspace) {
    const projName = workspace.replace(/^ios\//, '').replace(/\.xcworkspace|\.xcodeproj/, '');
    pbx =
      pbx ??
      readTextIfExists(join(root, 'ios', `${projName}.xcodeproj`, 'project.pbxproj'));
  }

  const detected = Boolean(podfile || workspace || pbx);
  if (!detected) {
    return {
      detected: false,
      missingReason: 'No iOS Xcode project or Podfile found under ios/.',
      issues: [],
      pods: [],
    };
  }

  const pods = lock ? parsePodfileLock(lock) : [];
  const hermesEnabled =
    podfile && /:hermes_enabled\s*=>\s*false/i.test(podfile)
      ? false
      : podfile && /hermes_enabled/i.test(podfile)
        ? true
        : pods.some((pod) => /hermes/i.test(pod.name))
          ? true
          : undefined;

  const newArchEnabled =
    podfile && /:fabric_enabled\s*=>\s*true|:new_arch_enabled\s*=>\s*true/i.test(podfile)
      ? true
      : podfile && /:fabric_enabled\s*=>\s*false/i.test(podfile)
        ? false
        : undefined;

  const build: IosBuildConfig = {
    deploymentTarget: parsePodfilePlatform(podfile) ?? parsePlistDeploymentTarget(pbx),
    hermesEnabled,
    newArchEnabled,
    architectures: parseArchitectures(pbx),
    configurations: pbx
      ? [...new Set([...pbx.matchAll(/name = (Debug|Release|Staging|Beta)/g)].map((m) => m[1]))]
      : [],
    signingRelatedFound: Boolean(
      pbx &&
        (/CODE_SIGN_IDENTITY/.test(pbx) ||
          /DEVELOPMENT_TEAM/.test(pbx) ||
          /PROVISIONING_PROFILE/.test(pbx)),
    ),
    bundleIdentifier: parseBundleIdentifier(pbx),
    sourceFiles: [
      'ios/Podfile',
      'ios/Podfile.lock',
      workspace,
    ].filter((v): v is string => Boolean(v && isFile(join(root, v)))),
  };

  const issues: Issue[] = [];

  if (hermesEnabled === false) {
    issues.push(
      issue({
        severity: 'warning',
        title: 'Hermes appears disabled on iOS',
        description:
          'Podfile indicates Hermes is disabled. This is a configuration observation, not a measured IPA delta.',
        evidence: ['ios/Podfile hermes_enabled => false'],
        platform: 'ios',
        affected: 'ios/Podfile',
        recommendation: 'Confirm whether Hermes is intentionally disabled.',
        confidence: 'high',
        category: 'build',
        id: 'ios-hermes-disabled',
      }),
    );
  }

  if (!lock && podfile) {
    issues.push(
      issue({
        severity: 'info',
        title: 'Podfile.lock is missing',
        description:
          'Without Podfile.lock, CocoaPods versions cannot be analyzed reproducibly.',
        evidence: ['ios/Podfile exists', 'ios/Podfile.lock not found'],
        platform: 'ios',
        affected: 'ios/Podfile.lock',
        recommendation: 'Commit Podfile.lock for reproducible iOS dependency analysis.',
        confidence: 'high',
        category: 'dependencies',
        id: 'ios-podfile-lock-missing',
      }),
    );
  }

  const target = build.deploymentTarget ? Number(build.deploymentTarget) : undefined;
  if (target !== undefined && !Number.isNaN(target) && target < 13) {
    issues.push(
      issue({
        severity: 'info',
        title: `iOS deployment target is ${build.deploymentTarget}`,
        description:
          'Very old deployment targets can force extra compatibility code. This tool does not measure the size impact.',
        evidence: [`IPHONEOS_DEPLOYMENT_TARGET=${build.deploymentTarget}`],
        platform: 'ios',
        affected: workspace,
        recommendation: 'Confirm the intended minimum iOS version for this release.',
        confidence: 'medium',
        category: 'build',
        id: 'ios-old-deployment-target',
      }),
    );
  }

  return {
    detected: true,
    build,
    pods,
    workspaceOrProject: workspace,
    issues,
  };
}
