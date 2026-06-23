import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import prompts from 'prompts';
import { hasFlag, valueAfter } from '../../cli/args.js';
import { printEnvelope, printUsageError } from '../../cli/output.js';
import type { AgentPlan, AgentPlanPreview, AgentSampleRunSummary } from '../../runtime/detector/agent-types.js';
import { buildAgentContext } from '../../runtime/detector/agent-context.js';
import { buildTaskFromAgentPlan, previewAgentPlan } from '../../runtime/detector/agent-plan.js';
import type { PageDetectionResult, DetectedAgentScreenshot } from '../../runtime/detector/types.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../../types.js';
import { runTask } from '../run.js';
import { defaultDetectedTaskName, parseOptionalPositiveInt, resolveAvailableDetectedTaskFile } from './args.js';
import { agentFiles } from './agent-plan-command.js';
import { printAgentPlanPreview } from './format.js';
import { persistGeneratedTask } from './persist.js';

export async function runInlineAgentDetect(options: {
  args: string[];
  result: PageDetectionResult;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const command = valueAfter(options.args, '--agent-command') ?? process.env.OCTOPARSE_AGENT_COMMAND;
  if (!command) {
    return printUsageError(
      options.json,
      'Missing Agent command: pass --agent-command or set OCTOPARSE_AGENT_COMMAND.',
      'Example: octoparse detect URL --agent --agent-command "node make-plan.mjs" --output task.json',
      'USAGE_ERROR'
    );
  }

  let workDir: string | undefined;
  try {
    const context = buildAgentContext(options.result, valueAfter(options.args, '--goal'));
    workDir = await mkdtemp(join(tmpdir(), 'octopus-agent-'));
    const contextFile = join(workDir, 'context.json');
    const planFile = join(workDir, 'plan.json');
    await writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

    const agent = await runAgentCommand({
      command,
      contextFile,
      planFile,
      goal: valueAfter(options.args, '--goal')
    });
    const plan = agent.plan;
    const preview = previewAgentPlan({ context, plan });

    if (!preview.pass && !hasFlag(options.args, '--allow-agent-risk')) {
      if (options.json) {
        printEnvelope(false, undefined, 'AGENT_PLAN_RISK', 'Agent plan preview did not pass; use --allow-agent-risk to force generation.');
      } else {
        if (!options.quiet) printAgentPlanPreview(preview, context.screenshot);
        console.error('Agent plan preview did not pass; use --allow-agent-risk to force generation.');
      }
      return EXIT_OPERATION_FAILED;
    }

    if (hasFlag(options.args, '--confirm-agent-plan') && !await confirmAgentPreview(preview, context.screenshot, options.quiet)) {
      if (options.json) printEnvelope(false, undefined, 'AGENT_PLAN_NOT_CONFIRMED', 'Agent plan was not confirmed; task generation was canceled.');
      else if (!options.quiet) console.log('Task generation canceled.');
      return EXIT_OPERATION_FAILED;
    }

    const taskId = valueAfter(options.args, '--task-id') ?? plan.taskId ?? randomUUID();
    const taskName = valueAfter(options.args, '--task-name') ?? plan.taskName ?? defaultDetectedTaskName(context.finalUrl);
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(options.args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
    await persistGeneratedTask({ task, file, args: options.args });

    const sampleRows = parseOptionalPositiveInt(valueAfter(options.args, '--run-sample'));
    const sampleRun = sampleRows
      ? await runSampleTask({
          taskId,
          taskFile: file,
          rows: sampleRows,
          outputDir: valueAfter(options.args, '--run-output'),
          chromePath: valueAfter(options.args, '--chrome-path'),
          headless: hasFlag(options.args, '--headless')
        })
      : undefined;

    const data = {
      generatedTask: {
        file,
        taskId,
        taskName,
        candidateId: task.detection.candidateId,
        fieldNames: task.fieldNames,
        selectionSource: 'inline_agent'
      },
      preview,
      agentFiles: agentFiles(options.args, contextFile, planFile),
      ...(sampleRun ? { sampleRun } : {})
    };
    if (options.json && !options.quiet) printEnvelope(true, data);
    else if (!options.quiet) {
      console.log(`Generated task: ${file}`);
      if (sampleRun) console.log(`Sample run: exit=${sampleRun.exitCode} maxRows=${sampleRun.requestedRows}`);
      console.log(`Validate: octoparse task validate ${taskId} --task-file ${file}`);
      console.log(`Run: octoparse run ${taskId} --task-file ${file}`);
      if (hasFlag(options.args, '--keep-agent-files')) {
        console.log(`Agent context: ${contextFile}`);
        console.log(`Agent plan: ${planFile}`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) printEnvelope(false, undefined, 'INLINE_AGENT_FAILED', message);
    else console.error(`Agent task generation failed: ${message}`);
    return EXIT_OPERATION_FAILED;
  } finally {
    if (workDir && !hasFlag(options.args, '--keep-agent-files')) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

export async function runInlineAgentDetectForTesting(options: {
  args: string[];
  result: PageDetectionResult;
  json?: boolean;
  quiet?: boolean;
}): Promise<number> {
  return runInlineAgentDetect({
    args: options.args,
    result: options.result,
    json: options.json ?? false,
    quiet: options.quiet ?? false
  });
}

async function runAgentCommand(options: {
  command: string;
  contextFile: string;
  planFile: string;
  goal?: string;
}): Promise<{ plan: AgentPlan; stdout: string }> {
  const child = spawn(options.command, {
    shell: true,
    env: {
      ...process.env,
      OCTOPARSE_AGENT_CONTEXT: options.contextFile,
      OCTOPARSE_AGENT_PLAN: options.planFile,
      ...(options.goal ? { OCTOPARSE_AGENT_GOAL: options.goal } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) {
    throw new Error(`Agent command failed with exit code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }

  const rawPlan = existsSync(options.planFile)
    ? await readFile(options.planFile, 'utf8')
    : stdout;
  if (!rawPlan.trim()) {
    throw new Error('Agent command did not write a plan to OCTOPARSE_AGENT_PLAN or stdout.');
  }
  const plan = JSON.parse(rawPlan) as AgentPlan;
  if (!existsSync(options.planFile)) await writeFile(options.planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { plan, stdout };
}

async function confirmAgentPreview(preview: AgentPlanPreview, screenshot: DetectedAgentScreenshot | undefined, quiet: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (!quiet) {
    printAgentPlanPreview(preview, screenshot);
    console.log('');
  }
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Generate an extraction task from this Agent plan?',
    choices: [
      { title: 'Generate task', value: 'apply' },
      { title: 'Cancel', value: 'cancel' }
    ],
    initial: 0
  });
  return response.action === 'apply';
}

async function runSampleTask(options: {
  taskId: string;
  taskFile: string;
  rows: number;
  outputDir?: string;
  chromePath?: string;
  headless: boolean;
}): Promise<{
  requestedRows: number;
  exitCode: number;
  envelope?: unknown;
  summary?: AgentSampleRunSummary;
  stdout?: string;
  stderr?: string;
}> {
  const args = [
    '--task-file',
    options.taskFile,
    '--max-rows',
    String(options.rows),
    ...(options.outputDir ? ['--output', options.outputDir] : []),
    ...(options.chromePath ? ['--chrome-path', options.chromePath] : []),
    ...(options.headless ? ['--headless'] : []),
    '--json'
  ];
  const captured = await captureProcessOutput(() => runTask(options.taskId, args));
  const stdout = captured.stdout.trim();
  let envelope: unknown;
  if (stdout) {
    try {
      envelope = JSON.parse(stdout.split('\n').at(-1) ?? stdout);
    } catch {}
  }
  const summary = envelope ? await buildSampleRunSummary(envelope).catch(() => undefined) : undefined;
  return {
    requestedRows: options.rows,
    exitCode: captured.code,
    ...(envelope ? { envelope } : {}),
    ...(summary ? { summary } : {}),
    ...(stdout && !envelope ? { stdout } : {}),
    ...(captured.stderr.trim() ? { stderr: captured.stderr.trim() } : {})
  };
}

async function buildSampleRunSummary(envelope: unknown): Promise<AgentSampleRunSummary | undefined> {
  const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : undefined;
  const outputDir = typeof data?.outputDir === 'string' ? data.outputDir : undefined;
  const totalRows = typeof data?.total === 'number' ? data.total : undefined;
  if (!outputDir) return undefined;
  const rows = await readJsonlRows(join(outputDir, 'rows.jsonl'), 5);
  if (!rows.length) {
    return {
      outputDir,
      ...(totalRows !== undefined ? { totalRows } : {}),
      sampledRows: [],
      fieldFillRates: {},
      missingFieldsByRow: [],
      judgment: totalRows === 0 ? 'No rows were collected; inspect search, pagination, login, or selected candidate.' : 'Rows artifact is empty or unavailable.'
    };
  }
  const fieldNames = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).sort();
  const fieldFillRates = Object.fromEntries(fieldNames.map((field) => {
    const filled = rows.filter((row) => hasMeaningfulValue(row[field])).length;
    return [field, Number((filled / rows.length).toFixed(2))];
  }));
  const missingFieldsByRow = rows.map((row, index) => ({
    rowIndex: index + 1,
    fields: fieldNames.filter((field) => !hasMeaningfulValue(row[field]))
  })).filter((item) => item.fields.length);
  return {
    outputDir,
    ...(totalRows !== undefined ? { totalRows } : {}),
    sampledRows: rows,
    fieldFillRates,
    missingFieldsByRow,
    judgment: missingFieldsByRow.length
      ? 'Sample rows contain missing values. Follow context.resultValidationPolicy before deciding whether this is normal partial data or a structural selector issue.'
      : 'Sample rows contain values for every observed field.'
  };
}

async function readJsonlRows(file: string, limit: number): Promise<Record<string, unknown>[]> {
  const raw = await readFile(file, 'utf8');
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) rows.push(parsed);
    if (rows.length >= limit) break;
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

async function captureProcessOutput(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: unknown, ..._args: unknown[]) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ..._args: unknown[]) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await run();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
