import type { DetectedApiListCandidate, DetectedCandidate, DetectedDetailPlan, DetectedField, DetectedFieldDiagnostics, DetectedPagination, DetectedVisualElement } from './types.js';
import { buildTaskFromCandidate } from './xml.js';
import { buildTaskFromApiListCandidate } from './api-list-detector.js';
import type {
  AgentCustomCandidatePlan,
  AgentDetailPlan,
  AgentFieldPlan,
  AgentPlan,
  AgentPlanPreview,
  AgentPreviewField,
  DetectAgentContext
} from './agent-types.js';

export function previewAgentPlan(options: { context: DetectAgentContext; plan: AgentPlan }): AgentPlanPreview {
  const apiCandidate = resolveAgentPlanApiCandidate(options.context, options.plan);
  if (apiCandidate) return previewApiAgentPlan(options.context, options.plan, apiCandidate);
  const base = resolveAgentPlanBaseCandidate(options.context, options.plan);
  if (base.type === 'form') throw new Error('Form candidates cannot directly generate extraction tasks.');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  const warnings: string[] = [];
  const recommendedFixes: string[] = [];
  const fields = previewFields(candidate.fields, base.fields);
  const detailFields = candidate.detailPlan ? previewFields(candidate.detailPlan.fields, base.detailPlan?.fields ?? []) : [];
  collectAgentVisualReviewWarnings(warnings, recommendedFixes, options.context, options.plan, candidate.id);
  collectAgentGoalRegionWarnings(warnings, recommendedFixes, options.context, candidate);
  collectAgentPreviewWarnings(warnings, recommendedFixes, candidate, fields, detailFields);
  const dedupedWarnings = Array.from(new Set(warnings));
  const dedupedFixes = Array.from(new Set(recommendedFixes));
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
    ...(options.plan.visualReview ? { visualReview: options.plan.visualReview } : {}),
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
    warnings: dedupedWarnings,
    recommendedFixes: dedupedFixes,
    ...(dedupedWarnings.length || dedupedFixes.length ? { repairInstruction: buildAgentRepairInstruction(dedupedWarnings, dedupedFixes) } : {}),
    pass: !hasBlockingAgentPreviewRisk(fields, detailFields)
      && !hasBlockingVisualReviewRisk(options.context, options.plan, candidate.id)
      && !hasBlockingGoalRegionRisk(options.context, candidate)
  };
}

export function buildTaskFromAgentPlan(options: {
  context: DetectAgentContext;
  plan: AgentPlan;
  taskId: string;
  taskName: string;
}) {
  const apiCandidate = resolveAgentPlanApiCandidate(options.context, options.plan);
  if (apiCandidate) {
    return buildTaskFromApiListCandidate({
      url: options.context.finalUrl,
      taskId: options.taskId,
      taskName: options.taskName,
      candidate: apiCandidate
    });
  }
  const base = resolveAgentPlanBaseCandidate(options.context, options.plan);
  if (base.type === 'form') throw new Error('Form candidates cannot directly generate extraction tasks.');
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

function resolveAgentPlanApiCandidate(context: DetectAgentContext, plan: AgentPlan): DetectedApiListCandidate | undefined {
  const apiCandidateId = plan.selection?.apiCandidateId;
  if (!apiCandidateId) return undefined;
  const candidate = context.apiCandidates?.find((item) => item.id === apiCandidateId);
  if (!candidate) throw new Error(`Agent plan references an unknown API candidate: ${apiCandidateId}`);
  return candidate;
}

function previewApiAgentPlan(context: DetectAgentContext, plan: AgentPlan, candidate: DetectedApiListCandidate): AgentPlanPreview {
  const warnings: string[] = [];
  const recommendedFixes: string[] = [];
  if (context.screenshot?.path && !plan.visualReview?.reviewed) {
    warnings.push('visualReview: plan does not confirm that context.screenshot.path was opened before choosing API candidate');
    recommendedFixes.push('Confirm the API candidate matches the primary visible list, not recommendations, ads, or an unrelated endpoint.');
  }
  const fields: AgentPreviewField[] = candidate.fields.map((field) => ({
    name: field.name,
    kind: field.type === 'url' ? 'href' : 'text',
    xpath: field.path,
    samples: field.samples.slice(0, 3),
    warnings: [],
    runtimeScope: 'loop_item',
    notes: ['API JSONPath field']
  }));
  return {
    schemaVersion: 'octopus.detect.agent-preview.v1',
    candidateId: candidate.id,
    candidate: {
      id: candidate.id,
      type: 'api_list',
      title: candidate.title,
      confidence: candidate.confidence,
      itemCount: candidate.itemCount
    },
    ...(plan.visualReview ? { visualReview: plan.visualReview } : {}),
    fields,
    ...(candidate.pagination ? {
      pagination: {
        type: 'scroll',
        xpath: '',
        text: `${candidate.pagination.param}${candidate.pagination.pageSizeParam ? `/${candidate.pagination.pageSizeParam}` : ''}`,
        confidence: candidate.confidence,
        isAjax: true,
        scope: 'global',
        reasons: candidate.reasons
      }
    } : {}),
    warnings,
    recommendedFixes,
    ...(warnings.length || recommendedFixes.length ? { repairInstruction: buildAgentRepairInstruction(warnings, recommendedFixes) } : {}),
    pass: warnings.length === 0
  };
}

function resolveAgentPlanBaseCandidate(context: DetectAgentContext, plan: AgentPlan): DetectedCandidate {
  const custom = plan.selection?.customCandidate;
  if (custom) return buildCustomCandidate(context, custom, plan.selection?.candidateId ?? plan.candidateId);
  const candidateId = plan.selection?.candidateId ?? plan.candidateId;
  if (!candidateId) throw new Error('Agent plan is missing selection.candidateId.');
  const base = context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan references an unknown candidate: ${candidateId}`);
  return base;
}

function buildCustomCandidate(
  context: DetectAgentContext,
  custom: AgentCustomCandidatePlan,
  fallbackId: string | undefined
): DetectedCandidate {
  if (!custom.xpath) throw new Error('Agent customCandidate is missing xpath.');
  const id = custom.id ?? fallbackId ?? 'agent_custom_candidate';
  const pageVisualElements = context.pageVisualElements ?? [];
  const elementIds = collectCustomCandidateElementIds(custom);
  const visualElements = elementIds.length
    ? elementIds.map((elementId) => {
        const element = pageVisualElements.find((item) => item.id === elementId || item.annotationLabel === elementId);
        if (!element) throw new Error(`Agent customCandidate references an unknown pageVisualElement: ${elementId}`);
        return {
          ...element,
          candidateId: custom.id ?? fallbackId ?? 'agent_custom_candidate',
          scope: 'visible_dom' as const,
          source: 'visible_dom' as const,
          relativeXPath: relativeXPathFromBase(custom.itemXPath ?? custom.xpath, element.xpath)
        };
      })
    : [];
  const fieldPlan = custom.fields ?? custom.fieldElementIds ?? [];
  const fields = fieldPlan.length
    ? applyAgentFieldPlan([], fieldPlan, 'custom_field', visualElements, custom.itemXPath ?? custom.xpath)
    : visualElements.map((element, index) => {
        const field = visualElementToField(element, element.fieldName || element.label || `custom_field_${index + 1}`);
        if (!field) throw new Error(`Agent customCandidate cannot derive a field from pageVisualElement: ${element.id}`);
        return field;
      });
  if (!fields.length) throw new Error('Agent customCandidate requires fields or fieldElementIds.');
  const sampleRows = custom.sampleRows?.length
    ? custom.sampleRows
    : [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))];
  return {
    id,
    type: custom.type ?? 'repeated_card',
    title: custom.title ?? 'Agent custom candidate',
    confidence: custom.confidence ?? 0.72,
    selector: custom.selector ?? '',
    xpath: custom.xpath,
    itemSelector: custom.itemSelector,
    itemXPath: custom.itemXPath ?? custom.xpath,
    itemCount: custom.itemCount ?? Math.max(1, sampleRows.length),
    fields,
    ...(visualElements.length ? { visualElements } : {}),
    sampleRows,
    reasons: [
      ...(custom.reasons ?? []),
      ...(custom.evidence ?? []).map((item) => `Agent visual evidence: ${item}`),
      'Synthetic candidate supplied by external agent plan'
    ]
  };
}

function collectCustomCandidateElementIds(custom: AgentCustomCandidatePlan): string[] {
  const ids = [
    ...(custom.fieldElementIds ?? []),
    ...(custom.fields ?? []).flatMap((field) => typeof field === 'string'
      ? [field]
      : [field.elementId, field.fieldId, field.source].filter((value): value is string => Boolean(value)))
  ];
  return Array.from(new Set(ids));
}

function previewFields(fields: DetectedField[], sourceFields: DetectedField[]): AgentPreviewField[] {
  return fields.map((field) => {
    const source = findPreviewSourceField(field, sourceFields);
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

function findPreviewSourceField(field: DetectedField, sourceFields: DetectedField[]): DetectedField | undefined {
  return sourceFields.find((item) => item === field)
    ?? sourceFields.find((item) => field.elementId && item.elementId === field.elementId)
    ?? sourceFields.find((item) => field.fieldId && item.fieldId === field.fieldId)
    ?? sourceFields.find((item) => item.name === field.name)
    ?? sourceFields.find((item) => item.xpath === field.xpath && item.kind === field.kind)
    ?? sourceFields.find((item) => item.xpath === field.xpath);
}

function isAcceptableLoopFieldWarning(warning: string, field: DetectedField): boolean {
  return Boolean(field.relativeXPath)
    && /xpath matched \d+ elements/i.test(warning)
    && /runtime may use the first element/i.test(warning);
}

function collectAgentVisualReviewWarnings(
  warnings: string[],
  recommendedFixes: string[],
  context: DetectAgentContext,
  plan: AgentPlan,
  selectedCandidateId: string
): void {
  if (!context.screenshot?.path) return;
  const review = plan.visualReview;
  if (!review?.reviewed) {
    warnings.push('visualReview: plan does not confirm that context.screenshot.path was opened and reviewed before choosing fields');
    recommendedFixes.push('Open context.screenshot.path before writing the plan, verify the candidate and field positions in the full-page screenshot, and record reviewed=true plus evidence in plan.visualReview.');
    return;
  }
  if (review.screenshotPath && review.screenshotPath !== context.screenshot.path) {
    warnings.push(`visualReview: screenshotPath does not match context.screenshot.path (${context.screenshot.path})`);
    recommendedFixes.push('Set plan.visualReview.screenshotPath to context.screenshot.path to avoid reusing an old screenshot or wrong page.');
  }
  if (review.annotatedScreenshotPath && review.annotatedScreenshotPath !== context.screenshot.annotatedPath) {
    warnings.push(`visualReview: annotatedScreenshotPath does not match context.screenshot.annotatedPath (${context.screenshot.annotatedPath ?? 'not available'})`);
    recommendedFixes.push('Set plan.visualReview.annotatedScreenshotPath to context.screenshot.annotatedPath, or omit the field.');
  }
  const selectedCrop = context.screenshot.candidateScreenshots?.find((item) => item.candidateId === selectedCandidateId);
  if (review.candidateScreenshotPath && selectedCrop && review.candidateScreenshotPath !== selectedCrop.path) {
    warnings.push(`visualReview: candidateScreenshotPath does not match the selected candidate crop (${selectedCrop.path})`);
    recommendedFixes.push('Set plan.visualReview.candidateScreenshotPath to the selected candidate crop path to avoid reviewing the wrong region.');
  }
  if (review.selectedCandidateId && review.selectedCandidateId !== selectedCandidateId) {
    warnings.push(`visualReview: selectedCandidateId ${review.selectedCandidateId} does not match selection.candidateId ${selectedCandidateId}`);
    recommendedFixes.push('Verify the actual extraction region in the full-page screenshot and keep visualReview.selectedCandidateId aligned with selection.candidateId.');
  }
  if (!review.evidence?.length) {
    warnings.push('visualReview: evidence is missing; the plan should state what was visually verified');
    recommendedFixes.push('Add plan.visualReview.evidence describing the screenshot evidence for the main list, key fields, detail/pagination controls, or excluded ads/sidebars.');
  }
  if (!review.checks) {
    warnings.push('visualReview: checks is missing; structured visual confirmations make the plan easier to audit');
    recommendedFixes.push('Add plan.visualReview.checks with mainRegionVerified, fieldsVerified, paginationVerified/detailLinksVerified, and excludedRegions where applicable.');
  } else {
    if (review.checks.mainRegionVerified === false) {
      warnings.push('visualReview: mainRegionVerified is false');
      recommendedFixes.push('Use the annotated screenshot to confirm selection.candidateId matches the main extraction region before setting mainRegionVerified=true.');
    }
    if (review.checks.fieldsVerified === false) {
      warnings.push('visualReview: fieldsVerified is false');
      recommendedFixes.push('Use the candidate crop to confirm field positions and semantics before setting fieldsVerified=true.');
    }
  }
}

function buildAgentRepairInstruction(warnings: string[], recommendedFixes: string[]): string {
  return [
    'Revise the agent plan before applying it.',
    warnings.length ? `Warnings: ${warnings.slice(0, 5).join(' | ')}` : '',
    recommendedFixes.length ? `Recommended fixes: ${recommendedFixes.slice(0, 5).join(' | ')}` : '',
    'Open the annotated screenshot and selected candidate crop, then update selection.candidateId, selection.fields, pagination/detail, and visualReview evidence/checks.'
  ].filter(Boolean).join(' ');
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
      recommendedFixes.push(`${prefix}: XPath may select a style/CSS container; choose the visible content container instead.`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.textLength ?? maxSampleLength(field.samples)) < 300) {
      recommendedFixes.push(`${prefix}: content text is short; prefer a parent under article/main that contains multiple paragraph elements.`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.paragraphCount ?? 2) <= 1) {
      recommendedFixes.push(`${prefix}: paragraph count is low; the XPath may select only one paragraph instead of the full content container.`);
    }
    if ((field.diagnostics?.matchCount ?? 1) > 1 && field.runtimeScope !== 'loop_item') {
      recommendedFixes.push(`${prefix}: XPath matches multiple elements; if runtime will take only the first, use a parent container XPath or explicitly merge text segments.`);
    }
  }
  if (!candidate.detailPlan && fields.some((field) => field.kind === 'href' || field.name === 'url')) {
    warnings.push('plan has list URL fields but no detail plan');
    recommendedFixes.push('If the goal includes detail-page content, add detail.mode=list_with_detail, urlField=url, and detail.fields.');
  }
}

function collectAgentGoalRegionWarnings(
  warnings: string[],
  recommendedFixes: string[],
  context: DetectAgentContext,
  candidate: DetectedCandidate
): void {
  const role = candidate.layout?.role;
  if (!role || !isNonPrimaryRegion(role) || !goalRequiresPrimaryContent(context.goal)) return;
  warnings.push(`goal/layout mismatch: selected candidate ${candidate.id} is ${role}, but the goal requires the primary/detail content region`);
  recommendedFixes.push('Do not select sidebar/navigation/footer/ad candidates; if the main content has no candidate, create a detail or main-content customCandidate from pageVisualElements.');
}

function hasBlockingVisualReviewRisk(context: DetectAgentContext, plan: AgentPlan, selectedCandidateId: string): boolean {
  if (!context.screenshot?.path) return false;
  const review = plan.visualReview;
  return !review?.reviewed
    || !review.evidence?.length
    || Boolean(review.screenshotPath && review.screenshotPath !== context.screenshot.path)
    || Boolean(review.annotatedScreenshotPath && review.annotatedScreenshotPath !== context.screenshot.annotatedPath)
    || Boolean(review.candidateScreenshotPath && context.screenshot.candidateScreenshots?.some((item) => item.candidateId === selectedCandidateId) && review.candidateScreenshotPath !== context.screenshot.candidateScreenshots.find((item) => item.candidateId === selectedCandidateId)?.path)
    || Boolean(review.selectedCandidateId && review.selectedCandidateId !== selectedCandidateId);
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

function hasBlockingGoalRegionRisk(context: DetectAgentContext, candidate: DetectedCandidate): boolean {
  const role = candidate.layout?.role;
  return Boolean(role && isNonPrimaryRegion(role) && goalRequiresPrimaryContent(context.goal));
}

function isNonPrimaryRegion(role: string): boolean {
  return /^(sidebar|nav|footer|header|ad)$/i.test(role);
}

function goalRequiresPrimaryContent(goal: string | undefined): boolean {
  const normalized = String(goal ?? '').replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return false;
  if (/忽略.{0,12}(侧栏|导航|页脚|广告)|排除.{0,12}(侧栏|导航|页脚|广告)|ignore.{0,24}(sidebar|nav|navigation|footer|ad)/i.test(normalized)) return true;
  if (/主内容|主体|当前页|当前页面|详情|详情页|正文|介绍|商户介绍|primary|main content|detail page|detail|article|body/i.test(normalized)) return true;
  return false;
}

function isContentPreviewField(field: AgentPreviewField): boolean {
  return /(^|_)(content|body|article|正文)(_|$)/i.test(field.name)
    || /(^|_)(content|body|article|正文)(_|$)/i.test(field.sourceName ?? '');
}

function maxSampleLength(samples: string[]): number {
  return samples.reduce((max, sample) => Math.max(max, String(sample ?? '').length), 0);
}

function applyAgentPlanToCandidate(candidate: DetectedCandidate, plan: AgentPlan): DetectedCandidate {
  const selection = plan.selection ?? {};
  const fieldsPlan = selection.fields ?? plan.fields;
  const detailPlan = selection.detail !== undefined ? selection.detail : plan.detail;
  const paginationPlan = selection.pagination !== undefined ? selection.pagination : plan.pagination;
  return {
    ...candidate,
    fields: fieldsPlan ? applyAgentFieldPlan(candidate.fields, fieldsPlan, 'field', candidate.visualElements ?? [], candidate.itemXPath ?? candidate.xpath) : candidate.fields,
    ...(paginationPlan !== undefined ? { pagination: normalizeAgentPagination(paginationPlan) } : {}),
    ...(detailPlan !== undefined ? { detailPlan: normalizeAgentDetailPlan(candidate, detailPlan) } : {})
  };
}

function applyAgentFieldPlan(
  fields: DetectedField[],
  plan: AgentFieldPlan[],
  fallbackPrefix: string,
  visualElements: DetectedVisualElement[] = [],
  itemXPath = ''
): DetectedField[] {
  return plan.map((item, index) => {
    if (typeof item === 'string') {
      const field = fields.find((candidate) => candidate.name === item || candidate.elementId === item || candidate.fieldId === item)
        ?? visualElementToField(findVisualElement(visualElements, item), item);
      if (!field) throw new Error(`Agent plan references an unknown field or element: ${item}`);
      return field;
    }
    const source = item.elementId ?? item.fieldId ?? item.source ?? item.name;
    const sourceField = source ? fields.find((field) => field.elementId === source || field.fieldId === source || field.name === source) : undefined;
    const sourceElementField = sourceField ? undefined : visualElementToField(
      source ? findVisualElement(visualElements, source) : undefined,
      item.as ?? item.name ?? source ?? `${fallbackPrefix}_${index + 1}`,
      item.kind
    );
    if (!sourceField && !sourceElementField && !item.xpath) throw new Error(`Agent plan field is missing elementId, source, or xpath: ${item.as ?? item.name ?? `${fallbackPrefix}_${index + 1}`}`);
    return {
      ...(sourceField ?? sourceElementField ?? {
        kind: item.kind ?? 'text',
        selector: item.selector ?? '',
        xpath: item.xpath ?? '',
        samples: item.samples ?? [],
        ...(item.xpath && itemXPath ? { relativeXPath: relativeXPathFromBase(itemXPath, item.xpath) } : {})
      }),
      name: item.as ?? item.name ?? sourceField?.name ?? sourceElementField?.name ?? `${fallbackPrefix}_${index + 1}`,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.xpath ? { xpath: item.xpath } : {}),
      ...(item.relativeXPath ? { relativeXPath: item.relativeXPath } : item.xpath && itemXPath ? { relativeXPath: relativeXPathFromBase(itemXPath, item.xpath) } : {}),
      ...(item.samples ? { samples: item.samples } : {}),
      ...(item.operations ? { operations: item.operations } : {})
    };
  });
}

function findVisualElement(visualElements: DetectedVisualElement[], source: string): DetectedVisualElement | undefined {
  return visualElements.find((element) => element.id === source
    || element.fieldId === source
    || element.annotationLabel === source
    || element.fieldName === source
    || element.label === source);
}

function visualElementToField(
  element: DetectedVisualElement | undefined,
  fallbackName: string,
  requestedKind?: DetectedField['kind']
): DetectedField | undefined {
  if (!element) return undefined;
  const kind = requestedKind ?? element.kind;
  const samples = samplesForVisualElementKind(element, kind);
  return {
    fieldId: element.fieldId || element.id,
    elementId: element.id,
    name: element.fieldName || element.label || fallbackName,
    kind,
    selector: element.selector || element.tagName || '',
    xpath: element.xpath,
    ...(element.relativeXPath ? { relativeXPath: element.relativeXPath } : {}),
    samples,
    diagnostics: visualElementDiagnostics(element, samples)
  };
}

function samplesForVisualElementKind(element: DetectedVisualElement, kind: DetectedField['kind']): string[] {
  const byKind = element.samplesByKind?.[kind]?.filter(Boolean);
  if (byKind?.length) return byKind.slice(0, 3);
  if (kind === element.kind && element.samples.length) return element.samples.slice(0, 3);
  if (kind === 'href') {
    const href = element.attributes?.href || '';
    return href ? [href] : [];
  }
  if (kind === 'src') {
    const src = element.attributes?.src || element.attributes?.currentSrc || '';
    return src ? [src] : [];
  }
  if (kind === 'value') {
    const value = element.attributes?.value || element.sample || '';
    return value ? [value] : [];
  }
  return element.samples.length ? element.samples.slice(0, 3) : element.sample ? [element.sample] : [];
}

function visualElementDiagnostics(element: DetectedVisualElement, samples: string[]): DetectedFieldDiagnostics {
  const matchedRows = element.rowCoverage?.matchedRows ?? (element.visible ? 1 : 0);
  const text = samples.join(' ');
  return {
    matchCount: Math.max(1, matchedRows),
    textLength: text.length,
    paragraphCount: Math.max(0, samples.filter(Boolean).length),
    hasStyleNoise: false,
    ...(element.boundingBox ? { boundingBox: element.boundingBox } : {}),
    ...(element.sample ? { sampleText: element.sample } : {}),
    warnings: []
  };
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

function relativeXPathFromBase(baseXPath: string, fieldXPath: string): string {
  const fieldPath = normalizeIndexedFieldXPath(baseXPath, fieldXPath);
  if (!baseXPath || !fieldPath || !fieldPath.startsWith(baseXPath)) return relativeXPathFromItem(fieldPath);
  const suffix = fieldPath.slice(baseXPath.length);
  if (!suffix) return '.';
  return suffix.startsWith('//') ? `.${suffix}` : `.${suffix}`;
}

function relativeXPathFromItem(xpath: string): string {
  const trimmed = xpath.trim();
  if (!trimmed) return '';
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return '';
  const tail = trimmed.slice(lastSlash + 1);
  return tail ? `/${tail}` : '';
}

function normalizeIndexedFieldXPath(baseXPath: string, fieldXPath: string): string {
  if (!baseXPath || !fieldXPath) return fieldXPath;
  const normalizedBase = baseXPath.replace(/\/+$/, '');
  const indexedPrefix = fieldXPath.slice(normalizedBase.length).match(/^\[\d+\](?=\/|\/\/|$)/)?.[0];
  if (fieldXPath.startsWith(normalizedBase) && indexedPrefix) {
    return normalizedBase + fieldXPath.slice(normalizedBase.length + indexedPrefix.length);
  }
  return fieldXPath;
}
