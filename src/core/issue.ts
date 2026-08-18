import type { Confidence, Issue, Platform, Severity } from '../types';

let counter = 0;

export function resetIssueIds(): void {
  counter = 0;
}

export function issue(input: {
  severity: Severity;
  title: string;
  description: string;
  evidence?: string[];
  platform?: Platform;
  affected?: string;
  estimatedImpactBytes?: number;
  estimatedImpactLabel?: string;
  recommendation: string;
  confidence?: Confidence;
  category: Issue['category'];
  id?: string;
}): Issue {
  counter += 1;
  return {
    id: input.id ?? `ISSUE-${String(counter).padStart(3, '0')}`,
    severity: input.severity,
    title: input.title,
    description: input.description,
    evidence: input.evidence ?? [],
    platform: input.platform ?? 'shared',
    affected: input.affected,
    estimatedImpactBytes: input.estimatedImpactBytes,
    estimatedImpactLabel: input.estimatedImpactLabel,
    recommendation: input.recommendation,
    confidence: input.confidence ?? 'medium',
    category: input.category,
  };
}

export function severityRank(severity: Severity): number {
  switch (severity) {
    case 'critical':
      return 0;
    case 'warning':
      return 1;
    case 'info':
      return 2;
    case 'passed':
      return 3;
    default:
      return 4;
  }
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank !== 0) return rank;
    return (b.estimatedImpactBytes ?? 0) - (a.estimatedImpactBytes ?? 0);
  });
}
