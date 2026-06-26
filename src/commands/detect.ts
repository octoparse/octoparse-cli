import type { PageDetectionResult } from '../runtime/detector/types.js';
import type { AgentPlan, DetectAgentContext } from '../runtime/detector/agent-types.js';
import { buildAgentContext } from '../runtime/detector/agent-context.js';
import { buildTaskFromAgentPlan, previewAgentPlan } from '../runtime/detector/agent-plan.js';
import {
  defaultDetectedTaskName,
  resolveAgentScreenshotPath,
  resolveAvailableDetectedTaskFile,
  splitRunUrlArgs
} from './detect/args.js';

export { detectCommand } from './detect/command.js';
export { recommendedApiCandidateForTesting } from './detect/command.js';
export { detectUrlCommand } from './detect/run-url.js';
export { runInlineAgentDetectForTesting } from './detect/agent-runner.js';
export { buildTaskFromAgentPlan } from '../runtime/detector/agent-plan.js';
export { resolveAvailableDetectedTaskFile, splitRunUrlArgs } from './detect/args.js';
export type {
  AgentDetailPlan,
  AgentFieldPlan,
  AgentPlan,
  AgentPlanPreview,
  AgentSampleRunSummary,
  AgentVisualReview,
  DetectAgentContext
} from '../runtime/detector/agent-types.js';

export function buildAgentContextForTesting(result: PageDetectionResult, goal?: string): DetectAgentContext {
  return buildAgentContext(result, goal);
}

export function previewAgentPlanForTesting(options: { context: DetectAgentContext; plan: AgentPlan }) {
  return previewAgentPlan(options);
}

export function resolveAgentScreenshotPathForTesting(args: string[], url: string): string | undefined {
  return resolveAgentScreenshotPath(args, url);
}

export function defaultDetectedTaskNameForTesting(url: string): string {
  return defaultDetectedTaskName(url);
}
