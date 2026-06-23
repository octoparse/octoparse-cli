import type { AgentVisualElement } from './agent-types.js';
import type { DetectedCandidate, DetectedField } from './types.js';

type AgentFieldScope = 'field' | 'detail';

export function ensureAgentElementIds(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    fields: candidate.fields.map((field, index) => ensureFieldElementId(candidate.id, 'field', field, index)),
    ...(candidate.detailPlan ? {
      detailPlan: {
        ...candidate.detailPlan,
        fields: candidate.detailPlan.fields.map((field, index) => ensureFieldElementId(candidate.id, 'detail', field, index))
      }
    } : {})
  }));
}

export function buildAgentVisualElements(candidates: DetectedCandidate[]): AgentVisualElement[] {
  return candidates.flatMap((candidate) => [
    ...candidate.fields.map((field) => visualElementForField(candidate.id, 'field', field)),
    ...(candidate.detailPlan?.fields.map((field) => visualElementForField(candidate.id, 'detail', field)) ?? [])
  ]);
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
    fieldName: field.name,
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
