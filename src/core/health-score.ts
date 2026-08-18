import type { HealthScores, Issue } from '../types';

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreCategory(issues: Issue[], category: Issue['category'], base = 100): number {
  let score = base;
  for (const issue of issues.filter((i) => i.category === category)) {
    if (issue.severity === 'critical') score -= 25;
    else if (issue.severity === 'warning') score -= 10;
    else if (issue.severity === 'info') score -= 3;
  }
  return clamp(score);
}

/** Health scores are 0–100 (100 is best). They are not finding counts. */

export function computeHealth(issues: Issue[]): HealthScores {
  const size = scoreCategory(issues, 'size');
  const dependencies = scoreCategory(issues, 'dependencies');
  const assets = scoreCategory(issues, 'assets');
  const performance = scoreCategory(issues, 'performance');
  const security = scoreCategory(issues, 'security');
  const build = scoreCategory(issues, 'build');
  const release = scoreCategory(issues, 'release');
  const overall = clamp(
    size * 0.25 +
      dependencies * 0.15 +
      assets * 0.1 +
      performance * 0.1 +
      security * 0.15 +
      build * 0.1 +
      release * 0.15,
  );
  return { overall, size, dependencies, assets, performance, security, build, release };
}
