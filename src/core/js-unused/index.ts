import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Issue, JsUnusedAnalysis, UnusedJsSymbol } from '../../types';
import { isDirectory, isFile, isVendorRel, rel, walkFiles } from '../../utils/fs';
import { issue } from '../issue';

const SOURCE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_NAME = new Set([
  'constructor',
  'render',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillUnmount',
  'shouldComponentUpdate',
  'getDerivedStateFromProps',
  'getSnapshotBeforeUpdate',
  'componentDidCatch',
  'styles',
  'default',
]);

interface NamedImport {
  imported: string;
  local: string;
}

interface ImportEdge {
  spec: string;
  resolved?: string;
  defaultName?: string;
  namespace?: string;
  names: NamedImport[];
  star: boolean;
}

interface ExportedSymbol {
  name: string;
  kind: UnusedJsSymbol['kind'];
  line: number;
  isDefault: boolean;
}

interface LocalSymbol {
  name: string;
  kind: UnusedJsSymbol['kind'];
  line: number;
}

interface ParsedFile {
  abs: string;
  rel: string;
  text: string;
  searchable: string;
  imports: ImportEdge[];
  exports: ExportedSymbol[];
  locals: LocalSymbol[];
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (line) => ' '.repeat(line.length));
}

function kindFor(name: string, hint?: string): UnusedJsSymbol['kind'] {
  if (hint === 'class') return 'class';
  if (/^[A-Z]/.test(name)) return 'component';
  return 'function';
}

const ENTRY_NAMES = [
  'index.js',
  'index.ts',
  'index.tsx',
  'index.jsx',
  'App.tsx',
  'App.ts',
  'App.js',
  'App.jsx',
  'src/index.js',
  'src/index.ts',
  'src/index.tsx',
  'src/App.tsx',
  'src/App.js',
  'app/index.js',
  'app/index.ts',
  'app/index.tsx',
  'app/_layout.tsx',
  'app/_layout.js',
];

function isLibraryRel(relative: string): boolean {
  return relative.split(/[\\/]/).includes('packages');
}

function isAppSourceRel(relative: string): boolean {
  const top = relative.split('/')[0];
  return top === 'src' || top === 'app';
}

function isToolingFile(relative: string): boolean {
  const base = relative.split('/').pop() ?? relative;
  if (base.startsWith('.')) return true;
  if (/\.config\.(js|cjs|mjs|ts|json)$/i.test(base)) return true;
  if (/^(metro|babel|jest|eslint|prettier|webpack|vite|tailwind)\.config\./i.test(base)) return true;
  return false;
}

function isSkippableRel(relative: string): boolean {
  if (isVendorRel(relative) || isLibraryRel(relative) || isToolingFile(relative)) return true;
  if (relative.startsWith('ios/') || relative.startsWith('android/')) return true;
  if (relative.includes('/__tests__/') || relative.includes('/__mocks__/')) return true;
  if (/\.(test|spec|stories)\./i.test(relative)) return true;
  if (relative.endsWith('.d.ts')) return true;
  return false;
}

function sourceRoots(root: string): string[] {
  return ['src', 'app'].map((name) => join(root, name)).filter(isDirectory);
}

function parseNamedList(raw: string): NamedImport[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      if (part === '...' || part.startsWith('type ')) return [];
      const renamed = part.match(/^(?:type\s+)?(\w+)\s+as\s+(\w+)$/);
      if (renamed) return [{ imported: renamed[1], local: renamed[2] }];
      const simple = part.match(/^(?:type\s+)?(\w+)$/);
      if (!simple) return [];
      return [{ imported: simple[1], local: simple[1] }];
    });
}

function parseImportClause(clause: string): Omit<ImportEdge, 'spec'> {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ') && !trimmed.includes('{')) {
    return { names: [], star: false };
  }
  const star = trimmed.match(/^\*\s+as\s+(\w+)$/);
  if (star) return { namespace: star[1], names: [], star: true };

  const mixed = trimmed.match(/^(\w+)\s*,\s*\{([\s\S]*)\}$/);
  if (mixed) return { defaultName: mixed[1], names: parseNamedList(mixed[2]), star: false };

  const named = trimmed.match(/^\{([\s\S]*)\}$/);
  if (named) return { names: parseNamedList(named[1]), star: false };

  if (/^\w+$/.test(trimmed)) return { defaultName: trimmed, names: [], star: false };
  return { names: [], star: false };
}

function parseFile(abs: string, root: string, text: string): ParsedFile {
  const searchable = stripComments(text);
  const imports: ImportEdge[] = [];
  const exports: ExportedSymbol[] = [];
  const locals: LocalSymbol[] = [];
  const seen = new Set<string>();

  const fromRe = /\b(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of searchable.matchAll(fromRe)) {
    const raw = match[0];
    if (/\b(?:import|export)\s+type\b/.test(raw)) continue;
    const clause = match[1].trim();
    const spec = match[2];
    const isExport = /^\s*export\b/.test(raw.trimStart()) || raw.trimStart().startsWith('export');
    if (isExport && clause === '*') {
      imports.push({ spec, names: [], star: true });
      continue;
    }
    const parsed = parseImportClause(clause);
    imports.push({ spec, ...parsed });
  }

  const sideEffect = /\bimport\s+['"]([^'"]+)['"]/g;
  for (const match of searchable.matchAll(sideEffect)) {
    imports.push({ spec: match[1], names: [], star: false });
  }

  const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of searchable.matchAll(requireRe)) {
    imports.push({ spec: match[1], names: [], star: false });
  }

  const destructureRequire =
    /\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of searchable.matchAll(destructureRequire)) {
    imports.push({ spec: match[2], names: parseNamedList(match[1]), star: false });
  }

  const defaultRequire =
    /\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of searchable.matchAll(defaultRequire)) {
    imports.push({ spec: match[2], defaultName: match[1], names: [], star: false });
  }

  const exportFns = [
    /export\s+default\s+(?:async\s+)?function(?:\s+(\w+))?/g,
    /export\s+default\s+class(?:\s+(\w+))?/g,
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+const\s+(\w+)\s*=/g,
  ];
  for (const re of exportFns) {
    for (const match of searchable.matchAll(re)) {
      const isDefault = match[0].includes('default');
      const name = match[1] || (isDefault ? 'default' : '');
      if (!name || SKIP_NAME.has(name) || seen.has(`export:${name}`)) continue;
      seen.add(`export:${name}`);
      const kind = match[0].includes('class') ? 'class' : kindFor(name);
      exports.push({ name, kind, line: lineNumber(searchable, match.index ?? 0), isDefault });
    }
  }

  const exportDefaultName = /export\s+default\s+([A-Z][A-Za-z0-9_]*)\s*;/g;
  for (const match of searchable.matchAll(exportDefaultName)) {
    if (seen.has(`export:${match[1]}`)) {
      const existing = exports.find((item) => item.name === match[1]);
      if (existing) existing.isDefault = true;
      continue;
    }
    seen.add(`export:${match[1]}`);
    exports.push({
      name: match[1],
      kind: kindFor(match[1]),
      line: lineNumber(searchable, match.index ?? 0),
      isDefault: true,
    });
  }

  const localRe = [
    /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/g,
    /(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:React\.)?(?:memo|forwardRef)\(/g,
    /(?:^|\n)\s*(?:export\s+)?class\s+(\w+)/g,
  ];
  for (const re of localRe) {
    for (const match of searchable.matchAll(re)) {
      const name = match[1];
      if (!name || SKIP_NAME.has(name) || seen.has(`local:${name}`)) continue;
      if (match[0].includes('export')) continue;
      seen.add(`local:${name}`);
      locals.push({
        name,
        kind: match[0].includes('class') ? 'class' : kindFor(name),
        line: lineNumber(searchable, match.index ?? 0),
      });
    }
  }

  return {
    abs,
    rel: rel(root, abs),
    text,
    searchable,
    imports,
    exports,
    locals,
  };
}

function resolveImport(
  fromAbs: string,
  spec: string,
  files: Map<string, ParsedFile>,
  root: string,
): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromAbs), spec);
  const candidates = [
    base,
    ...['.tsx', '.ts', '.jsx', '.js'].map((ext) => base + ext),
    ...['.tsx', '.ts', '.jsx', '.js'].map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    const relative = rel(root, candidate);
    if (isVendorRel(relative) || isLibraryRel(relative)) continue;
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

function countName(searchable: string, name: string): number {
  const matches = searchable.match(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'));
  return matches?.length ?? 0;
}

function loadParsedFile(abs: string, root: string, files: Map<string, ParsedFile>): void {
  const key = resolve(abs);
  if (files.has(key)) return;
  let text = '';
  try {
    text = readFileSync(key, 'utf8');
  } catch {
    return;
  }
  if (!text || text.length > 800_000) return;
  files.set(key, parseFile(key, root, text));
}

function findEntries(root: string, files: Map<string, ParsedFile>): string[] {
  const found: string[] = [];
  for (const name of ENTRY_NAMES) {
    const abs = resolve(root, name);
    if (files.has(abs) || isFile(abs)) {
      loadParsedFile(abs, root, files);
      if (files.has(abs)) found.push(abs);
    }
  }
  return [...new Set(found)];
}

function reachableFrom(entries: string[], files: Map<string, ParsedFile>): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const parsed = files.get(current);
    if (!parsed) continue;
    for (const edge of parsed.imports) {
      if (edge.resolved && !seen.has(edge.resolved)) stack.push(edge.resolved);
    }
  }
  return seen;
}

export function analyzeUnusedJs(root: string): JsUnusedAnalysis {
  const empty = (notes: string[]): JsUnusedAnalysis => ({
    entryFiles: [],
    scannedFileCount: 0,
    reachableModuleCount: 0,
    unusedInBytecode: [],
    unusedUnreachableModules: [],
    notes,
    issues: [],
  });

  const roots = sourceRoots(root);
  if (roots.length === 0) {
    return empty(['No src/ or app/ folder found. Unused JS is only scanned inside those folders.']);
  }

  const walked = roots.flatMap((dir) => walkFiles(dir, { extensions: SOURCE_EXT, maxFiles: 4000 }));
  const files = new Map<string, ParsedFile>();
  for (const abs of walked) {
    const relative = rel(root, abs);
    if (isSkippableRel(relative) || !isAppSourceRel(relative)) continue;
    loadParsedFile(abs, root, files);
  }

  const entries = findEntries(root, files);
  for (const parsed of files.values()) {
    for (const edge of parsed.imports) {
      edge.resolved = resolveImport(parsed.abs, edge.spec, files, root);
    }
  }
  const reachable = reachableFrom(entries, files);

  const importedFrom = new Map<string, ImportEdge[]>();
  for (const parsed of files.values()) {
    if (!reachable.has(parsed.abs)) continue;
    for (const edge of parsed.imports) {
      if (!edge.resolved) continue;
      const list = importedFrom.get(edge.resolved) ?? [];
      list.push(edge);
      importedFrom.set(edge.resolved, list);
    }
  }

  const unusedInBytecode: UnusedJsSymbol[] = [];
  const unusedUnreachableModules: UnusedJsSymbol[] = [];

  for (const parsed of files.values()) {
    if (!isAppSourceRel(parsed.rel) || isToolingFile(parsed.rel)) continue;
    const inGraph = reachable.has(parsed.abs);
    if (!inGraph) {
      unusedUnreachableModules.push({
        name: parsed.rel.split('/').pop() ?? parsed.rel,
        kind: 'module',
        file: parsed.rel,
        line: 1,
        inBundleGraph: false,
        likelyInBytecode: false,
        confidence: 'medium',
        evidence: ['Nothing in App or index.js imports this file.'],
        recommendation: 'Safe to delete for cleanup. Usually not in the current APK/AAB JavaScript.',
      });
      continue;
    }

    const isEntry = entries.includes(parsed.abs);
    const incoming = importedFrom.get(parsed.abs) ?? [];
    const namesImported = new Set(incoming.flatMap((edge) => edge.names.map((item) => item.imported)));
    const defaultImported = incoming.some((edge) => Boolean(edge.defaultName));
    const namespaceImported = incoming.some((edge) => edge.star || Boolean(edge.namespace));

    if (!isEntry) {
      for (const symbol of parsed.exports) {
      const imported =
        namespaceImported ||
        (symbol.isDefault && defaultImported) ||
        namesImported.has(symbol.name) ||
        (symbol.isDefault && namesImported.has('default'));
      const localHits = countName(parsed.searchable, symbol.name);
      const usedLocally = localHits > 1;
      if (imported || usedLocally) continue;
      unusedInBytecode.push({
        name: symbol.name,
        kind: symbol.kind,
        file: parsed.rel,
        line: symbol.line,
        inBundleGraph: true,
        likelyInBytecode: true,
        confidence: 'medium',
        evidence: ['Imported file, but this export is never used.'],
        recommendation: 'Comment or delete, then rebuild a release AAB/APK.',
      });
      }
    }

    for (const symbol of parsed.locals) {
      if (countName(parsed.searchable, symbol.name) > 1) continue;
      unusedInBytecode.push({
        name: symbol.name,
        kind: symbol.kind,
        file: parsed.rel,
        line: symbol.line,
        inBundleGraph: true,
        likelyInBytecode: true,
        confidence: 'medium',
        evidence: ['Declared in an imported file and never used there.'],
        recommendation: 'Comment or delete, then rebuild a release AAB/APK.',
      });
    }
  }

  unusedInBytecode.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  unusedUnreachableModules.sort((a, b) => a.file.localeCompare(b.file));

  const issues: Issue[] = [];
  if (unusedInBytecode.length) {
    issues.push(
      issue({
        severity: unusedInBytecode.length >= 15 ? 'warning' : 'info',
        title: `${unusedInBytecode.length} unused JS item(s) likely in bytecode`,
        description:
          'These unused functions or components live in files imported from App/index, so they can still ship in the app JavaScript (likely in Hermes bytecode). This is a static search, not a measured size.',
        evidence: unusedInBytecode.slice(0, 12).map((item) => `${item.file}:${item.line} ${item.name}`),
        recommendation:
          'Open the Unused JavaScript tab, start with “Likely in bytecode”, comment or delete the items, then rebuild a release AAB/APK.',
        confidence: 'medium',
        category: 'js-bundle',
        id: 'js-unused-in-graph',
      }),
    );
  }

  return {
    entryFiles: entries.map((abs) => rel(root, abs)),
    scannedFileCount: [...files.values()].filter((file) => isAppSourceRel(file.rel)).length,
    reachableModuleCount: [...reachable].filter((abs) => isAppSourceRel(rel(root, abs))).length,
    unusedInBytecode: unusedInBytecode.slice(0, 400),
    unusedUnreachableModules: unusedUnreachableModules.slice(0, 200),
    notes: [
      'Only src/ and app/ are scanned. Root tooling files such as .eslintrc.js are ignored.',
      'Likely in bytecode = unused code in a file the app already imports, so it can still ship in the JS/Hermes bytecode. Not in JS bundle = nothing imports the file, so Metro usually leaves it out.',
      'Savings are unknown until you rebuild a release AAB/APK. Minify may already drop some unused functions.',
      entries.length === 0 ? 'No index.js / App.tsx entry was found; reachability could not be computed.' : `Entries: ${entries.map((abs) => rel(root, abs)).join(', ')}`,
    ],
    issues,
  };
}
