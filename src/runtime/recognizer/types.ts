export type RecognizedCandidateType =
  | 'table'
  | 'repeated_card'
  | 'search_results'
  | 'detail'
  | 'link_collection'
  | 'form';

export interface RecognizedField {
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
  diagnostics?: RecognizedFieldDiagnostics;
}

export interface RecognizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecognizedFieldDiagnostics {
  matchCount: number;
  textLength: number;
  paragraphCount: number;
  hasStyleNoise: boolean;
  boundingBox?: RecognizedBox;
  sampleText?: string;
  warnings: string[];
}

export type RecognizedPaginationType = 'next_page' | 'load_more' | 'scroll';

export interface RecognizedPagination {
  type: RecognizedPaginationType;
  xpath: string;
  text: string;
  confidence: number;
  isAjax: boolean;
  scope: 'near_list' | 'global';
  revealByScroll?: boolean;
  reasons: string[];
}

export type RecognizedPopupType = 'login' | 'cookie' | 'newsletter' | 'ad' | 'captcha' | 'paywall' | 'unknown';

export interface RecognizedPopupDismissal {
  type: RecognizedPopupType;
  action: 'click' | 'escape' | 'hide';
  xpath?: string;
  text?: string;
  confidence: number;
  removed: boolean;
  reasons: string[];
}

export interface RecognizedCandidate {
  id: string;
  type: RecognizedCandidateType;
  title: string;
  confidence: number;
  layout?: RecognizedCandidateLayout;
  selector: string;
  xpath: string;
  itemSelector?: string;
  itemXPath?: string;
  itemCount: number;
  fields: RecognizedField[];
  sampleRows: Record<string, string>[];
  reasons: string[];
  pagination?: RecognizedPagination;
  detailPlan?: RecognizedDetailPlan;
  goalScore?: number;
  goalReasons?: string[];
  diagnostics?: RecognizedCandidateDiagnostics;
}

export interface RecognizedCandidateDiagnostics {
  matchCount: number;
  boundingBox?: RecognizedBox;
  sampleBoxes: RecognizedBox[];
  textLength: number;
  visualCoverage: number;
  warnings: string[];
}

export type RecognizedDetailMode = 'list_only' | 'list_with_detail' | 'detail_only';

export interface RecognizedDetailPlan {
  mode: RecognizedDetailMode;
  urlField: string;
  sampleUrls: string[];
  fields: RecognizedField[];
  sampleRows: Record<string, string>[];
  templateCount: number;
  status: 'planned' | 'unsupported_runtime';
  reasons: string[];
}

export type RecognizedRegionRole = 'main' | 'sidebar' | 'header' | 'footer' | 'nav' | 'ad' | 'unknown';

export interface RecognizedCandidateLayout {
  role: RecognizedRegionRole;
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

export interface PageRecognitionResult {
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  candidates: RecognizedCandidate[];
  searchPlan?: RecognizedSearchPlan;
  savedSession?: RecognizedSessionReference;
  selectedCandidateId?: string;
  selectedCandidateIds?: string[];
  llmRankInput?: RecognizedLlmRankInput;
  popupDismissals?: RecognizedPopupDismissal[];
  agentScreenshot?: RecognizedAgentScreenshot;
}

export interface RecognizedAgentScreenshot {
  path: string;
  fullPage: boolean;
}

export interface RecognizedSessionReference {
  name: string;
  origin: string;
  savedAt: string;
  cookieCount: number;
  kind: 'cookie';
  compatibility: 'cookies-only';
  hosts?: string[];
}

export interface RecognizedSearchPlan {
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

export interface RecognizedLlmRankInput {
  goal?: string;
  instruction: string;
  candidates: Array<{
    id: string;
    type: RecognizedCandidateType;
    score: number;
    layout?: RecognizedCandidateLayout;
    fields: string[];
    sampleRows: Record<string, string>[];
    reasons: string[];
  }>;
}

export interface RecognizeOptions {
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
  legacyRecognizer?: boolean;
  apiBaseUrl?: string;
  dismissPopups: boolean;
  saveSession?: boolean;
  sessionName?: string;
  agentScreenshotPath?: string;
  onChromeStatus?: (status: { state: string; progress?: number }) => void;
}
