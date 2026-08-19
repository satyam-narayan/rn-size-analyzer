import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PerformanceAnalysis, PerformanceFinding } from '../../types';
import { isFile, rel, walkFiles } from '../../utils/fs';
import { issue } from '../issue';

const SOURCE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);

const LIST_TUNING_NEARBY =
  /\b(windowSize|removeClippedSubviews|getItemLayout|maxToRenderPerBatch|initialNumToRender)\s*[:=]/;

const LIST_TUNING_IN_OBJECT =
  /\b(windowSize|removeClippedSubviews|getItemLayout|maxToRenderPerBatch|initialNumToRender)\s*:/;

const GENERIC_SPREAD = new Set(['props', 'rest', 'other', 'style', 'item', 'params', 'options']);

interface SharedListObject {
  hasTuning: boolean;
  hasKeyExtractor: boolean;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sliceBalancedBraces(source: string, start: number): string | undefined {
  if (source[start] !== '{') return undefined;
  let depth = 0;
  const end = Math.min(source.length, start + 4000);
  for (let i = start; i < end; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

function objectAtAssignment(source: string, matchIndex: number): string | undefined {
  const start = source.indexOf('{', matchIndex);
  if (start < 0) return undefined;
  return sliceBalancedBraces(source, start);
}

function findConstObject(source: string, name: string): string | undefined {
  const pattern = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escapeRegExp(name)}\\s*(?::[^=]+)?=\\s*\\{`,
  );
  const match = pattern.exec(source);
  if (!match) return undefined;
  return objectAtAssignment(source, match.index);
}

function namedImport(
  source: string,
  localName: string,
): { from: string; exportedName: string } | undefined {
  const fromNamed = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(fromNamed)) {
    const specifiers = match[1] ?? '';
    const from = match[2];
    if (!from) continue;
    for (const part of specifiers.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const aliased = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliased?.[2] === localName) return { from, exportedName: aliased[1] };
      if (trimmed === localName) return { from, exportedName: localName };
    }
  }
  return undefined;
}

function resolveImportFile(fromFile: string, spec: string, projectRoot: string): string | undefined {
  const candidates: string[] = [];
  const pushBase = (base: string) => {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      `${base}.jsx`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
      join(base, 'index.js'),
      join(base, 'index.jsx'),
      base,
    );
  };
  if (spec.startsWith('.')) {
    pushBase(resolve(dirname(fromFile), spec));
  } else {
    const stripped = spec.replace(/^@\//, '');
    pushBase(join(projectRoot, stripped));
    pushBase(join(projectRoot, 'src', stripped));
    pushBase(join(projectRoot, 'app', stripped));
  }
  return candidates.find((candidate) => isFile(candidate));
}

function readNearby(filePath: string): string | undefined {
  try {
    const text = readFileSync(filePath, 'utf8');
    return text.length > 400_000 ? undefined : text;
  } catch {
    return undefined;
  }
}

function spreadNames(window: string): string[] {
  return [...window.matchAll(/\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}/g)].map((match) => match[1]);
}

function inspectObject(objectText: string): SharedListObject {
  return {
    hasTuning: LIST_TUNING_IN_OBJECT.test(objectText),
    hasKeyExtractor: /\bkeyExtractor\s*:/.test(objectText),
  };
}

function indexSharedListObjects(files: string[]): Map<string, SharedListObject> {
  const index = new Map<string, SharedListObject>();
  const assignment =
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g;
  for (const file of files) {
    const source = readNearby(file);
    if (!source) continue;
    for (const match of source.matchAll(assignment)) {
      const name = match[1];
      if (!name || GENERIC_SPREAD.has(name)) continue;
      const objectText = objectAtAssignment(source, match.index ?? 0);
      if (!objectText) continue;
      const next = inspectObject(objectText);
      const previous = index.get(name);
      index.set(name, {
        hasTuning: Boolean(previous?.hasTuning) || next.hasTuning,
        hasKeyExtractor: Boolean(previous?.hasKeyExtractor) || next.hasKeyExtractor,
      });
    }
  }
  return index;
}

function resolveSpreadObject(
  source: string,
  filePath: string,
  projectRoot: string,
  name: string,
): string | undefined {
  const local = findConstObject(source, name);
  if (local) return local;
  const imported = namedImport(source, name);
  if (!imported) return undefined;
  const importedFile = resolveImportFile(filePath, imported.from, projectRoot);
  if (!importedFile) return undefined;
  const importedSource = readNearby(importedFile);
  if (!importedSource) return undefined;
  return findConstObject(importedSource, imported.exportedName);
}

function sharedLookup(
  source: string,
  filePath: string,
  projectRoot: string,
  name: string,
  index: Map<string, SharedListObject>,
): SharedListObject | undefined {
  const objectText = resolveSpreadObject(source, filePath, projectRoot, name);
  if (objectText) return inspectObject(objectText);
  if (GENERIC_SPREAD.has(name)) return undefined;
  return index.get(name);
}

function hasListTuning(
  source: string,
  filePath: string,
  projectRoot: string,
  window: string,
  index: Map<string, SharedListObject>,
): boolean {
  if (LIST_TUNING_NEARBY.test(window)) return true;
  return spreadNames(window).some(
    (name) => sharedLookup(source, filePath, projectRoot, name, index)?.hasTuning,
  );
}

function hasKeyExtractor(
  source: string,
  filePath: string,
  projectRoot: string,
  window: string,
  index: Map<string, SharedListObject>,
): boolean {
  if (/\bkeyExtractor\b/.test(window)) return true;
  return spreadNames(window).some(
    (name) => sharedLookup(source, filePath, projectRoot, name, index)?.hasKeyExtractor,
  );
}

function scanFile(
  root: string,
  file: string,
  index: Map<string, SharedListObject>,
): PerformanceFinding[] {
  const source = readNearby(file);
  if (!source) return [];
  const relative = rel(root, file);
  const findings: PerformanceFinding[] = [];

  const flatListMatches = [...source.matchAll(/<FlatList\b/g)];
  for (const match of flatListMatches) {
    const start = match.index ?? 0;
    const window = source.slice(start, start + 800);
    if (!hasKeyExtractor(source, file, root, window, index)) {
      findings.push({
        ruleId: 'perf-flatlist-keyextractor',
        file: relative,
        line: lineNumber(source, start),
        severity: 'info',
        explanation:
          'A FlatList opening tag was found without keyExtractor nearby, including shared spreads. This is a conservative static check.',
        recommendation:
          'Provide a stable keyExtractor (or use key fields) to avoid extra reconciliation work.',
      });
    }
    if (!hasListTuning(source, file, root, window, index) && window.length > 120) {
      findings.push({
        ruleId: 'perf-flatlist-opts',
        file: relative,
        line: lineNumber(source, start),
        severity: 'info',
        explanation:
          'FlatList does not set windowSize, removeClippedSubviews, or getItemLayout on the tag or via a spread object that defines those keys. These are optional; absence is not necessarily a bug.',
        recommendation:
          'For long lists, set those props on the list or spread a shared object that includes them. The object name does not matter.',
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

  const shared = indexSharedListObjects(files);
  const findings: PerformanceFinding[] = [];
  for (const file of files) {
    findings.push(...scanFile(root, file, shared));
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
