import { readFileSync } from 'node:fs';
import type { SecurityAnalysis, SecurityFinding } from '../../types';
import { rel, walkFiles } from '../../utils/fs';
import { issue } from '../issue';

const SOURCE_EXT = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.env',
  '.gradle',
  '.properties',
  '.plist',
  '.java',
  '.kt',
  '.m',
  '.mm',
  '.swift',
]);

interface Rule {
  id: string;
  regex: RegExp;
  explanation: string;
  recommendation: string;
  severity: SecurityFinding['severity'];
}

const RULES: Rule[] = [
  {
    id: 'sec-aws-access-key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    explanation: 'Potential AWS access key ID pattern.',
    recommendation: 'If this is a real key, rotate it and move secrets out of the client app.',
    severity: 'critical',
  },
  {
    id: 'sec-private-key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    explanation: 'A PEM private key block was found in a scanned file.',
    recommendation: 'Remove private keys from the application repository and rotate the key.',
    severity: 'critical',
  },
  {
    id: 'sec-google-api-key',
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    explanation: 'Potential Google API key pattern. Not every match is a leaked secret.',
    recommendation: 'Restrict the key by package name/bundle ID and API, or confirm it is intended to be public.',
    severity: 'warning',
  },
  {
    id: 'sec-http-url',
    regex: /['"`]http:\/\/[^\s'"`]+['"`]/g,
    explanation: 'Insecure HTTP URL literal. This may be a local/dev endpoint.',
    recommendation: 'Use HTTPS in production. Confirm this URL is not used in release builds.',
    severity: 'warning',
  },
  {
    id: 'sec-localhost',
    regex: /['"`]https?:\/\/(?:localhost|127\.0\.0\.1|10\.0\.2\.2)[:/][^'"`]*['"`]/g,
    explanation: 'localhost/emulator URL literal. May be leftover debug configuration.',
    recommendation: 'Ensure release builds do not point at local development servers.',
    severity: 'warning',
  },
  {
    id: 'sec-staging-url',
    regex: /['"`]https?:\/\/[^'"`]*(staging|stg-|dev\.|qa\.)[^'"`]*['"`]/gi,
    explanation: 'Potential staging/dev URL. Requires verification that it is not used in production.',
    recommendation: 'Gate staging endpoints behind build flavors / environment config.',
    severity: 'warning',
  },
];

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function snippet(source: string, index: number): string {
  const line = source.split('\n')[lineNumber(source, index) - 1] ?? '';
  return line.trim().slice(0, 160);
}

const FIREBASE_CLIENT_CONFIG = /(?:^|\/)(google-services\.json|GoogleService-Info[^/]*\.plist)$/i;

const SCHEMA_OR_DTD_URL =
  /schemas\.android\.com|www\.w3\.org|schemas\.microsoft\.com|xmlpull\.org|apple\.com\/dtds/i;

function shouldSkipMatch(
  source: string,
  index: number,
  match: string,
  ruleId: string,
  relativePath: string,
): boolean {
  const line = source.split('\n')[lineNumber(source, index) - 1] ?? '';
  const posix = relativePath.replace(/\\/g, '/');
  if (/xmlns\s*=/.test(line) || /<!DOCTYPE/i.test(line)) return true;
  if (SCHEMA_OR_DTD_URL.test(match) || SCHEMA_OR_DTD_URL.test(line)) return true;
  if (ruleId === 'sec-google-api-key' && FIREBASE_CLIENT_CONFIG.test(posix)) return true;
  return false;
}

export function analyzeSecurity(root: string): SecurityAnalysis {
  const files = walkFiles(root, {
    extensions: SOURCE_EXT,
    maxFiles: 2000,
  }).filter((file) => {
    const relative = rel(root, file);
    return (
      !relative.includes('node_modules') &&
      !relative.includes('Pods/') &&
      !relative.endsWith('package-lock.json')
    );
  });

  const findings: SecurityFinding[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (source.length > 500_000) continue;
    const relative = rel(root, file);
    for (const rule of RULES) {
      rule.regex.lastIndex = 0;
      const matches = [...source.matchAll(rule.regex)].slice(0, 5);
      for (const match of matches) {
        if (shouldSkipMatch(source, match.index ?? 0, match[0] ?? '', rule.id, relative)) continue;
        findings.push({
          ruleId: rule.id,
          file: relative,
          line: lineNumber(source, match.index ?? 0),
          severity: rule.severity,
          snippet: snippet(source, match.index ?? 0),
          explanation: `Potential secret/config issue: ${rule.explanation}`,
          recommendation: rule.recommendation,
        });
      }
    }
  }

  const issues = findings.slice(0, 30).map((finding) =>
    issue({
      severity: finding.severity,
      title: `Potential secret detected (${finding.ruleId})`,
      description: `${finding.explanation} This is a pattern match, not proof of a live credential.`,
      evidence: [`${finding.file}:${finding.line}`, finding.snippet],
      affected: finding.file,
      recommendation: finding.recommendation,
      confidence: finding.ruleId === 'sec-private-key' ? 'high' : 'low',
      category: 'security',
      id: `${finding.ruleId}:${finding.file}:${finding.line}`,
    }),
  );

  return { findings, issues };
}
