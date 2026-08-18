import { Command } from 'commander';
import { resolve } from 'node:path';
import { analyzeAndroidOnly, analyzeIosOnly, analyzeProject, compareArtifacts } from '../core/analyzer';
import { artifactKind, detectProject } from '../core/project-detector';
import { TOOL_NAME, TOOL_VERSION } from '../version';
import { EXIT, type AnalyzeOptions, type FailOn } from '../types';
import { emit, maybeOpenReport, writeReports } from './report';
import { toJson } from '../reporters/json';
import { printCheckFailure, printCheckPass } from '../reporters/terminal';
import { loadConfig } from '../utils/config';
import { parseSize, formatBytes } from '../utils/size';
import { isDirectory, isFile, readJsonIfExists } from '../utils/fs';
import { createProgress } from '../utils/progress';

function addCommonOptions(command: Command): Command {
  return command
    .option('-f, --format <format>', 'terminal | html | json', 'terminal')
    .option('--out <dir>', 'Report directory', 'rn-size-report')
    .option('--open', 'Open the HTML dashboard without prompting')
    .option('--quiet', 'Reduce progress output')
    .option('--cwd <dir>', 'Project directory');
}

function mergedOpts(options: Record<string, unknown>, cmd: Command): Record<string, unknown> {
  const globals = cmd.optsWithGlobals() as Record<string, unknown>;
  const result: Record<string, unknown> = { ...globals };
  for (const key of Object.keys(options)) {
    if (cmd.getOptionValueSource(key) === 'cli') {
      result[key] = options[key];
    }
  }
  return result;
}

function cwdFrom(opts: Record<string, unknown>): string {
  return resolve(String(opts.cwd ?? process.cwd()));
}

function baseOptions(opts: Record<string, unknown>, cwd = process.cwd()): AnalyzeOptions {
  return {
    cwd,
    format: opts.format as AnalyzeOptions['format'],
    open: opts.open as boolean | undefined,
    reportDir: opts.out as string | undefined,
    jsonStdout: opts.format === 'json',
    silent: opts.format === 'json' || Boolean(opts.quiet),
  };
}

function finish(analysis: Awaited<ReturnType<typeof analyzeProject>>, options: AnalyzeOptions): Promise<number> {
  const paths = writeReports(analysis, options);
  emit(analysis, options.format, options.jsonStdout);
  if (options.format !== 'json') {
    process.stderr.write(`\nReport:\n${paths.htmlPath}\n`);
  }
  return maybeOpenReport(paths.htmlPath, options).then(() => EXIT.PASS);
}

function artifactExists(abs: string): boolean {
  if (isFile(abs)) return true;
  return artifactKind(abs) === 'app' && isDirectory(abs);
}

function normalizeTargetToken(target: string | undefined): string | undefined {
  if (!target) return undefined;
  return target.trim().replace(/[,\s]+$/g, '').toLowerCase();
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name(TOOL_NAME)
    .description('React Native project, build, and release size analyzer')
    .version(TOOL_VERSION, '-V, --version', 'Print version')
    .helpOption('-h, --help', 'Show help');
  addCommonOptions(program);

  addCommonOptions(
    program
      .command('analyze', { isDefault: true })
      .description('Analyze Android and iOS. Auto-detects AAB/APK and IPA when present.')
      .argument('[target]', 'Optional path to .apk, .aab, .ipa, or .app'),
  ).action(async (target: string | undefined, options: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(options, cmd);
    const cwd = cwdFrom(opts);
    const normalizedTarget = normalizeTargetToken(target);
    const analyzeOpts = { ...baseOptions(opts, cwd), target };
    try {
      if (normalizedTarget === 'android') {
        const analysis = await analyzeAndroidOnly({ ...baseOptions(opts, cwd) });
        process.exitCode = await finish(analysis, baseOptions(opts, cwd));
        return;
      }
      if (normalizedTarget === 'ios') {
        const analysis = await analyzeIosOnly({ ...baseOptions(opts, cwd) });
        process.exitCode = await finish(analysis, baseOptions(opts, cwd));
        return;
      }
      if (target) {
        const abs = resolve(cwd, target);
        if (!artifactExists(abs)) {
          process.stderr.write(`Invalid project/build: file not found: ${abs}\n`);
          process.exitCode = EXIT.INVALID;
          return;
        }
      } else {
        const detected = detectProject(cwd);
        if (!detected.isReactNative && !detected.overview.androidDetected && !detected.overview.iosDetected) {
          process.stderr.write(`${detected.invalidReason ?? 'Not a React Native project.'}\n`);
          process.exitCode = EXIT.INVALID;
          return;
        }
      }
      const analysis = await analyzeProject(analyzeOpts);
      process.exitCode = await finish(analysis, analyzeOpts);
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  addCommonOptions(
    program
      .command('android')
      .description('Analyze Android project and auto-detect AAB/APK if present')
      .argument('[target]', 'Optional .apk or .aab'),
  ).action(async (target: string | undefined, options: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(options, cmd);
    const cwd = cwdFrom(opts);
    try {
      const analysis = await analyzeAndroidOnly({ ...baseOptions(opts, cwd), target });
      process.exitCode = await finish(analysis, { ...baseOptions(opts, cwd), target });
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  addCommonOptions(
    program
      .command('ios')
      .description('Analyze iOS project and auto-detect IPA if present')
      .argument('[target]', 'Optional .ipa or .app'),
  ).action(async (target: string | undefined, options: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(options, cmd);
    const cwd = cwdFrom(opts);
    try {
      const analysis = await analyzeIosOnly({ ...baseOptions(opts, cwd), target });
      process.exitCode = await finish(analysis, { ...baseOptions(opts, cwd), target });
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  addCommonOptions(
    program
      .command('compare')
      .description('Compare two Android or iOS build artifacts')
      .argument('<old-build>', 'Older .apk/.aab/.ipa')
      .argument('<new-build>', 'Newer .apk/.aab/.ipa'),
  ).action(async (oldBuild: string, newBuild: string, options: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(options, cmd);
    const cwd = cwdFrom(opts);
    const progress = createProgress(opts.format === 'json');
    try {
      progress.step('Comparing artifacts');
      const comparison = compareArtifacts(resolve(cwd, oldBuild), resolve(cwd, newBuild));
      const analysis = await analyzeProject({ ...baseOptions(opts, cwd), silent: true });
      analysis.comparison = comparison;
      analysis.issues = [...comparison.issues, ...analysis.issues];
      process.exitCode = await finish(analysis, baseOptions(opts, cwd));
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  addCommonOptions(
    program
      .command('check')
      .description('CI mode: fail if configured size limits are exceeded')
      .option('--max-increase <size>', 'Maximum allowed archive increase vs baseline, e.g. 2MB')
      .option('--max-size <size>', 'Maximum allowed archive size')
      .option('--baseline <file>', 'Baseline JSON from a previous report')
      .option('--json', 'Write JSON to stdout')
      .option('--fail-on <level>', 'critical | error | warning | never')
      .argument('[target]', 'Optional artifact to measure'),
  ).action(async (target: string | undefined, local: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(local, cmd);
    const cwd = cwdFrom(opts);
    const config = loadConfig(cwd);
    const jsonStdout = Boolean(local.json) || opts.format === 'json';
    try {
      const analysis = await analyzeProject({
        ...baseOptions(opts, cwd),
        target,
        jsonStdout,
        silent: true,
      });
      const paths = writeReports(analysis, { ...baseOptions(opts, cwd), jsonStdout });
      if (jsonStdout) {
        process.stdout.write(toJson(analysis) + '\n');
      }

      const baselinePath =
        String(local.baseline ?? config.baselinePath ?? resolve(cwd, 'rn-size-report', 'baseline.json'));
      const baseline = readJsonIfExists<{ androidBytes?: number; iosBytes?: number }>(baselinePath);
      const maxIncrease = local.maxIncrease ?? config.android?.maxIncrease ?? config.ios?.maxIncrease;
      const maxSize = local.maxSize ?? config.android?.maxSize ?? config.ios?.maxSize;
      const failOn = (local.failOn ?? config.failOn ?? 'error') as FailOn;

      const current = analysis.android.artifact?.archiveBytes ?? analysis.ios.artifact?.archiveBytes;
      const previous = analysis.android.artifact
        ? baseline?.androidBytes
        : analysis.ios.artifact
          ? baseline?.iosBytes
          : undefined;

      if (maxSize && current !== undefined) {
        const limit = parseSize(String(maxSize));
        if (current > limit) {
          printCheckFailure(`App size is ${formatBytes(current)}\nAllowed size: ${formatBytes(limit)}`);
          process.exitCode = EXIT.THRESHOLD;
          return;
        }
      }

      if (maxIncrease && current !== undefined && previous !== undefined) {
        const limit = parseSize(String(maxIncrease));
        const increase = current - previous;
        if (increase > limit) {
          printCheckFailure(
            `App size increased by ${formatBytes(increase)}\nAllowed increase: ${formatBytes(limit)}`,
          );
          process.exitCode = EXIT.THRESHOLD;
          return;
        }
      }

      const hasCritical = analysis.issues.some((i) => i.severity === 'critical');
      const hasWarning = analysis.issues.some((i) => i.severity === 'warning');
      if (failOn === 'never') {
        if (!jsonStdout) printCheckPass(`Report: ${paths.htmlPath}`);
        process.exitCode = EXIT.PASS;
        return;
      }
      if (failOn === 'critical' && hasCritical) {
        printCheckFailure('Critical issues found.');
        process.exitCode = EXIT.THRESHOLD;
        return;
      }
      if ((failOn === 'error' || failOn === 'warning') && hasCritical) {
        printCheckFailure('Critical issues found.');
        process.exitCode = EXIT.THRESHOLD;
        return;
      }
      if (failOn === 'warning' && hasWarning) {
        printCheckFailure('Warning issues found.');
        process.exitCode = EXIT.THRESHOLD;
        return;
      }

      if (!jsonStdout) {
        printCheckPass(`Report: ${paths.htmlPath}`);
      }
      process.exitCode = EXIT.PASS;
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  return program;
}
