import type { AgentPlanPreview } from '../../runtime/detector/agent-types.js';
import type { DetectedAgentScreenshot, PageDetectionResult } from '../../runtime/detector/types.js';
import { recommendedCandidate } from '../../runtime/detector/agent-context.js';

export function printDetectHuman(result: PageDetectionResult): void {
  console.log(`URL: ${result.finalUrl}`);
  console.log(`Title: ${result.title || '(untitled)'}`);
  console.log('');
  if (!result.candidates.length) {
    console.log('No extractable candidates were detected. Try increasing --scrolls, or open a search/list result page and retry.');
    return;
  }
  const selectedIds = result.selectedCandidateIds?.length
    ? result.selectedCandidateIds
    : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const selectedSet = new Set(selectedIds);
  const visibleCandidates = selectedSet.size
    ? result.candidates.filter((candidate) => selectedSet.has(candidate.id))
    : result.candidates;
  const recommended = selectedSet.size
    ? visibleCandidates[0] ?? recommendedCandidate(result.candidates)
    : recommendedCandidate(result.candidates);
  if (!recommended) return;
  if (selectedSet.size) {
    console.log(`Selected ${visibleCandidates.length} candidate(s): ${visibleCandidates.map((candidate) => candidate.id).join(', ')}`);
  } else {
    console.log(`Detected ${result.candidates.length} candidate(s). Candidates are not final tasks; choose the data region you want.`);
  }
  if (result.popupDismissals?.length) {
    console.log(`Dismissed popups: ${result.popupDismissals.map((item) => `${popupTypeLabel(item.type)}/${item.action}`).join(', ')}`);
  }
  console.log('');
  console.log('Recommendation:');
  if (recommended.type === 'form') {
    console.log('  This page appears to be a search/input entry point. Open the result page first, then run detect on that page.');
  } else {
    console.log(`  Start with [${recommended.id}] ${candidateTypeLabel(recommended.type)}.`);
    console.log(`  Generate task: octoparse detect ${shellArg(result.finalUrl)} --select ${recommended.id} --output task.json`);
    console.log('  Note: task.json is a literal file name; do not type angle brackets.');
  }
  for (const candidate of visibleCandidates) {
    console.log('');
    const scoreText = candidate.goalScore !== undefined
      ? `goalMatch=${formatConfidence(candidate.goalScore)}  confidence=${formatConfidence(candidate.confidence)}`
      : `confidence=${formatConfidence(candidate.confidence)}`;
    console.log(`[${candidate.id}] ${candidateTypeLabel(candidate.type)}  ${scoreText}`);
    console.log(`    ${candidateHint(candidate)}`);
    if (candidate.layout) {
      console.log(`    region=${candidateLayoutLabel(candidate.layout.role)} mainScore=${formatConfidence(candidate.layout.mainScore)} linkDensity=${formatConfidence(candidate.layout.linkDensity)}`);
    }
    if (candidate.pagination) {
      const paginationMode = candidate.pagination.revealByScroll ? ', reveal by scrolling first' : '';
      console.log(`    pagination=${paginationLabel(candidate.pagination.type)}${paginationMode} ${candidate.pagination.text ? `(${truncate(candidate.pagination.text, 40)})` : ''}  confidence=${formatConfidence(candidate.pagination.confidence)}`);
    }
    console.log(`    count=${candidate.itemCount} fields=${candidate.fields.map((field) => field.name).join(', ')}`);
    const sample = candidate.sampleRows[0];
    if (sample) console.log(`    sample=${formatSample(sample)}`);
    if (candidate.type === 'form') {
      console.log('    next: octoparse detect <url> --input q=keyword');
    } else {
      console.log(`    generate: octoparse detect ${shellArg(result.finalUrl)} --select ${candidate.id} --output task.json`);
    }
  }
}

export function printAgentPlanPreview(preview: AgentPlanPreview, screenshot: DetectedAgentScreenshot | undefined): void {
  console.log(`Agent plan preview: ${preview.candidateId}`);
  console.log(`Result: ${preview.pass ? 'pass' : 'not recommended; fix fields first'}`);
  console.log(`Candidate: ${candidateTypeLabel(preview.candidate.type)}  count=${preview.candidate.itemCount}  confidence=${formatConfidence(preview.candidate.confidence)}`);
  if (screenshot) console.log(`Screenshot: ${screenshot.path}`);
  if (preview.visualReview) {
    console.log(`Visual review: ${preview.visualReview.reviewed ? 'confirmed' : 'not confirmed'}`);
    if (preview.visualReview.evidence?.length) {
      for (const item of preview.visualReview.evidence) console.log(`  - ${item}`);
    }
  }
  console.log(`List fields: ${preview.fields.map((field) => field.name).join(', ') || '(none)'}`);
  if (preview.detail) {
    console.log(`Detail: ${detailModeLabel(preview.detail.mode)}  urlField=${preview.detail.urlField}`);
    console.log(`Detail fields: ${preview.detail.fields.map((field) => field.name).join(', ') || '(none)'}`);
  }
  if (preview.warnings.length) {
    console.log('');
    console.log('Risks:');
    for (const warning of preview.warnings) console.log(`  - ${warning}`);
  }
  if (preview.recommendedFixes.length) {
    console.log('');
    console.log('Recommended fixes:');
    for (const fix of preview.recommendedFixes) console.log(`  - ${fix}`);
  }
}

export function paginationLabel(type: string): string {
  if (type === 'next_page') return 'click next page';
  if (type === 'load_more') return 'click load more';
  if (type === 'scroll') return 'scroll loading';
  return type;
}

export function detailModeLabel(mode: string): string {
  if (mode === 'list_with_detail') return 'list + detail pages';
  if (mode === 'detail_only') return 'detail pages only';
  return 'list only';
}

export function candidateTypeLabel(type: string): string {
  if (type === 'table') return 'table';
  if (type === 'search_results') return 'linked list / search results';
  if (type === 'repeated_card') return 'repeated cards / list';
  if (type === 'link_collection') return 'link collection';
  if (type === 'form') return 'search/input form';
  if (type === 'detail') return 'detail page';
  return type;
}

function candidateLayoutLabel(role: string): string {
  if (role === 'main') return 'main';
  if (role === 'sidebar') return 'sidebar';
  if (role === 'header') return 'header';
  if (role === 'footer') return 'footer';
  if (role === 'nav') return 'navigation';
  if (role === 'ad') return 'ad';
  return 'unknown';
}

function popupTypeLabel(type: string): string {
  if (type === 'login') return 'login';
  if (type === 'cookie') return 'Cookie';
  if (type === 'newsletter') return 'newsletter';
  if (type === 'ad') return 'ad';
  if (type === 'captcha') return 'captcha';
  if (type === 'paywall') return 'paywall';
  return 'unknown';
}

function candidateHint(candidate: PageDetectionResult['candidates'][number]): string {
  if (candidate.type === 'form') return 'This is an entry point, not a data list. Use it only when building a search workflow.';
  if (candidate.type === 'link_collection') return 'Usually navigation, categories, or related links. Choose it only when you want a link list.';
  if (candidate.type === 'table') return 'Best for extracting table rows.';
  if (candidate.type === 'search_results') return 'Best for articles, products, search results, or feed lists with links.';
  if (candidate.type === 'repeated_card') return 'Best for repeated cards, articles, products, or list items.';
  return candidate.title;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSample(sample: Record<string, string>): string {
  const compact: Record<string, string> = {};
  for (const [key, value] of Object.entries(sample)) {
    compact[key] = truncate(value, 90);
  }
  return JSON.stringify(compact);
}

function truncate(value: string, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function shellArg(value: string): string {
  if (/^[\w\-./:?=%#]+$/.test(value) && value.length < 140) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
