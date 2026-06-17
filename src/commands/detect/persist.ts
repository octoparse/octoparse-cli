import { writeFile } from 'node:fs/promises';
import { valueAfter } from '../../cli/args.js';
import { resolveAuth } from '../../runtime/auth.js';
import { saveDetectedTaskToCloud, type CloudSavableTask } from '../../runtime/task-cloud-save.js';

export const SKIP_DETECT_CLOUD_SAVE_ENV = 'OCTOPARSE_DETECT_SKIP_CLOUD_SAVE';

export async function persistGeneratedTask(options: {
  task: CloudSavableTask;
  file: string;
  args: string[];
  saveToCloud?: boolean;
}): Promise<void> {
  await writeFile(options.file, `${JSON.stringify(options.task, null, 2)}\n`, 'utf8');
  if (options.saveToCloud === false || process.env[SKIP_DETECT_CLOUD_SAVE_ENV] === '1') return;

  const auth = await resolveAuth();
  if (!auth.credential) {
    throw new Error('Task was written to the local file, but cloud saving requires authentication. Run "octoparse auth login" and try again.');
  }

  await saveDetectedTaskToCloud({
    auth: auth.credential,
    baseUrl: valueAfter(options.args, '--api-base-url'),
    task: options.task
  });
}
