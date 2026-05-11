import { EXIT_OPERATION_FAILED, type JsonEnvelope } from '../types.js';

export function printResult<T>(json: boolean, data: T): void {
  if (json) {
    printEnvelope(true, data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function printEnvelope<T>(ok: true, data: T): void;
export function printEnvelope(ok: false, data: undefined, code: string, message: string): void;
export function printEnvelope<T>(ok: boolean, data?: T, code?: string, message?: string): void {
  const payload: JsonEnvelope<T> = ok
    ? { ok: true, data }
    : { ok: false, error: { code: code ?? 'ERROR', message: message ?? 'Unknown error' } };
  console.log(JSON.stringify(payload));
}

export function printJsonLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

export function printMissingRun(json: boolean, runId: string): number {
  if (json) {
    printEnvelope(false, undefined, 'RUN_NOT_FOUND', `Run not found: ${runId}`);
  } else {
    console.error(`Run not found: ${runId}`);
  }
  return EXIT_OPERATION_FAILED;
}

export function printUsageError(json: boolean, message: string, usage?: string, code = 'USAGE_ERROR'): number {
  const fullMessage = usage ? `${message}\n${usage}` : message;
  if (json) {
    printEnvelope(false, undefined, code, fullMessage);
  } else {
    console.error(message);
    if (usage) console.error(usage);
  }
  return EXIT_OPERATION_FAILED;
}
