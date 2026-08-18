import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { AnalyzeOptions, OutputFormat, ProjectAnalysis } from '../types';
import { writeHtmlReport } from '../reporters/html';
import { writeJsonReport, toJson } from '../reporters/json';
import { printTerminal } from '../reporters/terminal';
import { writeJson } from '../utils/fs';

export function defaultReportDir(cwd: string, override?: string): string {
  return resolve(cwd, override ?? 'rn-size-report');
}

export function writeReports(
  analysis: ProjectAnalysis,
  options: { cwd: string; reportDir?: string; format?: OutputFormat; jsonStdout?: boolean },
): { htmlPath: string; jsonPath: string } {
  const dir = defaultReportDir(options.cwd, options.reportDir);
  const htmlPath = writeHtmlReport(dir, analysis);
  const jsonPath = writeJsonReport(dir, analysis);
  writeJson(join(dir, 'baseline.json'), {
    generatedAt: analysis.generatedAt,
    androidBytes: analysis.android.artifact?.archiveBytes,
    iosBytes: analysis.ios.artifact?.archiveBytes,
    overview: analysis.overview,
  });
  return { htmlPath, jsonPath };
}

export function emit(analysis: ProjectAnalysis, format: OutputFormat | undefined, jsonStdout?: boolean): void {
  if (jsonStdout || format === 'json') {
    process.stdout.write(toJson(analysis) + '\n');
    return;
  }
  if (format !== 'html') {
    printTerminal(analysis);
  }
}

export function openPath(filePath: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export async function maybeOpenReport(htmlPath: string, options: AnalyzeOptions): Promise<void> {
  if (options.open === false) return;
  if (options.open === true) {
    openPath(htmlPath);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || options.jsonStdout || options.format === 'json') {
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question('Open report? [Y/n] ', resolveAnswer);
  });
  rl.close();
  if (!answer || /^y/i.test(answer)) openPath(htmlPath);
}
