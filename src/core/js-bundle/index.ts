import { join } from 'node:path';
import type { JsBundleAnalysis } from '../../types';
import { isFile, walkFiles, rel } from '../../utils/fs';
import { statSync } from 'node:fs';
import { issue } from '../issue';

const BUNDLE_NAMES = [
  'index.android.bundle',
  'index.ios.bundle',
  'index.bundle',
  'main.jsbundle',
];

export function analyzeJsBundle(root: string): JsBundleAnalysis {
  const candidates = [
    join(root, 'android', 'app', 'src', 'main', 'assets', 'index.android.bundle'),
    join(root, 'ios', 'main.jsbundle'),
  ];

  const walked = walkFiles(root, {
    maxFiles: 2000,
    extensions: new Set(['.bundle', '.jsbundle', '.hbc', '.map']),
  });

  let foundPath: string | undefined;
  for (const candidate of [...candidates, ...walked]) {
    const base = candidate.split(/[\\/]/).pop() ?? '';
    if (BUNDLE_NAMES.includes(base) || base.endsWith('.hbc') || base.endsWith('.jsbundle')) {
      if (isFile(candidate) && !candidate.includes('node_modules')) {
        foundPath = candidate;
        break;
      }
    }
  }

  if (!foundPath) {
    return {
      found: false,
      largestModules: [],
      notes: [
        'No packaged JS bundle was found in the project tree. Bundles are usually produced during release builds and live inside APK/AAB/IPA artifacts.',
      ],
      issues: [
        issue({
          severity: 'info',
          title: 'JS bundle not found in the project tree',
          description:
            'Without a release artifact or prebundled file, JavaScript size cannot be measured. Metro source maps are not parsed in this run.',
          recommendation:
            'Place a release AAB/APK or IPA in the project (auto-detected) to measure JS size.',
          confidence: 'high',
          category: 'js-bundle',
          id: 'js-bundle-missing',
        }),
      ],
    };
  }

  const bytes = statSync(foundPath).size;
  const sourceMapFound = isFile(`${foundPath}.map`) || walked.some((f) => f.endsWith('.map'));
  const hermesLikely = foundPath.endsWith('.hbc') || bytes > 0;

  return {
    found: true,
    path: rel(root, foundPath),
    bytes,
    hermesLikely: foundPath.endsWith('.hbc'),
    sourceMapFound,
    largestModules: sourceMapFound
      ? [
          {
            name: '(source map present)',
            note: 'Module-level breakdown from source maps is not implemented in v0.1. The map file was detected only.',
          },
        ]
      : [],
    notes: [
      hermesLikely && foundPath.endsWith('.hbc')
        ? 'File extension suggests a Hermes bytecode bundle.'
        : 'Hermes vs JSC cannot be proven from this filename alone.',
      sourceMapFound
        ? 'A source map file was found; per-module sizes are future work.'
        : 'No source map found; per-module sizes are unavailable.',
    ],
    issues: [],
  };
}
