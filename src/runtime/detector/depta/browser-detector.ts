import type { Page } from 'puppeteer-core';

export interface DeptaListGroup {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  score: number;
  rowSamples: Array<{
    text: string;
    href: string;
    image: string;
    chunks: string[];
  }>;
  fieldXPaths: string[];
  reasons: string[];
  navigationLike: boolean;
}

export async function detectDeptaListGroups(page: Page): Promise<DeptaListGroup[]> {
  return page.evaluate(() => {
    type VisualInfo = {
      isVisible: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
      area: number;
    };

    type VisualNode = {
      id: number;
      nodeName: string;
      attrId: string;
      attrClass: string;
      attrLink: string;
      xpath: string;
      text: string;
      nodeText: string;
      innerTextLength: number;
      visual: VisualInfo;
      parent?: VisualNode;
      children: VisualNode[];
      visibleChildren?: VisualNode[];
      index: number;
      level: number;
    };

    type DataRegion = {
      parent: VisualNode;
      combinationSize: number;
      startPoint: number;
      nodesCovered: number;
      treeSizeScore: number;
      areaSizeScore: number;
      score: number;
      xpath: string;
      isSiblingCombineRegion: boolean;
      reasons: string[];
    };

    type DataRecord = {
      elements: VisualNode[];
      size: number;
    };

    const ignoreTags = new Set(['STYLE', 'SCRIPT', 'NOSCRIPT', 'APPLET', 'OBJECT', 'LINK', 'BR', 'SVG', 'CANVAS', 'PATH', 'META', 'TEMPLATE']);
    const skipHosts = new Set(['FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);
    const listTags = new Set(['LI', 'DL', 'TR', 'OL']);
    const maxNodeInGeneralizedNodes = 5;
    const similarityThreshold = 0.72;

    function visibleChildren(node: VisualNode): VisualNode[] {
      if (!node.visibleChildren) node.visibleChildren = node.children.filter((child) => child.visual.isVisible);
      return node.visibleChildren;
    }

    function getChild(node: VisualNode, index: number): VisualNode | undefined {
      return node.children[index - 1];
    }

    function getVisibleChild(node: VisualNode, index: number): VisualNode | undefined {
      return visibleChildren(node)[index - 1];
    }

    function subtreeSize(node: VisualNode): number {
      return 1 + node.children.reduce((sum, child) => sum + subtreeSize(child), 0);
    }

    function subtreeDepth(node: VisualNode): number {
      if (!node.children.length) return 0;
      return 1 + Math.max(...node.children.map(subtreeDepth));
    }

    function normalizedText(value: string | null | undefined): string {
      return (value || '').replace(/\s+/g, ' ').trim();
    }

    function ownText(element: Element): string {
      const chunks: string[] = [];
      element.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const value = normalizedText(child.textContent);
          if (value) chunks.push(value);
        }
      });
      return chunks.join(' ');
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent: Element | null = current.parentElement;
        const currentTag = current.tagName;
        const tag = current.tagName.toLowerCase();
        const same: Element[] = parent ? Array.from(parent.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${tag}[${same.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return `/${parts.join('/')}`;
    }

    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        if (html.id && !/[^\w-]/.test(html.id)) {
          parts.unshift(`#${CSS.escape(html.id)}`);
          break;
        }
        const classes = Array.from(html.classList)
          .filter((item) => !/^\d/.test(item) && !/\d{4,}/.test(item))
          .slice(0, 2)
          .map((item) => `.${CSS.escape(item)}`)
          .join('');
        const parent: Element | null = current.parentElement;
        const currentTag = current.tagName;
        const same: Element[] = parent ? Array.from(parent.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parent;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    }

    function commonXPath(a: string, b: string): string {
      const left = a.split('/').filter(Boolean);
      const right = b.split('/').filter(Boolean);
      const output: string[] = [];
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        const l = left[index].replace(/\[\d+\]$/, '');
        const r = right[index].replace(/\[\d+\]$/, '');
        if (l !== r) break;
        if (left[index] === right[index]) output.push(left[index]);
        else output.push(l);
      }
      return output.length ? `/${output.join('/')}` : '';
    }

    function matchOneNodeScore(a?: VisualNode, b?: VisualNode): number {
      if (!a || !b || a.nodeName !== b.nodeName) return 0;
      const aChildren = visibleChildren(a);
      const bChildren = visibleChildren(b);
      const matrix = Array.from({ length: aChildren.length + 1 }, () => Array(bChildren.length + 1).fill(0));
      for (let i = 1; i <= aChildren.length; i += 1) {
        for (let j = 1; j <= bChildren.length; j += 1) {
          matrix[i][j] = Math.max(
            matrix[i][j - 1],
            matrix[i - 1][j],
            matrix[i - 1][j - 1] + matchOneNodeScore(aChildren[i - 1], bChildren[j - 1])
          );
        }
      }
      return 1 + matrix[aChildren.length][bChildren.length];
    }

    function matchMultiNodesScore(a: VisualNode[], b: VisualNode[]): number {
      const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          matrix[i][j] = Math.max(
            matrix[i][j - 1],
            matrix[i - 1][j],
            matrix[i - 1][j - 1] + matchOneNodeScore(a[i - 1], b[j - 1])
          );
        }
      }
      return 1 + matrix[a.length][b.length];
    }

    function normalizedMatchScore(a: VisualNode | VisualNode[], b: VisualNode | VisualNode[]): number {
      if (Array.isArray(a) && Array.isArray(b)) {
        const sizeA = a.reduce((sum, node) => sum + subtreeSize(node), 1);
        const sizeB = b.reduce((sum, node) => sum + subtreeSize(node), 1);
        return (matchMultiNodesScore(a, b) * 2) / (sizeA + sizeB);
      }
      if (!Array.isArray(a) && !Array.isArray(b)) {
        return (matchOneNodeScore(a, b) * 2) / (subtreeSize(a) + subtreeSize(b));
      }
      return 0;
    }

    function visualInfo(element: HTMLElement): VisualInfo {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const width = Math.min(rect.width, document.body.clientWidth || rect.width);
      const height = rect.height;
      const area = Math.max(0, width) * Math.max(0, height);
      const hasBox = width > 0 && height > 0;
      const isVisible = hasBox && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      return { isVisible, x: rect.left, y: rect.top, width, height, area };
    }

    function findMainSection(root: HTMLElement, level = 4): HTMLElement {
      const visible = Array.from(root.children).filter((child): child is HTMLElement => {
        if (!(child instanceof HTMLElement) || ignoreTags.has(child.tagName)) return false;
        if (child.localName === 'header' || child.localName === 'footer') return false;
        const style = window.getComputedStyle(child);
        return style.display !== 'none' && normalizedText(child.innerText).length > 0;
      });
      const bodyTextLength = Math.max(1, normalizedText(document.body.innerText).length);
      const candidates = visible.filter((element) => {
        const textLength = normalizedText(element.innerText).length;
        if (textLength < 80 || textLength / bodyTextLength < 0.15) return false;
        const rect = element.getBoundingClientRect();
        if (rect.height === 0 || rect.top > window.innerHeight * 2) return false;
        return element.scrollHeight / Math.max(1, document.body.scrollHeight) > 0.25 || element.scrollHeight > 500;
      });
      if (candidates.length === 1 && level > 1) {
        if (visible.length === 1 || candidates[0].scrollHeight >= document.body.scrollHeight * 0.9) {
          return findMainSection(candidates[0], level - 1);
        }
        return candidates[0];
      }
      return root;
    }

    function buildTree(): { root: VisualNode; nodeByXPath: Map<string, VisualNode> } {
      const rootElement = findMainSection(document.body);
      let nextId = 1;
      const nodeByXPath = new Map<string, VisualNode>();
      function create(element: HTMLElement, parent?: VisualNode): VisualNode {
        const node: VisualNode = {
          id: nextId++,
          nodeName: element.tagName,
          attrId: element.id || '',
          attrClass: typeof element.className === 'string' ? element.className : '',
          attrLink: element instanceof HTMLAnchorElement ? element.href : element instanceof HTMLImageElement ? element.currentSrc || element.src : '',
          xpath: xpath(element),
          text: normalizedText(element.textContent),
          nodeText: ownText(element),
          innerTextLength: normalizedText(element.innerText).length,
          visual: visualInfo(element),
          parent,
          children: [],
          index: parent ? parent.children.length + 1 : 1,
          level: parent ? parent.level + 1 : 0
        };
        nodeByXPath.set(node.xpath, node);
        for (const child of Array.from(element.children)) {
          if (!(child instanceof HTMLElement)) continue;
          if (ignoreTags.has(child.tagName) || skipHosts.has(child.tagName)) continue;
          const rect = child.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0 && child.children.length === 0) continue;
          node.children.push(create(child, node));
        }
        return node;
      }
      return { root: create(rootElement), nodeByXPath };
    }

    function compareGeneralizedNodes(node: VisualNode): number {
      const children = visibleChildren(node);
      const scores: number[] = [];
      for (let childCounter = 1; childCounter <= maxNodeInGeneralizedNodes; childCounter += 1) {
        for (let combinationSize = childCounter; combinationSize <= maxNodeInGeneralizedNodes; combinationSize += 1) {
          if (!getVisibleChild(node, childCounter + 2 * combinationSize - 1)) continue;
          let startPoint = childCounter;
          for (let nextPoint = childCounter + combinationSize; nextPoint <= children.length; nextPoint += combinationSize) {
            if (!getVisibleChild(node, nextPoint + combinationSize - 1)) continue;
            const a: VisualNode[] = [];
            const b: VisualNode[] = [];
            for (let i = startPoint; i < nextPoint; i += 1) {
              const child = getVisibleChild(node, i);
              if (child) a.push(child);
            }
            for (let i = nextPoint; i < nextPoint + combinationSize; i += 1) {
              const child = getVisibleChild(node, i);
              if (child) b.push(child);
            }
            scores.push(normalizedMatchScore(a, b));
            startPoint = nextPoint;
          }
        }
      }
      return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    }

    function identifyDataRegions(initStartPoint: number, node: VisualNode, similarity: number): DataRegion[] {
      const dataRegions: DataRegion[] = [];
      const childCount = visibleChildren(node).length;
      const comparisonScore = compareGeneralizedNodes(node);
      let maxRegion: DataRegion = {
        parent: node,
        combinationSize: 0,
        startPoint: 0,
        nodesCovered: 0,
        treeSizeScore: 0,
        areaSizeScore: 0,
        score: 0,
        xpath: '',
        isSiblingCombineRegion: false,
        reasons: ['DEPTA repeated generalized nodes']
      };
      for (let combinationSize = 1; combinationSize <= maxNodeInGeneralizedNodes; combinationSize += 1) {
        for (let startPoint = initStartPoint; startPoint < initStartPoint + combinationSize; startPoint += 1) {
          let current: DataRegion = { ...maxRegion, combinationSize: 0, startPoint: 0, nodesCovered: 0 };
          let active = false;
          for (let childNumber = startPoint; childNumber + 2 * combinationSize - 1 <= childCount; childNumber += combinationSize) {
            if (comparisonScore >= similarity) {
              if (!active) {
                current = {
                  parent: node,
                  combinationSize,
                  startPoint: childNumber,
                  nodesCovered: 2 * combinationSize,
                  treeSizeScore: 0,
                  areaSizeScore: 0,
                  score: 0,
                  xpath: '',
                  isSiblingCombineRegion: false,
                  reasons: ['DEPTA repeated generalized nodes']
                };
                active = true;
              } else {
                current.nodesCovered += combinationSize;
              }
            } else if (active) {
              break;
            }
          }
          if (maxRegion.nodesCovered < current.nodesCovered && (maxRegion.startPoint === 0 || current.startPoint <= maxRegion.startPoint)) {
            maxRegion = current;
          }
        }
      }
      if (maxRegion.nodesCovered > 0) {
        dataRegions.push(maxRegion);
        if (maxRegion.startPoint + maxRegion.nodesCovered - 1 !== childCount) {
          dataRegions.push(...identifyDataRegions(maxRegion.startPoint + maxRegion.nodesCovered, node, similarity));
        }
      }
      return dataRegions;
    }

    function findAllDataRegions(node: VisualNode, listTagRegions: DataRegion[]): DataRegion[] {
      const dataRegions: DataRegion[] = [];
      if (subtreeDepth(node) >= 2 || (node.children.length > 5 && new Set(node.children.map((child) => child.nodeName)).size === 1)) {
        const current = identifyDataRegions(1, node, similarityThreshold);
        if (node.nodeName !== 'BODY' && current.length) dataRegions.push(...current);
        if (listTags.has(node.nodeName)) listTagRegions.push(...current);
        for (const child of visibleChildren(node)) {
          dataRegions.push(...findAllDataRegions(child, listTagRegions));
        }
      }
      return dataRegions;
    }

    function scoreRegions(regions: DataRegion[]): DataRegion[] {
      for (const region of regions) {
        region.treeSizeScore = subtreeDepth(region.parent) * 3.8 + subtreeSize(region.parent) * 0.2;
        region.areaSizeScore = region.parent.visual.area || 1;
      }
      const treeScores = regions.map((region) => region.treeSizeScore);
      const areaScores = regions.map((region) => region.areaSizeScore);
      const minTree = Math.min(...treeScores);
      const maxTree = Math.max(...treeScores);
      const minArea = Math.min(...areaScores);
      const maxArea = Math.max(...areaScores);
      for (const region of regions) {
        const treeNorm = maxTree === minTree ? 0.5 : (region.treeSizeScore - minTree) / (maxTree - minTree);
        const areaNorm = maxArea === minArea ? 0.5 : (region.areaSizeScore - minArea) / (maxArea - minArea);
        region.score = treeNorm * 0.3 + areaNorm * 0.7;
      }
      return regions;
    }

    function findCrossSections(regions: DataRegion[]): DataRegion[] {
      const commonMap = new Map<string, DataRegion[]>();
      for (let i = 0; i < regions.length; i += 1) {
        for (let j = i + 1; j < regions.length; j += 1) {
          const common = commonXPath(regions[i].parent.xpath, regions[j].parent.xpath);
          if (!common || common === regions[i].parent.xpath || common === regions[j].parent.xpath) continue;
          const list = commonMap.get(common) ?? [];
          if (!list.includes(regions[i])) list.push(regions[i]);
          if (!list.includes(regions[j])) list.push(regions[j]);
          commonMap.set(common, list);
        }
      }
      const output: DataRegion[] = [];
      for (const [common, list] of commonMap) {
        if (list.length < 2) continue;
        const first = getVisibleChild(list[0].parent, 1);
        const last = getVisibleChild(list[list.length - 1].parent, 1);
        if (!first || !last || first.nodeName !== last.nodeName || first.nodeName === 'TD') continue;
        const childDiff = Math.abs(visibleChildren(first).length - visibleChildren(last).length) / Math.max(1, visibleChildren(first).length, visibleChildren(last).length);
        if (childDiff >= 0.5) continue;
        const commonNode = list[0].parent.parent;
        if (!commonNode) continue;
        output.push({
          parent: commonNode,
          combinationSize: 1,
          startPoint: 1,
          nodesCovered: visibleChildren(commonNode).length,
          treeSizeScore: list.reduce((sum, region) => sum + region.treeSizeScore, 0),
          areaSizeScore: list.reduce((sum, region) => sum + region.areaSizeScore * 0.75, 0),
          score: 0,
          xpath: common,
          isSiblingCombineRegion: true,
          reasons: ['DEPTA cross-region merge']
        });
      }
      return output;
    }

    function findListTagCompensations(listTagRegions: DataRegion[], existing: DataRegion[]): DataRegion[] {
      const counts = new Map<VisualNode, DataRegion[]>();
      for (const region of listTagRegions) {
        const parent = region.parent.parent;
        if (!parent) continue;
        counts.set(parent, [...(counts.get(parent) ?? []), region]);
      }
      const output: DataRegion[] = [];
      for (const [parent, regions] of counts) {
        if (regions.length <= 3) continue;
        if (existing.some((region) => region.parent === parent)) continue;
        const first = regions[0].parent;
        output.push({
          parent,
          combinationSize: 1,
          startPoint: visibleChildren(parent).indexOf(first) + 1 || 1,
          nodesCovered: regions.length,
          treeSizeScore: regions.reduce((sum, region) => sum + subtreeSize(region.parent), 0),
          areaSizeScore: regions.reduce((sum, region) => sum + region.parent.visual.area, 0),
          score: 0,
          xpath: '',
          isSiblingCombineRegion: true,
          reasons: ['DEPTA list-tag compensation']
        });
      }
      return output;
    }

    function sliceDataRegion(region: DataRegion): DataRecord[] {
      const records: DataRecord[] = [];
      const parentChildren = visibleChildren(region.parent);
      const tagCounts = new Map<string, number>();
      for (const child of parentChildren) tagCounts.set(child.nodeName, (tagCounts.get(child.nodeName) ?? 0) + 1);
      const dominantTag = Array.from(tagCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      for (let childCounter = region.startPoint; childCounter + region.combinationSize <= region.startPoint + region.nodesCovered; childCounter += region.combinationSize) {
        const elements: VisualNode[] = [];
        for (let inner = childCounter; inner < childCounter + region.combinationSize; inner += 1) {
          const child = getVisibleChild(region.parent, inner);
          if (child && (!dominantTag || child.nodeName === dominantTag)) elements.push(child);
        }
        if (elements.length) {
          records.push({ elements, size: elements.reduce((sum, element) => sum + subtreeSize(element), 0) });
        }
      }
      return records;
    }

    function findDataRecords(region: DataRegion): DataRecord[] {
      if (region.combinationSize !== 1) return sliceDataRegion(region);
      const parent = region.parent;
      const first = getChild(parent, 1);
      if (!first) return [];
      for (let index = region.startPoint; index < region.startPoint + region.nodesCovered; index += 1) {
        const generalizedNode = getChild(parent, index);
        if (!generalizedNode || first.nodeName !== generalizedNode.nodeName) continue;
        if (subtreeDepth(generalizedNode) <= 2) return sliceDataRegion(region);
        let prev = getChild(generalizedNode, 1);
        if (!prev) continue;
        for (let childIndex = 2; childIndex <= generalizedNode.children.length; childIndex += 1) {
          const next = getChild(generalizedNode, childIndex);
          if (next && normalizedMatchScore(prev, next) < similarityThreshold) return sliceDataRegion(region);
          if (next) prev = next;
        }
      }
      const records: DataRecord[] = [];
      const parentChildren = visibleChildren(parent);
      const tagCounts = new Map<string, number>();
      for (const child of parentChildren) tagCounts.set(child.nodeName, (tagCounts.get(child.nodeName) ?? 0) + 1);
      const dominantTag = Array.from(tagCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      for (let index = region.startPoint; index < region.startPoint + region.nodesCovered; index += 1) {
        const generalizedNode = getChild(parent, index);
        if (!generalizedNode || (dominantTag && generalizedNode.nodeName !== dominantTag)) continue;
        for (const child of visibleChildren(generalizedNode)) {
          records.push({ elements: [child], size: subtreeSize(child) });
        }
      }
      return records.length ? records : sliceDataRegion(region);
    }

    function collectDescendantXPaths(nodes: VisualNode[], output: string[]): void {
      for (const node of nodes) {
        output.push(node.xpath);
        collectDescendantXPaths(visibleChildren(node), output);
      }
    }

    function longestCommonPrefix(values: string[]): string {
      if (!values.length) return '';
      for (let index = 0; index < values[0].length; index += 1) {
        const char = values[0][index];
        for (let item = 1; item < values.length; item += 1) {
          if (index === values[item].length || values[item][index] !== char) return values[0].slice(0, index);
        }
      }
      return values[0];
    }

    function alignRecords(records: DataRecord[], region: DataRegion): { rowXPath: string; fieldXPaths: string[] } {
      const seeds = records.slice().sort((a, b) => b.size - a.size).slice(0, Math.min(8, records.length));
      const seedXPaths = seeds.map((record) => record.elements[0]?.xpath).filter(Boolean);
      let rowXPath = longestCommonPrefix(seedXPaths);
      if (rowXPath.endsWith('[') || rowXPath.endsWith('/')) rowXPath = rowXPath.slice(0, -1);
      else if (/\[\d$/.test(rowXPath)) rowXPath = rowXPath.replace(/\[\d$/, '');
      else if (!rowXPath.endsWith(']')) rowXPath = rowXPath.slice(0, rowXPath.lastIndexOf('/'));
      const allXPaths: string[] = [];
      for (const seed of seeds) collectDescendantXPaths(seed.elements, allXPaths);
      const fieldXPaths = Array.from(new Set(allXPaths.map((value) => {
        let relative = value.slice(rowXPath.length).replace(/^\[\d+\]/, '');
        if (!relative) relative = '/';
        if (!relative.startsWith('/')) relative = `/${relative}`;
        return relative;
      }))).slice(0, 16);
      if (region.xpath) rowXPath = rowXPath.replace(region.parent.xpath, region.xpath);
      return { rowXPath, fieldXPaths };
    }

    function evaluateXPath(path: string): Element[] {
      try {
        const result = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const elements: Element[] = [];
        for (let index = 0; index < result.snapshotLength; index += 1) {
          const node = result.snapshotItem(index);
          if (node instanceof Element) elements.push(node);
        }
        return elements;
      } catch {
        return [];
      }
    }

    function rowSample(element: Element): { text: string; href: string; image: string; chunks: string[] } {
      const text = normalizedText((element as HTMLElement).innerText || element.textContent).slice(0, 500);
      const link = element.matches('a') ? element as HTMLAnchorElement : element.querySelector('a') as HTMLAnchorElement | null;
      const image = element.matches('img') ? element as HTMLImageElement : element.querySelector('img') as HTMLImageElement | null;
      const chunks = Array.from(element.querySelectorAll('h1,h2,h3,h4,a,p,span,div'))
        .map((item) => normalizedText((item as HTMLElement).innerText || item.textContent))
        .filter((value, index, arr) => value.length >= 2 && value.length <= 180 && arr.indexOf(value) === index)
        .slice(0, 8);
      return {
        text,
        href: link?.href || '',
        image: image?.currentSrc || image?.src || '',
        chunks
      };
    }

    function isNavigationLike(region: DataRegion, samples: Array<{ text: string; href: string }>): boolean {
      const ancestorTags = new Set<string>();
      let node: VisualNode | undefined = region.parent;
      while (node) {
        ancestorTags.add(node.nodeName);
        node = node.parent;
      }
      if (ancestorTags.has('NAV') || ancestorTags.has('HEADER')) return true;
      const rect = region.parent.visual;
      const sampleTexts = samples.map((sample) => sample.text).filter(Boolean);
      const shortTextRate = sampleTexts.filter((value) => value.length <= 8).length / Math.max(1, sampleTexts.length);
      const navTextRate = sampleTexts.filter((value) => /^(新闻|网页|贴吧|知道|图片|视频|地图|文库|更多|设置|登录|注册|首页|分类|导航|about|home|login|news|images|video|more)$/i.test(value)).length / Math.max(1, sampleTexts.length);
      if (rect.y < 180 && rect.height < 160 && shortTextRate > 0.75) return true;
      return navTextRate > 0.45;
    }

    const { root } = buildTree();
    const listTagRegions: DataRegion[] = [];
    let regions = findAllDataRegions(root, listTagRegions);
    regions = scoreRegions(regions);
    regions.push(...findCrossSections(regions));
    regions.push(...findListTagCompensations(listTagRegions, regions));
    regions = scoreRegions(regions);

    const seen = new Set<string>();
    const output: DeptaListGroup[] = [];
    for (const region of regions.sort((a, b) => b.score - a.score)) {
      const records = findDataRecords(region);
      if (records.length < 2) continue;
      const { rowXPath, fieldXPaths } = alignRecords(records, region);
      if (!rowXPath || seen.has(rowXPath)) continue;
      seen.add(rowXPath);
      const elements = evaluateXPath(rowXPath).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      });
      if (elements.length < 2) continue;
      const samples = elements.slice(0, 6).map(rowSample).filter((sample) => sample.text || sample.href || sample.image);
      const uniqueTextCount = new Set(samples.map((sample) => sample.text).filter(Boolean)).size;
      if (uniqueTextCount < Math.min(2, samples.length)) continue;
      output.push({
        parentSelector: selector(evaluateXPath(region.parent.xpath)[0] || document.body),
        parentXPath: region.parent.xpath,
        itemSelector: selector(elements[0]),
        itemXPath: rowXPath,
        itemCount: elements.length,
        score: region.score,
        rowSamples: samples,
        fieldXPaths,
        reasons: region.reasons,
        navigationLike: isNavigationLike(region, samples)
      });
      if (output.length >= 30) break;
    }

    return output;
  });
}
