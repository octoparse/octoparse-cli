import { resolve } from 'node:path';

export function defaultExportFileName(taskName: string, format: string): string {
  return resolve(`${safeFileName(taskName)}.${format}`);
}

export function safeFileName(value: string): string {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '_')
    .slice(0, 120);
  return safe || 'octopus-export';
}

export function safeTaskName(value: string): string {
  const withoutScheme = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const name = safeFileName(withoutScheme).replace(/^_+|_+$/g, '');
  return name || 'octopus-task';
}
