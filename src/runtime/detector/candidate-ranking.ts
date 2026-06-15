import { isLegalBoilerplateText } from './candidate-boilerplate.js';
import type { DetectedCandidate } from './types.js';

export function applyGoalScores(candidates: DetectedCandidate[], goal: string): DetectedCandidate[] {
  const tokens = goalTokens(goal);
  return candidates
    .map((candidate) => {
      const haystack = [
        candidate.type,
        candidate.title,
        ...candidate.fields.map((field) => `${field.name} ${field.kind} ${field.samples.join(' ')}`),
        ...candidate.sampleRows.flatMap((row) => Object.values(row))
      ].join(' ').toLowerCase();
      let score = candidate.confidence;
      const reasons: string[] = [];
      for (const token of tokens) {
        if (haystack.includes(token)) {
          score += 0.08;
          reasons.push(`matches "${token}"`);
        }
      }
      if (/标题|title|链接|url|文章|商品|列表|结果|价格|price/i.test(goal) && candidate.type !== 'form' && candidate.type !== 'link_collection') {
        score += 0.12;
        reasons.push('goal asks for extractable list/detail data');
      }
      if (/搜索|查询|关键词|input|search/i.test(goal) && candidate.type === 'form') {
        score += 0.16;
        reasons.push('goal asks for search/input');
      }
      if (candidate.type === 'link_collection' && !/链接|url|导航|分类|link/i.test(goal)) {
        score -= 0.12;
      }
      const rawGoalScore = score + layoutRankingBoost(candidate);
      return {
        candidate: {
          ...candidate,
          goalScore: Number(Math.max(0, Math.min(0.99, rawGoalScore)).toFixed(2)),
          goalReasons: reasons
        },
        rankingScore: rawGoalScore + candidateDataQualityBoost(candidate)
      };
    })
    .sort((a, b) => b.rankingScore - a.rankingScore)
    .map((item) => item.candidate);
}

export function rankCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates
    .slice()
    .sort((a, b) => candidateRankingScore(b) - candidateRankingScore(a));
}

export function dedupeEquivalentCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  const kept: DetectedCandidate[] = [];
  for (const candidate of rankCandidates(candidates)) {
    const duplicateIndex = kept.findIndex((item) => candidatesLikelySameDataset(item, candidate));
    if (duplicateIndex === -1) {
      kept.push(candidate);
      continue;
    }
    if (candidateDedupScore(candidate) > candidateDedupScore(kept[duplicateIndex])) {
      kept[duplicateIndex] = candidate;
    }
  }
  return rankCandidates(kept);
}

export function filterDetectedBoilerplateCandidates(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates.filter((candidate) => !candidateIsLegalBoilerplate(candidate) && !candidateLooksLikePaginationControls(candidate));
}

function candidateIsLegalBoilerplate(candidate: Pick<DetectedCandidate, 'sampleRows' | 'fields' | 'reasons' | 'layout' | 'type'>): boolean {
  if (candidate.layout?.role === 'footer' && candidate.layout.boilerplatePenalty >= 0.55) return true;
  if (candidate.reasons.some((reason) => /footer\/legal boilerplate/i.test(reason))) return true;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ];
  return values.some((value) => isLegalBoilerplateText(value));
}

export function candidateLooksLikePaginationControls(candidate: Pick<DetectedCandidate, 'sampleRows' | 'fields' | 'reasons' | 'type' | 'xpath' | 'itemXPath' | 'itemCount'>): boolean {
  if (candidate.type === 'form' || candidate.type === 'detail') return false;
  if (candidate.itemCount < 2 || candidate.fields.length > 4) return false;
  const structural = [
    candidate.xpath,
    candidate.itemXPath,
    candidate.reasons.join(' '),
    ...candidate.fields.flatMap((field) => [field.name, field.xpath, field.relativeXPath ?? '', field.selector])
  ].join(' ');
  const hasPagerStructure = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(structural);
  if (!hasPagerStructure) return false;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map((value) => String(value ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (values.length < 2) return false;
  const pageTokenCount = values.filter((value) => /^(?:\d{1,5}|next|prev|previous|>|›|»|→|<|‹|«|←|下一页|上一页|下页|上页)$/i.test(value)).length;
  const pageUrlCount = values.filter(isPaginationUrlValue).length;
  const shortValueCount = values.filter((value) => value.length <= 48).length;
  const paginationValueRate = (pageTokenCount + pageUrlCount) / values.length;
  const shortValueRate = shortValueCount / values.length;
  const pairedPageLinks = pageTokenCount >= 2 && pageUrlCount >= 2;
  return paginationValueRate >= 0.55 && (shortValueRate >= 0.7 || pairedPageLinks);
}

function isPaginationUrlValue(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Array.from(parsed.searchParams.keys()).some((key) => /^(?:page|p|page_num|pagenum|paged|offset|start)$/i.test(key))
      || /\/page\/\d+(?:[/?#]|$)/i.test(parsed.pathname);
  } catch {
    return /(?:[?&](?:page|p|page_num|pagenum|paged|offset|start)=\d+|\/page\/\d+(?:[/?#]|$))/i.test(value);
  }
}

function candidatesLikelySameDataset(left: DetectedCandidate, right: DetectedCandidate): boolean {
  if (left.type === 'form' || right.type === 'form' || left.type === 'detail' || right.type === 'detail') return false;
  if (left.id === right.id) return true;
  const leftItems = normalizeXPathForOverlap(left.itemXPath || left.xpath);
  const rightItems = normalizeXPathForOverlap(right.itemXPath || right.xpath);
  if (leftItems && rightItems && (leftItems === rightItems || leftItems.startsWith(`${rightItems}/`) || rightItems.startsWith(`${leftItems}/`))) {
    return true;
  }

  const urlOverlap = jaccard(sampleValuesForCandidate(left, ['url']), sampleValuesForCandidate(right, ['url']));
  if (urlOverlap >= 0.5) return true;
  const imageOverlap = jaccard(sampleValuesForCandidate(left, ['image']), sampleValuesForCandidate(right, ['image']));
  if (imageOverlap >= 0.5) return true;

  const textOverlap = jaccard(
    normalizedSampleTexts(left).filter((value) => value.length >= 8),
    normalizedSampleTexts(right).filter((value) => value.length >= 8)
  );
  return textOverlap >= 0.55 && fieldNameOverlap(left, right) >= 0.5;
}

function candidateDedupScore(candidate: DetectedCandidate): number {
  const fieldNames = new Set(candidate.fields.map((field) => field.name));
  const semanticFields = Array.from(fieldNames)
    .filter((name) => /^(?:title|url|image|date|author|likes|summary|标题|标题链接|链接|图片|日期|时间|作者|摘要|描述|价格|评分|数量)$|href|link/i.test(name))
    .length;
  const refinedBonus = candidate.reasons.some((reason) => /Fields refined/i.test(reason)) ? 0.18 : 0;
  const typeBonus = candidate.type === 'repeated_card' ? 0.08 : candidate.type === 'search_results' ? 0.04 : 0;
  const layout = candidate.layout;
  const layoutBonus = layout
    ? layout.mainScore * 0.16 - layout.sidebarPenalty * 0.12 - layout.boilerplatePenalty * 0.12 + (layout.role === 'main' ? 0.08 : 0)
    : 0;
  return candidate.confidence
    + semanticFields * 0.08
    + Math.min(0.18, candidate.itemCount / 80)
    + refinedBonus
    + typeBonus
    + layoutBonus;
}

function normalizeXPathForOverlap(xpath: string | undefined): string {
  return (xpath || '').replace(/\[\d+\]/g, '').replace(/\/+$/g, '');
}

function sampleValuesForCandidate(candidate: DetectedCandidate, names: string[]): string[] {
  const wanted = new Set(names);
  return candidate.sampleRows
    .flatMap((row) => Object.entries(row).filter(([key]) => wanted.has(key)).map(([, value]) => normalizeSampleValue(value)))
    .filter(Boolean);
}

function normalizedSampleTexts(candidate: DetectedCandidate): string[] {
  return candidate.sampleRows
    .flatMap((row) => Object.values(row))
    .map(normalizeSampleValue)
    .filter(Boolean);
}

function normalizeSampleValue(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[?#].*$/g, '')
    .trim()
    .toLowerCase();
}

function fieldNameOverlap(left: DetectedCandidate, right: DetectedCandidate): number {
  const leftNames = left.fields.map((field) => field.name);
  const rightNames = right.fields.map((field) => field.name);
  return jaccard(leftNames, rightNames);
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left.filter(Boolean));
  const rightSet = new Set(right.filter(Boolean));
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function candidateRankingScore(candidate: DetectedCandidate): number {
  return (candidate.goalScore ?? candidate.confidence + layoutRankingBoost(candidate)) + candidateDataQualityBoost(candidate);
}

function candidateDataQualityBoost(candidate: DetectedCandidate): number {
  const fields = candidate.fields;
  const sampleValues = [
    ...fields.flatMap((field) => field.samples),
    ...candidate.sampleRows.flatMap((row) => Object.values(row))
  ].map(normalizeSampleValue).filter(Boolean);
  const hasUsableTitle = fields.some((field) => /^(标题|title)$/i.test(field.name) && field.samples.some((sample) => !isLabelOnlySample(sample) && normalizeSampleValue(sample).length >= 4));
  const hasHref = fields.some((field) => field.kind === 'href' && field.samples.some(Boolean));
  const hasSummary = fields.some((field) => /摘要|描述|summary|description|snippet/i.test(field.name) && field.samples.some((sample) => normalizeSampleValue(sample).length >= 30));
  const nonEmptyCells = candidate.sampleRows.flatMap((row) => Object.values(row)).filter((value) => normalizeSampleValue(value)).length;
  const totalCells = Math.max(1, candidate.sampleRows.length * Math.max(1, fields.length));
  const fillRate = nonEmptyCells / totalCells;
  const firstRowValues = Object.values(candidate.sampleRows[0] ?? {});
  const firstRowFillRate = firstRowValues.filter((value) => normalizeSampleValue(value)).length / Math.max(1, fields.length);
  const labelRatio = sampleValues.length
    ? sampleValues.filter(isLabelOnlySample).length / sampleValues.length
    : 1;
  const smartFullColRate = protectedSmartFullColRate(candidate);
  const taxonomyLike = candidateLooksLikeTaxonomyFilterList(candidate);
  let boost = 0;
  if (hasUsableTitle && hasHref) boost += 0.12;
  if (hasSummary) boost += 0.06;
  if (fields.length >= 3) boost += 0.04;
  if (fillRate >= 0.7) boost += 0.03;
  if (smartFullColRate !== undefined) boost += Math.max(-0.08, Math.min(0.08, (smartFullColRate - 0.55) * 0.2));
  if (fields.some((field) => /reference|citation|referencetext|cs1format|脚注|引用/i.test(field.name))) boost -= 0.14;
  if (taxonomyLike) boost -= 0.34;
  if (candidateLooksLikeFooterOrNavigation(candidate)) boost -= 0.2;
  if (fields.some((field) => field.name.length > 80)) boost -= 0.08;
  if (firstRowFillRate < 0.35 && fields.length >= 6) boost -= 0.08;
  if (fields.length <= 2 && !hasHref) boost -= 0.18;
  if (labelRatio >= 0.55 && !hasHref) boost -= 0.16;
  if (candidate.type === 'repeated_card' && fields.length <= 2 && candidate.itemCount >= 40 && !hasHref) boost -= 0.08;
  return Math.max(-0.35, Math.min(0.25, boost));
}

function candidateLooksLikeFooterOrNavigation(candidate: DetectedCandidate): boolean {
  if (candidate.layout && ['footer', 'header', 'nav', 'ad'].includes(candidate.layout.role)) return true;
  const values = [
    ...candidate.sampleRows.flatMap((row) => Object.values(row)),
    ...candidate.fields.flatMap((field) => field.samples)
  ].map(normalizeSampleValue).filter(Boolean);
  if (!values.length) return false;
  const navTerms = values.filter((value) => /^(about|blog|home|login|sign in|sign up|privacy|terms|contact|careers|community|guides|tutorials|glossary|learn|tools|web technologies|html|css|javascript|首页|登录|注册|关于|博客|隐私|条款|联系)$/.test(value)).length;
  const shortRate = values.filter((value) => value.length <= 24).length / values.length;
  return navTerms / values.length >= 0.45 && shortRate >= 0.75;
}

function candidateLooksLikeTaxonomyFilterList(candidate: DetectedCandidate): boolean {
  if (candidate.itemCount < 8) return false;
  const hrefs = candidate.fields
    .filter((field) => field.kind === 'href')
    .flatMap((field) => field.samples)
    .map(normalizeSampleValue)
    .filter(Boolean);
  if (hrefs.length < 2) return false;
  if (hrefs.every(isTaxonomyHrefValue)) return true;
  const primaryHref = candidate.fields.find((field) => field.kind === 'href' && /^(?:url|链接|标题链接|title_?link|href)$/i.test(field.name))
    ?? candidate.fields.find((field) => field.kind === 'href');
  const primaryHrefValues = (primaryHref?.samples ?? []).map(normalizeSampleValue).filter(Boolean);
  if (primaryHrefValues.length < 2 || !primaryHrefValues.every(isTaxonomyHrefValue)) return false;
  const title = candidate.fields.find((field) => field.kind === 'text' && /^(?:title|标题)$/.test(field.name));
  const titleValues = (title?.samples ?? []).map(normalizeSampleValue).filter(Boolean);
  const shortFacetTitles = titleValues.length >= 2
    && titleValues.every((value) => value.length <= 48 && !/[.!?。！？]/.test(value));
  const noPrimaryRecordHref = hrefs
    .filter((value) => !primaryHrefValues.includes(value))
    .filter((value) => !isTaxonomyHrefValue(value))
    .length === 0;
  return shortFacetTitles && noPrimaryRecordHref;
}

function isTaxonomyHrefValue(value: string): boolean {
  return /(?:[?&](?:type|category|tag|topic|filter|industry|batch)=|\/(?:type|category|categories|tag|tags|topics?|filters?|industries|batches)\b)/i.test(value);
}

function protectedSmartFullColRate(candidate: DetectedCandidate): number | undefined {
  const reason = candidate.reasons.find((item) => /fullColRate=/i.test(item));
  const value = reason?.match(/fullColRate=([0-9.]+)/i)?.[1];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLabelOnlySample(value: string): boolean {
  const normalized = normalizeSampleValue(value).replace(/[:：]+$/g, '');
  if (!normalized) return true;
  return /^(authors?|submitted|comments?|abstract|capital|votes?|answers?|views?|asked|modified|updated|tags?|关键词|作者|提交|评论|摘要|首都)$/i.test(normalized)
    || (normalized.length <= 24 && /[:：]$/.test(String(value).trim()));
}

export function layoutRankingBoost(candidate: Pick<DetectedCandidate, 'layout' | 'type'>): number {
  const layout = candidate.layout;
  if (!layout) return 0;
  let boost = layout.score * 0.18 + layout.mainScore * 0.1 - layout.sidebarPenalty * 0.18 - layout.boilerplatePenalty * 0.18;
  if (layout.role === 'main') boost += 0.1;
  if (layout.role === 'sidebar') boost -= 0.08;
  if (layout.role === 'nav' || layout.role === 'header' || layout.role === 'footer' || layout.role === 'ad') boost -= 0.16;
  if (candidate.type === 'link_collection' && layout.role !== 'main') boost -= 0.08;
  return boost;
}

function goalTokens(goal: string): string[] {
  return goal.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 20);
}
