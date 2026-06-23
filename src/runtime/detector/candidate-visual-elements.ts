import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedField, DetectedVisualElement } from './types.js';

const MAX_VISUAL_ELEMENTS_PER_CANDIDATE = 24;

export async function attachCandidateVisualElements(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      fields: candidate.fields.map((field) => ({
        name: field.name,
        kind: field.kind,
        xpath: field.xpath,
        relativeXPath: field.relativeXPath || '',
        samples: field.samples.slice(0, 3)
      }))
    }));
  if (!input.length) return candidates;

  const visualById = await page.evaluate((items, limit) => {
    type FieldKind = 'text' | 'href' | 'src' | 'value';
    type ElementRole = 'text' | 'link' | 'image' | 'input' | 'button';
    type Box = { x: number; y: number; width: number; height: number };
    type FieldInput = { name: string; kind: FieldKind; xpath: string; relativeXPath: string; samples: string[] };
    type CandidateInput = { id: string; type: string; xpath: string; itemXPath: string; fields: FieldInput[] };
    type VisualElementOutput = {
      id: string;
      candidateId: string;
      scope: 'visible_dom';
      source: 'visible_dom';
      label: string;
      tagName: string;
      kind: FieldKind;
      role: ElementRole;
      selector: string;
      xpath: string;
      relativeXPath: string;
      boundingBox: Box;
      visible: boolean;
      clickable: boolean;
      sample: string;
      samples: string[];
      samplesByKind: Partial<Record<FieldKind, string[]>>;
      attributes: Record<string, string>;
      rowCoverage: {
        matchedRows: number;
        filledRows: number;
        totalRows: number;
        fillRate: number;
      };
      confidence: number;
    };

    function evaluateXPath(xpath: string, context: Document | Element = document): Element[] {
      if (!xpath) return [];
      try {
        const result = document.evaluate(xpath.includes('[*]') ? xpath.replace(/\[\*\]/g, '') : xpath, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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

    function firstByXPath(xpath: string, context: Document | Element = document): Element | null {
      return evaluateXPath(xpath, context)[0] || null;
    }

    function text(element: Element | null): string {
      if (!element) return '';
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        return (element.value || element.placeholder || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      }
      if (element instanceof HTMLImageElement) {
        return (element.alt || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      }
      return ((element as HTMLElement).innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }

    function ownText(element: Element): string {
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 4
        && rect.height >= 4
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && style.pointerEvents !== 'none';
    }

    function box(element: Element): Box {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.localName;
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.localName === tag) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${tag}[${index}]`);
        current = current.parentElement;
      }
      return `/${parts.join('/')}`;
    }

    function cssSelector(element: Element): string {
      const tag = element.localName;
      const html = element as HTMLElement;
      if (html.id) return `${tag}#${cssEscape(html.id)}`;
      const stableClass = Array.from(html.classList || []).find((token) => token.length >= 3 && !/^\d|^(active|selected|current|hover|focus|show|hide)$/i.test(token));
      return stableClass ? `${tag}.${cssEscape(stableClass)}` : tag;
    }

    function cssEscape(value: string): string {
      return value.replace(/[^a-z0-9_-]/gi, '\\$&');
    }

    function xpathLiteral(value: string): string {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat('${value.replace(/'/g, "',\"'\",'")}')`;
    }

    function absoluteFieldXPath(itemXPath: string, relativeXPath: string): string {
      if (!relativeXPath || relativeXPath === '.') return itemXPath;
      if (relativeXPath.startsWith('.//')) return `${itemXPath}//${relativeXPath.slice(3)}`;
      if (relativeXPath.startsWith('./')) return `${itemXPath}/${relativeXPath.slice(2)}`;
      return `${itemXPath}/${relativeXPath.replace(/^\/+/, '')}`;
    }

    function compactRelativeXPath(row: Element, element: Element): string {
      if (row === element) return '.';
      const tag = element.localName;
      const html = element as HTMLElement;
      const candidates: string[] = [];
      if (html.id) candidates.push(`.//${tag}[@id=${xpathLiteral(html.id)}]`);
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'itemprop', 'aria-label', 'title', 'alt', 'name', 'role']) {
        const value = element.getAttribute(attr);
        if (value && value.length <= 90) candidates.push(`.//${tag}[@${attr}=${xpathLiteral(value)}]`);
      }
      for (const token of Array.from(html.classList || []).filter((item) => item.length >= 3).slice(0, 4)) {
        candidates.push(`.//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(` ${token} `)})]`);
      }
      const sameTag = Array.from(row.querySelectorAll(tag)).filter((item) => item === element || visible(item));
      const tagIndex = sameTag.indexOf(element) + 1;
      if (tagIndex > 0) candidates.push(`.//${tag}[${tagIndex}]`);

      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate, row);
        if (matches.length === 1 && matches[0] === element) return candidate;
      }

      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== row) {
        const currentTag = current.localName;
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.localName === currentTag) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${currentTag}[${index}]`);
        current = current.parentElement;
      }
      return current === row && parts.length ? `./${parts.join('/')}` : `.${xpath(element)}`;
    }

    function roleFor(element: Element): ElementRole {
      const tag = element.localName;
      const role = element.getAttribute('role') || '';
      if (tag === 'img' || element instanceof HTMLImageElement) return 'image';
      if (tag === 'a') return 'link';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
      return 'text';
    }

    function defaultKindFor(element: Element): FieldKind {
      const role = roleFor(element);
      if (role === 'image') return 'src';
      if (role === 'input') return 'value';
      return 'text';
    }

    function attributesFor(element: Element): Record<string, string> {
      const attrs: Record<string, string> = {};
      for (const name of ['href', 'src', 'alt', 'title', 'aria-label', 'value', 'placeholder', 'datetime']) {
        const value = name === 'href' && element instanceof HTMLAnchorElement
          ? element.href
          : name === 'src' && element instanceof HTMLImageElement
            ? (element.currentSrc || element.src)
            : element.getAttribute(name) || '';
        if (value) attrs[name] = value.slice(0, 500);
      }
      return attrs;
    }

    function valuesByKind(element: Element | null): Partial<Record<FieldKind, string>> {
      const values: Partial<Record<FieldKind, string>> = {};
      if (!element) return values;
      const value = text(element);
      if (value) values.text = value;
      if (element instanceof HTMLAnchorElement && element.href) values.href = element.href;
      const anchor = element.closest('a') as HTMLAnchorElement | null;
      if (!values.href && anchor?.href) values.href = anchor.href;
      if (element instanceof HTMLImageElement && (element.currentSrc || element.src)) values.src = element.currentSrc || element.src;
      const image = element.querySelector('img') as HTMLImageElement | null;
      if (!values.src && image && (image.currentSrc || image.src)) values.src = image.currentSrc || image.src;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        values.value = element.value || element.getAttribute('value') || text(element);
      }
      return values;
    }

    function sampleValue(row: Element, relativeXPath: string, kind: FieldKind): string {
      const element = firstByXPath(relativeXPath, row);
      if (!element) return '';
      const values = valuesByKind(element);
      return values[kind] || '';
    }

    function samplesByKind(rows: Element[], relativeXPath: string, preferredKind: FieldKind): Partial<Record<FieldKind, string[]>> {
      const output: Partial<Record<FieldKind, string[]>> = {};
      for (const kind of ['text', 'href', 'src', 'value'] as FieldKind[]) {
        const samples = rows
          .map((row) => sampleValue(row, relativeXPath, kind))
          .map((value) => value.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 3);
        if (samples.length) output[kind] = samples;
      }
      if (!output[preferredKind]?.length) {
        const firstElement = firstByXPath(relativeXPath, rows[0]);
        const value = valuesByKind(firstElement as Element)[preferredKind] || '';
        if (value) output[preferredKind] = [value];
      }
      return output;
    }

    function candidateElements(row: Element): Element[] {
      const broad = Array.from(row.querySelectorAll([
        'a',
        'img',
        'button',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        'time',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'li',
        'span',
        'div',
        'strong',
        'em',
        'small',
        '[aria-label]',
        '[title]'
      ].join(',')));
      return broad.filter((element) => {
        if (!visible(element)) return false;
        if (/^(script|style|noscript|svg|path)$/i.test(element.localName)) return false;
        const role = roleFor(element);
        const value = text(element);
        const own = ownText(element);
        const rect = element.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const areaRatio = (rect.width * rect.height) / Math.max(1, rowRect.width * rowRect.height);
        if (role === 'image') return Boolean((element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src) && rect.width >= 16 && rect.height >= 16;
        if (role === 'link' || role === 'button' || role === 'input') return Boolean(value || valuesByKind(element).href || valuesByKind(element).value);
        if (!value || value.length < 2) return false;
        if (value.length > 500) return false;
        if (areaRatio > 0.78 && !/^(p|h1|h2|h3|h4|h5|h6)$/i.test(element.localName)) return false;
        if (/^(div|span|li)$/i.test(element.localName) && !own && element.children.length > 3) return false;
        return true;
      });
    }

    function fieldKey(kind: FieldKind, relativeXPath: string): string {
      return `${kind}:${relativeXPath || '.'}`;
    }

    function knownFieldKeys(fields: FieldInput[]): Set<string> {
      return new Set(fields.map((field) => fieldKey(field.kind, field.relativeXPath || '')));
    }

    function sampleOverlapsKnownField(samples: string[], fields: FieldInput[]): boolean {
      const normalized = new Set(samples.map(normalizeValue).filter(Boolean));
      if (!normalized.size) return false;
      return fields.some((field) => field.samples.some((sample) => normalized.has(normalizeValue(sample))));
    }

    function normalizeValue(value: string): string {
      return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function labelFor(element: Element, role: ElementRole, samples: string[], attrs: Record<string, string>): string {
      const name = attrs['aria-label'] || attrs.title || attrs.alt || samples[0] || role;
      return `${role}:${name}`.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function safeIdPart(value: string): string {
      return String(value)
        .trim()
        .replace(/[^a-z0-9_\u4e00-\u9fff-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'element';
    }

    function scoreElement(input: {
      element: Element;
      role: ElementRole;
      kind: FieldKind;
      sample: string;
      coverage: number;
      knownSample: boolean;
    }): number {
      let score = 0.28 + input.coverage * 0.32;
      if (input.role === 'link') score += 0.18;
      if (input.role === 'image') score += 0.16;
      if (/^(h1|h2|h3|h4)$/i.test(input.element.localName)) score += 0.16;
      if (/^(time|p|strong|em|small)$/i.test(input.element.localName)) score += 0.08;
      if (/price|amount|money|cost|date|time|author|user|name|title|score|rating|评论|赞|价格|金额|时间|日期|作者|标题|评分/i.test(`${input.element.localName} ${(input.element as HTMLElement).className} ${(input.element as HTMLElement).id} ${input.sample}`)) score += 0.12;
      if (input.knownSample) score -= 0.28;
      if (input.sample.length > 160 && input.role !== 'text') score -= 0.08;
      return Number(Math.max(0.01, Math.min(0.99, score)).toFixed(2));
    }

    const result: Record<string, VisualElementOutput[]> = {};
    for (const item of items as CandidateInput[]) {
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 6);
      if (!rows.length) continue;
      const first = rows[0];
      const existingKeys = knownFieldKeys(item.fields);
      const seen = new Set<string>();
      const elements: VisualElementOutput[] = [];

      for (const element of candidateElements(first)) {
        const role = roleFor(element);
        const kind = defaultKindFor(element);
        const relativeXPath = compactRelativeXPath(first, element);
        if (!relativeXPath) continue;
        const sampleKinds = samplesByKind(rows, relativeXPath, kind);
        const samples = (sampleKinds[kind] ?? sampleKinds.text ?? sampleKinds.href ?? sampleKinds.src ?? sampleKinds.value ?? []).filter(Boolean);
        if (!samples.length) continue;
        const key = fieldKey(kind, relativeXPath);
        const duplicate = existingKeys.has(key);
        const attrs = attributesFor(element);
        const matchedRows = rows.filter((row) => firstByXPath(relativeXPath, row)).length;
        const filledRows = rows.filter((row) => sampleValue(row, relativeXPath, kind)).length;
        const fillRate = Number((filledRows / Math.max(1, rows.length)).toFixed(2));
        if (fillRate < 0.17 && rows.length >= 3) continue;
        const label = labelFor(element, role, samples, attrs);
        const uniqueKey = `${key}:${normalizeValue(samples[0])}`;
        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);
        const knownSample = sampleOverlapsKnownField(samples, item.fields);
        if (duplicate && knownSample) continue;
        const confidence = scoreElement({ element, role, kind, sample: samples[0], coverage: fillRate, knownSample });
        if (confidence < 0.18) continue;
        elements.push({
          id: `ve_${safeIdPart(item.id)}_${String(elements.length + 1)}_${safeIdPart(label)}`,
          candidateId: item.id,
          scope: 'visible_dom',
          source: 'visible_dom',
          label,
          tagName: element.localName,
          kind,
          role,
          selector: cssSelector(element),
          xpath: absoluteFieldXPath(item.itemXPath, relativeXPath),
          relativeXPath,
          boundingBox: box(element),
          visible: true,
          clickable: role === 'link' || role === 'button' || Boolean((element as HTMLElement).onclick),
          sample: samples[0] || '',
          samples,
          samplesByKind: sampleKinds,
          attributes: attrs,
          rowCoverage: {
            matchedRows,
            filledRows,
            totalRows: rows.length,
            fillRate
          },
          confidence
        });
      }

      result[item.id] = elements
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0) || a.boundingBox.y - b.boundingBox.y || a.boundingBox.x - b.boundingBox.x)
        .slice(0, limit);
    }
    return result;
  }, input, MAX_VISUAL_ELEMENTS_PER_CANDIDATE) as Record<string, DetectedVisualElement[]>;

  return candidates.map((candidate) => {
    const visualElements = visualById[candidate.id] ?? [];
    if (!visualElements.length) return candidate;
    return {
      ...candidate,
      visualElements,
      reasons: candidate.reasons.some((reason) => /visible DOM elements/i.test(reason))
        ? candidate.reasons
        : [...candidate.reasons, 'Agent visualElements include visible DOM choices inside candidate rows']
    };
  });
}

export const attachCandidateVisualElementsForTesting = attachCandidateVisualElements;
