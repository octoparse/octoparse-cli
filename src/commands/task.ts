import { firstPositionalArg, hasFlag, parseCsv, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { ApiRequestError, fetchTaskList } from '../runtime/api-client.js';
import { API_KEY_ENV, resolveAuth } from '../runtime/auth.js';
import { inspectTask, TaskDefinitionProvider } from '../runtime/task-definition-provider.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_UNSUPPORTED_TASK } from '../types.js';

export async function taskList(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.apiKey) {
    const message = `API key required. Run "octoparse auth login" or set ${API_KEY_ENV}.`;
    if (json) printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
    else console.error(`Authentication failed: ${message}`);
    return EXIT_OPERATION_FAILED;
  }

  try {
    const result = await fetchTaskList({
      apiKey: auth.apiKey,
      baseUrl: valueAfter(args, '--api-base-url'),
      pageIndex: parsePositiveInt(valueAfter(args, '--page'), 1),
      pageSize: parsePositiveInt(valueAfter(args, '--page-size') ?? valueAfter(args, '--limit'), 20),
      keyword: valueAfter(args, '--keyword'),
      taskIds: parseCsv(valueAfter(args, '--task-ids') ?? valueAfter(args, '--task-id')),
      taskGroup: valueAfter(args, '--task-group'),
      status: valueAfter(args, '--status'),
      taskType: valueAfter(args, '--task-type'),
      isScheduled: valueAfter(args, '--scheduled')
    });

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    console.log(`Tasks: ${result.currentTotal || result.tasks.length}/${result.total}  page=${result.pageIndex} pageSize=${result.pageSize}`);
    console.log(`API: ${result.baseUrl}${result.endpoint}`);
    if (!result.tasks.length) {
      console.log('No tasks found');
      return EXIT_OK;
    }

    for (const task of result.tasks) {
      console.log(formatTaskListLine(task));
    }
    return EXIT_OK;
  } catch (error) {
    const code = error instanceof ApiRequestError ? error.code : 'TASK_LIST_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`${code === 'AUTH_INVALID' ? 'Authentication failed' : 'Failed to fetch task list'}: ${message}`);
      if (error instanceof ApiRequestError && error.body && code !== 'AUTH_INVALID') {
        console.error(`Response: ${error.body}`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

export function formatTaskListLine(task: unknown): string {
  const item = task && typeof task === 'object' ? task as Record<string, unknown> : {};
  const taskId = String(item.taskId ?? item.id ?? '');
  const taskName = String(item.taskName ?? item.name ?? '');
  return `  ${taskId}  ${taskName}`;
}

export async function taskInspect(command: string, args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--task-file']);
  const json = hasFlag(args, '--json');
  const taskFile = valueAfter(args, '--task-file');

  if (!taskId) {
    return printUsageError(
      json,
      'Error: missing taskId',
      `Usage: octoparse task ${command} <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]`
    );
  }

  try {
    const provider = new TaskDefinitionProvider();
    const task = await provider.getTask(taskId, taskFile);
    const inspection = inspectTask(task);

    if (json) {
      printEnvelope(true, inspection);
    } else {
      console.log(`Task: ${inspection.taskId}`);
      console.log(`Name: ${inspection.taskName}`);
      console.log(`Actions: ${inspection.actionCount} (${inspection.actionTypes.join(', ') || 'none'})`);
      console.log(`Fields: ${inspection.fields.join(', ') || 'none'}`);
      console.log(`Kernel browser: ${inspection.usesKernelBrowser ? 'yes' : 'no'}`);
      console.log(command === 'validate' ? 'Validation: ok' : 'Task file is runnable by standalone engine v1.');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      printEnvelope(false, undefined, 'TASK_INVALID', message);
    } else {
      console.error(`Invalid task definition: ${message}`);
    }
    return EXIT_UNSUPPORTED_TASK;
  }
}
