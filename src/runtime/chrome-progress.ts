export interface ChromeResolveStatus {
  state: 'checking' | 'downloading' | 'retrying' | 'completed' | 'failed' | string;
  progress?: number;
}

export type ChromeResolveStatusHandler = (status: ChromeResolveStatus) => void;

export interface ChromeProgressReporter {
  onStatus(status: ChromeResolveStatus): void;
}

const DEFAULT_PROGRESS_BAR_WIDTH = 30;

export function formatChromeResolveStatus(status: ChromeResolveStatus): string {
  const progress = normalizedProgress(status);
  return `Chrome ${chromeResolveStateLabel(status.state)}${typeof progress === 'number' ? ` ${progress}%` : ''}`;
}

export function formatChromeProgressBar(status: ChromeResolveStatus, width = DEFAULT_PROGRESS_BAR_WIDTH): string {
  const progress = normalizedProgress(status);
  const resolvedProgress = typeof progress === 'number'
    ? progress
    : status.state === 'completed'
      ? 100
      : 0;
  const safeWidth = Math.max(8, Math.min(80, Math.floor(width)));
  const completed = Math.round((resolvedProgress / 100) * safeWidth);
  const bar = `${'='.repeat(completed)}${'-'.repeat(safeWidth - completed)}`;
  const suffix = status.state === 'failed' && typeof progress !== 'number'
    ? ''
    : ` [${bar}] ${resolvedProgress}%`;
  return `Chrome ${chromeResolveStateLabel(status.state)}${suffix}`;
}

function normalizedProgress(status: ChromeResolveStatus): number | undefined {
  return typeof status.progress === 'number' && Number.isFinite(status.progress)
    ? Math.max(0, Math.min(100, Math.round(status.progress)))
    : undefined;
}

export function createChromeProgressReporter(options: {
  enabled: boolean;
  write?: (message: string) => void;
  prefix?: string;
  interactive?: boolean;
  barWidth?: number;
}): ChromeProgressReporter | undefined {
  if (!options.enabled) return undefined;
  const write = options.write ?? ((message: string) => process.stderr.write(message));
  const interactive = options.interactive ?? Boolean(process.stderr.isTTY);
  let lastLine = '';
  let lastRenderedLength = 0;
  return {
    onStatus(status) {
      const line = `${options.prefix ?? ''}${interactive
        ? formatChromeProgressBar(status, options.barWidth)
        : formatChromeResolveStatus(status)}`;
      if (line === lastLine) return;
      lastLine = line;
      if (!interactive) {
        write(`${line}\n`);
        return;
      }

      const final = status.state === 'completed' || status.state === 'failed';
      const padding = lastRenderedLength > line.length ? ' '.repeat(lastRenderedLength - line.length) : '';
      write(`\r${line}${padding}${final ? '\n' : ''}`);
      lastRenderedLength = final ? 0 : line.length;
    }
  };
}

function chromeResolveStateLabel(state: string): string {
  if (state === 'checking') return 'checking';
  if (state === 'downloading') return 'downloading';
  if (state === 'retrying') return 'download retrying';
  if (state === 'completed') return 'ready';
  if (state === 'failed') return 'setup failed';
  return state;
}
