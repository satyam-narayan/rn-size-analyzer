import type {
  AndroidAnalysis,
  IosAnalysis,
  ReleaseAnalysis,
  SecurityAnalysis,
  ChecklistItem,
} from '../../types';
import { issue } from '../issue';

function item(
  id: string,
  label: string,
  status: ChecklistItem['status'],
  detail: string,
  platform: ChecklistItem['platform'],
): ChecklistItem {
  return { id, label, status, detail, platform };
}

export function analyzeRelease(input: {
  android: AndroidAnalysis;
  ios: IosAnalysis;
  security: SecurityAnalysis;
  hermesEnabled?: boolean;
  platform?: 'android' | 'ios' | 'all';
}): ReleaseAnalysis {
  const scope = input.platform ?? 'all';
  const includeAndroid = scope !== 'ios';
  const includeIos = scope !== 'android';
  const android: ChecklistItem[] = [];
  const ios: ChecklistItem[] = [];

  if (includeAndroid && input.android.detected) {
    android.push(
      item(
        'android-project',
        'Android project',
        'ready',
        'Android Gradle project detected.',
        'android',
      ),
    );
    android.push(
      item(
        'android-hermes',
        'Hermes',
        input.android.build?.hermesEnabled === false ? 'warning' : input.android.build?.hermesEnabled ? 'ready' : 'unknown',
        input.android.build?.hermesEnabled === undefined
          ? 'Hermes flag was not found in gradle.properties.'
          : `hermesEnabled=${input.android.build.hermesEnabled}`,
        'android',
      ),
    );
    android.push(
      item(
        'android-r8',
        'R8/ProGuard',
        input.android.build?.minifyEnabled === true
          ? 'ready'
          : input.android.build?.minifyEnabled === false
            ? 'warning'
            : 'unknown',
        input.android.build?.minifyEnabled === undefined
          ? 'Could not parse minifyEnabled for the release build type.'
          : `minifyEnabled=${input.android.build.minifyEnabled}`,
        'android',
      ),
    );
    android.push(
      item(
        'android-signing',
        'Signing configuration',
        input.android.build?.signingConfigPresent ? 'ready' : 'warning',
        input.android.build?.signingConfigPresent
          ? 'signingConfigs or storeFile reference was found. Presence does not prove production keystores are valid.'
          : 'No signingConfigs/storeFile detected in parsed Gradle files.',
        'android',
      ),
    );
    android.push(
      item(
        'android-debuggable',
        'Release not debuggable',
        input.android.build?.debuggable === true ? 'not-ready' : 'ready',
        input.android.build?.debuggable === true
          ? 'release.debuggable is true.'
          : 'No debuggable true flag parsed on the release build type.',
        'android',
      ),
    );
  } else if (includeAndroid) {
    android.push(
      item('android-missing', 'Android project', 'unknown', input.android.missingReason ?? 'Not detected.', 'android'),
    );
  }

  if (includeIos && input.ios.detected) {
    ios.push(item('ios-project', 'iOS project', 'ready', 'iOS project/Podfile detected.', 'ios'));
    ios.push(
      item(
        'ios-hermes',
        'Hermes',
        input.ios.build?.hermesEnabled === false ? 'warning' : input.ios.build?.hermesEnabled ? 'ready' : 'unknown',
        input.ios.build?.hermesEnabled === undefined
          ? 'Hermes flag was not conclusively parsed from Podfile.'
          : `hermes_enabled=${input.ios.build.hermesEnabled}`,
        'ios',
      ),
    );
    ios.push(
      item(
        'ios-signing',
        'Signing-related configuration',
        input.ios.build?.signingRelatedFound ? 'ready' : 'unknown',
        input.ios.build?.signingRelatedFound
          ? 'CODE_SIGN_IDENTITY / DEVELOPMENT_TEAM / profile keys were found. This does not validate certificates.'
          : 'Could not detect signing-related Xcode settings.',
        'ios',
      ),
    );
    ios.push(
      item(
        'ios-deployment',
        'Deployment target',
        input.ios.build?.deploymentTarget ? 'ready' : 'unknown',
        input.ios.build?.deploymentTarget
          ? `IPHONEOS_DEPLOYMENT_TARGET=${input.ios.build.deploymentTarget}`
          : 'Deployment target was not parsed.',
        'ios',
      ),
    );
  } else if (includeIos) {
    ios.push(item('ios-missing', 'iOS project', 'unknown', input.ios.missingReason ?? 'Not detected.', 'ios'));
  }

  const staging = input.security.findings.filter((f) => f.ruleId === 'sec-staging-url' || f.ruleId === 'sec-localhost');
  if (staging.length > 0 && includeAndroid) {
    android.push(
      item(
        'android-staging',
        'Staging/localhost URLs',
        'warning',
        `${staging.length} potential staging/localhost URL(s) found in the repo. Requires verification.`,
        'shared',
      ),
    );
  }
  if (staging.length > 0 && includeIos) {
    ios.push(
      item(
        'ios-staging',
        'Staging/localhost URLs',
        'warning',
        `${staging.length} potential staging/localhost URL(s) found in the repo. Requires verification.`,
        'shared',
      ),
    );
  }

  const all = [...android, ...ios];
  const overall = all.some((i) => i.status === 'not-ready')
    ? 'NOT READY'
    : all.some((i) => i.status === 'warning')
      ? 'WARNING'
      : 'READY';

  const issues = [];
  if (overall === 'NOT READY') {
    issues.push(
      issue({
        severity: 'critical',
        title: 'Release checklist is NOT READY',
        description: 'One or more release checklist items are blocking.',
        evidence: all.filter((i) => i.status === 'not-ready').map((i) => i.label),
        recommendation: 'Resolve blocking release configuration issues before shipping.',
        confidence: 'high',
        category: 'release',
        id: 'release-not-ready',
      }),
    );
  } else if (overall === 'WARNING') {
    issues.push(
      issue({
        severity: 'warning',
        title: 'Release checklist has warnings',
        description: 'The project can be analyzed, but some release checks need review.',
        evidence: all.filter((i) => i.status === 'warning').map((i) => i.label),
        recommendation: 'Review warning items before a production release.',
        confidence: 'medium',
        category: 'release',
        id: 'release-warning',
      }),
    );
  }

  return { overall, android, ios, issues };
}
