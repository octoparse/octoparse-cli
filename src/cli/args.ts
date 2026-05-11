export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function firstPositionalArg(args: string[], valueFlags: string[] = []): string | undefined {
  const flagsWithValues = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return args[index + 1];
    if (arg.startsWith('-')) {
      if (flagsWithValues.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

export function parseCsv(value: string | undefined): string[] | undefined {
  const items = value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return items.length ? items : undefined;
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
