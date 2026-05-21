import { createCipheriv, randomUUID } from 'node:crypto';
import { hostname, platform, release } from 'node:os';
import { clientVersion } from './client-headers.js';
import type { AuthSource } from './auth.js';
import type { RunOptions, RunStatus, TaskDefinition } from '../types.js';

const TRACKING_URL_ENV = 'OCTOPARSE_TRACKING_URL';
const TRACKING_DISABLED_ENV = 'OCTOPARSE_TRACKING_DISABLED';
const TRACKING_DEBUG_ENV = 'OCTOPARSE_TRACKING_DEBUG';
const DEFAULT_TRACKING_URL = 'https://tracking.octoparse.com';
const UPLOAD_ENDPOINT = '/extract/upload';
const ENCRYPTION_KEY = 'Octopus1';

export type TrackingEventName =
  | 'TrackCollectStart'
  | 'TrackCollectEnd'
  | 'CollectHistory'
  | 'TaskSettings'
  | 'TaskExecutionResult';

export interface TrackingEvent {
  time: string;
  name: TrackingEventName;
  content: Record<string, unknown>;
}

export interface CliTrackingContext {
  userId?: string;
  authSource?: AuthSource;
}

export interface TrackingRunContext {
  runId?: string;
  lotId?: string;
  taskId: string;
  taskName?: string;
  taskType?: string | number;
  collectType?: string;
  options: RunOptions;
  startedAt: number;
  startUtc: string;
  startEntrance: string;
  startWay: 'manual';
  billingWarningCount: number;
}

export class TrackingClient {
  private readonly launchId = randomUUID();

  constructor(
    private readonly context: CliTrackingContext = {},
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  send(event: TrackingEvent): void {
    this.sendMany([event]);
  }

  sendMany(events: TrackingEvent[]): void {
    if (!isTrackingEnabled()) return;
    if (!events.length) return;
    void this.upload(events).catch((error) => {
      if (process.env[TRACKING_DEBUG_ENV] === '1') {
        console.error(`tracking upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async upload(events: TrackingEvent[]): Promise<void> {
    const payload = {
      product: 'Octoparse',
      channel: 'Cli',
      version: clientVersion(),
      common: {
        launchId: this.launchId,
        userId: this.context.userId ?? '',
        os: `${platform()} ${release()}`,
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        language: process.env.LANG ?? '',
        nodeVersion: process.version,
        keySource: this.context.authSource ?? 'none',
        time: trackingTimeNow()
      },
      events
    };

    const response = await this.fetchImpl(`${trackingBaseUrl()}${UPLOAD_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        data: encryptTrackingPayload(JSON.stringify(payload))
      })
    });
    if (!response.ok) {
      throw new Error(`tracking HTTP ${response.status}`);
    }
    if (process.env[TRACKING_DEBUG_ENV] === '1') {
      console.error(`tracking upload success: ${response.status} ${events.map((event) => event.name).join(',')}`);
    }
  }
}

export function createTrackingClient(context: CliTrackingContext = {}): TrackingClient {
  return new TrackingClient(context);
}

export function createTrackingRunContext(options: {
  taskId: string;
  runOptions: RunOptions;
  billingWarningCount: number;
}): TrackingRunContext {
  const now = Date.now();
  return {
    taskId: options.taskId,
    options: options.runOptions,
    startedAt: now,
    startUtc: formatTrackingTime(now),
    startEntrance: 'cli_run_command',
    startWay: 'manual',
    billingWarningCount: options.billingWarningCount
  };
}

export function markTrackingRunStarted(context: TrackingRunContext, event: {
  runId: string;
  lotId: string;
  taskId: string;
  taskName: string;
}): void {
  context.runId = event.runId;
  context.lotId = event.lotId;
  context.taskId = event.taskId;
  context.taskName = event.taskName;
}

export function markTrackingTaskLoaded(context: TrackingRunContext, task: TaskDefinition): void {
  context.taskId = task.taskId;
  context.taskName = task.taskName;
  context.collectType = inferCollectType(task);
  context.taskType = task.workFlowType ?? (task.isTemplate ? 10 : 'custom');
}

export function collectStartTrackingEvent(
  context: TrackingRunContext,
  success: boolean,
  failReason = ''
): TrackingEvent {
  return {
    time: trackingTimeNow(),
    name: 'TrackCollectStart',
    content: {
      taskId: context.taskId,
      taskFile: context.options.taskFile ?? '',
      collectType: context.collectType ?? 'Unknown',
      entrance: context.startEntrance,
      speed: false,
      startWay: context.startWay,
      success,
      fail_reason: failReason,
      timeSpend: Date.now() - context.startedAt,
      newCreate: false,
      taskType: context.taskType ?? 'unknown'
    }
  };
}

export function collectEndTrackingEvents(context: TrackingRunContext, options: {
  status: RunStatus;
  endWay: 'manual' | 'finish';
  success: boolean;
  failReason?: string;
  total: number;
  stoppedAt?: string;
  useCaptchaCount?: number | null;
  useProxyCount?: number | null;
  localTaskCharge?: number | null;
}): TrackingEvent[] {
  const endTime = options.stoppedAt ? new Date(options.stoppedAt) : new Date();
  const endText = formatTrackingTime(endTime);
  return [
    {
      time: trackingTimeNow(),
      name: 'TrackCollectEnd',
      content: {
        taskId: context.taskId,
        taskFile: context.options.taskFile ?? '',
        collectType: context.collectType ?? 'Unknown',
        speed: false,
        endWay: options.endWay,
        success: options.success,
        fail_reason: options.failReason ?? ''
      }
    },
    {
      time: trackingTimeNow(),
      name: 'CollectHistory',
      content: {
        taskId: context.taskId,
        taskFile: context.options.taskFile ?? '',
        speed: false,
        collectType: context.collectType ?? 'Unknown',
        collectCount: options.total,
        collectStart: context.startUtc,
        collectEnd: endText,
        collectUrl: []
      }
    },
    {
      time: trackingTimeNow(),
      name: 'TaskExecutionResult',
      content: {
        taskId: context.taskId,
        taskFile: context.options.taskFile ?? '',
        subTaskId: null,
        lotNo: context.lotId ?? '',
        taskExecutionResult: {
          status: options.status,
          startTime: context.startedAt,
          endTime: Date.now(),
          useTime: Date.now() - context.startedAt,
          endWay: options.endWay,
          total: options.total,
          useCaptchaCount: options.useCaptchaCount ?? null,
          useProxyCount: options.useProxyCount ?? null,
          balance: null,
          localTaskCharge: options.localTaskCharge ?? null
        }
      }
    }
  ];
}

export function taskSettingsTrackingEvent(context: TrackingRunContext, task: TaskDefinition): TrackingEvent {
  return {
    time: trackingTimeNow(),
    name: 'TaskSettings',
    content: {
      taskId: context.taskId,
      taskFile: context.options.taskFile ?? '',
      subTaskId: null,
      lotNo: context.lotId ?? '',
      taskSettings: {
        taskName: task.taskName,
        taskType: task.workFlowType ?? null,
        runnerType: inferRunnerType(task),
        isSpeedMode: false,
        isJson: false,
        ipProxy: inferProxySettings(task),
        userAgent: inferUserAgentSettings(task),
        cookie: inferCookieSettings(task)
      }
    }
  };
}

export function trackingBaseUrl(): string {
  return (process.env[TRACKING_URL_ENV] || DEFAULT_TRACKING_URL).replace(/\/+$/, '');
}

function isTrackingEnabled(): boolean {
  return process.env[TRACKING_DISABLED_ENV] !== '1';
}

function inferCollectType(task: TaskDefinition): string {
  if (task.isTemplate) return 'Template';
  if (typeof task.workFlowType === 'number') return String(task.workFlowType);
  return 'Custom';
}

function inferRunnerType(task: TaskDefinition): string {
  if (/useKernelBrowser="true"/i.test(task.xml)) return 'kernel';
  return 'chrome';
}

function inferProxySettings(task: TaskDefinition): Record<string, unknown> {
  const settings = getRecord(getRecord(task.brokerSettings)?.ipProxySettings);
  return {
    type: normalizeNone(settings?.ipProxyFromType),
    period: numberValue(getRecord(settings?.strongIpProxySettings)?.period) ?? null
  };
}

function inferUserAgentSettings(task: TaskDefinition): Record<string, unknown> {
  const settings = getRecord(getRecord(task.brokerSettings)?.userAgentSwitchSettings);
  return {
    switchType: task.userAgent ? 'Custom' : normalizeNone(settings?.switchType),
    period: numberValue(settings?.customPeriod) ?? null
  };
}

function inferCookieSettings(task: TaskDefinition): Record<string, unknown> {
  const settings = getRecord(getRecord(task.brokerSettings)?.cookieClearSettings);
  return {
    clearType: normalizeNone(settings?.clearType),
    period: numberValue(settings?.customPeriod) ?? null
  };
}

function normalizeNone(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (value === 0 || value === '0') return 'None';
  return value;
}

function encryptTrackingPayload(clearText: string): string {
  const keyBuffer = Buffer.alloc(16);
  keyBuffer.write(ENCRYPTION_KEY);
  const cipher = createCipheriv('aes-128-ecb', keyBuffer, null);
  return cipher.update(clearText, 'utf8', 'base64') + cipher.final('base64');
}

function trackingTimeNow(): string {
  return formatTrackingTime(new Date());
}

export function formatTrackingTime(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  const micros = `${pad3(date.getMilliseconds())}000`;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = pad2(Math.floor(absoluteOffset / 60));
  const offsetRemainderMinutes = pad2(absoluteOffset % 60);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${micros}${sign}${offsetHours}:${offsetRemainderMinutes}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
