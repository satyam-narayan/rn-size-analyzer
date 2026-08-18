import { join } from 'node:path';
import type { AnalyzerConfig } from '../types';
import { readJsonIfExists } from './fs';

export const CONFIG_FILE_NAME = '.rn-size-analyzer.json';

export function loadConfig(cwd: string, override?: AnalyzerConfig): AnalyzerConfig {
  const fromFile = readJsonIfExists<AnalyzerConfig>(join(cwd, CONFIG_FILE_NAME)) ?? {};
  return mergeConfig(fromFile, override ?? {});
}

export function mergeConfig(base: AnalyzerConfig, override: AnalyzerConfig): AnalyzerConfig {
  return {
    ...base,
    ...override,
    android: { ...base.android, ...override.android },
    ios: { ...base.ios, ...override.ios },
    ignore: override.ignore ?? base.ignore ?? [],
    rules: { ...base.rules, ...override.rules },
  };
}

export function isIgnored(config: AnalyzerConfig, issueId: string): boolean {
  return (config.ignore ?? []).includes(issueId);
}
