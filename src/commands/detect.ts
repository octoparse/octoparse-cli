import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { DetectionLoginRequiredError, detectPage } from '../runtime/detector/page-detector.js';
import { buildTaskFromCandidate } from '../runtime/detector/xml.js';
import { createChromeProgressReporter } from '../runtime/chrome-progress.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../runtime/platform-support.js';
import type { PageDetectionResult, DetectedAgentScreenshot, DetectedCandidate, DetectedDetailPlan, DetectedField, DetectedFieldDiagnostics, DetectedPagination, DetectedSearchPlan } from '../runtime/detector/types.js';
import { safeFileName } from '../runtime/naming.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_RUNTIME_FAILED } from '../types.js';
import { runTask } from './run.js';

type AgentFieldPlan = string | {
  source?: string;
  name?: string;
  as?: string;
  kind?: DetectedField['kind'];
  selector?: string;
  xpath?: string;
  relativeXPath?: string;
  samples?: string[];
  operations?: DetectedField['operations'];
};

interface DetectAgentContext {
  schemaVersion: 'octopus.detect.agent-context.v1';
  instruction: string;
  decisionPolicy: {
    requiredInputs: string[];
    rankingRule: string;
    recommendedCandidateRule: string;
    paginationRule: string;
    searchRule: string;
  };
  resultValidationPolicy: {
    normalPartialDataRule: string;
    doNotRecreateTaskWhen: string[];
    recreateTaskOnlyWhen: string[];
    maxAutomaticRecreateAttempts: number;
    afterRepairBudgetRule: string;
  };
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  goal?: string;
  recommendedCandidateId?: string;
  screenshot?: DetectedAgentScreenshot;
  candidates: DetectedCandidate[];
  searchPlan?: DetectedSearchPlan;
  popupDismissals?: PageDetectionResult['popupDismissals'];
  savedSession?: PageDetectionResult['savedSession'];
}

interface AgentPlan {
  schemaVersion?: string;
  context?: DetectAgentContext;
  contextFile?: string;
  candidateId?: string;
  selection?: {
    candidateId?: string;
    fields?: AgentFieldPlan[];
    pagination?: DetectedPagination | null | false;
    detail?: AgentDetailPlan | null | false;
  };
  fields?: AgentFieldPlan[];
  pagination?: DetectedPagination | null | false;
  detail?: AgentDetailPlan | null | false;
  taskId?: string;
  taskName?: string;
}

interface AgentPlanPreview {
  schemaVersion: 'octopus.detect.agent-preview.v1';
  pass: boolean;
  candidateId: string;
  candidate: {
    id: string;
    type: DetectedCandidate['type'];
    title: string;
    confidence: number;
    itemCount: number;
    diagnostics?: DetectedCandidate['diagnostics'];
  };
  fields: AgentPreviewField[];
  detail?: {
    mode: DetectedDetailPlan['mode'];
    urlField: string;
    sampleUrls: string[];
    fields: AgentPreviewField[];
  };
  pagination?: DetectedPagination;
  warnings: string[];
  recommendedFixes: string[];
}

interface AgentPreviewField {
  name: string;
  sourceName?: string;
  kind: DetectedField['kind'];
  xpath: string;
  samples: string[];
  diagnostics?: DetectedFieldDiagnostics;
  warnings: string[];
  runtimeScope?: 'loop_item' | 'page';
  notes?: string[];
}

interface AgentDetailPlan {
  mode?: DetectedDetailPlan['mode'];
  urlField?: string;
  sampleUrls?: string[];
  fields?: AgentFieldPlan[];
}

export async function detectCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const quiet = hasFlag(args, '--quiet');
  if (hasFlag(args, '--screenshot') || hasFlag(args, '--agent-screenshot')) {
    return printUsageError(
      json,
      'detect already generates a full-page screenshot for Agent/LLM workflows by default; --screenshot and --agent-screenshot are no longer supported.',
      'Usage: octoparse detect URL --prepare-agent --json --goal "extraction goal" --output context.json',
      'USAGE_ERROR'
    );
  }
  if (valueAfter(args, '--preview-agent-plan')) {
    return previewAgentPlanCommand(args, json, quiet);
  }
  if (valueAfter(args, '--apply-agent-plan')) {
    return applyAgentPlanCommand(args, json, quiet);
  }
  const url = firstPositionalArg(args, [
    '--chrome-path',
    '--wait-ms',
    '--scrolls',
    '--timeout-ms',
    '--max-candidates',
    '--select',
    '--output',
    '--task-id',
    '--task-name',
    '--goal',
    '--session-name',
    '--input',
    '--query',
    '--submit',
    '--agent-context',
    '--agent-command',
    '--apply-agent-plan',
    '--preview-agent-plan',
    '--run-sample',
    '--run-output',
    '--api-base-url'
  ]);
  if (!url) {
    return printUsageError(
      json,
      'Error: missing URL',
      'Usage: octoparse detect URL --auto|--manual [--goal "list"] [--output task.json] [--json]',
      'USAGE_ERROR'
    );
  }
  if (!isLocalChromeRuntimeSupported()) {
    return printUsageError(json, LINUX_ARM64_UNSUPPORTED_MESSAGE, undefined, LINUX_ARM64_UNSUPPORTED_CODE);
  }
  if (hasFlag(args, '--auto') && hasFlag(args, '--manual')) {
    return printUsageError(
      json,
      'detect accepts only one mode: --auto or --manual.',
      'Usage: octoparse detect URL --auto|--manual [--goal "list"]',
      'USAGE_ERROR'
    );
  }
  if (hasFlag(args, '--agent') && !valueAfter(args, '--agent-command') && !process.env.OCTOPARSE_AGENT_COMMAND) {
    return printUsageError(
      json,
      'Missing Agent command: pass --agent-command or set OCTOPARSE_AGENT_COMMAND.',
      'Example: octoparse detect URL --agent --agent-command "node make-plan.mjs" --output task.json',
      'USAGE_ERROR'
    );
  }
  if (hasFlag(args, '--run-sample') && !hasFlag(args, '--agent')) {
    return printUsageError(
      json,
      '--run-sample is only supported for the detect --agent workflow.',
      'Example: octoparse detect URL --agent --agent-command "node make-plan.mjs" --run-sample 5 --json',
      'USAGE_ERROR'
    );
  }
  const runSampleError = validateRunSample(args);
  if (runSampleError) {
    return printUsageError(
      json,
      runSampleError,
      'Usage: octoparse detect URL --agent --agent-command <cmd> --run-sample <positive integer> [--json]',
      'RUN_SAMPLE_INVALID'
    );
  }
  try {
    const agentScreenshotPath = resolveAgentScreenshotPath(args, url);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const chromeProgress = createChromeProgressReporter({
      enabled: !json && !quiet && !valueAfter(args, '--chrome-path'),
      write: (message) => originalStderrWrite(message)
    });
    const result = await detectPage({
      url,
      input: parseDetectInput(args),
      submit: valueAfter(args, '--submit'),
      goal: valueAfter(args, '--goal'),
      chromePath: valueAfter(args, '--chrome-path'),
      manual: hasFlag(args, '--manual'),
      interactive: hasFlag(args, '--interactive') || hasFlag(args, '--manual'),
      waitMs: parsePositiveInt(valueAfter(args, '--wait-ms'), 1500),
      scrolls: parsePositiveInt(valueAfter(args, '--scrolls'), 10),
      timeoutMs: parsePositiveInt(valueAfter(args, '--timeout-ms'), 45_000),
      maxCandidates: parsePositiveInt(valueAfter(args, '--max-candidates'), 8),
      llmRank: hasFlag(args, '--llm-rank'),
      legacyDetector: hasFlag(args, '--legacy-detector') || process.env.OCTOPARSE_LEGACY_DETECTOR === '1',
      apiBaseUrl: valueAfter(args, '--api-base-url'),
      dismissPopups: !hasFlag(args, '--no-dismiss-popups'),
      saveSession: hasFlag(args, '--save-session'),
      sessionName: valueAfter(args, '--session-name'),
      agentScreenshotPath,
      onChromeStatus: chromeProgress?.onStatus
    });

    if (hasFlag(args, '--agent')) {
      return runInlineAgentDetect({ args, result, json, quiet });
    }

    if (hasFlag(args, '--prepare-agent')) {
      const context = buildAgentContext(result, valueAfter(args, '--goal'));
      const outputFile = valueAfter(args, '--output');
      if (outputFile) await writeFile(resolve(outputFile), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
      if (json && !quiet) printEnvelope(true, outputFile ? { file: resolve(outputFile), agentContext: context } : context);
      else if (!quiet) {
        if (outputFile) console.log(`Agent context: ${resolve(outputFile)}`);
        else console.log(JSON.stringify(context, null, 2));
      }
      return EXIT_OK;
    }

    const interactiveSelectedIds = result.selectedCandidateIds?.length ? result.selectedCandidateIds : result.selectedCandidateId ? [result.selectedCandidateId] : [];
    const manualTaskChoice = hasFlag(args, '--manual') && !json && !quiet
      ? await chooseManualTaskOutput(result, valueAfter(args, '--output'))
      : undefined;
    const selectedId = valueAfter(args, '--select') ?? interactiveSelectedIds[0] ?? (hasFlag(args, '--auto') ? recommendedCandidate(result.candidates)?.id : undefined);
    const outputFile = manualTaskChoice?.outputFile ?? valueAfter(args, '--output');
    const shouldGenerateTask = manualTaskChoice ? manualTaskChoice.generate : Boolean(selectedId || outputFile);
    if (shouldGenerateTask) {
      if (!selectedId) {
        const message = hasFlag(args, '--interactive') || hasFlag(args, '--manual')
          ? 'No extraction target was selected: click a highlighted data group in the browser, then continue.'
          : 'Task-file generation requires --select candidateId or --auto.';
        return printUsageError(json, message, 'Example: octoparse detect https://example.com --manual', 'DETECT_SELECT_REQUIRED');
      }
      const candidate = result.candidates.find((item) => item.id === selectedId);
      if (!candidate) {
        const message = `Candidate not found: ${selectedId}`;
        if (json) printEnvelope(false, undefined, 'DETECT_CANDIDATE_NOT_FOUND', message);
        else console.error(message);
        return EXIT_OPERATION_FAILED;
      }
      if (candidate.type === 'form') {
        const message = 'Form candidates are search/input entry points and cannot be turned directly into extraction tasks. Open the submitted result page, or use --goal/--input to generate a search workflow.';
        if (json) printEnvelope(false, undefined, 'DETECT_CANDIDATE_UNSUPPORTED', message);
        else console.error(message);
        return EXIT_OPERATION_FAILED;
      }
      const taskId = valueAfter(args, '--task-id') ?? `detected_${safeFileName(new URL(result.finalUrl).hostname || 'site')}`;
      const taskName = valueAfter(args, '--task-name') ?? `Detected ${new URL(result.finalUrl).hostname || result.finalUrl}`;
      const task = buildTaskFromCandidate({ url: result.finalUrl, taskId, taskName, candidate, popupDismissals: result.popupDismissals, session: result.savedSession, searchPlan: result.searchPlan });
      const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
      await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
      const data = { ...result, generatedTask: { file, taskId, taskName, candidateId: candidate.id, fieldNames: task.fieldNames, pagination: candidate.pagination, session: task.detection.session } };
      if (json && !quiet) printEnvelope(true, data);
      else if (!quiet) {
        printDetectHuman(result);
        console.log('');
        console.log(`Generated task: ${file}`);
        if (task.detection.session) {
          console.log(`Saved session: ${task.detection.session.name} (${task.detection.session.cookieCount} cookies, cookies-only)`);
        }
        if (task.detection.detailPlan) {
          console.log(`Detail plan: ${detailModeLabel(task.detection.detailPlan.mode)} (${task.detection.detailPlan.fields.map((field) => field.name).join(', ') || 'no fields'})`);
        }
        console.log(`Validate: octoparse task validate ${taskId} --task-file ${file}`);
        console.log(`Run: octoparse run ${taskId} --task-file ${file}`);
      }
      return EXIT_OK;
    }

    if (json && !quiet) printEnvelope(true, { ...result, recommendedCandidateId: recommendedCandidate(result.candidates)?.id });
    else if (!quiet) printDetectHuman(result);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DetectionLoginRequiredError ? 'LOGIN_SESSION_REQUIRED' : 'DETECT_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else console.error(`Detection failed: ${message}`);
    return EXIT_RUNTIME_FAILED;
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

async function runInlineAgentDetect(options: {
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
    workDir = await mkdtemp(join(tmpdir(), 'octoparse-agent-'));
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

    if (!hasFlag(options.args, '--yes') && !await confirmAgentPreview(preview, context.screenshot, options.quiet)) {
      if (options.json) printEnvelope(false, undefined, 'AGENT_PLAN_NOT_CONFIRMED', 'Agent plan was not confirmed; task generation was canceled.');
      else if (!options.quiet) console.log('Task generation canceled.');
      return EXIT_OPERATION_FAILED;
    }

    const taskId = valueAfter(options.args, '--task-id') ?? plan.taskId ?? `detected_${safeFileName(new URL(context.finalUrl).hostname || 'site')}`;
    const taskName = valueAfter(options.args, '--task-name') ?? plan.taskName ?? `Detected ${new URL(context.finalUrl).hostname || context.finalUrl}`;
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(options.args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

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
  return {
    requestedRows: options.rows,
    exitCode: captured.code,
    ...(envelope ? { envelope } : {}),
    ...(stdout && !envelope ? { stdout } : {}),
    ...(captured.stderr.trim() ? { stderr: captured.stderr.trim() } : {})
  };
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

async function applyAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
  const planFile = valueAfter(args, '--apply-agent-plan');
  if (!planFile) return printUsageError(json, 'Missing Agent plan file.', 'Usage: octoparse detect --apply-agent-plan plan.json --agent-context context.json --output task.json', 'USAGE_ERROR');
  try {
    const planPath = resolve(planFile);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentPlan;
    const context = await resolveAgentContext(plan, valueAfter(args, '--agent-context'), dirname(planPath));
    const taskId = valueAfter(args, '--task-id') ?? plan.taskId ?? `detected_${safeFileName(new URL(context.finalUrl).hostname || 'site')}`;
    const taskName = valueAfter(args, '--task-name') ?? plan.taskName ?? `Detected ${new URL(context.finalUrl).hostname || context.finalUrl}`;
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    const data = {
      generatedTask: {
        file,
        taskId,
        taskName,
        candidateId: task.detection.candidateId,
        fieldNames: task.fieldNames,
        selectionSource: 'external_ai'
      }
    };
    if (json && !quiet) printEnvelope(true, data);
    else if (!quiet) {
      console.log(`Generated task: ${file}`);
      console.log(`Agent plan: ${planPath}`);
      console.log(`Validate: octoparse task validate ${taskId} --task-file ${file}`);
      console.log(`Run: octoparse run ${taskId} --task-file ${file}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'AGENT_PLAN_FAILED', message);
    else console.error(`Failed to apply Agent plan: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
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

function agentFiles(args: string[], contextFile: string, planFile: string): { contextFile?: string; planFile?: string } | undefined {
  if (!hasFlag(args, '--keep-agent-files')) return undefined;
  return { contextFile, planFile };
}

async function previewAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
  const planFile = valueAfter(args, '--preview-agent-plan');
  if (!planFile) return printUsageError(json, 'Missing Agent plan file.', 'Usage: octoparse detect --preview-agent-plan plan.json --agent-context context.json --json', 'USAGE_ERROR');
  try {
    const planPath = resolve(planFile);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentPlan;
    const context = await resolveAgentContext(plan, valueAfter(args, '--agent-context'), dirname(planPath));
    const preview = previewAgentPlan({ context, plan });
    if (json && !quiet) printEnvelope(true, preview);
    else if (!quiet) printAgentPlanPreview(preview, context.screenshot);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'AGENT_PLAN_PREVIEW_FAILED', message);
    else console.error(`Failed to preview Agent plan: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
}

async function resolveAgentContext(plan: AgentPlan, contextFile: string | undefined, planDir: string): Promise<DetectAgentContext> {
  if (plan.context) return assertAgentContext(plan.context);
  const file = contextFile ?? plan.contextFile;
  if (!file) throw new Error('Agent plan has no embedded context; pass --agent-context context.json or embed it in plan.context.');
  const resolved = resolve(planDir, file);
  return assertAgentContext(JSON.parse(await readFile(resolved, 'utf8')) as DetectAgentContext);
}

function assertAgentContext(value: DetectAgentContext): DetectAgentContext {
  if (value?.schemaVersion !== 'octopus.detect.agent-context.v1') throw new Error('Invalid Agent context schemaVersion.');
  if (!Array.isArray(value.candidates)) throw new Error('Invalid Agent context: missing candidates.');
  return value;
}

export function buildAgentContextForTesting(result: PageDetectionResult, goal?: string): DetectAgentContext {
  return buildAgentContext(result, goal);
}

export function previewAgentPlanForTesting(options: { context: DetectAgentContext; plan: AgentPlan }): AgentPlanPreview {
  return previewAgentPlan(options);
}

function buildAgentContext(result: PageDetectionResult, goal?: string): DetectAgentContext {
  const recommended = recommendedCandidate(result.candidates);
  return {
    schemaVersion: 'octopus.detect.agent-context.v1',
    instruction: [
      'You are choosing a web scraping task plan from deterministic candidates.',
      'Select candidateId for the primary data region. Optionally filter or rename fields.',
      'For detail scraping, return detail.mode=list_with_detail or detail_only, urlField, and detail fields.',
      'Always use the user goal, full-page screenshot, candidate bounding boxes, diagnostics, and sample rows together when judging candidates.',
      'Use diagnostics.matchCount, textLength, paragraphCount, hasStyleNoise, boundingBox, sampleRows, and screenshot to avoid narrow, noisy, or sidebar XPath.',
      'Before applying a task, run --preview-agent-plan and revise fields whose warnings say content is short, CSS noise exists, or XPath matches multiple elements.',
      'Do not invent XPath when an existing candidate field can be reused. Ignore ads, sidebars, navigation, and boilerplate.'
    ].join(' '),
    decisionPolicy: {
      requiredInputs: [
        'context.goal',
        'context.screenshot.path',
        'candidate.boundingBox or candidate.layout.boundingBox',
        'candidate.sampleRows',
        'candidate.fields',
        'candidate.diagnostics',
        'candidate.pagination'
      ],
      rankingRule: 'Choose the candidate that best matches the user goal and the visible main content in the full-page screenshot. Text samples alone are insufficient when layout, sidebars, ads, or pagination are ambiguous.',
      recommendedCandidateRule: 'recommendedCandidateId is a deterministic hint, not a final answer. Override it when screenshot/layout/diagnostics/sampleRows show a better match for the user goal.',
      paginationRule: 'Only keep pagination when the candidate has explicit pagination evidence that matches the visible page controls or a real scroll-loading behavior; disable pagination when the screenshot shows a footer pager or no continuation control for the selected region.',
      searchRule: 'When the user goal describes a search/query keyword, use searchPlan and detected submit controls from context instead of treating the blank search homepage as the extraction target.'
    },
    resultValidationPolicy: {
      normalPartialDataRule: 'Real list pages often contain heterogeneous records, ads, sponsored cards, topic blocks, recommendation modules, or rows where optional fields are legitimately absent. Isolated missing values are normal partial data, not task failure.',
      doNotRecreateTaskWhen: [
        'Only an isolated row or small minority of rows is missing optional fields while the main rows extract correctly.',
        'The sparse rows visually correspond to ads, promoted content, topic cards, recommendation blocks, separators, or other non-primary records.',
        'The selected candidate, search action, pagination behavior, and core fields still match the user goal.',
        'A rerun would only try to force every heterogeneous page item into one uniform schema.'
      ],
      recreateTaskOnlyWhen: [
        'Core fields required by the user goal are missing for most representative rows that should contain them.',
        'Extracted rows clearly come from the wrong region such as navigation, sidebar, footer, ads, or an unrelated list.',
        'Search, login dismissal, or pagination is structurally wrong and prevents reaching the target data.',
        'Preview warnings plus run evidence show a systematic selector issue, not natural per-row sparsity.'
      ],
      maxAutomaticRecreateAttempts: 1,
      afterRepairBudgetRule: 'After one structural repair attempt, stop recreating tasks automatically. Report partial-data evidence and ask for user direction only if a different target or stricter completeness requirement is needed.'
    },
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    capturedAt: result.capturedAt,
    ...(goal ? { goal } : {}),
    ...(recommended ? { recommendedCandidateId: recommended.id } : {}),
    ...(result.agentScreenshot ? { screenshot: result.agentScreenshot } : {}),
    ...(result.searchPlan ? { searchPlan: result.searchPlan } : {}),
    candidates: result.candidates,
    ...(result.popupDismissals?.length ? { popupDismissals: result.popupDismissals } : {}),
    ...(result.savedSession ? { savedSession: result.savedSession } : {})
  };
}

function previewAgentPlan(options: { context: DetectAgentContext; plan: AgentPlan }): AgentPlanPreview {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan is missing selection.candidateId.');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan references an unknown candidate: ${candidateId}`);
  if (base.type === 'form') throw new Error('Form candidates cannot be turned directly into extraction tasks.');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  const warnings: string[] = [];
  const recommendedFixes: string[] = [];
  const fields = previewFields(candidate.fields, base.fields);
  const detailFields = candidate.detailPlan ? previewFields(candidate.detailPlan.fields, base.detailPlan?.fields ?? []) : [];
  collectAgentPreviewWarnings(warnings, recommendedFixes, candidate, fields, detailFields);
  return {
    schemaVersion: 'octopus.detect.agent-preview.v1',
    candidateId: candidate.id,
    candidate: {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      confidence: candidate.confidence,
      itemCount: candidate.itemCount,
      ...(candidate.diagnostics ? { diagnostics: candidate.diagnostics } : {})
    },
    fields,
    ...(candidate.detailPlan ? {
      detail: {
        mode: candidate.detailPlan.mode,
        urlField: candidate.detailPlan.urlField,
        sampleUrls: candidate.detailPlan.sampleUrls,
        fields: detailFields
      }
    } : {}),
    ...(candidate.pagination ? { pagination: candidate.pagination } : {}),
    warnings: Array.from(new Set(warnings)),
    recommendedFixes: Array.from(new Set(recommendedFixes)),
    pass: !hasBlockingAgentPreviewRisk(fields, detailFields)
  };
}

function previewFields(fields: DetectedField[], sourceFields: DetectedField[]): AgentPreviewField[] {
  return fields.map((field) => {
    const source = sourceFields.find((item) => item === field || item.name === field.name || item.xpath === field.xpath);
    const diagnostics = field.diagnostics ?? source?.diagnostics;
    const runtimeScope = field.relativeXPath ? 'loop_item' : 'page';
    const warnings = (diagnostics?.warnings ?? []).filter((warning) => !isAcceptableLoopFieldWarning(warning, field));
    const notes = diagnostics?.warnings?.some((warning) => isAcceptableLoopFieldWarning(warning, field))
      ? ['XPath matches multiple page elements, but the generated runtime uses this field relative to each loop item.']
      : undefined;
    return {
      name: field.name,
      ...(source && source.name !== field.name ? { sourceName: source.name } : {}),
      kind: field.kind,
      xpath: field.xpath,
      samples: field.samples.slice(0, 3),
      ...(diagnostics ? { diagnostics } : {}),
      warnings,
      runtimeScope,
      ...(notes?.length ? { notes } : {})
    };
  });
}

function isAcceptableLoopFieldWarning(warning: string, field: DetectedField): boolean {
  return Boolean(field.relativeXPath)
    && /xpath matched \d+ elements/i.test(warning)
    && /runtime may use the first element/i.test(warning);
}

function collectAgentPreviewWarnings(
  warnings: string[],
  recommendedFixes: string[],
  candidate: DetectedCandidate,
  fields: AgentPreviewField[],
  detailFields: AgentPreviewField[]
): void {
  if (candidate.diagnostics?.warnings.length) warnings.push(...candidate.diagnostics.warnings.map((item) => `candidate: ${item}`));
  for (const field of [...fields, ...detailFields]) {
    const prefix = detailFields.includes(field) ? `detail.${field.name}` : field.name;
    for (const warning of field.warnings) warnings.push(`${prefix}: ${warning}`);
    if (field.diagnostics?.hasStyleNoise) {
      recommendedFixes.push(`${prefix}: the current XPath may target a style/CSS container; choose the visible content container instead.`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.textLength ?? maxSampleLength(field.samples)) < 300) {
      recommendedFixes.push(`${prefix}: body text is short; prefer a parent container under article/main that contains multiple <p> nodes.`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.paragraphCount ?? 2) <= 1) {
      recommendedFixes.push(`${prefix}: paragraph count is low; this may target only one paragraph and should be changed to the complete body container.`);
    }
    if ((field.diagnostics?.matchCount ?? 1) > 1 && field.runtimeScope !== 'loop_item') {
      recommendedFixes.push(`${prefix}: XPath matches multiple elements; if runtime only reads the first one, use a parent-container XPath or explicitly merge text segments.`);
    }
  }
  if (!candidate.detailPlan && fields.some((field) => field.kind === 'href' || field.name === 'url')) {
    warnings.push('plan has list URL fields but no detail plan');
    recommendedFixes.push('If the target includes detail-page body text, add detail.mode=list_with_detail, urlField=url, and detail.fields.');
  }
}

function hasBlockingAgentPreviewRisk(fields: AgentPreviewField[], detailFields: AgentPreviewField[]): boolean {
  return [...fields, ...detailFields].some((field) => {
    if (!isContentPreviewField(field)) return false;
    const diagnostics = field.diagnostics;
    const textLength = diagnostics?.textLength ?? maxSampleLength(field.samples);
    const paragraphCount = diagnostics?.paragraphCount ?? 2;
    return diagnostics?.hasStyleNoise || textLength < 300 || paragraphCount <= 1;
  });
}

function isContentPreviewField(field: AgentPreviewField): boolean {
  return /(^|_)(content|body|article|正文)(_|$)/i.test(field.name)
    || /(^|_)(content|body|article|正文)(_|$)/i.test(field.sourceName ?? '');
}

function maxSampleLength(samples: string[]): number {
  return samples.reduce((max, sample) => Math.max(max, String(sample ?? '').length), 0);
}

export function buildTaskFromAgentPlan(options: {
  context: DetectAgentContext;
  plan: AgentPlan;
  taskId: string;
  taskName: string;
}) {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan is missing selection.candidateId.');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan references an unknown candidate: ${candidateId}`);
  if (base.type === 'form') throw new Error('Form candidates cannot be turned directly into extraction tasks.');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  return buildTaskFromCandidate({
    url: options.context.finalUrl,
    taskId: options.taskId,
    taskName: options.taskName,
    candidate,
    popupDismissals: options.context.popupDismissals,
    session: options.context.savedSession,
    searchPlan: options.context.searchPlan
  });
}

function applyAgentPlanToCandidate(candidate: DetectedCandidate, plan: AgentPlan): DetectedCandidate {
  const selection = plan.selection ?? {};
  const fieldsPlan = selection.fields ?? plan.fields;
  const detailPlan = selection.detail !== undefined ? selection.detail : plan.detail;
  const paginationPlan = selection.pagination !== undefined ? selection.pagination : plan.pagination;
  return {
    ...candidate,
    fields: fieldsPlan ? applyAgentFieldPlan(candidate.fields, fieldsPlan, 'field') : candidate.fields,
    ...(paginationPlan !== undefined ? { pagination: normalizeAgentPagination(paginationPlan) } : {}),
    ...(detailPlan !== undefined ? { detailPlan: normalizeAgentDetailPlan(candidate, detailPlan) } : {})
  };
}

function applyAgentFieldPlan(fields: DetectedField[], plan: AgentFieldPlan[], fallbackPrefix: string): DetectedField[] {
  return plan.map((item, index) => {
    if (typeof item === 'string') {
      const field = fields.find((candidate) => candidate.name === item);
      if (!field) throw new Error(`Agent plan references an unknown field: ${item}`);
      return field;
    }
    const source = item.source ?? item.name;
    const sourceField = source ? fields.find((field) => field.name === source) : undefined;
    if (!sourceField && !item.xpath) throw new Error(`Agent plan field is missing source or xpath: ${item.as ?? item.name ?? `${fallbackPrefix}_${index + 1}`}`);
    return {
      ...(sourceField ?? {
        kind: item.kind ?? 'text',
        selector: item.selector ?? '',
        xpath: item.xpath ?? '',
        samples: item.samples ?? []
      }),
      name: item.as ?? item.name ?? sourceField?.name ?? `${fallbackPrefix}_${index + 1}`,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.xpath ? { xpath: item.xpath } : {}),
      ...(item.relativeXPath ? { relativeXPath: item.relativeXPath } : {}),
      ...(item.samples ? { samples: item.samples } : {}),
      ...(item.operations ? { operations: item.operations } : {})
    };
  });
}

function normalizeAgentPagination(value: DetectedPagination | null | false | undefined): DetectedPagination | undefined {
  if (!value) return undefined;
  return {
    type: value.type,
    xpath: value.xpath ?? '',
    text: value.text ?? '',
    confidence: value.confidence ?? 0.9,
    isAjax: value.isAjax ?? value.type !== 'next_page',
    scope: value.scope ?? 'global',
    ...(value.revealByScroll ? { revealByScroll: true } : {}),
    reasons: value.reasons?.length ? value.reasons : ['selected by external agent plan']
  };
}

function normalizeAgentDetailPlan(candidate: DetectedCandidate, value: AgentDetailPlan | null | false | undefined): DetectedDetailPlan | undefined {
  if (!value || value.mode === 'list_only') return undefined;
  const existing = candidate.detailPlan;
  const mode = value.mode ?? existing?.mode ?? 'list_with_detail';
  const existingFields = existing?.fields ?? [];
  const fields = value.fields
    ? applyAgentFieldPlan(existingFields, value.fields, 'detail_field')
    : existingFields;
  if (!fields.length) throw new Error('Agent plan requests detail-page extraction but provides no detail.fields and has no reusable detail fields.');
  return {
    mode,
    urlField: value.urlField ?? existing?.urlField ?? 'url',
    sampleUrls: value.sampleUrls ?? existing?.sampleUrls ?? sampleUrlsForCandidate(candidate),
    fields,
    sampleRows: [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))],
    templateCount: fields.length ? 1 : 0,
    status: 'planned',
    reasons: ['selected by external agent plan']
  };
}

function sampleUrlsForCandidate(candidate: DetectedCandidate): string[] {
  const urlField = candidate.fields.find((field) => field.name === 'url' && field.kind === 'href')
    ?? candidate.fields.find((field) => field.kind === 'href');
  return Array.from(new Set([
    ...candidate.sampleRows.map((row) => typeof row.url === 'string' ? row.url : ''),
    ...(urlField?.samples ?? [])
  ].filter((value) => /^https?:\/\//i.test(value)))).slice(0, 3);
}

async function chooseManualTaskOutput(
  result: Awaited<ReturnType<typeof detectPage>>,
  providedOutputFile: string | undefined
): Promise<{ generate: boolean; outputFile?: string } | undefined> {
  const selected = result.selectedCandidateIds?.length || result.selectedCandidateId;
  if (!selected || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Generate an extraction task file?',
    choices: [
      { title: providedOutputFile ? `Write to ${providedOutputFile}` : 'Write to default file detected_<host>.json', value: 'default' },
      { title: 'Enter file name', value: 'custom' },
      { title: 'Preview candidates only, do not generate a task', value: 'preview' }
    ],
    initial: 0
  });
  if (response.action === 'preview') return { generate: false };
  if (response.action === 'custom') {
    const file = await prompts({
      type: 'text',
      name: 'file',
      message: 'Task file name',
      initial: providedOutputFile || 'task.json'
    });
    return file.file ? { generate: true, outputFile: String(file.file) } : { generate: false };
  }
  return { generate: true, outputFile: providedOutputFile };
}

export async function detectUrlCommand(url: string | undefined, args: string[]): Promise<number> {
  const allArgs = [url ?? '', ...args].filter(Boolean);
  const json = hasFlag(allArgs, '--json') || hasFlag(allArgs, '--jsonl');
  if (hasFlag(args, '--screenshot') || hasFlag(args, '--agent-screenshot')) {
    return printUsageError(
      json,
      'run-url already generates a full-page screenshot for Agent/LLM workflows by default; --screenshot and --agent-screenshot are no longer supported.',
      'Usage: octoparse run-url <url> --auto|--select <candidateId> [--goal <text>] [--input <name=value>] [--max-rows <n>]',
      'USAGE_ERROR'
    );
  }
  if (!url || url.startsWith('-')) {
    return printUsageError(
      json,
      'Error: missing URL',
      'Usage: octoparse run-url <url> --goal <text>|--auto [--input <name=value>] [--max-rows <n>] [--json|--jsonl]',
      'USAGE_ERROR'
    );
  }
  if (!isLocalChromeRuntimeSupported()) {
    return printUsageError(json, LINUX_ARM64_UNSUPPORTED_MESSAGE, undefined, LINUX_ARM64_UNSUPPORTED_CODE);
  }

  if (!hasFlag(args, '--auto') && !valueAfter(args, '--select')) {
    return printUsageError(
      json,
      'run-url requires --auto or --select <candidateId> to avoid choosing the wrong extraction target.',
      'First run: octoparse detect <url>',
      'DETECT_SELECT_REQUIRED'
    );
  }

  const outputDir = await mkdtemp(join(tmpdir(), 'octoparse-detected-task-'));
  const taskFile = join(outputDir, 'task.json');
  const splitArgs = splitRunUrlArgs(args);
  const detectArgs = [
    url,
    ...splitArgs.detectArgs,
    ...(json ? ['--json'] : []),
    '--quiet',
    '--output',
    taskFile
  ];
  const detectExit = await detectCommand(detectArgs);
  if (detectExit !== EXIT_OK) return detectExit;

  const task = JSON.parse(await readFile(taskFile, 'utf8')) as { taskId: string };
  return runTask(task.taskId, ['--task-file', taskFile, ...splitArgs.runArgs]);
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : undefined;
}

function validateRunSample(args: string[]): string | null {
  if (!hasFlag(args, '--run-sample')) return null;
  const raw = valueAfter(args, '--run-sample');
  if (!raw || raw.startsWith('-')) return '--run-sample requires a positive integer';
  return parseOptionalPositiveInt(raw) ? null : '--run-sample requires a positive integer';
}

function parseDetectInput(args: string[]): Record<string, string> | undefined {
  const input: Record<string, string> = {};
  const query = valueAfter(args, '--query');
  if (query) input.q = query;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--input') continue;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('-')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) input.q = raw;
    else input[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return Object.keys(input).length ? input : undefined;
}

function resolveAgentScreenshotPath(args: string[], url: string): string | undefined {
  if (!hasFlag(args, '--prepare-agent') && !hasFlag(args, '--agent')) return undefined;
  const output = valueAfter(args, '--output');
  if (output) {
    const resolvedOutput = resolve(output);
    const ext = extname(resolvedOutput);
    const base = ext ? resolvedOutput.slice(0, -ext.length) : resolvedOutput;
    return `${base}.fullpage.png`;
  }
  let host = 'page';
  try {
    host = safeFileName(new URL(url).hostname || 'page');
  } catch {
    host = safeFileName(url || 'page');
  }
  return resolve(`detected_${host}.fullpage.png`);
}

export function resolveAgentScreenshotPathForTesting(args: string[], url: string): string | undefined {
  return resolveAgentScreenshotPath(args, url);
}

export function resolveAvailableDetectedTaskFile(taskId: string): string {
  const base = resolve(`${safeFileName(taskId)}.json`);
  if (!existsSync(base)) return base;
  const dir = dirname(base);
  const ext = extname(base);
  const name = basename(base, ext);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(dir, `${name}-${index}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return base;
}

export function splitRunUrlArgs(args: string[]): { detectArgs: string[]; runArgs: string[] } {
  const detectValueFlags = new Set([
    '--goal',
    '--input',
    '--query',
    '--submit',
    '--select',
    '--wait-ms',
    '--scrolls',
    '--max-candidates',
    '--task-id',
    '--task-name',
    '--session-name',
    '--agent-command',
    '--api-base-url'
  ]);
  const detectBooleanFlags = new Set([
    '--auto',
    '--agent',
    '--yes',
    '--keep-agent-files',
    '--allow-agent-risk',
    '--manual',
    '--interactive',
    '--llm-rank',
    '--no-dismiss-popups',
    '--save-session'
  ]);
  const runValueFlags = new Set(['--output', '--max-rows', '--extension-timeout-ms']);
  const runBooleanFlags = new Set(['--headless', '--disable-image', '--disable-ad', '--debug-bridge', '--detach', '--json', '--jsonl']);
  const sharedValueFlags = new Set(['--chrome-path', '--timeout-ms']);
  const detectArgs: string[] = [];
  const runArgs: string[] = [];

  const pushValue = (target: string[], flag: string, value: string | undefined) => {
    target.push(flag);
    if (value !== undefined) target.push(value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (sharedValueFlags.has(arg)) {
      pushValue(detectArgs, arg, value);
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (detectValueFlags.has(arg)) {
      pushValue(detectArgs, arg, value);
      index += 1;
      continue;
    }
    if (runValueFlags.has(arg)) {
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (detectBooleanFlags.has(arg)) {
      detectArgs.push(arg);
      continue;
    }
    if (runBooleanFlags.has(arg)) {
      runArgs.push(arg);
      continue;
    }
    runArgs.push(arg);
  }
  return { detectArgs, runArgs };
}

function recommendedCandidate(candidates: Awaited<ReturnType<typeof detectPage>>['candidates']) {
  const usable = candidates.filter((candidate) => candidate.type !== 'form');
  const ranked = usable.length ? usable : candidates;
  return ranked
    .slice()
    .sort((a, b) => (b.goalScore ?? b.confidence) - (a.goalScore ?? a.confidence))[0];
}

function printDetectHuman(result: Awaited<ReturnType<typeof detectPage>>): void {
  console.log(`URL: ${result.finalUrl}`);
  console.log(`Title: ${result.title || '(untitled)'}`);
  console.log('');
  if (!result.candidates.length) {
    console.log('No extractable candidates were detected. Try increasing --scrolls, or open a search/list result page and retry.');
    return;
  }
  const selectedIds = result.selectedCandidateIds?.length
    ? result.selectedCandidateIds
    : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const selectedSet = new Set(selectedIds);
  const visibleCandidates = selectedSet.size
    ? result.candidates.filter((candidate) => selectedSet.has(candidate.id))
    : result.candidates;
  const recommended = selectedSet.size
    ? visibleCandidates[0] ?? recommendedCandidate(result.candidates)
    : recommendedCandidate(result.candidates);
  if (selectedSet.size) {
    console.log(`Selected ${visibleCandidates.length} candidate(s): ${visibleCandidates.map((candidate) => candidate.id).join(', ')}`);
  } else {
    console.log(`Detected ${result.candidates.length} candidate(s). Candidates are not final tasks; choose the data region you want.`);
  }
  if (result.popupDismissals?.length) {
    console.log(`Dismissed popups: ${result.popupDismissals.map((item) => `${popupTypeLabel(item.type)}/${item.action}`).join(', ')}`);
  }
  console.log('');
  console.log('Recommendation:');
  if (recommended.type === 'form') {
    console.log('  This page appears to be a search/input entry point. Open the result page first, then run detect on that page.');
  } else {
    console.log(`  Start with [${recommended.id}] ${candidateTypeLabel(recommended.type)}.`);
    console.log(`  Generate task: octoparse detect ${shellArg(result.finalUrl)} --select ${recommended.id} --output task.json`);
    console.log('  Note: task.json is a literal file name; do not type angle brackets.');
  }
  for (const candidate of visibleCandidates) {
    console.log('');
    const scoreText = candidate.goalScore !== undefined
      ? `goalMatch=${formatConfidence(candidate.goalScore)}  confidence=${formatConfidence(candidate.confidence)}`
      : `confidence=${formatConfidence(candidate.confidence)}`;
    console.log(`[${candidate.id}] ${candidateTypeLabel(candidate.type)}  ${scoreText}`);
    console.log(`    ${candidateHint(candidate)}`);
    if (candidate.layout) {
      console.log(`    region=${candidateLayoutLabel(candidate.layout.role)} mainScore=${formatConfidence(candidate.layout.mainScore)} linkDensity=${formatConfidence(candidate.layout.linkDensity)}`);
    }
    if (candidate.pagination) {
      const paginationMode = candidate.pagination.revealByScroll ? ', reveal by scrolling first' : '';
      console.log(`    pagination=${paginationLabel(candidate.pagination.type)}${paginationMode} ${candidate.pagination.text ? `(${truncate(candidate.pagination.text, 40)})` : ''}  confidence=${formatConfidence(candidate.pagination.confidence)}`);
    }
    console.log(`    count=${candidate.itemCount} fields=${candidate.fields.map((field) => field.name).join(', ')}`);
    const sample = candidate.sampleRows[0];
    if (sample) console.log(`    sample=${formatSample(sample)}`);
    if (candidate.type === 'form') {
      console.log('    next: octoparse detect <url> --input q=keyword');
    } else {
      console.log(`    generate: octoparse detect ${shellArg(result.finalUrl)} --select ${candidate.id} --output task.json`);
    }
  }
}

function printAgentPlanPreview(preview: AgentPlanPreview, screenshot: DetectedAgentScreenshot | undefined): void {
  console.log(`Agent plan preview: ${preview.candidateId}`);
  console.log(`Result: ${preview.pass ? 'pass' : 'not recommended; fix fields first'}`);
  console.log(`Candidate: ${candidateTypeLabel(preview.candidate.type)}  count=${preview.candidate.itemCount}  confidence=${formatConfidence(preview.candidate.confidence)}`);
  if (screenshot) console.log(`Screenshot: ${screenshot.path}`);
  console.log(`List fields: ${preview.fields.map((field) => field.name).join(', ') || '(none)'}`);
  if (preview.detail) {
    console.log(`Detail: ${detailModeLabel(preview.detail.mode)}  urlField=${preview.detail.urlField}`);
    console.log(`Detail fields: ${preview.detail.fields.map((field) => field.name).join(', ') || '(none)'}`);
  }
  if (preview.warnings.length) {
    console.log('');
    console.log('Risks:');
    for (const warning of preview.warnings) console.log(`  - ${warning}`);
  }
  if (preview.recommendedFixes.length) {
    console.log('');
    console.log('Recommended fixes:');
    for (const fix of preview.recommendedFixes) console.log(`  - ${fix}`);
  }
}

function paginationLabel(type: string): string {
  if (type === 'next_page') return 'click next page';
  if (type === 'load_more') return 'click load more';
  if (type === 'scroll') return 'scroll loading';
  return type;
}

function detailModeLabel(mode: string): string {
  if (mode === 'list_with_detail') return 'list + detail pages';
  if (mode === 'detail_only') return 'detail pages only';
  return 'list only';
}

function candidateTypeLabel(type: string): string {
  if (type === 'table') return 'table';
  if (type === 'search_results') return 'linked list/results';
  if (type === 'repeated_card') return 'repeated cards/list';
  if (type === 'link_collection') return 'link collection';
  if (type === 'form') return 'search/input form';
  if (type === 'detail') return 'detail page';
  return type;
}

function candidateLayoutLabel(role: string): string {
  if (role === 'main') return 'main';
  if (role === 'sidebar') return 'sidebar';
  if (role === 'header') return 'header';
  if (role === 'footer') return 'footer';
  if (role === 'nav') return 'navigation';
  if (role === 'ad') return 'ad';
  return 'unknown';
}

function popupTypeLabel(type: string): string {
  if (type === 'login') return 'login';
  if (type === 'cookie') return 'Cookie';
  if (type === 'newsletter') return 'newsletter';
  if (type === 'ad') return 'ad';
  if (type === 'captcha') return 'captcha';
  if (type === 'paywall') return 'paywall';
  return 'unknown';
}

function candidateHint(candidate: Awaited<ReturnType<typeof detectPage>>['candidates'][number]): string {
  if (candidate.type === 'form') return 'This is an entry point, not a data list; use it for an input keyword and search workflow.';
  if (candidate.type === 'link_collection') return 'This is usually navigation/category/related links; choose it only when you want a link list.';
  if (candidate.type === 'table') return 'Best for extracting table rows.';
  if (candidate.type === 'search_results') return 'Best for articles, products, search results, or feed lists with links.';
  if (candidate.type === 'repeated_card') return 'Best for repeated cards, articles, products, or list items.';
  return candidate.title;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSample(sample: Record<string, string>): string {
  const compact: Record<string, string> = {};
  for (const [key, value] of Object.entries(sample)) {
    compact[key] = truncate(value, 90);
  }
  return JSON.stringify(compact);
}

function truncate(value: string, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function shellArg(value: string): string {
  if (/^[\w\-./:?=%#]+$/.test(value) && value.length < 140) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
