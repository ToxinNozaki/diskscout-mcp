const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Human readable size using 1024 steps, matching how Windows reports sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function mb(n: number): number {
  return n * 1024 * 1024;
}

export function gb(n: number): number {
  return n * 1024 * 1024 * 1024;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
