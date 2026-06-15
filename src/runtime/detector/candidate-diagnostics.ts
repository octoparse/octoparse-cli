import type { Page } from 'puppeteer-core';
import type { DetectedCandidate, DetectedCandidateDiagnostics, DetectedFieldDiagnostics } from './types.js';

export async function attachAgentDiagnostics(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates.map((candidate) => ({
    id: candidate.id,
    xpath: candidate.xpath,
    itemXPath: candidate.itemXPath || candidate.xpath,
    fields: candidate.fields.map((field) => ({
      name: field.name,
      xpath: field.xpath,
      relativeXPath: field.relativeXPath || ''
    })),
    detailFields: candidate.detailPlan?.fields.map((field) => ({
      name: field.name,
      xpath: field.xpath,
      relativeXPath: field.relativeXPath || ''
    })) ?? []
  }));
  const diagnostics = await page.evaluate((items) => {
    type Box = { x: number; y: number; width: number; height: number };
    type FieldInput = { name: string; xpath: string; relativeXPath: string };
    type FieldDiag = {
      matchCount: number;
      textLength: number;
      paragraphCount: number;
      hasStyleNoise: boolean;
      boundingBox?: Box;
      sampleText?: string;
      warnings: string[];
    };
    function evaluateXPath(xpath: string, context: Document | Element = document): Element[] {
      if (!xpath) return [];
      const result = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const output: Element[] = [];
      for (let index = 0; index < result.snapshotLength; index += 1) {
        const node = result.snapshotItem(index);
        if (node instanceof Element) output.push(node);
      }
      return output;
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
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
    function unionBox(elements: Element[]): Box | undefined {
      const boxes = elements.filter(visible).map((element) => box(element)).filter((item) => item.width > 0 && item.height > 0);
      if (!boxes.length) return undefined;
      const left = Math.min(...boxes.map((item) => item.x));
      const top = Math.min(...boxes.map((item) => item.y));
      const right = Math.max(...boxes.map((item) => item.x + item.width));
      const bottom = Math.max(...boxes.map((item) => item.y + item.height));
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function styleNoise(value: string): boolean {
      const count = (value.match(/--weui-|data_color_scheme|rgba?\(|#[0-9a-f]{3,8}\b|ACTIVE-|BG-|FG-/gi) ?? []).length;
      return count >= 8 || /--weui-[\s\S]{80,}/i.test(value) || /\.data_color_scheme_dark\{/i.test(value);
    }
    function fieldDiagnostics(field: FieldInput): FieldDiag {
      const matches = evaluateXPath(field.xpath).filter(visible);
      const texts = matches.map(text).filter(Boolean);
      const joined = texts.join('\n');
      const paragraphCount = matches.reduce((sum, element) => sum + Math.max(0, element.querySelectorAll('p').length), 0);
      const warnings: string[] = [];
      if (!matches.length) warnings.push('xpath matched no visible elements');
      if (field.name.includes('content') && joined.length < 180) warnings.push('content text looks short');
      if (styleNoise(joined)) warnings.push('text contains CSS/style noise');
      if (matches.length > 1) warnings.push(`xpath matched ${matches.length} elements; runtime may use the first element unless XPath targets a container`);
      return {
        matchCount: matches.length,
        textLength: joined.length,
        paragraphCount,
        hasStyleNoise: styleNoise(joined),
        ...(unionBox(matches) ? { boundingBox: unionBox(matches) } : {}),
        ...(joined ? { sampleText: joined.slice(0, 500) } : {}),
        warnings
      };
    }
    return items.map((candidate) => {
      const items = evaluateXPath(candidate.itemXPath).filter(visible);
      const candidateText = items.slice(0, 10).map(text).join('\n');
      const candidateBox = unionBox(items);
      const sampleBoxes = items.slice(0, 8).map((element) => box(element));
      return {
        id: candidate.id,
        diagnostics: {
          matchCount: items.length,
          ...(candidateBox ? { boundingBox: candidateBox } : {}),
          sampleBoxes,
          textLength: candidateText.length,
          visualCoverage: candidateBox ? Number(((candidateBox.width * candidateBox.height) / Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight)).toFixed(4)) : 0,
          warnings: items.length ? [] : ['itemXPath matched no visible elements']
        },
        fields: candidate.fields.map((field) => ({ name: field.name, diagnostics: fieldDiagnostics(field) })),
        detailFields: candidate.detailFields.map((field) => ({ name: field.name, diagnostics: fieldDiagnostics(field) }))
      };
    });
  }, input);
  const byId = new Map(diagnostics.map((item) => [item.id, item]));
  return candidates.map((candidate) => {
    const item = byId.get(candidate.id);
    if (!item) return candidate;
    const fieldDiag = new Map(item.fields.map((field) => [field.name, field.diagnostics as DetectedFieldDiagnostics]));
    const detailDiag = new Map(item.detailFields.map((field) => [field.name, field.diagnostics as DetectedFieldDiagnostics]));
    return {
      ...candidate,
      diagnostics: item.diagnostics as DetectedCandidateDiagnostics,
      fields: candidate.fields.map((field) => fieldDiag.has(field.name) ? { ...field, diagnostics: fieldDiag.get(field.name) } : field),
      ...(candidate.detailPlan ? {
        detailPlan: {
          ...candidate.detailPlan,
          fields: candidate.detailPlan.fields.map((field) => detailDiag.has(field.name) ? { ...field, diagnostics: detailDiag.get(field.name) } : field)
        }
      } : {})
    };
  });
}
