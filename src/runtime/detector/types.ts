export type DetectedCandidateType =
  | 'table'
  | 'repeated_card'
  | 'search_results'
  | 'detail'
  | 'link_collection'
  | 'form';

export interface DetectedField {
  fieldId?: string;
  elementId?: string;
  name: string;
  kind: 'text' | 'href' | 'src' | 'value';
  selector: string;
  xpath: string;
  relativeSelector?: string;
  relativeXPath?: string;
  operations?: Array<{
    type: 'trim' | 'regex_match' | 'regex_replace';
    params: string[];
  }>;
  samples: string[];
  diagnostics?: DetectedFieldDiagnostics;
}

export interface DetectedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedFieldDiagnostics {
  matchCount: number;
  textLength: number;
  paragraphCount: number;
  hasStyleNoise: boolean;
  boundingBox?: DetectedBox;
  sampleText?: string;
  warnings: string[];
}

export type DetectedPaginationType = 'next_page' | 'load_more' | 'scroll';

export interface DetectedPagination {
  type: DetectedPaginationType;
  xpath: string;
  text: string;
  confidence: number;
  isAjax: boolean;
  scope: 'near_list' | 'global';
  revealByScroll?: boolean;
  reasons: string[];
}

export type DetectedPopupType = 'login' | 'cookie' | 'newsletter' | 'ad' | 'captcha' | 'paywall' | 'unknown';

export interface DetectedPopupDismissal {
  type: DetectedPopupType;
  action: 'click' | 'escape' | 'hide';
  xpath?: string;
  text?: string;
  confidence: number;
  removed: boolean;
  confirmedByUser?: boolean;
  reasons: string[];
}

export interface DetectedCandidate {
  id: string;
  type: DetectedCandidateType;
  title: string;
  confidence: number;
  layout?: DetectedCandidateLayout;
  selector: string;
  xpath: string;
  itemSelector?: string;
  itemXPath?: string;
  itemCount: number;
  fields: DetectedField[];
  sampleRows: Record<string, string>[];
  reasons: string[];
  pagination?: DetectedPagination;
  detailPlan?: DetectedDetailPlan;
  goalScore?: number;
  goalReasons?: string[];
  diagnostics?: DetectedCandidateDiagnostics;
}

export interface DetectedCandidateDiagnostics {
  matchCount: number;
  boundingBox?: DetectedBox;
  sampleBoxes: DetectedBox[];
  textLength: number;
  visualCoverage: number;
  warnings: string[];
}

export type DetectedDetailMode = 'list_only' | 'list_with_detail' | 'detail_only';

export interface DetectedDetailPlan {
  mode: DetectedDetailMode;
  urlField: string;
  sampleUrls: string[];
  fields: DetectedField[];
  sampleRows: Record<string, string>[];
  templateCount: number;
  status: 'planned' | 'unsupported_runtime';
  reasons: string[];
}

export type DetectedRegionRole = 'main' | 'sidebar' | 'header' | 'footer' | 'nav' | 'ad' | 'unknown';

export interface DetectedCandidateLayout {
  role: DetectedRegionRole;
  score: number;
  mainScore: number;
  sidebarPenalty: number;
  boilerplatePenalty: number;
  visualCoverage: number;
  textDensity: number;
  linkDensity: number;
  centerDistance: number;
  reasons: string[];
}

export interface PageDetectionResult {
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  candidates: DetectedCandidate[];
  searchPlan?: DetectedSearchPlan;
  savedSession?: DetectedSessionReference;
  selectedCandidateId?: string;
  selectedCandidateIds?: string[];
  llmRankInput?: DetectedLlmRankInput;
  popupDismissals?: DetectedPopupDismissal[];
  agentScreenshot?: DetectedAgentScreenshot;
}

export interface DetectedAgentScreenshot {
  path: string;
  fullPage: boolean;
  annotatedPath?: string;
  candidateScreenshots?: DetectedAgentCandidateScreenshot[];
}

export interface DetectedAgentCandidateScreenshot {
  candidateId: string;
  path: string;
  boundingBox: DetectedBox;
  rank: number;
}

export interface DetectedSessionReference {
  name: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  kind: 'cookie';
  compatibility: 'cookies-only';
  hosts?: string[];
}

export interface DetectedSearchPlan {
  startUrl: string;
  finalUrl: string;
  inputs: Array<{
    name: string;
    value: string;
    xpath: string;
  }>;
  submit?: {
    mode: 'click' | 'enter';
    xpath?: string;
    text?: string;
  };
}

export interface DetectedLlmRankInput {
  goal?: string;
  instruction: string;
  candidates: Array<{
    id: string;
    type: DetectedCandidateType;
    score: number;
    layout?: DetectedCandidateLayout;
    fields: string[];
    sampleRows: Record<string, string>[];
    reasons: string[];
  }>;
}

export interface DetectOptions {
  url: string;
  input?: Record<string, string>;
  submit?: string;
  goal?: string;
  manual: boolean;
  interactive: boolean;
  chromePath?: string;
  waitMs: number;
  scrolls: number;
  timeoutMs: number;
  maxCandidates: number;
  llmRank: boolean;
  legacyDetector?: boolean;
  apiBaseUrl?: string;
  dismissPopups: boolean;
  saveSession?: boolean;
  sessionName?: string;
  agentScreenshotPath?: string;
  onChromeStatus?: (status: { state: string; progress?: number }) => void;
}
