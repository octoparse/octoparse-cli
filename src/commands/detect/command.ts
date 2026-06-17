import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../../cli/args.js';
import { printEnvelope, printUsageError } from '../../cli/output.js';
import { createChromeProgressReporter } from '../../runtime/chrome-progress.js';
import { buildAgentContext, recommendedCandidate } from '../../runtime/detector/agent-context.js';
import { DetectionLoginRequiredError, detectPage } from '../../runtime/detector/page-detector.js';
import type { PageDetectionResult } from '../../runtime/detector/types.js';
import { buildTaskFromCandidate } from '../../runtime/detector/xml.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../../runtime/platform-support.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_RUNTIME_FAILED } from '../../types.js';
import {
  defaultDetectedTaskName,
  parseDetectInput,
  resolveAgentScreenshotPath,
  resolveAvailableDetectedTaskFile,
  validateRunSample
} from './args.js';
import { applyAgentPlanCommand, previewAgentPlanCommand } from './agent-plan-command.js';
import { runInlineAgentDetect } from './agent-runner.js';
import { detailModeLabel, printDetectHuman } from './format.js';
import { persistGeneratedTask } from './persist.js';

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
      'Choose only one detect mode: --auto or --manual.',
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
      '--run-sample is only supported by the detect --agent workflow.',
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
    const result = await runPageDetection(args, url, json, quiet);

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

    return handleDirectDetectResult({ args, result, json, quiet });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DetectionLoginRequiredError ? 'LOGIN_SESSION_REQUIRED' : 'DETECT_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else console.error(`Detection failed: ${message}`);
    return EXIT_RUNTIME_FAILED;
  }
}

async function runPageDetection(args: string[], url: string, json: boolean, quiet: boolean): Promise<PageDetectionResult> {
  const agentScreenshotPath = resolveAgentScreenshotPath(args, url);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const chromeProgress = createChromeProgressReporter({
    enabled: !json && !quiet && !valueAfter(args, '--chrome-path'),
    write: (message) => originalStderrWrite(message)
  });
  return detectPage({
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
}

async function handleDirectDetectResult(options: {
  args: string[];
  result: PageDetectionResult;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const { args, result, json, quiet } = options;
  const interactiveSelectedIds = result.selectedCandidateIds?.length ? result.selectedCandidateIds : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const manualTaskChoice = hasFlag(args, '--manual') && !json && !quiet
    ? await chooseManualTaskOutput(result, valueAfter(args, '--output'))
    : undefined;
  const selectedId = valueAfter(args, '--select') ?? interactiveSelectedIds[0] ?? (hasFlag(args, '--auto') ? recommendedCandidate(result.candidates)?.id : undefined);
  const outputFile = manualTaskChoice?.outputFile ?? valueAfter(args, '--output');
  const shouldGenerateTask = manualTaskChoice ? manualTaskChoice.generate : Boolean(selectedId || outputFile);
  if (shouldGenerateTask) {
    return generateDirectTask({ args, result, selectedId, outputFile, json, quiet });
  }

  if (json && !quiet) printEnvelope(true, { ...result, recommendedCandidateId: recommendedCandidate(result.candidates)?.id });
  else if (!quiet) printDetectHuman(result);
  return EXIT_OK;
}

async function generateDirectTask(options: {
  args: string[];
  result: PageDetectionResult;
  selectedId: string | undefined;
  outputFile: string | undefined;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const { args, result, selectedId, outputFile, json, quiet } = options;
  if (!selectedId) {
    const message = hasFlag(args, '--interactive') || hasFlag(args, '--manual')
      ? 'No extraction target was selected: click a highlighted data group in the browser and continue.'
      : 'Generating a task file requires --select candidateId or --auto.';
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
    const message = 'Form candidates are search/input entry points and cannot directly generate an extraction task. Open the submitted result page, or use --goal/--input to generate a search workflow.';
    if (json) printEnvelope(false, undefined, 'DETECT_CANDIDATE_UNSUPPORTED', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }
  const taskId = valueAfter(args, '--task-id') ?? randomUUID();
  const taskName = valueAfter(args, '--task-name') ?? defaultDetectedTaskName(result.finalUrl);
  const task = buildTaskFromCandidate({ url: result.finalUrl, taskId, taskName, candidate, popupDismissals: result.popupDismissals, session: result.savedSession, searchPlan: result.searchPlan });
  const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
  await persistGeneratedTask({ task, file, args });
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

async function chooseManualTaskOutput(
  result: PageDetectionResult,
  providedOutputFile: string | undefined
): Promise<{ generate: boolean; outputFile?: string } | undefined> {
  const selected = result.selectedCandidateIds?.length || result.selectedCandidateId;
  if (!selected || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'Generate an extraction task file?',
    choices: [
      { title: providedOutputFile ? `Write to ${providedOutputFile}` : 'Write to the default detected_<host>.json file', value: 'default' },
      { title: 'Enter a file name', value: 'custom' },
      { title: 'Preview candidates only', value: 'preview' }
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
