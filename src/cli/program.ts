import { Command } from 'commander';
import { resolve } from 'node:path';
import { analyzeAndroidOnly, analyzeIosOnly, analyzeProject } from '../core/analyzer';
import { detectProject } from '../core/project-detector';
import { TOOL_NAME, TOOL_VERSION } from '../version';
import { EXIT, type AnalyzeOptions } from '../types';
import { emit, maybeOpenReport, writeReports } from './report';

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

function normalizePlatform(platform: string | undefined): 'android' | 'ios' | undefined {
  if (!platform) return undefined;
  const value = platform.trim().replace(/[,\s]+$/g, '').toLowerCase();
  if (value === 'android' || value === 'ios') return value;
  return undefined;
}

function printUsageError(received?: string): void {
  if (received) {
    process.stderr.write(`Unknown argument: ${received}\n`);
  }
  process.stderr.write('Use: rn-size-analyzer    or    rn-size-analyzer android    or    rn-size-analyzer ios\n');
  process.stderr.write('Build artifacts are auto-detected. Do not pass an APK, AAB, or IPA path.\n');
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
      .description('Analyze Android and iOS, or one platform. Auto-detects AAB/APK and IPA when present.')
      .argument('[platform]', 'android | ios. Omit to analyze both.'),
  ).action(async (platform: string | undefined, options: Record<string, unknown>, cmd: Command) => {
    const opts = mergedOpts(options, cmd);
    const cwd = cwdFrom(opts);
    const normalized = normalizePlatform(platform);
    if (platform && !normalized) {
      printUsageError(platform);
      process.exitCode = EXIT.INVALID;
      return;
    }
    try {
      if (normalized === 'android') {
        const analysis = await analyzeAndroidOnly(baseOptions(opts, cwd));
        process.exitCode = await finish(analysis, baseOptions(opts, cwd));
        return;
      }
      if (normalized === 'ios') {
        const analysis = await analyzeIosOnly(baseOptions(opts, cwd));
        process.exitCode = await finish(analysis, baseOptions(opts, cwd));
        return;
      }
      const detected = detectProject(cwd);
      if (!detected.isReactNative && !detected.overview.androidDetected && !detected.overview.iosDetected) {
        process.stderr.write(`${detected.invalidReason ?? 'Not a React Native project.'}\n`);
        process.exitCode = EXIT.INVALID;
        return;
      }
      const analyzeOpts = baseOptions(opts, cwd);
      const analysis = await analyzeProject(analyzeOpts);
      process.exitCode = await finish(analysis, analyzeOpts);
    } catch (error) {
      process.stderr.write(`Analyzer error: ${(error as Error).message}\n`);
      process.exitCode = EXIT.ANALYZER_ERROR;
    }
  });

  return program;
}
