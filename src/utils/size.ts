const DECIMAL: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1000,
  mb: 1000 * 1000,
  gb: 1000 * 1000 * 1000,
};

const BINARY: Record<string, number> = {
  kib: 1024,
  mib: 1024 * 1024,
  gib: 1024 * 1024 * 1024,
};

export function parseSize(input: string): number {
  const trimmed = input.trim().replace(/,/g, '');
  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) {
    throw new Error(`Invalid size value: "${input}". Expected examples: 2MB, 512KB, 1000000.`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = DECIMAL[unit] ?? BINARY[unit];
  if (!multiplier) {
    throw new Error(`Unknown size unit "${match[2]}" in "${input}".`);
  }
  return Math.round(value * multiplier);
}

/** Display sizes using decimal units (same as macOS Finder / Play Console): 1 MB = 1,000,000 bytes. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1000) return `${sign}${abs} B`;
  if (abs < 1000 * 1000) return `${sign}${(abs / 1000).toFixed(fractionDigits)} KB`;
  if (abs < 1000 * 1000 * 1000) return `${sign}${(abs / (1000 * 1000)).toFixed(fractionDigits)} MB`;
  return `${sign}${(abs / (1000 * 1000 * 1000)).toFixed(fractionDigits)} GB`;
}

export function formatBytesExact(bytes: number): string {
  return formatBytes(bytes);
}

export function percentChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return ((after - before) / before) * 100;
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}
