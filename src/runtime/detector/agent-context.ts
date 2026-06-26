import type { PageDetectionResult, DetectedAgentScreenshot, DetectedCandidate } from './types.js';
import type {
  AgentCandidateDecisionSummary,
  AgentDecisionSummary,
  AgentVisualArtifacts,
  DetectAgentContext
} from './agent-types.js';
import { buildAgentVisualElements, ensureAgentElementIds } from './agent-elements.js';
import { rankCandidates } from './candidate-ranking.js';

export function buildAgentContext(result: PageDetectionResult, goal?: string): DetectAgentContext {
  const candidates = ensureAgentElementIds(result.candidates);
  const recommended = recommendedCandidate(candidates);
  const visualArtifacts = buildAgentVisualArtifacts(result.agentScreenshot);
  const visualElements = buildAgentVisualElements(candidates);
  const decisionSummary = buildAgentDecisionSummary(candidates, recommended?.id, visualArtifacts);
  return {
    schemaVersion: 'octopus.detect.agent-context.v1',
    instruction: [
      'You are choosing a web scraping task plan from deterministic candidates.',
      'Select candidateId for the primary data region. Optionally filter or rename fields.',
      'Prefer selecting fields by visualElements[].id / elementId when a field appears in the annotated screenshot or candidate crop.',
      'visualElements includes detected_field entries and extra visible_dom entries from the selected candidate rows. Use visible_dom elementIds when detector fields miss a visible title, price, image, author, metric, or detail link.',
      'For detail scraping, return detail.mode=list_with_detail or detail_only, urlField, and detail fields.',
      'Start with decisionSummary, then use visualArtifacts.annotatedScreenshotPath and candidate crop images to match candidateId to the visible page.',
      'Always use the user goal, annotated/full-page screenshot, candidate bounding boxes, diagnostics, and sample rows together when judging candidates.',
      'Before selecting any candidate, infer the page primary task target from the user goal and the live visible structure: title, first viewport, active navigation/tab, semantic page purpose, and main content prominence. If the user goal is explicit, honor it; if it is vague or absent, let the visible page structure decide. Do not default to either detail extraction or the largest repeated list. Choose a detail entity, list, feed, table, or form only after that target judgment.',
      'If the correct visible region is missing from candidates, use pageVisualElements and return selection.customCandidate with xpath, itemXPath, fieldElementIds or fields; the CLI will validate it as a synthetic candidate before task generation.',
      'If apiCandidates is present, it contains JSON/XHR list candidates observed from browser network responses. Prefer an API candidate only when it clearly represents the same primary visible list and the user wants scalable list collection.',
      'When the goal asks for the current page, primary content, detail page, article/body, introduction, or explicitly says to ignore sidebars/navigation/ads, do not select sidebar/nav/footer/header/ad candidates even if they contain repeated cards. Recommendation modules such as nearby/related items are not the primary page entity unless the user explicitly asks for them.',
      'For a single detail page whose main content is absent from deterministic candidates, create a customCandidate with type=detail from pageVisualElements for title, rating, address, status, phone, body/introduction, and main image.',
      'Before writing the plan, open context.visualArtifacts.annotatedScreenshotPath or context.screenshot.annotatedPath with a vision-capable tool and verify the selected candidate and fields against the visible page.',
      'Include visualReview.reviewed=true, visualReview.screenshotPath, visualReview.selectedCandidateId, visualReview.evidence, and visualReview.checks in the plan when context.screenshot.path is present.',
      'Use diagnostics.matchCount, textLength, paragraphCount, hasStyleNoise, boundingBox, sampleRows, and screenshot to avoid narrow, noisy, or sidebar XPath.',
      'Before applying a task, run --preview-agent-plan and revise fields whose warnings say content is short, CSS noise exists, or XPath matches multiple elements.',
      'Do not invent XPath when an existing candidate field can be reused. Ignore ads, sidebars, navigation, and boilerplate.'
    ].join(' '),
    ...(visualArtifacts ? { visualArtifacts } : {}),
    decisionSummary,
    decisionPolicy: {
      requiredInputs: [
        'context.goal',
        'context.decisionSummary',
        'context.visualArtifacts.annotatedScreenshotPath or context.screenshot.path',
        'context.visualArtifacts.candidateScreenshots',
        'context.visualElements',
        'context.pageVisualElements when candidates miss the correct visible region',
        'context.apiCandidates when the page is API-backed and DOM candidates are weak or blocked',
        'context.visualElements[].source, annotationLabel, rowCoverage, boundingBox, samplesByKind',
        'candidate.boundingBox or candidate.layout.boundingBox',
        'candidate.sampleRows',
        'candidate.fields',
        'candidate.diagnostics',
        'candidate.pagination'
      ],
      taskTargetRule: 'Before choosing any candidate, infer the primary task target from the user goal and real-time visible page structure. If the user goal is explicit, honor it; if it is vague or absent, use the page title, first viewport, active tab/navigation, semantic purpose, and main-content prominence to decide whether the target is a single entity/detail, a repeated list/feed/table, a form, or another main region. Do not hard-code detail extraction and do not automatically choose the largest list; record the target judgment in visualReview evidence.',
      rankingRule: 'Choose the candidate that best matches the user goal and the visible main content in the full-page screenshot. Text samples alone are insufficient when layout, sidebars, ads, or pagination are ambiguous. Use visible_dom visualElements to recover fields that the deterministic detector did not promote. For detail/current-page goals, sidebar recommendation lists are wrong even when their fields look complete.',
      recommendedCandidateRule: 'recommendedCandidateId is a deterministic hint, not a final answer. Override it when screenshot/layout/diagnostics/sampleRows show a better match for the user goal. If no candidate covers the visible target, create selection.customCandidate from pageVisualElements instead of forcing a wrong candidate.',
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
    ...(visualElements.length ? { visualElements } : {}),
    ...(result.pageVisualElements?.length ? { pageVisualElements: result.pageVisualElements } : {}),
    ...(result.apiCandidates?.length ? { apiCandidates: result.apiCandidates } : {}),
    ...(result.searchPlan ? { searchPlan: result.searchPlan } : {}),
    ...(result.popupDismissals?.length ? { popupDismissals: result.popupDismissals } : {}),
    ...(result.savedSession ? { savedSession: result.savedSession } : {}),
    candidates
  };
}

export function recommendedCandidate(candidates: DetectedCandidate[]): DetectedCandidate | undefined {
  const usable = candidates.filter((candidate) => candidate.type !== 'form');
  const ranked = usable.length ? usable : candidates;
  return rankCandidates(ranked)[0];
}

function buildAgentVisualArtifacts(screenshot: DetectedAgentScreenshot | undefined): AgentVisualArtifacts | undefined {
  if (!screenshot) return undefined;
  return {
    fullPageScreenshotPath: screenshot.path,
    ...(screenshot.annotatedPath ? { annotatedScreenshotPath: screenshot.annotatedPath } : {}),
    candidateScreenshots: (screenshot.candidateScreenshots ?? []).map((item) => ({
      candidateId: item.candidateId,
      path: item.path,
      rank: item.rank,
      boundingBox: item.boundingBox
    }))
  };
}

function buildAgentDecisionSummary(
  candidates: DetectedCandidate[],
  recommendedCandidateId: string | undefined,
  visualArtifacts: AgentVisualArtifacts | undefined
): AgentDecisionSummary {
  const cropByCandidate = new Map((visualArtifacts?.candidateScreenshots ?? []).map((item) => [item.candidateId, item]));
  const ranked = rankCandidates(candidates);
  return {
    ...(recommendedCandidateId ? { recommendedCandidateId } : {}),
    useTheseVisualInputs: [
      ...(visualArtifacts?.annotatedScreenshotPath ? [`annotatedScreenshotPath=${visualArtifacts.annotatedScreenshotPath}`] : []),
      ...(visualArtifacts?.fullPageScreenshotPath ? [`fullPageScreenshotPath=${visualArtifacts.fullPageScreenshotPath}`] : []),
      ...(visualArtifacts?.candidateScreenshots.length ? ['candidateScreenshots for top ranked candidate crops'] : [])
    ],
    candidates: ranked.map((candidate, index): AgentCandidateDecisionSummary => {
      const crop = cropByCandidate.get(candidate.id);
      return {
        candidateId: candidate.id,
        rank: index + 1,
        type: candidate.type,
        title: candidate.title,
        confidence: candidate.confidence,
        ...(candidate.goalScore !== undefined ? { goalScore: candidate.goalScore } : {}),
        ...(candidate.layout?.role ? { role: candidate.layout.role } : {}),
        itemCount: candidate.itemCount,
        fieldNames: candidate.fields.map((field) => field.name),
        fields: candidate.fields.map((field) => ({
          name: field.name,
          ...(field.elementId ? { elementId: field.elementId } : {}),
          kind: field.kind
        })),
        ...(candidate.visualElements?.length ? {
          visibleDomHints: candidate.visualElements
            .filter((element) => element.source === 'visible_dom')
            .slice(0, 12)
            .map((element) => ({
              elementId: element.id,
              annotationLabel: element.annotationLabel,
              role: element.role,
              kind: element.kind,
              sample: element.sample,
              ...(element.rowCoverage ? { rowCoverage: element.rowCoverage } : {})
            }))
        } : {}),
        ...(candidate.sampleRows[0] ? { sampleRow: candidate.sampleRows[0] } : {}),
        visual: {
          ...(candidateBoundingBox(candidate) ? { boundingBox: candidateBoundingBox(candidate) } : {}),
          ...(crop ? { candidateScreenshotPath: crop.path } : {})
        },
        strengths: candidateStrengths(candidate, recommendedCandidateId),
        risks: candidateRisks(candidate)
      };
    }),
    rules: [
      'Prefer the visible main content region that matches the user goal.',
      'Avoid candidates whose layout role is sidebar, nav, footer, header, or ad unless the user explicitly asks for that region.',
      'Prefer candidates with coherent repeated records, useful field names, populated samples, and pagination evidence when the user wants multiple pages.',
      'Use screenshot crop paths to verify candidateId before selecting fields.'
    ]
  };
}

function candidateBoundingBox(candidate: DetectedCandidate) {
  return candidate.diagnostics?.boundingBox;
}

function candidateStrengths(candidate: DetectedCandidate, recommendedCandidateId: string | undefined): string[] {
  const strengths: string[] = [];
  if (candidate.id === recommendedCandidateId) strengths.push('deterministic recommended candidate');
  if (candidate.layout?.role === 'main') strengths.push('layout is main content');
  if (candidate.itemCount >= 3) strengths.push(`contains ${candidate.itemCount} repeated items`);
  if (candidate.fields.length >= 2) strengths.push(`has ${candidate.fields.length} detected fields`);
  if (candidate.pagination) strengths.push(`has ${candidate.pagination.type} pagination evidence`);
  if (candidate.detailPlan?.fields.length) strengths.push(`has ${candidate.detailPlan.fields.length} detail-page field candidates`);
  return strengths;
}

function candidateRisks(candidate: DetectedCandidate): string[] {
  const risks: string[] = [];
  if (candidate.type === 'form') risks.push('form candidate is an input/search entry and cannot directly generate an extraction task');
  if (candidate.layout?.role && candidate.layout.role !== 'main') risks.push(`layout role is ${candidate.layout.role}`);
  if (candidate.fields.length <= 1) risks.push('few detected fields');
  if (candidate.diagnostics?.warnings.length) risks.push(...candidate.diagnostics.warnings.slice(0, 3));
  if (!candidate.sampleRows.length) risks.push('no sample rows');
  return risks;
}
