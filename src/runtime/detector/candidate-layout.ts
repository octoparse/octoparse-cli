import type { Page } from 'puppeteer-core';
import { layoutRankingBoost, rankCandidates } from './candidate-ranking.js';
import type { DetectedCandidate, DetectedCandidateLayout } from './types.js';

export async function applyLayoutScores(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      fieldNames: candidate.fields.map((field) => field.name),
      fieldCount: candidate.fields.length,
      itemCount: candidate.itemCount,
      reasons: candidate.reasons
    }));
  if (!input.length) return rankCandidates(candidates);
  const layouts = await page.evaluate((items) => {
    type LayoutInfo = DetectedCandidateLayout;
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const bodyHeight = Math.max(1, document.documentElement.scrollHeight || document.body?.scrollHeight || viewportHeight);

    function evaluateXPath(xpath: string): Element[] {
      if (!xpath) return [];
      const normalized = xpath.includes('[*]') ? xpath.replace(/\[\*\]/g, '') : xpath;
      try {
        const result = document.evaluate(normalized, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const output: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) output.push(node);
        }
        return output;
      } catch {
        return [];
      }
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || ''
      ].join(' ');
    }

    function unionRect(elements: Element[]): { left: number; top: number; right: number; bottom: number; width: number; height: number; area: number } | null {
      const rects = elements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (!rects.length) return null;
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      return { left, top, right, bottom, width, height, area: width * height };
    }

    function linkDensity(elements: Element[], value: string): number {
      const linkText = elements
        .flatMap((element) => Array.from(element.querySelectorAll('a')))
        .map((element) => text(element))
        .join(' ');
      return Math.max(0, Math.min(1, linkText.length / Math.max(1, value.length)));
    }

    function closestRole(elements: Element[], attrs: string): LayoutInfo['role'] | '' {
      for (const element of elements) {
        if (element.closest('header,[role="banner"]')) return 'header';
        if (element.closest('footer,[role="contentinfo"]')) return 'footer';
        if (element.closest('nav,[role="navigation"],[class*="nav" i],[class*="menu" i],[class*="category" i],[class*="cate" i]')) return 'nav';
        if (element.closest('aside,[role="complementary"],[class*="sidebar" i],[class*="side" i],[class*="right" i],[class*="left" i]')) return 'sidebar';
        if (element.closest('[class*="ad" i],[id*="ad" i],[class*="banner" i],[id*="banner" i],[class*="sponsor" i]')) return 'ad';
      }
      if (/(header|footer|nav|menu|category|sidebar|aside|advert|banner|sponsor)/i.test(attrs)) {
        if (/header/i.test(attrs)) return 'header';
        if (/footer/i.test(attrs)) return 'footer';
        if (/advert|banner|sponsor/i.test(attrs)) return 'ad';
        if (/nav|menu|category/i.test(attrs)) return 'nav';
        return 'sidebar';
      }
      return '';
    }

    function clamp(value: number): number {
      return Math.max(0, Math.min(1, value));
    }

    const layouts: Record<string, LayoutInfo> = {};
    for (const item of items) {
      const itemElements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 120);
      const rootElements = evaluateXPath(item.xpath).filter(visible).slice(0, 12);
      const elements = itemElements.length ? itemElements : rootElements;
      const rect = unionRect(elements);
      if (!rect) continue;
      const value = elements.slice(0, 30).map(text).join(' ');
      const attrs = elements.slice(0, 10).map(attrText).join(' ');
      const areaRatio = clamp(rect.area / Math.max(1, viewportWidth * viewportHeight));
      const widthRatio = clamp(rect.width / viewportWidth);
      const heightRatio = clamp(rect.height / viewportHeight);
      const xCenter = (rect.left + rect.right) / 2;
      const yCenter = (rect.top + rect.bottom) / 2;
      const centerDistance = clamp(Math.abs(xCenter - viewportWidth / 2) / (viewportWidth / 2));
      const topRatio = clamp(rect.top / viewportHeight);
      const documentTopRatio = clamp((rect.top + window.scrollY) / bodyHeight);
      const ld = linkDensity(elements, value);
      const textDensity = clamp(value.length / Math.max(1, rect.area / 80));
      const shortTextRate = elements
        .slice(0, 20)
        .map(text)
        .filter(Boolean)
        .filter((chunk) => chunk.length <= 12).length / Math.max(1, elements.slice(0, 20).filter((element) => text(element)).length);
      const hasSemanticLayoutField = item.fieldNames.some((name) => /summary|description|snippet|image|cover|date|time|title|url|href|link|摘要|描述|图片|封面|日期|时间|标题|链接/i.test(name));
      const repeatedRichness = clamp(item.itemCount / 8) * 0.45 + clamp(item.fieldCount / 5) * 0.35 + (hasSemanticLayoutField ? 0.2 : 0);
      const visualCoverage = clamp(areaRatio * 0.65 + widthRatio * 0.2 + heightRatio * 0.15);
      let mainScore = 0.18;
      mainScore += (1 - centerDistance) * 0.24;
      mainScore += visualCoverage * 0.18;
      mainScore += repeatedRichness * 0.24;
      mainScore += textDensity * 0.08;
      if (rect.left > viewportWidth * 0.16 && rect.right < viewportWidth * 0.86) mainScore += 0.08;
      if (rect.width > viewportWidth * 0.42) mainScore += 0.07;
      if (documentTopRatio < 0.72 && topRatio < 1.8) mainScore += 0.06;

      let sidebarPenalty = 0;
      if (rect.right < viewportWidth * 0.24 || rect.left > viewportWidth * 0.72) sidebarPenalty += 0.32;
      if (widthRatio < 0.28) sidebarPenalty += 0.2;
      if (ld > 0.68 && shortTextRate > 0.55) sidebarPenalty += 0.16;
      if (/(sidebar|aside|right|left|rank|hot|recommend|related|widget|side)/i.test(attrs)) sidebarPenalty += 0.18;

      let boilerplatePenalty = 0;
      if (topRatio < 0.12 && rect.height < viewportHeight * 0.22) boilerplatePenalty += 0.2;
      if (documentTopRatio > 0.82) boilerplatePenalty += 0.24;
      if (ld > 0.78 && value.length < 600) boilerplatePenalty += 0.16;
      if (/(footer|copyright|icp|privacy|terms|login|register|nav|menu|category)/i.test(`${attrs} ${value}`)) boilerplatePenalty += 0.18;
      if (/(advert|广告|推广|sponsor|banner)/i.test(`${attrs} ${value}`)) boilerplatePenalty += 0.28;

      const explicitRole = closestRole(elements, attrs);
      let role: LayoutInfo['role'] = 'unknown';
      if (explicitRole) role = explicitRole;
      else if (mainScore >= 0.62 && sidebarPenalty < 0.34 && boilerplatePenalty < 0.34) role = 'main';
      else if (sidebarPenalty >= 0.34) role = 'sidebar';
      else if (boilerplatePenalty >= 0.34) role = topRatio < 0.2 ? 'header' : 'footer';

      const strongMainContent = repeatedRichness > 0.72
        && boilerplatePenalty < 0.28
        && (
          (visualCoverage > 0.45 && centerDistance < 0.32 && widthRatio > 0.45)
          || (visualCoverage > 0.62 && centerDistance < 0.35 && sidebarPenalty < 0.12)
        );
      if (strongMainContent) {
        role = 'main';
        mainScore = Math.max(mainScore, 0.72);
        sidebarPenalty *= 0.35;
      }

      if (role === 'main') {
        sidebarPenalty *= 0.55;
        boilerplatePenalty *= 0.65;
      } else if (role === 'sidebar' || role === 'nav' || role === 'ad') {
        mainScore *= 0.72;
      }

      const reasons: string[] = [];
      if (role === 'main') reasons.push('centered rich repeated content');
      if (role === 'sidebar') reasons.push('side-column layout');
      if (role === 'nav') reasons.push('navigation-like layout');
      if (role === 'ad') reasons.push('advertising/banner-like layout');
      if (widthRatio < 0.28) reasons.push('narrow column');
      if (ld > 0.68) reasons.push('high link density');
      if (repeatedRichness > 0.65) reasons.push('rich repeated records');
      if (visualCoverage > 0.3) reasons.push('large visual coverage');

      layouts[item.id] = {
        role,
        score: Number(clamp(mainScore - sidebarPenalty * 0.55 - boilerplatePenalty * 0.65).toFixed(2)),
        mainScore: Number(clamp(mainScore).toFixed(2)),
        sidebarPenalty: Number(clamp(sidebarPenalty).toFixed(2)),
        boilerplatePenalty: Number(clamp(boilerplatePenalty).toFixed(2)),
        visualCoverage: Number(visualCoverage.toFixed(2)),
        textDensity: Number(textDensity.toFixed(2)),
        linkDensity: Number(ld.toFixed(2)),
        centerDistance: Number(centerDistance.toFixed(2)),
        reasons
      };
    }
    return layouts;
  }, input);

  return rankCandidates(candidates.map((candidate) => {
    const layout = layouts[candidate.id];
    if (!layout) return candidate;
    const adjusted = Math.max(0.1, Math.min(0.99, candidate.confidence + layoutRankingBoost({ ...candidate, layout })));
    return {
      ...candidate,
      layout,
      confidence: Number(adjusted.toFixed(2)),
      reasons: [...candidate.reasons, ...layout.reasons.map((reason) => `Layout: ${reason}`)]
    };
  }));
}
