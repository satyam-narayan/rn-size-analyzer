import { readFileSync } from 'node:fs';
import type { PerformanceAnalysis, PerformanceFinding } from '../../types';
import { rel, walkFiles } from '../../utils/fs';
import { issue } from '../issue';

const SOURCE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function scanFile(root: string, file: string): PerformanceFinding[] {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (source.length > 400_000) return [];
  const relative = rel(root, file);
  const findings: PerformanceFinding[] = [];

  const flatListMatches = [...source.matchAll(/<FlatList\b/g)];
  for (const match of flatListMatches) {
    const start = match.index ?? 0;
    const window = source.slice(start, start + 800);
    if (!/keyExtractor\s*=/.test(window) && !/\bkeyExtractor\b/.test(window)) {
      findings.push({
        ruleId: 'perf-flatlist-keyextractor',
        file: relative,
        line: lineNumber(source, start),
        severity: 'info',
        explanation:
          'A FlatList opening tag was found without keyExtractor in the following ~800 characters. This is a conservative static check and may be a false positive if keyExtractor is spread from props.',
        recommendation:
          'Provide a stable keyExtractor (or use key fields) to avoid extra reconciliation work.',
      });
    }
    const hasWindow = /windowSize\s*=/.test(window);
    const hasRemove = /removeClippedSubviews\s*=/.test(window);
    const hasGetItem = /getItemLayout\s*=/.test(window);
    if (!hasWindow && !hasRemove && !hasGetItem && window.length > 120) {
      findings.push({
        ruleId: 'perf-flatlist-opts',
        file: relative,
        line: lineNumber(source, start),
        severity: 'info',
        explanation:
          'FlatList does not obviously set windowSize, removeClippedSubviews, or getItemLayout nearby. These are optional; absence is not necessarily a bug.',
        recommendation:
          'For long lists, consider windowSize, getItemLayout, and avoiding anonymous inline renderItem allocations where profiling shows cost.',
      });
    }
  }

  const consoleMatches = [...source.matchAll(/\bconsole\.(log|debug|info)\s*\(/g)];
  if (consoleMatches.length >= 8) {
    const first = consoleMatches[0];
    findings.push({
      ruleId: 'perf-console-log',
      file: relative,
      line: lineNumber(source, first.index ?? 0),
      severity: 'info',
      explanation: `${consoleMatches.length} console.log/debug/info calls were found in this file. This is a static count, not a runtime cost measurement.`,
      recommendation: 'Strip or gate verbose logging in production builds.',
    });
  }

  return findings;
}

export function analyzePerformance(root: string): PerformanceAnalysis {
  const files = walkFiles(root, {
    extensions: SOURCE_EXT,
    maxFiles: 1500,
  }).filter((file) => {
    const relative = rel(root, file);
    return (
      !relative.includes('node_modules') &&
      (relative.startsWith('src/') ||
        relative.startsWith('app/') ||
        relative.startsWith('screens/') ||
        relative.endsWith('App.tsx') ||
        relative.endsWith('App.js') ||
        relative.startsWith('components/'))
    );
  });

  const findings: PerformanceFinding[] = [];
  for (const file of files) {
    findings.push(...scanFile(root, file));
  }

  const issues = findings.slice(0, 20).map((finding) =>
    issue({
      severity: finding.severity,
      title: `${finding.ruleId} in ${finding.file}:${finding.line}`,
      description: finding.explanation,
      evidence: [`${finding.file}:${finding.line}`],
      affected: finding.file,
      recommendation: finding.recommendation,
      confidence: 'low',
      category: 'performance',
      id: `${finding.ruleId}:${finding.file}:${finding.line}`,
    }),
  );

  return { findings, issues };
}
