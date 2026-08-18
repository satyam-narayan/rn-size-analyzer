export interface ProgressLogger {
  step(label: string, ok?: boolean, detail?: string): void;
  warn(message: string): void;
  error(message: string): void;
  info(message: string): void;
}

export function createProgress(silent = false): ProgressLogger {
  return {
    step(label: string, ok = true, detail?: string) {
      if (silent) return;
      const mark = ok ? '✓' : '–';
      const suffix = detail ? ` ${detail}` : '';
      process.stderr.write(`${label}... ${mark}${suffix}\n`);
    },
    warn(message: string) {
      if (silent) return;
      process.stderr.write(`⚠ ${message}\n`);
    },
    error(message: string) {
      process.stderr.write(`✗ ${message}\n`);
    },
    info(message: string) {
      if (silent) return;
      process.stderr.write(`${message}\n`);
    },
  };
}
