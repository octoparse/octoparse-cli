import { gzipSync } from 'node:zlib';
import { fetchAccountInfo, fetchUserDefaultTaskGroupId, saveTaskInfo, type TaskSaveResult } from './api-client.js';
import type { AuthCredential } from './auth.js';
import { clientVersion } from './client-headers.js';

const TASK_STATUS_READY = 1;
const TASK_PRIORITY_NORMAL = 3;
const TASK_PARALLEL_CAPACITY_DEFAULT = 2;
const TASK_TYPE_WEB = 1;
const TASK_SCHEDULE_MANUAL = 5;
const WORKFLOW_TYPE_ADVANCED = 1;
const TASK_DOWNLOAD_STATUS_ASK = 0;
const DEFAULT_TASK_GROUP_ID = 1;
const DEFAULT_EFFECTIVE_TO = '2078-07-06T00:00:00.000Z';

export interface SaveDetectedTaskToCloudOptions {
  auth: AuthCredential;
  task: CloudSavableTask;
  baseUrl?: string;
}

export interface CloudSavableTask {
  taskId: string;
  taskName: string;
  xml: string;
  workflowSetting?: unknown;
  brokerSettings?: unknown;
  template?: unknown;
  workFlowType?: number;
  userAgent?: string;
  disableAD?: boolean;
  disableImage?: boolean;
}

export async function saveDetectedTaskToCloud(options: SaveDetectedTaskToCloudOptions): Promise<TaskSaveResult> {
  const account = await fetchAccountInfo({ auth: options.auth, baseUrl: options.baseUrl });
  const userId = stringValue(account.data.userId);
  const taskGroupId = await fetchUserDefaultTaskGroupId({ auth: options.auth, baseUrl: options.baseUrl }).catch(() => undefined);
  const result = await saveTaskInfo({
    auth: options.auth,
    baseUrl: options.baseUrl,
    taskInfo: detectedTaskToCloudTaskInfo(options.task, userId, taskGroupId)
  });
  if (result.status !== 1) {
    throw new Error(saveTaskStatusMessage(result));
  }
  return result;
}

export function detectedTaskToCloudTaskInfo(task: CloudSavableTask, userId = '', taskGroupId = DEFAULT_TASK_GROUP_ID): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    taskGroupId: taskGroupId > 0 ? taskGroupId : DEFAULT_TASK_GROUP_ID,
    description: '',
    disableMapReduce: false,
    disableImage: Boolean(task.disableImage),
    adBlockEnable: Boolean(task.disableAD),
    userAgent: task.userAgent ?? '',
    supplementEnable: false,
    author: userId,
    optimizationType: 0,
    status: TASK_STATUS_READY,
    incrementalExtractSettings: {
      taskId: '',
      parameters: '',
      compareType: 0,
      sampleUrl: '',
      selectedParameters: ''
    },
    taskId: task.taskId,
    taskName: task.taskName,
    taskType: TASK_TYPE_WEB,
    useMobileAgent: false,
    userId,
    version: clientVersion(),
    workFlowType: Number(task.workFlowType) || WORKFLOW_TYPE_ADVANCED,
    localMapReduce: false,
    configDownload: false,
    downloadStatus: TASK_DOWNLOAD_STATUS_ASK,
    showSettingAfterSave: false,
    useKernelBrowser: false,
    useChromeBrowser: true,
    xoml: encodeTaskXml(task.xml),
    priority: TASK_PRIORITY_NORMAL,
    capacity: TASK_PARALLEL_CAPACITY_DEFAULT,
    scheduleDate: '',
    scheduleTime: '0',
    scheduleType: TASK_SCHEDULE_MANUAL,
    effectiveFrom: now,
    effectiveTo: DEFAULT_EFFECTIVE_TO,
    brokerSettings: task.brokerSettings ?? {},
    template: task.template ?? null,
    ...(task.workflowSetting ? { workflowSetting: task.workflowSetting } : {})
  };
}

export function encodeTaskXml(xml: string): string {
  const textBuffer = Buffer.from(xml, 'ucs2');
  const zipBuffer = gzipSync(textBuffer);
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeInt32LE(zipBuffer.length, 0);
  return Buffer.concat([lengthPrefix, zipBuffer]).toString('base64');
}

function saveTaskStatusMessage(result: TaskSaveResult): string {
  if (result.status === 2) {
    const suffix = result.taskCountLimit > 0
      ? ` Current task count ${result.taskCount}, limit ${result.taskCountLimit}.`
      : '';
    return `The cloud task limit has been reached; the task cannot be saved.${suffix}`;
  }
  return `Failed to save task to cloud. Server status: ${result.status || 'unknown'}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
