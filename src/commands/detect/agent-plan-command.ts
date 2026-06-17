import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hasFlag, valueAfter } from '../../cli/args.js';
import { printEnvelope, printUsageError } from '../../cli/output.js';
import type { AgentPlan, DetectAgentContext } from '../../runtime/detector/agent-types.js';
import { buildTaskFromAgentPlan, previewAgentPlan } from '../../runtime/detector/agent-plan.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../../types.js';
import { printAgentPlanPreview } from './format.js';
import { persistGeneratedTask } from './persist.js';
import { defaultDetectedTaskName, resolveAvailableDetectedTaskFile } from './args.js';

export async function applyAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
  const planFile = valueAfter(args, '--apply-agent-plan');
  if (!planFile) return printUsageError(json, 'Missing Agent plan file.', 'Usage: octoparse detect --apply-agent-plan plan.json --agent-context context.json --output task.json', 'USAGE_ERROR');
  try {
    const planPath = resolve(planFile);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentPlan;
    const context = await resolveAgentContext(plan, valueAfter(args, '--agent-context'), dirname(planPath));
    const taskId = valueAfter(args, '--task-id') ?? plan.taskId ?? randomUUID();
    const taskName = valueAfter(args, '--task-name') ?? plan.taskName ?? defaultDetectedTaskName(context.finalUrl);
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
    await persistGeneratedTask({ task, file, args });
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

export async function previewAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
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

export async function resolveAgentContext(plan: AgentPlan, contextFile: string | undefined, planDir: string): Promise<DetectAgentContext> {
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

export function agentFiles(args: string[], contextFile: string, planFile: string): { contextFile?: string; planFile?: string } | undefined {
  if (!hasFlag(args, '--keep-agent-files')) return undefined;
  return { contextFile, planFile };
}
