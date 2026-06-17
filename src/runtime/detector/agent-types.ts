import type {
  DetectedAgentScreenshot,
  DetectedBox,
  DetectedCandidate,
  DetectedDetailPlan,
  DetectedField,
  DetectedFieldDiagnostics,
  DetectedPagination,
  DetectedSearchPlan,
  PageDetectionResult
} from './types.js';

export type AgentFieldPlan = string | {
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

export interface DetectAgentContext {
  schemaVersion: 'octopus.detect.agent-context.v1';
  instruction: string;
  visualArtifacts?: AgentVisualArtifacts;
  decisionSummary: AgentDecisionSummary;
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

export interface AgentPlan {
  schemaVersion?: string;
  context?: DetectAgentContext;
  contextFile?: string;
  visualReview?: AgentVisualReview;
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

export interface AgentVisualReview {
  reviewed?: boolean;
  screenshotPath?: string;
  annotatedScreenshotPath?: string;
  candidateScreenshotPath?: string;
  selectedCandidateId?: string;
  evidence?: string[];
  checks?: {
    mainRegionVerified?: boolean;
    fieldsVerified?: boolean;
    paginationVerified?: boolean;
    detailLinksVerified?: boolean;
    excludedRegions?: string[];
  };
}

export interface AgentPlanPreview {
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
  visualReview?: AgentVisualReview;
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
  repairInstruction?: string;
}

export interface AgentVisualArtifacts {
  fullPageScreenshotPath?: string;
  annotatedScreenshotPath?: string;
  candidateScreenshots: Array<{
    candidateId: string;
    path: string;
    rank: number;
    boundingBox: DetectedBox;
  }>;
}

export interface AgentDecisionSummary {
  recommendedCandidateId?: string;
  useTheseVisualInputs: string[];
  candidates: AgentCandidateDecisionSummary[];
  rules: string[];
}

export interface AgentCandidateDecisionSummary {
  candidateId: string;
  rank: number;
  type: DetectedCandidate['type'];
  title: string;
  confidence: number;
  goalScore?: number;
  role?: string;
  itemCount: number;
  fieldNames: string[];
  sampleRow?: Record<string, string>;
  visual: {
    boundingBox?: DetectedBox;
    candidateScreenshotPath?: string;
  };
  strengths: string[];
  risks: string[];
}

export interface AgentPreviewField {
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

export interface AgentSampleRunSummary {
  outputDir?: string;
  totalRows?: number;
  sampledRows: Record<string, unknown>[];
  fieldFillRates: Record<string, number>;
  missingFieldsByRow: Array<{
    rowIndex: number;
    fields: string[];
  }>;
  judgment: string;
}

export interface AgentDetailPlan {
  mode?: DetectedDetailPlan['mode'];
  urlField?: string;
  sampleUrls?: string[];
  fields?: AgentFieldPlan[];
}
