import type { AgentVisualElement } from './agent-types.js';
import type { DetectedCandidate, DetectedField, DetectedVisualElement } from './types.js';

type AgentFieldScope = 'field' | 'detail' | 'visible_dom';

export function ensureAgentElementIds(candidates: DetectedCandidate[]): DetectedCandidate[] {
  let visualIndex = 1;
  return candidates.map((candidate) => ({
    ...candidate,
    fields: candidate.fields.map((field, index) => ensureFieldElementId(candidate.id, 'field', field, index)),
    ...(candidate.visualElements?.length ? {
      visualElements: candidate.visualElements.map((element, index) => ensureVisualElementId(candidate.id, element, index, visualIndex++))
    } : {}),
    ...(candidate.detailPlan ? {
      detailPlan: {
        ...candidate.detailPlan,
        fields: candidate.detailPlan.fields.map((field, index) => ensureFieldElementId(candidate.id, 'detail', field, index))
      }
    } : {})
  }));
}

export function buildAgentVisualElements(candidates: DetectedCandidate[]): AgentVisualElement[] {
  const seen = new Set<string>();
  const output: AgentVisualElement[] = [];
  const push = (element: AgentVisualElement) => {
    if (seen.has(element.id)) return;
    seen.add(element.id);
    output.push({
      ...element,
      annotationLabel: element.annotationLabel || `V${output.length + 1}`
    });
  };
  for (const candidate of candidates) {
    candidate.fields.map((field) => visualElementForField(candidate.id, 'field', field)).forEach(push);
    (candidate.visualElements ?? []).forEach((element) => push(element));
    (candidate.detailPlan?.fields.map((field) => visualElementForField(candidate.id, 'detail', field)) ?? []).forEach(push);
  }
  return output;
}

function ensureFieldElementId(
  candidateId: string,
  scope: AgentFieldScope,
  field: DetectedField,
  index: number
): DetectedField {
  const elementId = field.elementId || field.fieldId || buildFieldElementId(candidateId, scope, index, field.name);
  return {
    ...field,
    fieldId: field.fieldId || elementId,
    elementId
  };
}

function ensureVisualElementId(candidateId: string, element: DetectedVisualElement, index: number, visualIndex: number): DetectedVisualElement {
  return {
    ...element,
    candidateId: element.candidateId || candidateId,
    id: element.id || buildFieldElementId(candidateId, element.scope || 'visible_dom', index, element.fieldName || element.label || element.role),
    annotationLabel: element.annotationLabel || `V${visualIndex}`,
    scope: element.scope || 'visible_dom',
    source: element.source || 'visible_dom'
  };
}

function buildFieldElementId(candidateId: string, scope: AgentFieldScope, index: number, fieldName: string): string {
  return [
    'e',
    safeIdPart(candidateId),
    scope,
    String(index + 1),
    safeIdPart(fieldName || 'field')
  ].filter(Boolean).join('_');
}

function visualElementForField(candidateId: string, scope: AgentFieldScope, field: DetectedField): AgentVisualElement {
  return {
    id: field.elementId || field.fieldId || buildFieldElementId(candidateId, scope, 0, field.name),
    fieldId: field.fieldId || field.elementId,
    candidateId,
    scope,
    source: 'detected_field',
    fieldName: field.name,
    label: field.name,
    kind: field.kind,
    role: visualRoleForField(field),
    selector: field.selector,
    xpath: field.xpath,
    ...(field.relativeXPath ? { relativeXPath: field.relativeXPath } : {}),
    ...(field.diagnostics?.boundingBox ? { boundingBox: field.diagnostics.boundingBox } : {}),
    visible: field.diagnostics ? Boolean(field.diagnostics.matchCount && field.diagnostics.boundingBox) : true,
    clickable: field.kind === 'href',
    sample: field.diagnostics?.sampleText || field.samples[0] || '',
    samples: field.samples.slice(0, 3)
  };
}

function visualRoleForField(field: DetectedField): AgentVisualElement['role'] {
  if (field.kind === 'href') return 'link';
  if (field.kind === 'src') return 'image';
  if (field.kind === 'value') return 'input';
  return 'text';
}

function safeIdPart(value: string): string {
  return String(value)
    .trim()
    .replace(/[^a-z0-9_\u4e00-\u9fff-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'field';
}
