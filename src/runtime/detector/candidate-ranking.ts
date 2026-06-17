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

export function candidateSelectionScore(candidate: DetectedCandidate): number {
  return candidateRankingScore(candidate);
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
  const titleValues = candidateTitleLikeTextValues(candidate);
  const hasUsableTitle = titleValues.some((sample) => !isLabelOnlySample(sample) && normalizeSampleValue(sample).length >= 4);
  const hasHref = fields.some((field) => field.kind === 'href' && field.samples.some(Boolean));
  const hrefs = candidateHrefValues(candidate);
  const taxonomyHrefRate = hrefs.length ? hrefs.filter(isTaxonomyHrefValue).length / hrefs.length : 0;
  const recordHrefRate = hrefs.length ? hrefs.filter(isLikelyRecordHrefValue).length / hrefs.length : 0;
  const hasSummary = fields.some((field) => /摘要|描述|summary|description|snippet/i.test(field.name) && field.samples.some((sample) => normalizeSampleValue(sample).length >= 30));
  const hasDate = candidateHasDateSignal(candidate);
  const hasRecordMetadata = candidateHasRecordMetadataSignal(candidate);
  const hasBracketedMetadata = candidateHasBracketedMetadata(candidate);
  const looksLikeLinkGridNavigation = candidateLooksLikeLinkGridNavigation(candidate, titleValues, hrefs);
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
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const shortTitleRate = titleValues.length
    ? titleValues.filter((value) => normalizeSampleValue(value).length <= 12 || isLabelOnlySample(value)).length / titleValues.length
    : 1;
  const shallowLinkList = fields.length <= 2 && hasHref && candidate.itemCount >= 8 && shortTitleRate >= 0.7;
  let boost = 0;
  if (hasUsableTitle && hasHref) boost += 0.12;
  if (hasSummary) boost += 0.06;
  if (hasDate) boost += 0.08;
  if (longTitleRate >= 0.45 && hasHref) boost += 0.08;
  if (recordHrefRate >= 0.5 && longTitleRate >= 0.35) boost += 0.06;
  if (hasRecordMetadata && fields.length >= 4) boost += 0.05;
  if (hasBracketedMetadata && hasDate && hasHref) boost += 0.04;
  if (fields.length >= 3) boost += 0.04;
  if (fillRate >= 0.7) boost += 0.03;
  if (smartFullColRate !== undefined) boost += Math.max(-0.08, Math.min(0.08, (smartFullColRate - 0.55) * 0.2));
  if (fields.some((field) => /reference|citation|referencetext|cs1format|脚注|引用/i.test(field.name))) boost -= 0.14;
  if (taxonomyLike) boost -= 0.55;
  if (taxonomyHrefRate >= 0.7 && longTitleRate < 0.35) boost -= 0.18;
  if (looksLikeLinkGridNavigation) boost -= 0.5;
  if (shallowLinkList && !hasDate && longTitleRate < 0.25) boost -= 0.28;
  if (shortTitleRate >= 0.85 && !hasDate && fields.length <= 3) boost -= 0.16;
  if (candidateLooksLikeFooterOrNavigation(candidate)) boost -= 0.2;
  if (fields.some((field) => field.name.length > 80)) boost -= 0.08;
  if (firstRowFillRate < 0.35 && fields.length >= 6) boost -= 0.08;
  if (fields.length <= 2 && !hasHref) boost -= 0.18;
  if (labelRatio >= 0.55 && !hasHref) boost -= 0.16;
  if (candidate.type === 'repeated_card' && fields.length <= 2 && candidate.itemCount >= 40 && !hasHref) boost -= 0.08;
  if (candidate.type === 'link_collection' && !hasDate) boost -= 0.12;
  return Math.max(-0.75, Math.min(0.35, boost));
}

function candidateTitleLikeTextValues(candidate: DetectedCandidate): string[] {
  const preferred = candidate.fields.filter((field) => field.kind === 'text' && /^(?:title\d*|标题\d*|名称\d*|name\d*|描述\d*|summary\d*|摘要\d*)$/i.test(field.name));
  const fallback = candidate.fields.filter((field) => field.kind === 'text');
  return (preferred.length ? preferred : fallback)
    .flatMap((field) => field.samples)
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

function candidateHrefValues(candidate: DetectedCandidate): string[] {
  return candidate.fields
    .filter((field) => field.kind === 'href')
    .flatMap((field) => field.samples)
    .map(normalizeHrefValue)
    .filter(Boolean);
}

function candidateHasDateSignal(candidate: DetectedCandidate): boolean {
  return candidate.fields
    .filter((field) => field.kind === 'text')
    .some((field) => /date|time|日期|时间|发布|更新|posted|published/i.test(field.name)
      || field.samples.some(looksLikeDateValue));
}

function candidateHasRecordMetadataSignal(candidate: DetectedCandidate): boolean {
  return candidate.fields
    .filter((field) => field.kind === 'text')
    .some((field) => /地区|区域|省份|城市|位置|地点|类型|分类|状态|价格|金额|公司|作者|来源|日期|时间|date|time|location|type|category|status|price|author|source/i.test(field.name)
      || field.samples.some((sample) => isBracketedMetadataSample(sample) || looksLikeDateValue(sample)));
}

function candidateHasBracketedMetadata(candidate: DetectedCandidate): boolean {
  const textValues = candidate.fields
    .filter((field) => field.kind === 'text')
    .flatMap((field) => field.samples);
  return textValues.filter(isBracketedMetadataSample).length >= 2;
}

function candidateLooksLikeLinkGridNavigation(candidate: DetectedCandidate, titleValues: string[], hrefs: string[]): boolean {
  if (candidate.itemCount > 10) return false;
  if (candidate.fields.length < 6 || hrefs.length < 6) return false;
  if (candidateHasDateSignal(candidate)) return false;
  const textValues = candidate.fields
    .filter((field) => field.kind === 'text')
    .flatMap((field) => field.samples)
    .map(normalizeSampleValue)
    .filter(Boolean);
  if (textValues.length < 6) return false;
  const shortTextRate = textValues.filter((value) => value.length <= 14 || isLabelOnlySample(value)).length / textValues.length;
  const longTitleRate = titleValues.length
    ? titleValues.filter(isLikelyRecordTitleSample).length / titleValues.length
    : 0;
  const taxonomyOrServiceHrefRate = hrefs.filter((value) => isTaxonomyHrefValue(value) || isLikelyServiceNavigationHrefValue(value)).length / hrefs.length;
  const hrefFieldRate = candidate.fields.filter((field) => field.kind === 'href').length / candidate.fields.length;
  return shortTextRate >= 0.75
    && longTitleRate < 0.25
    && hrefFieldRate >= 0.35
    && taxonomyOrServiceHrefRate >= 0.55;
}

function isLikelyRecordTitleSample(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  if (!normalized || isLabelOnlySample(value)) return false;
  if (looksLikeDateValue(value) || isBracketedMetadataSample(value)) return false;
  return normalized.length >= 14 || /[a-z0-9][a-z0-9 ,:|()[\]/.-]{18,}/i.test(normalized);
}

function isLikelyRecordHrefValue(value: string): boolean {
  if (!value || isTaxonomyHrefValue(value) || isPaginationUrlValue(value)) return false;
  if (/^(?:javascript:|mailto:|tel:|#)/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return looksLikeRecordPath(parsed.pathname);
  } catch {
    return looksLikeRecordPath(value);
  }
}

function isLikelyServiceNavigationHrefValue(value: string): boolean {
  if (!value) return false;
  if (/^(?:javascript:|mailto:|tel:|#)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname;
    return /\/(?:ground|user|work|help|about|service|member|channel|city)(?:[/?#-]|$)/i.test(path)
      || (path === '/' && parsed.searchParams.has('ucode'));
  } catch {
    return /\/(?:ground|user|work|help|about|service|member|channel|city)(?:[/?#-]|$)|^#$/i.test(value);
  }
}

function looksLikeRecordPath(path: string): boolean {
  return /(?:detail|details|item|product|article|news|post|job|jobs|markinfo|notice|tender|bid|info|view)(?:[/?#-]|$)/i.test(path)
    || /\/\d{3,}(?:[/?#.]|$)/.test(path)
    || /\/[^/?#]*\d{3,}[^/?#]*\.html(?:[?#]|$)?/i.test(path)
    || /\/[a-z0-9-]*\d{3,}[a-z0-9-]*\/?$/i.test(path);
}

function looksLikeDateValue(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  return /\b(?:19|20)\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?(?:日)?\b/.test(normalized)
    || /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|june|jul|july|aug|sep|sept|oct|nov|dec)[a-z]*\s+(?:19|20)\d{2}\b/i.test(normalized)
    || /\b(?:jan|feb|mar|apr|may|jun|june|jul|july|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+(?:19|20)\d{2}\b/i.test(normalized);
}

function isBracketedMetadataSample(value: string): boolean {
  const normalized = normalizeSampleValue(value);
  return /^[\[【(（]\s*[^()[\]【】（）]{1,12}\s*[\]】)）]$/.test(normalized);
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
  const hrefs = candidateHrefValues(candidate);
  if (hrefs.length < 2) return false;
  if (hrefs.every(isTaxonomyHrefValue)) return true;
  const primaryHref = candidate.fields.find((field) => field.kind === 'href' && /^(?:url|链接|标题链接|title_?link|href)$/i.test(field.name))
    ?? candidate.fields.find((field) => field.kind === 'href');
  const primaryHrefValues = (primaryHref?.samples ?? []).map(normalizeHrefValue).filter(Boolean);
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
  return /(?:[?&](?:type|category|categoryid|cate|cateid|cat|catid|tag|topic|filter|industry|batch|class|classid|area|province|city|region|district|zone|trade|sector|field|kwtype)=|\/(?:type|category|categories|cate|cat|tag|tags|topics?|filters?|industr(?:y|ies)|batches|class|classid|city|cities|area|province|region|district|zone|trade|sector|fields?)(?:[/?#-]|$)|\/info\/lists\/classid(?:[/?#]|$)|\/search(?:\.html)?\?[^#]*(?:cate|cateid|catid|classid|industry|area|province|city|region|activeName)=)/i.test(value);
}

function normalizeHrefValue(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
  return /^(authors?|submitted|comments?|abstract|capital|votes?|answers?|views?|asked|modified|updated|tags?|关键词|作者|提交|评论|摘要|首都|首页|登录|注册|关于|联系|更多|全部|全部分类|分类|类型|地区|行业|城市|招标采购|前期项目|结果公告|vip项目|招标热点|行业招标|城市子站|热门|推荐|帮助中心|客服中心)$/i.test(normalized)
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
