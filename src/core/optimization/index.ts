import type { DependencyNode, Issue, Recommendation } from '../../types';
import { formatBytes } from '../../utils/size';
import { issue } from '../issue';

const KNOWN: Record<
  string,
  { why: string; checks: string[] }
> = {
  'react-native-video': {
    why: 'Native video frameworks/codecs often contribute significant binary size on both platforms.',
    checks: [
      'Review which codecs/exporters are compiled in.',
      'Review Android ABI configuration.',
      'Review whether ExoPlayer / AVPlayer extras are required.',
      'Compare package version impact between releases.',
      'Test an alternative only if product requirements allow it.',
    ],
  },
  '@react-native-firebase/app': {
    why: 'Firebase SDKs pull native Google/Firebase libraries that add binary size.',
    checks: [
      'Confirm every Firebase product package is required.',
      'Review Android Play services BOM versions.',
      'Review iOS pods pulled by Firebase.',
    ],
  },
  'react-native-reanimated': {
    why: 'Reanimated ships native worklets runtime code. Size impact varies by version and New Architecture.',
    checks: [
      'Confirm the version is required by navigation/animation usage.',
      'Compare with previous release native .so/framework sizes.',
    ],
  },
  'react-native-screens': {
    why: 'Native navigation primitives add modest native code. Rarely the largest contributor by itself.',
    checks: ['Verify it is required by the navigation stack in use.'],
  },
};

export function buildRecommendations(input: {
  nativeModules: DependencyNode[];
  issues: Issue[];
}): { recommendations: Recommendation[]; extraIssues: Issue[] } {
  const recommendations: Recommendation[] = [];
  const extraIssues: Issue[] = [];

  for (const node of input.nativeModules) {
    const known = KNOWN[node.name];
    if (!known && (node.androidBytes ?? 0) + (node.iosBytes ?? 0) === 0) continue;
    const android = node.androidBytes;
    const ios = node.iosBytes;
    recommendations.push({
      id: `opt-${node.name}`,
      title: node.name,
      why: known?.why ?? 'This package includes native Android and/or iOS code, which can affect binary size.',
      impact: [
        android !== undefined ? `Android impact (attribution estimated): ${formatBytes(android)}` : 'Android impact: not measured',
        ios !== undefined ? `iOS impact (attribution estimated): ${formatBytes(ios)}` : 'iOS impact: not measured',
      ].join(' · '),
      whatToCheck: known?.checks ?? [
        'Review whether all native components are required.',
        'Review ABI / architecture slices.',
        'Compare package version impact.',
      ],
      confidence: node.androidBytes || node.iosBytes ? 'medium' : 'low',
      relatedIssueIds: [],
    });

    if ((android ?? 0) > 5 * 1024 * 1024) {
      extraIssues.push(
        issue({
          severity: 'warning',
          title: `${node.name} likely contributes significant Android native size`,
          description: known?.why ?? 'Native libraries were attributed to this package by name matching.',
          evidence: [
            `Estimated Android size: ${formatBytes(android ?? 0)}`,
            'Could not confidently attribute every .so; this is a heuristic.',
          ],
          platform: 'android',
          affected: node.name,
          estimatedImpactBytes: android,
          estimatedImpactLabel: 'Attribution estimated (requires verification)',
          recommendation: known?.checks.join(' ') ?? 'Review native dependency/ABI configuration.',
          confidence: 'medium',
          category: 'dependencies',
          id: `opt-android-${node.name}`,
        }),
      );
    }
  }

  const minify = input.issues.find((i) => i.id === 'android-minify-off');
  if (minify) {
    recommendations.push({
      id: 'opt-r8',
      title: 'Enable R8/resource shrinking for release',
      why: 'Without minification, unused Java/Kotlin and resources may remain in the APK/AAB.',
      impact: 'Estimated impact: UNKNOWN without a before/after release build.',
      whatToCheck: [
        'Set minifyEnabled true for the release build type.',
        'Consider shrinkResources true.',
        'Validate ProGuard keep rules so the app still launches.',
      ],
      confidence: 'low',
      relatedIssueIds: [minify.id],
    });
  }

  return { recommendations, extraIssues };
}
