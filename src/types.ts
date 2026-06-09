export const EXIT_OK = 0;
export const EXIT_OPERATION_FAILED = 1;
export const EXIT_RUNTIME_FAILED = 2;
export const EXIT_UNSUPPORTED_TASK = 3;

export type DataExportFormat = 'xlsx' | 'csv' | 'html' | 'json' | 'xml';
export type RunStatus = 'running' | 'paused' | 'stopping' | 'completed' | 'failed' | 'stopped';

export interface TaskDefinition {
  taskId: string;
  taskName: string;
  xml: string;
  xoml: string;
  fieldNames: string[];
  recognition?: {
    session?: {
      name: string;
      origin: string;
      savedAt?: string;
      cookieCount?: number;
      kind?: string;
      compatibility?: string;
      hosts?: string[];
    };
    [key: string]: unknown;
  };
  workflowSetting?: unknown;
  brokerSettings?: unknown;
  template?: unknown;
  workFlowType?: number;
  templateVersionId?: string | number;
  isTemplate?: boolean;
  userAgent?: string;
  disableAD?: boolean;
  disableImage?: boolean;
}

export interface RunOptions {
  taskId: string;
  taskFile?: string;
  outputDir: string;
  headless: boolean;
  json: boolean;
  jsonl: boolean;
  chromePath?: string;
  disableImage: boolean;
  disableAD: boolean;
  runTimeoutMs: number;
  extensionTimeoutMs: number;
  debugBridge: boolean;
  detach: boolean;
  maxRows?: number;
}

export interface RunSummary {
  runId: string;
  lotId: string;
  taskId: string;
  taskName?: string;
  status: RunStatus;
  total: number;
  outputDir: string;
  startedAt: string;
  stoppedAt?: string;
  stopReason?: string;
  maxRows?: number;
  downloads?: {
    status: string;
    outputDir?: string;
    total: number;
    pending: number;
    downloading: number;
    succeeded: number;
    failed: number;
    canceled: number;
    completed: number;
  };
}

export type CaptchaType =
  | 'image'
  | 'slider'
  | 'click'
  | 'recaptcha-v2'
  | 'recaptcha-v2-callback'
  | 'recaptcha-v3'
  | 'recaptcha-v3-callback'
  | 'hcaptcha'
  | 'hcaptcha-callback'
  | 'cloudflare'
  | 'unknown';

export interface CaptchaRequest {
  captchaType?: CaptchaType | number;
  url?: string;
  key?: string;
  action?: string;
  image?: string;
  image2?: string;
  data?: unknown;
}

export interface ProxyRequest {
  taskId: string;
}

export interface ProxyResponse {
  proxyIp: {
    ip?: string;
    port?: number;
    account?: string;
    password?: string;
    user?: string;
    host?: string;
    protocol?: number;
    encryptIp?: string;
    encryptAccount?: string;
    encryptPassword?: string;
  };
}

export interface JsonEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
