import { join } from 'node:path';
import type { ProjectAnalysis } from '../types';
import { writeJson } from '../utils/fs';

export function toJson(analysis: ProjectAnalysis): string {
  return JSON.stringify(analysis, null, 2);
}

export function writeJsonReport(reportDir: string, analysis: ProjectAnalysis): string {
  const file = join(reportDir, 'report.json');
  writeJson(file, analysis);
  return file;
}
