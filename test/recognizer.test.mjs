import assert from 'node:assert/strict';
import { chdir, cwd } from 'node:process';
import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { buildAgentContextForTesting, buildTaskFromAgentPlan, previewAgentPlanForTesting, recognizeCommand, resolveAgentScreenshotPathForTesting, resolveAvailableRecognizedTaskFile, runInlineAgentRecognizeForTesting, runUrlCommand, splitRunUrlArgs } from '../dist/commands/recognize.js';
import { browserSessionPath, loadBrowserSession, saveBrowserSession } from '../dist/runtime/browser-session.js';
import { hasLinuxDisplayEnvironment, requiresVirtualDisplay } from '../dist/runtime/virtual-display.js';
import { dedupeEquivalentCandidates, detectInteractivePaginationOptionsForTesting, detectPageObstructionsForTesting, detectPaginationForCandidatesForTesting, dismissPageObstructionsForTesting, filterRecognizedBoilerplateCandidates, findSearchInputCandidatesForTesting, isPlausiblePaginationOptionForTesting, pageLooksLikeSearchResultForTesting, preferredPaginationForTesting, refineCandidateFieldsForTesting, resetManualOverlayHintKeysForTesting, resolveSearchSubmitButtonByGeometryForTesting, resolveSearchSubmitButtonForTesting, scoreSearchResultPageForTesting, shouldPromptForLoginInterventionForTesting, writeManualOverlayHintOnceForTesting } from '../dist/runtime/recognizer/page-recognizer.js';
import { buildTaskFromCandidate } from '../dist/runtime/recognizer/xml.js';

test('resolveAvailableRecognizedTaskFile creates a default file without overwriting existing tasks', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'recognizer-output-'));
  try {
    chdir(dir);
    assert.equal(resolveAvailableRecognizedTaskFile('recognized_example.com'), resolve('recognized_example.com.json'));
    await writeFile(resolve('recognized_example.com.json'), '{}\n');
    assert.equal(resolveAvailableRecognizedTaskFile('recognized_example.com'), resolve('recognized_example.com-1.json'));
  } finally {
    chdir(previousCwd);
  }
});

test('resolveAgentScreenshotPathForTesting enables default full-page screenshots for agent workflows', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'recognizer-agent-shot-'));
  try {
    chdir(dir);
    const testCwd = cwd();
    assert.equal(
      resolveAgentScreenshotPathForTesting(['--prepare-agent', '--json', '--output', 'context.json'], 'https://example.com/list'),
      resolve(testCwd, 'context.fullpage.png')
    );
    assert.equal(
      resolveAgentScreenshotPathForTesting(['--agent', '--agent-command', 'node make-plan.mjs', '--output', 'task.json'], 'https://example.com/list'),
      resolve(testCwd, 'task.fullpage.png')
    );
    assert.equal(
      resolveAgentScreenshotPathForTesting(['--auto', '--output', 'task.json'], 'https://example.com/list'),
      undefined
    );
  } finally {
    chdir(previousCwd);
  }
});

test('virtual display detection identifies Linux servers without a display', () => {
  const platform = mock.property(process, 'platform', 'linux');
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;

  try {
    assert.equal(hasLinuxDisplayEnvironment(), false);
    assert.equal(requiresVirtualDisplay(), true);

    process.env.DISPLAY = ':99';
    assert.equal(hasLinuxDisplayEnvironment(), true);
    assert.equal(requiresVirtualDisplay(), false);
  } finally {
    platform.mock.restore();
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = previousWayland;
  }
});

test('recognize rejects obsolete explicit screenshot flags', async () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await recognizeCommand(['https://example.com/list', '--prepare-agent', '--screenshot', 'custom.png', '--json', '--quiet']), 1);
    assert.equal(await recognizeCommand(['https://example.com/list', '--agent-screenshot', 'custom.png', '--json', '--quiet']), 1);
    assert.equal(await runUrlCommand('https://example.com/list', ['--auto', '--screenshot', 'custom.png', '--json']), 1);
  } finally {
    console.log = previousLog;
  }
});

test('splitRunUrlArgs keeps run output separate from recognize task output', () => {
  const split = splitRunUrlArgs([
    '--auto',
    '--goal',
    'articles',
    '--output',
    '/tmp/octoparse-runs',
    '--max-rows',
    '5',
    '--chrome-path',
    '/Applications/Chrome.app',
    '--timeout-ms',
    '90000',
    '--api-base-url',
    'https://api.example.test',
    '--jsonl',
    '--no-dismiss-popups',
    '--llm-rank'
  ]);

  assert.deepEqual(split.recognizeArgs, [
    '--auto',
    '--goal',
    'articles',
    '--chrome-path',
    '/Applications/Chrome.app',
    '--timeout-ms',
    '90000',
    '--api-base-url',
    'https://api.example.test',
    '--no-dismiss-popups',
    '--llm-rank'
  ]);
  assert.deepEqual(split.runArgs, [
    '--output',
    '/tmp/octoparse-runs',
    '--max-rows',
    '5',
    '--chrome-path',
    '/Applications/Chrome.app',
    '--timeout-ms',
    '90000',
    '--jsonl'
  ]);
});

test('recognize --agent rejects missing agent command before page recognition', async () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    const code = await recognizeCommand(['https://example.com/list', '--agent', '--json', '--quiet']);
    assert.equal(code, 1);
  } finally {
    console.log = previousLog;
  }
});

test('saveBrowserSession writes private cookie files and preserves covered hosts', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'recognizer-session-home-'));
  process.env.HOME = home;
  try {
    const reference = await saveBrowserSession({
      name: 'example.com',
      origin: 'https://example.com',
      hosts: ['example.com', 'passport.example.com', 'example.com'],
      cookies: [
        { name: 'sid', value: 'secret', domain: 'example.com', path: '/' },
        { name: 'expired', value: 'old', domain: 'example.com', expires: 1 }
      ]
    });
    const fileStat = await stat(browserSessionPath('example.com'));
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.deepEqual(reference.hosts, ['example.com', 'passport.example.com']);
    assert.equal(reference.cookieCount, 1);
    const loaded = await loadBrowserSession('example.com');
    assert.deepEqual(loaded.hosts, ['example.com', 'passport.example.com']);
    assert.deepEqual(loaded.cookies.map((cookie) => cookie.name), ['sid']);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('manual overlay CLI hint is deduped by workflow stage across page changes', () => {
  resetManualOverlayHintKeysForTesting();
  const messages = [];
  const runtimeConsole = {
    suppress() {},
    restore() {},
    restoreOriginal() {},
    writeStderr(message) {
      messages.push(message);
    },
    async question() {
      return '';
    }
  };

  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/a' }, 'pagination', 'Confirm pagination\n');
  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/b' }, 'pagination', 'Confirm pagination\n');
  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/b' }, 'candidate', 'Confirm recognition result\n');

  assert.deepEqual(messages, ['Confirm pagination\n', 'Confirm recognition result\n']);
});

test('dedupeEquivalentCandidates collapses duplicate card/list detections', () => {
  const base = {
    title: 'Feed cards',
    confidence: 0.9,
    selector: 'main',
    xpath: '/html/body/main/section',
    itemSelector: 'article',
    itemXPath: '/html/body/main/section/article',
    itemCount: 64,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['没买到合适的尺寸'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/explore/1'] },
      { name: 'image', kind: 'src', selector: 'img', xpath: '/html/body/main/section/article/img', relativeXPath: './img', samples: ['https://cdn.example.com/1.jpg'] },
      { name: 'summary', kind: 'text', selector: 'p', xpath: '/html/body/main/section/article/p', relativeXPath: './p', samples: ['没买到合适的尺寸，也来自自己写了'] }
    ],
    sampleRows: [
      {
        title: '没买到合适的尺寸',
        url: 'https://example.com/explore/1',
        image: 'https://cdn.example.com/1.jpg',
        summary: '没买到合适的尺寸，也来自自己写了'
      }
    ],
    reasons: ['Fields refined from repeated item structure'],
    layout: {
      role: 'main',
      score: 0.9,
      mainScore: 0.9,
      sidebarPenalty: 0,
      boilerplatePenalty: 0,
      visualCoverage: 0.8,
      textDensity: 0.5,
      linkDensity: 1,
      centerDistance: 0.1,
      reasons: []
    }
  };

  const deduped = dedupeEquivalentCandidates([
    { ...base, id: 'search_results_1', type: 'search_results', confidence: 0.91 },
    { ...base, id: 'search_results_4', type: 'search_results', itemXPath: '/html/body/main/section/div/article', confidence: 0.88 },
    { ...base, id: 'repeated_card_5', type: 'repeated_card', confidence: 0.9 }
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'repeated_card_5');
});

test('filterRecognizedBoilerplateCandidates removes legal footer records but keeps ordinary link collections', () => {
  const footer = {
    id: 'search_results_2',
    type: 'search_results',
    title: 'Footer legal links',
    confidence: 0.75,
    selector: 'footer',
    xpath: '/html/body/footer',
    itemSelector: 'a',
    itemXPath: '/html/body/footer/a',
    itemCount: 2,
    fields: [
      { name: 'text', kind: 'text', selector: 'a', xpath: '/html/body/footer/a', relativeXPath: '.', samples: ['沪ICP备13030189号', '隐私政策'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/footer/a', relativeXPath: '.', samples: ['https://beian.miit.gov.cn/', 'https://example.com/privacy'] }
    ],
    sampleRows: [{ text: '沪ICP备13030189号', url: 'https://beian.miit.gov.cn/' }],
    reasons: ['Likely footer/legal boilerplate group']
  };
  const links = {
    ...footer,
    id: 'link_collection_1',
    type: 'link_collection',
    title: 'Useful links',
    selector: 'main',
    xpath: '/html/body/main/section',
    itemXPath: '/html/body/main/section/a',
    fields: [
      { name: 'text', kind: 'text', selector: 'a', xpath: '/html/body/main/section/a', relativeXPath: '.', samples: ['产品文档', '价格说明'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/a', relativeXPath: '.', samples: ['https://example.com/docs', 'https://example.com/pricing'] }
    ],
    sampleRows: [{ text: '产品文档', url: 'https://example.com/docs' }],
    reasons: ['Several adjacent links detected']
  };
  const mixedLegalFooter = {
    ...footer,
    id: 'search_results_3',
    title: 'Mixed footer links',
    selector: 'div.side-bar',
    xpath: '/html/body/div[2]/div[5]',
    itemXPath: '/html/body/div[2]/div[5]/a',
    fields: [
      { name: 'text', kind: 'text', selector: 'a', xpath: '/html/body/div[2]/div[5]/a', relativeXPath: '.', samples: ['创作中心', '业务合作', '沪ICP备13030189号'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/div[2]/div[5]/a', relativeXPath: '.', samples: ['https://example.com/creator', 'https://example.com/business', 'https://beian.miit.gov.cn/'] }
    ],
    sampleRows: [
      { text: '创作中心', url: 'https://example.com/creator' },
      { text: '业务合作', url: 'https://example.com/business' },
      { text: '沪ICP备13030189号', url: 'https://beian.miit.gov.cn/' }
    ],
    reasons: ['Several adjacent links detected']
  };
  const layoutFooter = {
    ...links,
    id: 'link_collection_2',
    layout: {
      role: 'footer',
      score: 0.08,
      mainScore: 0.22,
      sidebarPenalty: 0.1,
      boilerplatePenalty: 0.62,
      visualCoverage: 0.08,
      textDensity: 0.2,
      linkDensity: 0.9,
      centerDistance: 0.1,
      reasons: ['high link density']
    }
  };

  const filtered = filterRecognizedBoilerplateCandidates([footer, links, mixedLegalFooter, layoutFooter]);
  assert.deepEqual(filtered.map((candidate) => candidate.id), ['link_collection_1']);
});

test('detectPaginationForCandidates does not infer scroll from long pages alone', async () => {
  const candidate = {
    id: 'repeated_card_1',
    type: 'repeated_card',
    title: 'Waterfall cards',
    confidence: 0.9,
    selector: '#feed',
    xpath: '/html/body/main/section',
    itemSelector: 'article.card',
    itemXPath: '/html/body/main/section/article',
    itemCount: 69,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const page = fakePaginationPage({
    bodyHeight: 5000,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows: Array.from({ length: candidate.itemCount }, (_, index) => ({
      text: `Card ${index + 1}`,
      rect: { left: 80 + (index % 3) * 260, top: 120 + Math.floor(index / 3) * 210, right: 300 + (index % 3) * 260, bottom: 300 + Math.floor(index / 3) * 210 },
      children: [
        {
          text: '下一页',
          attrs: { className: 'next note-link' },
          rect: { left: 110 + (index % 3) * 260, top: 250 + Math.floor(index / 3) * 210, right: 170 + (index % 3) * 260, bottom: 280 + Math.floor(index / 3) * 210 }
        }
      ]
    }))
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination, undefined);
});

test('detectPaginationForCandidates uses scroll only when the scroll probe sees list-item growth', async () => {
  const candidate = {
    id: 'repeated_card_1',
    type: 'repeated_card',
    title: 'Waterfall cards',
    confidence: 0.9,
    selector: '#feed',
    xpath: '/html/body/main/section',
    itemSelector: 'article.card',
    itemXPath: '/html/body/main/section/article',
    itemCount: 24,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const page = fakePaginationPage({
    bodyHeight: 3600,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows: Array.from({ length: candidate.itemCount }, (_, index) => ({
      text: `Card ${index + 1}`,
      rect: { left: 80 + (index % 3) * 260, top: 120 + Math.floor(index / 3) * 210, right: 300 + (index % 3) * 260, bottom: 300 + Math.floor(index / 3) * 210 },
      children: []
    }))
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: false,
    sawGrowth: true,
    maxArticleLikeCount: 48,
    maxContentHeight: 12000,
    maxPageHeight: 6200,
    grewArticleLikeCount: 24,
    grewContentHeight: 5000,
    grewPageHeight: 2600,
    reachedBottom: false
  });

  assert.equal(withPagination.pagination.type, 'scroll');
  assert.equal(withPagination.pagination.xpath, '');
  assert.match(withPagination.pagination.reasons.join(' '), /list-like item count grew/);
});

test('detectPaginationForCandidates does not infer scroll from Baidu-like static hot list height changes', async () => {
  const candidate = {
    id: 'protected_smart_1',
    type: 'search_results',
    title: 'Baidu hot search list',
    confidence: 0.86,
    selector: '#hotsearch-content-wrapper',
    xpath: '/html/body/div/ul',
    itemSelector: 'li.hotsearch-item',
    itemXPath: '/html/body/div/ul/li',
    itemCount: 10,
    fields: [
      { name: '标题', kind: 'text', selector: 'span.title-content-title', xpath: '/html/body/div/ul/li/span', relativeXPath: './span', samples: ['高考加油'] },
      { name: '标题链接', kind: 'href', selector: 'a.title-content', xpath: '/html/body/div/ul/li/a', relativeXPath: './a', samples: ['https://www.baidu.com/s?wd=test'] }
    ],
    sampleRows: [{ '标题': '高考加油', '标题链接': 'https://www.baidu.com/s?wd=test' }],
    reasons: ['protected SmartProxy candidate']
  };
  const page = fakePaginationPage({
    bodyHeight: 1600,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows: Array.from({ length: candidate.itemCount }, (_, index) => ({
      tag: 'li',
      text: `热搜 ${index + 1} 高考加油 原始列表项`,
      attrs: { className: 'hotsearch-item' },
      rect: { left: 720, top: 220 + index * 42, right: 1050, bottom: 252 + index * 42 },
      children: [
        {
          tag: 'a',
          text: `热搜 ${index + 1}`,
          attrs: { href: `https://www.baidu.com/s?wd=${index + 1}`, className: 'title-content' },
          rect: { left: 760, top: 224 + index * 42, right: 1000, bottom: 248 + index * 42 }
        }
      ]
    }))
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: false,
    sawGrowth: true,
    maxArticleLikeCount: 10,
    maxContentHeight: 4200,
    maxPageHeight: 2200,
    grewArticleLikeCount: 0,
    grewContentHeight: 1800,
    grewPageHeight: 600,
    reachedBottom: true
  });

  assert.equal(withPagination.pagination, undefined);
});

test('detectPaginationForCandidates removes protected scroll when the probe reached bottom without growth', async () => {
  const candidate = {
    id: 'protected_smart_1',
    type: 'search_results',
    title: 'Baidu hot search list',
    confidence: 0.86,
    selector: '#hotsearch-content-wrapper',
    xpath: '/html/body/div/ul',
    itemSelector: 'li.hotsearch-item',
    itemXPath: '/html/body/div/ul/li',
    itemCount: 10,
    fields: [
      { name: '标题', kind: 'text', selector: 'span.title-content-title', xpath: '/html/body/div/ul/li/span', relativeXPath: './span', samples: ['高考加油'] }
    ],
    sampleRows: [{ '标题': '高考加油' }],
    reasons: ['protected SmartProxy candidate'],
    pagination: {
      type: 'scroll',
      xpath: '',
      text: 'Scroll page',
      confidence: 0.84,
      isAjax: true,
      scope: 'global',
      reasons: ['Detected by protected SmartProxy pagination']
    }
  };
  const page = fakePaginationPage({
    bodyHeight: 810,
    viewportHeight: 806,
    itemXPath: candidate.itemXPath,
    rows: Array.from({ length: candidate.itemCount }, (_, index) => ({
      tag: 'li',
      text: `热搜 ${index + 1} 高考加油 原始列表项`,
      attrs: { className: 'hotsearch-item' },
      rect: { left: 720, top: 220 + index * 42, right: 1050, bottom: 252 + index * 42 },
      children: []
    }))
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: false,
    sawGrowth: false,
    maxArticleLikeCount: 1,
    maxContentHeight: 346260,
    maxPageHeight: 810,
    grewArticleLikeCount: 0,
    grewContentHeight: 0,
    grewPageHeight: 0,
    reachedBottom: true
  });

  assert.equal(withPagination.pagination, undefined);
});

test('detectPaginationForCandidates keeps reliable external numeric next pagination', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 20,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 80, right: 720, bottom: 160 + index * 80 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 2300,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'page active', ariaCurrent: 'page' }, rect: { left: 300, top: 1780, right: 330, bottom: 1810 } },
      { text: '2', attrs: { className: 'page' }, rect: { left: 340, top: 1780, right: 370, bottom: 1810 } },
      { text: '下一页', attrs: { className: 'pager-next' }, rect: { left: 380, top: 1780, right: 450, bottom: 1810 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'next_page');
  assert.match(withPagination.pagination.text, /2|下一页/);
});

test('detectPaginationForCandidates prefers bottom numeric pager over scroll fallback on long lists', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 36,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 100, right: 720, bottom: 170 + index * 100 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 4600,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'page active', ariaCurrent: 'page' }, rect: { left: 300, top: 3980, right: 340, bottom: 4025 } },
      { text: '2', attrs: { className: 'page' }, rect: { left: 370, top: 3980, right: 410, bottom: 4025 } },
      { text: '3', attrs: { className: 'page' }, rect: { left: 440, top: 3980, right: 480, bottom: 4025 } },
      { text: '...', attrs: { className: 'page ellipsis' }, rect: { left: 510, top: 3980, right: 565, bottom: 4025 } },
      { text: '100', attrs: { className: 'page' }, rect: { left: 600, top: 3980, right: 660, bottom: 4025 } },
      { text: '>', attrs: { className: 'page next' }, rect: { left: 700, top: 3980, right: 750, bottom: 4025 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'next_page');
  assert.match(withPagination.pagination.text, /^(2|>)$/);
});

test('detectPaginationForCandidates finds cnblogs-style bottom pager after the page is scrolled', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Cnblogs posts',
    confidence: 0.9,
    selector: '#post_list',
    xpath: '/html/body/main/section',
    itemSelector: 'article.post-item',
    itemXPath: '/html/body/main/section/article',
    itemCount: 20,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Post ${index + 1}`,
    rect: { left: 80, top: 120 + index * 170, right: 720, bottom: 250 + index * 170 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 4300,
    viewportHeight: 900,
    scrollY: 3000,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'btn current', ariaCurrent: 'page' }, rect: { left: 260, top: 3720, right: 292, bottom: 3752 } },
      { text: '2', attrs: { className: 'btn' }, rect: { left: 304, top: 3720, right: 336, bottom: 3752 } },
      { text: '3', attrs: { className: 'btn' }, rect: { left: 348, top: 3720, right: 380, bottom: 3752 } },
      { text: '...', attrs: { className: 'btn' }, rect: { left: 392, top: 3720, right: 434, bottom: 3752 } },
      { text: '100', attrs: { className: 'btn' }, rect: { left: 448, top: 3720, right: 496, bottom: 3752 } },
      { text: '>', attrs: { className: 'btn' }, rect: { left: 508, top: 3720, right: 540, bottom: 3752 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'next_page');
  assert.equal(withPagination.pagination.text, '>');
  assert.match(withPagination.pagination.reasons.join(' '), /numeric pager sequence|pager arrow after numeric pages/);
});

test('manual pagination options include cnblogs-style numeric pager arrow', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Cnblogs posts',
    confidence: 0.9,
    selector: '#post_list',
    xpath: '/html/body/main/section',
    itemSelector: 'article.post-item',
    itemXPath: '/html/body/main/section/article',
    itemCount: 20,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] }
    ],
    sampleRows: [{ title: 'Alpha' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Post ${index + 1}`,
    rect: { left: 80, top: 120 + index * 170, right: 720, bottom: 250 + index * 170 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 4300,
    viewportHeight: 900,
    scrollY: 3000,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'btn current', ariaCurrent: 'page' }, rect: { left: 260, top: 3720, right: 292, bottom: 3752 } },
      { text: '2', attrs: { className: 'btn' }, rect: { left: 304, top: 3720, right: 336, bottom: 3752 } },
      { text: '3', attrs: { className: 'btn' }, rect: { left: 348, top: 3720, right: 380, bottom: 3752 } },
      { text: '...', attrs: { className: 'btn' }, rect: { left: 392, top: 3720, right: 434, bottom: 3752 } },
      { text: '100', attrs: { className: 'btn' }, rect: { left: 448, top: 3720, right: 496, bottom: 3752 } },
      { text: '>', attrs: { className: 'btn' }, rect: { left: 508, top: 3720, right: 540, bottom: 3752 } }
    ]
  });

  const options = await detectInteractivePaginationOptionsForTesting(page, [candidate]);

  assert.equal(options[0].type, 'next_page');
  assert.equal(options[0].text, '>');
  assert.match(options[0].reasons.join(' '), /pager arrow after numeric pages/);
});

test('detectPaginationForCandidates does not treat load-more end state as clickable pagination', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'News feed',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 50,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 80, right: 720, bottom: 160 + index * 80 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 5200,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { tag: 'div', text: '没有更多内容了，去首页看看', attrs: { className: 'load-more' }, rect: { left: 80, top: 4700, right: 720, bottom: 4760 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.notEqual(withPagination.pagination?.type, 'load_more');
});

test('detectPaginationForCandidates keeps existing load-more over scroll fallback', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 50,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test'],
    pagination: {
      type: 'load_more',
      xpath: '//button[contains(normalize-space(.), "查看更多")]',
      text: '查看更多',
      confidence: 0.64,
      isAjax: true,
      scope: 'near_list',
      reasons: ['Detected by protected SmartProxy pagination']
    }
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 80, right: 720, bottom: 160 + index * 80 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 5200,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'load_more');
  assert.equal(withPagination.pagination.text, '查看更多');
});

test('detectPaginationForCandidates prefers global load-more over weak next-page', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 4,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 90, right: 720, bottom: 160 + index * 90 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 1800,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '下一页', attrs: { className: 'next' }, rect: { left: 80, top: 520, right: 148, bottom: 552 } },
      { tag: 'button', text: '查看更多', attrs: { className: 'load-more' }, rect: { left: 300, top: 1200, right: 420, bottom: 1240 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'load_more');
  assert.equal(withPagination.pagination.text, '查看更多');
});

test('preferredPaginationForTesting marks load-more as scroll-revealed when scroll and button signals both exist', () => {
  const selected = preferredPaginationForTesting({
    type: 'scroll',
    xpath: '',
    text: 'Scroll page',
    confidence: 0.78,
    isAjax: true,
    scope: 'global',
    reasons: ['long repeated-card/list page with no reliable external pager']
  }, {
    type: 'load_more',
    xpath: '//div[contains(normalize-space(.), "加载更多")]',
    text: '加载更多',
    confidence: 0.62,
    isAjax: true,
    scope: 'global',
    reasons: ['load-more text or attributes']
  });

  assert.equal(selected.type, 'load_more');
  assert.equal(selected.revealByScroll, true);
  assert.match(selected.reasons.join(' '), /scroll/i);
});

test('preferredPaginationForTesting prefers reliable next-page over scroll continuation', () => {
  const selected = preferredPaginationForTesting({
    type: 'scroll',
    xpath: '',
    text: 'Scroll page',
    confidence: 0.87,
    isAjax: true,
    scope: 'global',
    reasons: ['long repeated-card/list page with scroll continuation']
  }, {
    type: 'next_page',
    xpath: '/html/body/nav[1]//a[normalize-space(.)="2"]',
    text: '2',
    confidence: 0.78,
    isAjax: false,
    scope: 'near_list',
    reasons: ['numeric pager sequence']
  });

  assert.equal(selected.type, 'next_page');
  assert.equal(selected.text, '2');
});

test('detectPaginationForCandidates carries load-more seen during pre-scroll probe', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 32,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 90, right: 720, bottom: 160 + index * 90 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 4200,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: true,
    sawGrowth: true,
    maxArticleLikeCount: 64,
    maxContentHeight: 9000,
    maxPageHeight: 7200,
    bestActiveLoadMoreText: '加载更多',
    bestActiveLoadMoreXPath: '/html/body/main/button[1]'
  });

  assert.equal(withPagination.pagination.type, 'load_more');
  assert.equal(withPagination.pagination.revealByScroll, true);
  assert.match(withPagination.pagination.xpath, /加载更多/);
  assert.match(withPagination.pagination.reasons.join(' '), /scroll probe/);
});

test('detectPaginationForCandidates keeps scroll over horizontal filter carousel arrows', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 36,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test'],
    pagination: {
      type: 'next_page',
      xpath: '/html[1]/body[1]/div[1]/button[1]',
      text: '>',
      confidence: 0.82,
      isAjax: true,
      scope: 'near_list',
      reasons: ['Detected by protected SmartProxy pagination']
    }
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80 + (index % 3) * 260, top: 180 + Math.floor(index / 3) * 220, right: 300 + (index % 3) * 260, bottom: 360 + Math.floor(index / 3) * 220 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 5400,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      {
        tag: 'div',
        text: '员工人数 盈利情况 学生 行业 地区 公司',
        attrs: { className: 'filter carousel chips' },
        rect: { left: 70, top: 96, right: 980, bottom: 150 },
        children: [
          { tag: 'span', text: '员工人数', attrs: { className: 'chip' }, rect: { left: 96, top: 108, right: 176, bottom: 138 } },
          { tag: 'span', text: '盈利情况', attrs: { className: 'chip' }, rect: { left: 192, top: 108, right: 286, bottom: 138 } },
          { tag: 'button', text: '>', attrs: { className: 'arrow-right next' }, rect: { left: 928, top: 104, right: 962, bottom: 142 } }
        ]
      }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: false,
    sawGrowth: true,
    maxArticleLikeCount: 72,
    maxContentHeight: 15000,
    maxPageHeight: 7800,
    grewArticleLikeCount: 36,
    grewContentHeight: 7000,
    grewPageHeight: 2400,
    reachedBottom: false
  });

  assert.equal(withPagination.pagination.type, 'scroll');
  assert.equal(withPagination.pagination.xpath, '');
});

test('manual pagination filter rejects ordinary short text as next-page', () => {
  assert.equal(isPlausiblePaginationOptionForTesting({
    type: 'next_page',
    xpath: '/html/body/main/section/article[1]/span[1]',
    text: 'Zayn~',
    confidence: 0.78,
    isAjax: true,
    scope: 'near_list',
    reasons: ['Detected by protected SmartProxy pagination']
  }), false);
  assert.equal(isPlausiblePaginationOptionForTesting({
    type: 'next_page',
    xpath: '//a[contains(@class, "pager-next")]',
    text: '',
    confidence: 0.78,
    isAjax: true,
    scope: 'near_list',
    reasons: ['pager arrow after numeric pages']
  }), true);
});

test('search submit resolver ignores article suggestion links and keeps the real search button', async () => {
  const page = fakeSearchPage({
    url: 'https://www.csdn.net/',
    title: 'CSDN',
    bodyText: 'openai 搜索 推荐文章',
    elements: [
      {
        tag: 'header',
        attrs: { id: 'toolbar-search', className: 'toolbar search-box' },
        rect: { left: 0, top: 0, right: 1000, bottom: 80 },
        children: [
          {
            tag: 'input',
            attrs: { name: 'q', type: 'text', placeholder: '搜索' },
            rect: { left: 280, top: 20, right: 610, bottom: 52 }
          },
          {
            tag: 'button',
            text: '搜索',
            attrs: { className: 'search-btn', type: 'button' },
            rect: { left: 620, top: 20, right: 690, bottom: 52 }
          }
        ]
      },
      {
        tag: 'div',
        attrs: { className: 'suggest-list' },
        rect: { left: 280, top: 56, right: 690, bottom: 260 },
        children: [
          {
            tag: 'a',
            text: 'OpenAI 最新文章',
            attrs: { href: 'https://blog.csdn.net/example/article/details/123', className: 'article-item' },
            rect: { left: 280, top: 62, right: 690, bottom: 96 }
          }
        ]
      }
    ]
  });

  const button = await resolveSearchSubmitButtonForTesting(page, {
    inputs: [{ name: 'q', xpath: '/html[1]/body[1]/header[1]/input[1]' }]
  });

  assert.equal(button?.xpath, '/html[1]/body[1]/header[1]/button[1]');
  assert.equal(button?.text, '搜索');
});

test('search submit resolver accepts icon-only controls aligned with search input', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { className: 'search-panel' },
        rect: { left: 120, top: 70, right: 1040, bottom: 150 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'queryBox', placeholder: '搜索或输入任何问题', className: 'textarea' },
            rect: { left: 150, top: 88, right: 940, bottom: 132 }
          },
          {
            tag: 'div',
            attrs: { className: 'icon-button' },
            rect: { left: 956, top: 91, right: 1000, bottom: 135 },
            children: [
              {
                tag: 'svg',
                attrs: { className: 'magnifier' },
                rect: { left: 966, top: 101, right: 990, bottom: 125 }
              }
            ]
          }
        ]
      }
    ]
  });

  const inputs = await findSearchInputCandidatesForTesting(page, 'q');
  const button = await resolveSearchSubmitButtonForTesting(page, {
    inputs: [{ name: 'q', xpath: inputs[0].xpath }],
    preferredButtons: inputs[0].buttonXPath ? [{ xpath: inputs[0].buttonXPath }] : []
  });

  assert.match(inputs[0]?.buttonXPath, /div/);
  assert.equal(button?.xpath, inputs[0]?.buttonXPath);
  assert.ok((button?.score ?? 0) >= 1.2, button);
});

test('search submit resolver records clickable parent when click lands on nested icon', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { className: 'search-shell' },
        rect: { left: 120, top: 70, right: 1040, bottom: 150 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'q', placeholder: '搜索关键词', className: 'textarea' },
            rect: { left: 150, top: 88, right: 940, bottom: 132 }
          },
          {
            tag: 'button',
            attrs: { className: 'search-button', ariaLabel: '搜索' },
            rect: { left: 956, top: 91, right: 1000, bottom: 135 },
            children: [
              {
                tag: 'svg',
                attrs: { className: 'search-icon' },
                rect: { left: 966, top: 101, right: 990, bottom: 125 },
                children: [
                  {
                    tag: 'path',
                    attrs: { className: 'search-path' },
                    rect: { left: 971, top: 106, right: 985, bottom: 120 }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  const inputs = await findSearchInputCandidatesForTesting(page, 'q');
  const button = await resolveSearchSubmitButtonForTesting(page, {
    inputs: [{ name: 'q', xpath: inputs[0].xpath }],
    preferredButtons: inputs[0].buttonXPath ? [{ xpath: inputs[0].buttonXPath }] : []
  });

  assert.equal(inputs[0]?.buttonXPath, '/html[1]/body[1]/div[1]/button[1]');
  assert.equal(button?.xpath, '/html[1]/body[1]/div[1]/button[1]');
});

test('search submit geometry fallback finds compact right-side controls', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { className: 'textarea-shell' },
        rect: { left: 120, top: 70, right: 1040, bottom: 150 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'queryBox', placeholder: '搜索或输入任何问题', className: 'textarea' },
            rect: { left: 150, top: 88, right: 940, bottom: 132 }
          },
          {
            tag: 'span',
            attrs: { className: 'suffix icon' },
            rect: { left: 958, top: 92, right: 1002, bottom: 136 }
          }
        ]
      }
    ]
  });

  const button = await resolveSearchSubmitButtonByGeometryForTesting(page, '/html[1]/body[1]/div[1]/textarea[1]');

  assert.equal(button?.xpath, '/html[1]/body[1]/div[1]/span[1]');
  assert.ok((button?.score ?? 0) >= 1.1, button);
});

test('search submit resolver ignores clear icon and chooses nearby search control', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { className: 'search-shell' },
        rect: { left: 120, top: 70, right: 1040, bottom: 150 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'q', placeholder: '搜索关键词', className: 'textarea' },
            rect: { left: 150, top: 88, right: 860, bottom: 132 }
          },
          {
            tag: 'span',
            attrs: { className: 'clear-icon', ariaLabel: '清除' },
            rect: { left: 816, top: 96, right: 844, bottom: 124 }
          },
          {
            tag: 'div',
            attrs: { className: 'suffix search-submit icon-button' },
            rect: { left: 884, top: 91, right: 928, bottom: 135 },
            children: [
              {
                tag: 'svg',
                attrs: { className: 'magnifier' },
                rect: { left: 894, top: 101, right: 918, bottom: 125 }
              }
            ]
          }
        ]
      }
    ]
  });

  const inputs = await findSearchInputCandidatesForTesting(page, 'q');
  const button = await resolveSearchSubmitButtonForTesting(page, {
    inputs: [{ name: 'q', xpath: inputs[0].xpath }],
    preferredButtons: inputs[0].buttonXPath ? [{ xpath: inputs[0].buttonXPath }] : []
  });

  assert.equal(inputs[0]?.buttonXPath, '/html[1]/body[1]/div[1]/div[1]');
  assert.equal(button?.xpath, '/html[1]/body[1]/div[1]/div[1]');
  assert.doesNotMatch(button?.xpath || '', /span/);
});

test('search submit resolver finds search button outside the immediate search wrapper', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'section',
        attrs: { className: 'search-zone' },
        rect: { left: 80, top: 60, right: 1100, bottom: 180 },
        children: [
          {
            tag: 'div',
            attrs: { className: 'input-box' },
            rect: { left: 100, top: 80, right: 900, bottom: 150 },
            children: [
              {
                tag: 'textarea',
                attrs: { name: 'q', placeholder: '搜索关键词', className: 'textarea' },
                rect: { left: 120, top: 94, right: 860, bottom: 136 }
              }
            ]
          },
          {
            tag: 'button',
            attrs: { className: 'go-button search-submit', ariaLabel: '搜索' },
            rect: { left: 930, top: 90, right: 990, bottom: 140 }
          }
        ]
      }
    ]
  });

  const inputs = await findSearchInputCandidatesForTesting(page, 'q');
  const button = await resolveSearchSubmitButtonForTesting(page, {
    inputs: [{ name: 'q', xpath: inputs[0].xpath }],
    preferredButtons: inputs[0].buttonXPath ? [{ xpath: inputs[0].buttonXPath }] : []
  });

  assert.equal(inputs[0]?.buttonXPath, '/html[1]/body[1]/section[1]/button[1]');
  assert.equal(button?.xpath, '/html[1]/body[1]/section[1]/button[1]');
});

test('findSearchInputCandidates detects custom editable search boxes', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { className: 'search-wrapper' },
        rect: { left: 320, top: 48, right: 1240, bottom: 164 },
        children: [
          {
            tag: 'div',
            text: '登录探索更多内容',
            attrs: { role: 'textbox', contenteditable: 'true', className: 'search-input', dataPlaceholder: '登录探索更多内容' },
            rect: { left: 356, top: 72, right: 1120, bottom: 148 }
          },
          {
            tag: 'button',
            text: '',
            attrs: { ariaLabel: '搜索', className: 'search-button' },
            rect: { left: 1190, top: 112, right: 1228, bottom: 150 }
          }
        ]
      }
    ]
  });

  const candidates = await findSearchInputCandidatesForTesting(page, 'query');

  assert.equal(candidates[0]?.type, 'textbox');
  assert.match(candidates[0]?.placeholder, /探索|搜索/);
  assert.match(candidates[0]?.buttonXPath, /button/);
  assert.ok(candidates[0]?.score >= 1.5, candidates[0]);
});

test('findSearchInputCandidates detects semantic textarea search boxes', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/explore',
    title: 'Example',
    bodyText: '',
    elements: [
      {
        tag: 'div',
        attrs: { id: 'search-input-in-feeds', className: 'textarea-container when-history-visible' },
        rect: { left: 80, top: 72, right: 1080, bottom: 152 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'aiSearchTextarea', className: 'textarea', placeholder: '搜索或输入任何问题' },
            rect: { left: 96, top: 86, right: 980, bottom: 132 }
          },
          {
            tag: 'button',
            text: '',
            attrs: { ariaLabel: '搜索', className: 'search-button' },
            rect: { left: 1000, top: 90, right: 1044, bottom: 134 }
          }
        ]
      }
    ]
  });

  const candidates = await findSearchInputCandidatesForTesting(page, 'q');

  assert.equal(candidates[0]?.type, 'textarea');
  assert.equal(candidates[0]?.name, 'aiSearchTextarea');
  assert.match(candidates[0]?.placeholder, /搜索/);
  assert.match(candidates[0]?.buttonXPath, /button/);
  assert.ok(candidates[0]?.score >= 1.5, candidates[0]);
});

test('findSearchInputCandidates ignores non-search composer textareas', async () => {
  const page = fakeSearchPage({
    url: 'https://example.com/article/1',
    title: 'Example Article',
    bodyText: '文章详情 评论区',
    elements: [
      {
        tag: 'section',
        attrs: { className: 'comment-composer' },
        rect: { left: 80, top: 600, right: 920, bottom: 820 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'comment', className: 'comment-editor', placeholder: '发布你的评论' },
            rect: { left: 120, top: 640, right: 860, bottom: 760 }
          },
          {
            tag: 'button',
            text: '发布',
            attrs: { className: 'submit-comment' },
            rect: { left: 760, top: 772, right: 860, bottom: 812 }
          }
        ]
      }
    ]
  });

  const candidates = await findSearchInputCandidatesForTesting(page, 'q');

  assert.equal(candidates.length, 0, candidates);
});

test('findSearchInputCandidates ignores search-like textareas inside login modal', async () => {
  const page = fakeSearchPage({
    url: 'https://www.xiaohongshu.com/explore',
    title: '小红书',
    bodyText: '登录后推荐更懂你的笔记 手机号登录 输入验证码',
    elements: [
      {
        tag: 'main',
        text: '正常内容 openai 笔记列表',
        attrs: { className: 'explore-feed' },
        rect: { left: 0, top: 80, right: 1000, bottom: 1200 },
        children: []
      },
      {
        tag: 'div',
        text: '登录后推荐更懂你的笔记 手机号登录 输入验证码',
        attrs: { className: 'login-modal mask', role: 'dialog' },
        rect: { left: 320, top: 130, right: 980, bottom: 760 },
        children: [
          {
            tag: 'textarea',
            attrs: { name: 'aiSearchTextarea', className: 'textarea', placeholder: '登录探索更多内容' },
            rect: { left: 380, top: 220, right: 900, bottom: 280 }
          }
        ]
      }
    ]
  });

  const candidates = await findSearchInputCandidatesForTesting(page, 'q');

  assert.equal(candidates.length, 0, candidates);
});

test('search result scoring prefers actual result tab over CSDN entry and article tabs', async () => {
  const options = recognizeOptionsForSearchScoring('https://www.csdn.net/', 'openai');
  const entry = fakeSearchPage({
    url: 'https://www.csdn.net/',
    title: 'CSDN_专业开发者社区',
    bodyText: 'OpenAI 极客头条 技术文章 首页 推荐 资讯 ' + '普通首页内容 '.repeat(80),
    elements: searchResultLikeElements({ className: 'home-feed', itemTextPrefix: 'OpenAI 首页推荐' })
  });
  const article = fakeSearchPage({
    url: 'https://blog.csdn.net/example/article/details/123',
    title: 'OpenAI 文章',
    bodyText: 'OpenAI 正文内容 ' + '文章段落 '.repeat(120),
    elements: searchResultLikeElements({ className: 'article-list', itemTextPrefix: 'OpenAI 文章段落' })
  });
  const result = fakeSearchPage({
    url: 'https://so.csdn.net/so/search?q=openai',
    title: 'openai 搜索结果',
    bodyText: '搜索结果 openai 相关结果 ' + '结果摘要 '.repeat(120),
    elements: searchResultLikeElements({ className: 'search-result-list', itemTextPrefix: 'OpenAI 搜索结果' })
  });

  assert.equal(await pageLooksLikeSearchResultForTesting(entry, options), false);
  assert.equal(await pageLooksLikeSearchResultForTesting(article, options), false);
  assert.equal(await pageLooksLikeSearchResultForTesting(result, options), true);

  const entryScore = await scoreSearchResultPageForTesting(entry, options, false, 0, 3);
  const articleScore = await scoreSearchResultPageForTesting(article, options, true, 1, 3);
  const resultScore = await scoreSearchResultPageForTesting(result, options, true, 2, 3);

  assert.ok(resultScore > entryScore + 4, { resultScore, entryScore });
  assert.ok(resultScore > articleScore + 4, { resultScore, articleScore });
});

test('detectPageObstructionsForTesting ignores normal content feeds that mention login', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 5000,
    viewportHeight: 900,
    elements: [
      {
        tag: 'main',
        text: '登录后可查看更多 这是正常信息流内容 大东北被一个足球联赛给粘起来了 A股摘帽进行时',
        attrs: { id: 'main-feed' },
        rect: { left: 0, top: 0, right: 1000, bottom: 1200 },
        style: { position: 'static', zIndex: 'auto' },
        children: [
          {
            tag: 'a',
            text: '大东北被一个足球联赛给粘起来了',
            attrs: { className: 'article-item-description' },
            rect: { left: 280, top: 80, right: 760, bottom: 120 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const detected = await detectPageObstructionsForTesting(page);

  assert.deepEqual(detected, []);
});

test('detectPageObstructionsForTesting keeps real fixed login modals', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 1200,
    viewportHeight: 900,
    bodyOverflow: 'hidden',
    topElementId: 'login-modal',
    elements: [
      {
        tag: 'div',
        text: '登录 手机号 验证码',
        attrs: { id: 'login-modal', className: 'login modal', role: 'dialog' },
        rect: { left: 300, top: 180, right: 900, bottom: 650 },
        style: { position: 'fixed', zIndex: '1000' },
        children: [
          {
            tag: 'button',
            text: '关闭',
            attrs: { className: 'close' },
            rect: { left: 840, top: 200, right: 880, bottom: 240 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const detected = await detectPageObstructionsForTesting(page);

  assert.equal(detected.length, 1);
  assert.equal(detected[0].type, 'login');
  assert.match(detected[0].closeText, /关闭/);
});

test('detectPageObstructionsForTesting ignores ordinary Baidu search home content', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 1400,
    viewportHeight: 900,
    topElementId: 'search-root',
    elements: [
      {
        tag: 'main',
        text: '新闻 hao123 地图 贴吧 视频 图片 网盘 文库 文心 设置 登录 百度一下 高考加油 复杂问题就找文心助手',
        attrs: { id: 'search-root', className: 'search-home' },
        rect: { left: 0, top: 0, right: 1200, bottom: 900 },
        style: { position: 'relative', zIndex: '20' },
        children: [
          {
            tag: 'form',
            text: '百度一下',
            attrs: { className: 'search-form' },
            rect: { left: 280, top: 240, right: 980, bottom: 340 },
            style: { position: 'static', zIndex: 'auto' },
            children: [
              {
                tag: 'input',
                text: '',
                attrs: { name: 'wd', type: 'text' },
                rect: { left: 300, top: 260, right: 780, bottom: 315 },
                style: { position: 'static', zIndex: 'auto' }
              },
              {
                tag: 'button',
                text: '百度一下',
                attrs: {},
                rect: { left: 800, top: 260, right: 960, bottom: 315 },
                style: { position: 'static', zIndex: 'auto' }
              }
            ]
          }
        ]
      }
    ]
  });

  const detected = await detectPageObstructionsForTesting(page);

  assert.deepEqual(detected, []);
});

test('auto recognize does not prompt for manual login intervention just because the terminal is interactive', () => {
  assert.equal(shouldPromptForLoginInterventionForTesting(recognizeOptionsForSearchScoring('https://www.baidu.com/', '李小龙')), false);
  assert.equal(shouldPromptForLoginInterventionForTesting({
    ...recognizeOptionsForSearchScoring('https://www.baidu.com/', '李小龙'),
    manual: true,
    interactive: true
  }), true);
});

test('dismissPageObstructionsForTesting closes ordinary login popup when requested', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 1200,
    viewportHeight: 900,
    bodyOverflow: 'hidden',
    topElementId: 'login-modal',
    elements: [
      {
        tag: 'div',
        text: '登录后推荐更懂你的笔记 手机号登录 输入验证码',
        attrs: { id: 'login-modal', className: 'login modal mask', role: 'dialog' },
        rect: { left: 320, top: 130, right: 980, bottom: 760 },
        style: { position: 'fixed', zIndex: '1000' },
        children: [
          {
            tag: 'button',
            text: '×',
            attrs: { className: 'close' },
            rect: { left: 930, top: 160, right: 960, bottom: 190 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const results = await dismissPageObstructionsForTesting(page, { includeLogin: true });

  assert.equal(results.length, 1, results);
  assert.equal(results[0].type, 'login');
  assert.equal(results[0].action, 'click');
  assert.match(results[0].xpath, /button/);
  assert.match(results[0].text, /×|登录后推荐/);
});

test('dismissPageObstructionsForTesting does not hide login popup when close click has no effect', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 1200,
    viewportHeight: 900,
    bodyOverflow: 'hidden',
    topElementId: 'login-modal',
    elements: [
      {
        tag: 'div',
        text: '登录后推荐更懂你的笔记 手机号登录 输入验证码',
        attrs: { id: 'login-modal', className: 'login modal mask', role: 'dialog', persistOnClose: true },
        rect: { left: 320, top: 130, right: 980, bottom: 760 },
        style: { position: 'fixed', zIndex: '1000' },
        children: [
          {
            tag: 'button',
            text: '×',
            attrs: { className: 'close' },
            rect: { left: 930, top: 160, right: 960, bottom: 190 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const results = await dismissPageObstructionsForTesting(page, { includeLogin: true });
  const detectedAfter = await detectPageObstructionsForTesting(page);

  assert.deepEqual(results, []);
  assert.equal(detectedAfter[0]?.type, 'login');
});

test('dismissPageObstructionsForTesting skips login popup unless explicitly requested', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 1200,
    viewportHeight: 900,
    bodyOverflow: 'hidden',
    topElementId: 'login-modal',
    elements: [
      {
        tag: 'div',
        text: '登录 手机号 验证码',
        attrs: { id: 'login-modal', className: 'login modal', role: 'dialog' },
        rect: { left: 300, top: 180, right: 900, bottom: 650 },
        style: { position: 'fixed', zIndex: '1000' },
        children: [
          {
            tag: 'button',
            text: '关闭',
            attrs: { className: 'close' },
            rect: { left: 840, top: 200, right: 880, bottom: 240 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const results = await dismissPageObstructionsForTesting(page);

  assert.deepEqual(results, []);
});

test('detectPageObstructionsForTesting does not hide unknown footer-like overlays without close controls', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 3000,
    viewportHeight: 900,
    topElementId: 'footer',
    elements: [
      {
        tag: 'div',
        text: '关于36氪 城市合作 寻求报道 我要入驻 投资者关系 商务合作 关于我们 联系我们 加入我们 违法和不良信息举报',
        attrs: { id: 'footer' },
        rect: { left: 0, top: 100, right: 1200, bottom: 900 },
        style: { position: 'relative', zIndex: '20' }
      }
    ]
  });

  const detected = await detectPageObstructionsForTesting(page);

  assert.deepEqual(detected, []);
});

test('refineCandidateFieldsForTesting names icon-only engagement metrics by icon semantics', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'News cards',
    confidence: 0.9,
    selector: '#feed',
    xpath: '/html/body/main/section',
    itemSelector: 'article.card',
    itemXPath: '/html/body/main/section/article',
    itemCount: 3,
    fields: [
      { name: 'title', kind: 'text', selector: 'h2', xpath: '/html/body/main/section/article/h2', relativeXPath: './h2', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const page = fakeRefinePage({
    itemXPath: candidate.itemXPath,
    rows: [
      newsMetricRow(0, ['234', '141', '644']),
      newsMetricRow(1, ['69', '398', '578']),
      newsMetricRow(2, ['84', '130', '83'])
    ]
  });

  const [refined] = await refineCandidateFieldsForTesting(page, [candidate]);
  const names = refined.fields.map((field) => field.name);

  assert.ok(names.includes('comments'));
  assert.ok(names.includes('favorites'));
  assert.ok(names.includes('shares'));
  assert.ok(!names.includes('likes'));
  assert.equal(refined.fields.find((field) => field.name === 'comments')?.relativeXPath, './span[3]/span[1]');
  assert.equal(refined.fields.find((field) => field.name === 'favorites')?.relativeXPath, './span[4]/span[1]');
  assert.equal(refined.fields.find((field) => field.name === 'shares')?.relativeXPath, './span[5]/span[1]');
});

test('buildTaskFromCandidate creates a local task JSON payload accepted by task provider shape', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_example',
    taskName: 'Recognized Example',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        },
        {
          name: 'url',
          kind: 'href',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['https://example.com/a']
        }
      ],
      sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
      reasons: ['test']
    }
  });

  assert.equal(task.taskId, 'recognized_example');
  assert.deepEqual(task.fieldNames, ['title', 'url']);
  assert.match(task.xml, /<ns0:NavigateAction/);
  assert.match(task.xml, /<ns0:LoopAction/);
  assert.match(task.xml, /LoopType="VarilableItemList"/);
  assert.match(task.xml, /<ns0:ExtractDataAction/);
  assert.match(task.xml, /&lt;Name&gt;title&lt;\/Name&gt;/);
  assert.match(task.xml, /&lt;ExtractType&gt;ExtractText&lt;\/ExtractType&gt;/);
  assert.match(task.xml, /&lt;Name&gt;url&lt;\/Name&gt;/);
  assert.match(task.xml, /ExtractHref/);
  assert.match(task.xml, /&lt;RelativeXpath&gt;\/a\[1\]&lt;\/RelativeXpath&gt;/);
  assert.doesNotMatch(task.xml, /&lt;RelativeXpath&gt;\.\/a\[1\]&lt;\/RelativeXpath&gt;/);
});

test('buildTaskFromCandidate preserves search input and submit actions before extraction', () => {
  const task = buildTaskFromCandidate({
    url: 'https://www.baidu.com/s?wd=%E6%9D%8E%E5%B0%8F%E9%BE%99',
    taskId: 'recognized_baidu_search',
    taskName: 'Recognized Baidu Search',
    searchPlan: {
      startUrl: 'https://www.baidu.com/',
      finalUrl: 'https://www.baidu.com/s?wd=%E6%9D%8E%E5%B0%8F%E9%BE%99',
      inputs: [{ name: 'wd', value: '李小龙', xpath: '/html[1]/body[1]/div[1]/form[1]/span[1]/input[1]' }],
      submit: { mode: 'click', xpath: '/html[1]/body[1]/div[1]/form[1]/span[2]/input[1]', text: '百度一下' }
    },
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.result:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 10,
      fields: [
        { name: 'title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['李小龙'] },
        { name: 'url', kind: 'href', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['https://example.com/bruce-lee'] }
      ],
      sampleRows: [{ title: '李小龙', url: 'https://example.com/bruce-lee' }],
      reasons: ['test']
    }
  });

  assert.equal(task.recognition.url, 'https://www.baidu.com/s?wd=%E6%9D%8E%E5%B0%8F%E9%BE%99');
  assert.equal(task.recognition.search?.startUrl, 'https://www.baidu.com/');
  assert.equal(task.recognition.search?.inputs[0]?.xpath, '/html[1]/body[1]/div[1]/form[1]/span[1]/input[1]');
  assert.match(task.xml, /URL="https:\/\/www\.baidu\.com\/"/);
  assert.match(task.xml, /<ns0:EnterTextAction/);
  assert.match(task.xml, /TextToSet="李小龙"/);
  assert.match(task.xml, /AutoSubmit="false"/);
  assert.match(task.xml, /<ns0:ClickAction[^>]*x:Name="ClickSearchSubmit"/);
  assert.match(task.xml, /Click search submit \(百度一下\)/);
  assert.doesNotMatch(task.xml, /ClickSearchSubmit"[^>]*ScrollTime="100"/);
  assert.match(task.xml, /<ns0:NavigateAction[^>]*x:Name="NavigateSearchResults"/);
  assert.match(task.xml, /Caption="Open confirmed search results"/);
  assert.ok(task.xml.indexOf('<ns0:EnterTextAction') < task.xml.indexOf('<ns0:ExtractDataAction'));
  assert.ok(task.xml.indexOf('x:Name="ClickSearchSubmit"') < task.xml.indexOf('x:Name="NavigateSearchResults"'));
  assert.ok(task.xml.indexOf('x:Name="NavigateSearchResults"') < task.xml.indexOf('<ns0:ExtractDataAction'));
});

test('buildTaskFromCandidate can submit search by enter when no button was found', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/search?q=lee',
    taskId: 'recognized_enter_search',
    taskName: 'Recognized Enter Search',
    searchPlan: {
      startUrl: 'https://example.com/',
      finalUrl: 'https://example.com/search?q=lee',
      inputs: [{ name: 'q', value: 'lee', xpath: '/html[1]/body[1]/input[1]' }],
      submit: { mode: 'enter' }
    },
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.result:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [{ name: 'title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['Lee'] }],
      sampleRows: [{ title: 'Lee' }],
      reasons: ['test']
    }
  });

  assert.match(task.xml, /<ns0:EnterTextAction/);
  assert.match(task.xml, /AutoSubmit="true"/);
  assert.match(task.xml, /x:Name="NavigateSearchResults"/);
  assert.doesNotMatch(task.xml, /ClickSearchSubmit/);
});

test('buildTaskFromCandidate does not insert search result navigation when URL did not change', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/search',
    taskId: 'recognized_same_url_search',
    taskName: 'Recognized Same URL Search',
    searchPlan: {
      startUrl: 'https://example.com/search',
      finalUrl: 'https://example.com/search',
      inputs: [{ name: 'q', value: 'lee', xpath: '/html[1]/body[1]/input[1]' }],
      submit: { mode: 'click', xpath: '/html[1]/body[1]/button[1]' }
    },
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.result:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [{ name: 'title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['Lee'] }],
      sampleRows: [{ title: 'Lee' }],
      reasons: ['test']
    }
  });

  assert.match(task.xml, /x:Name="ClickSearchSubmit"/);
  assert.doesNotMatch(task.xml, /x:Name="NavigateSearchResults"/);
});

test('buildTaskFromCandidate inserts safe popup dismissal clicks after navigation', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_popup',
    taskName: 'Recognized Popup',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ title: 'Alpha' }],
      reasons: ['test']
    },
    popupDismissals: [
      {
        type: 'login',
        action: 'click',
        xpath: '/html[1]/body[1]/div[2]/button[1]',
        text: '×',
        confidence: 0.9,
        removed: true,
        reasons: ['test popup']
      },
      {
        type: 'captcha',
        action: 'click',
        xpath: '/html[1]/body[1]/div[3]/button[1]',
        text: 'close',
        confidence: 0.9,
        removed: true,
        reasons: ['unsafe popup']
      }
    ]
  });

  assert.match(task.xml, /x:Name="DismissPopup1"/);
  assert.match(task.xml, /Caption="Dismiss login popup"/);
  assert.match(task.xml, /ElementXPath="&lt;ActionItem&gt;&lt;AbsXpath&gt;\/html\[1\]\/body\[1\]\/div\[2\]\/button\[1\]/);
  assert.doesNotMatch(task.xml, /Dismiss captcha popup/);
  assert.equal(task.recognition.popupDismissals.length, 2);
});

test('buildTaskFromCandidate stores only a browser session reference', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_session',
    taskName: 'Recognized Session',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ title: 'Alpha' }],
      reasons: ['test']
    },
    session: {
      name: 'example.com',
      origin: 'https://example.com',
      savedAt: '2026-05-27T00:00:00.000Z',
      cookieCount: 2,
      kind: 'cookie',
      compatibility: 'cookies-only'
    }
  });

  assert.deepEqual(task.recognition.session, {
    name: 'example.com',
    origin: 'https://example.com',
    savedAt: '2026-05-27T00:00:00.000Z',
    cookieCount: 2,
    kind: 'cookie',
    compatibility: 'cookies-only'
  });
  assert.doesNotMatch(JSON.stringify(task), /sessionid=secret/);
});

test('buildAgentContextForTesting exposes deterministic candidates for external agents', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    agentScreenshot: { path: '/tmp/example.full.png', fullPage: true },
    candidates: [
      {
        id: 'search_results_1',
        type: 'search_results',
        title: 'Search/list results',
        confidence: 0.8,
        selector: 'main',
        xpath: '/html[1]/body[1]/main[1]',
        itemSelector: 'main > div.card:nth-of-type(1)',
        itemXPath: '/html[1]/body[1]/main[1]/div',
        itemCount: 3,
        fields: [
          {
            name: 'title',
            kind: 'text',
            selector: 'a',
            xpath: '/html[1]/body[1]/main[1]/div//a[1]',
            relativeXPath: './a[1]',
            samples: ['Alpha']
          },
          {
            name: 'url',
            kind: 'href',
            selector: 'a',
            xpath: '/html[1]/body[1]/main[1]/div//a[1]',
            relativeXPath: './a[1]',
            samples: ['https://example.com/a']
          }
        ],
        sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
        reasons: ['test']
      }
    ]
  }, '采新闻列表');

  assert.equal(context.schemaVersion, 'octopus.recognize.agent-context.v1');
  assert.equal(context.goal, '采新闻列表');
  assert.equal(context.recommendedCandidateId, 'search_results_1');
  assert.equal(context.screenshot.path, '/tmp/example.full.png');
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.goal'));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.screenshot.path'));
  assert.match(context.decisionPolicy.rankingRule, /full-page screenshot/);
  assert.match(context.decisionPolicy.recommendedCandidateRule, /not a final answer/);
  assert.match(context.decisionPolicy.paginationRule, /explicit pagination evidence/);
  assert.match(context.resultValidationPolicy.normalPartialDataRule, /heterogeneous records/);
  assert.equal(context.resultValidationPolicy.maxAutomaticRecreateAttempts, 1);
  assert.match(context.resultValidationPolicy.doNotRecreateTaskWhen.join(' '), /small minority/);
  assert.match(context.resultValidationPolicy.recreateTaskOnlyWhen.join(' '), /systematic selector issue|wrong region/);
  assert.match(context.instruction, /diagnostics\.matchCount/);
  assert.equal(context.candidates[0].fields[0].xpath, '/html[1]/body[1]/main[1]/div//a[1]');
});

test('previewAgentPlanForTesting reports risky detail content choices for external agents', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    candidates: [
      {
        id: 'search_results_1',
        type: 'search_results',
        title: 'Search/list results',
        confidence: 0.8,
        selector: 'main',
        xpath: '/html/body/main',
        itemSelector: 'article',
        itemXPath: '/html/body/main/article',
        itemCount: 10,
        fields: [
          { name: 'title', kind: 'text', selector: 'a', xpath: '/html/body/main/article/a', relativeXPath: './a', samples: ['Alpha'] },
          { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
        ],
        sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
        detailPlan: {
          mode: 'list_with_detail',
          urlField: 'url',
          sampleUrls: ['https://example.com/a'],
          fields: [
            {
              name: 'detail_content',
              kind: 'text',
              selector: 'p',
              xpath: '/html/body/article/p',
              samples: ['Short body'],
              diagnostics: {
                matchCount: 3,
                textLength: 90,
                paragraphCount: 3,
                hasStyleNoise: false,
                sampleText: 'Short body',
                warnings: ['content text looks short', 'xpath matched 3 elements; runtime may use the first element unless XPath targets a container']
              }
            }
          ],
          sampleRows: [{ detail_content: 'Short body' }],
          templateCount: 1,
          status: 'planned',
          reasons: ['test detail']
        },
        reasons: ['test']
      }
    ]
  });
  const preview = previewAgentPlanForTesting({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: ['title', 'url'],
        detail: {
          mode: 'list_with_detail',
          urlField: 'url',
          fields: [{ source: 'detail_content', as: 'body' }]
        }
      }
    }
  });

  assert.equal(preview.schemaVersion, 'octopus.recognize.agent-preview.v1');
  assert.equal(preview.pass, false);
  assert.equal(preview.detail.fields[0].name, 'body');
  assert.match(preview.warnings.join('\n'), /content text looks short/);
  assert.match(preview.recommendedFixes.join('\n'), /parent container/);
});

test('buildTaskFromAgentPlan applies external agent field choices and detail plan', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    candidates: [
      {
        id: 'search_results_1',
        type: 'search_results',
        title: 'Search/list results',
        confidence: 0.8,
        selector: 'main',
        xpath: '/html[1]/body[1]/main[1]',
        itemSelector: 'main > div.card:nth-of-type(1)',
        itemXPath: '/html[1]/body[1]/main[1]/div',
        itemCount: 3,
        fields: [
          {
            name: 'title',
            kind: 'text',
            selector: 'a',
            xpath: '/html[1]/body[1]/main[1]/div//a[1]',
            relativeXPath: './a[1]',
            samples: ['Alpha']
          },
          {
            name: 'url',
            kind: 'href',
            selector: 'a',
            xpath: '/html[1]/body[1]/main[1]/div//a[1]',
            relativeXPath: './a[1]',
            samples: ['https://example.com/a']
          },
          {
            name: 'summary',
            kind: 'text',
            selector: 'p',
            xpath: '/html[1]/body[1]/main[1]/div//p[1]',
            relativeXPath: './p[1]',
            samples: ['Summary']
          }
        ],
        sampleRows: [{ title: 'Alpha', url: 'https://example.com/a', summary: 'Summary' }],
        detailPlan: {
          mode: 'list_with_detail',
          urlField: 'url',
          sampleUrls: ['https://example.com/a'],
          fields: [
            {
              name: 'detail_content',
              kind: 'text',
              selector: 'article',
              xpath: '/html[1]/body[1]/article[1]',
              samples: ['Body']
            }
          ],
          sampleRows: [{ detail_content: 'Body' }],
          templateCount: 1,
          status: 'planned',
          reasons: ['test detail plan']
        },
        reasons: ['test']
      }
    ]
  });
  const task = buildTaskFromAgentPlan({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: [
          { source: 'title', as: 'headline' },
          'url'
        ],
        detail: {
          mode: 'list_with_detail',
          urlField: 'url',
          fields: [
            { source: 'detail_content', as: 'body' }
          ]
        }
      }
    },
    taskId: 'recognized_agent',
    taskName: 'Recognized Agent'
  });

  assert.deepEqual(task.fieldNames, ['headline', 'url', 'body']);
  assert.equal(task.recognition.candidateId, 'search_results_1');
  assert.equal(task.recognition.detailPlan.mode, 'list_with_detail');
  assert.deepEqual(task.recognition.detailPlan.fields.map((field) => field.name), ['body']);
  assert.match(task.xml, /Name&gt;headline/);
  assert.match(task.xml, /Name&gt;body/);
  assert.match(task.xml, /x:Name="ClickDetail"/);
  assert.doesNotMatch(task.xml, /Name&gt;summary/);
});

test('runInlineAgentRecognizeForTesting lets an external command generate and apply a plan', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'recognizer-inline-agent-'));
  const agentScript = join(dir, 'agent.mjs');
  const taskFile = join(dir, 'task.json');
  const seenWorkDirFile = join(dir, 'seen-workdir.txt');
  await writeFile(agentScript, `
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const context = JSON.parse(await readFile(process.env.OCTOPARSE_AGENT_CONTEXT, 'utf8'));
await writeFile(${JSON.stringify(seenWorkDirFile)}, dirname(process.env.OCTOPARSE_AGENT_CONTEXT));
const plan = {
  schemaVersion: 'octopus.recognize.agent-plan.v1',
  selection: {
    candidateId: context.recommendedCandidateId,
    fields: [
      { source: 'title', as: 'headline' },
      { source: 'url', as: 'url' }
    ],
    pagination: null
  }
};
await writeFile(process.env.OCTOPARSE_AGENT_PLAN, JSON.stringify(plan, null, 2));
`);

  try {
    chdir(dir);
    const code = await runInlineAgentRecognizeForTesting({
      args: ['--agent-command', `${process.execPath} ${agentScript}`, '--yes', '--output', taskFile],
      quiet: true,
      result: {
        url: 'https://example.com/list',
        finalUrl: 'https://example.com/list',
        title: 'Example',
        capturedAt: '2026-05-28T00:00:00.000Z',
        candidates: [
          {
            id: 'search_results_1',
            type: 'search_results',
            title: 'Search/list results',
            confidence: 0.8,
            selector: 'main',
            xpath: '/html[1]/body[1]/main[1]',
            itemSelector: 'main > div.card:nth-of-type(1)',
            itemXPath: '/html[1]/body[1]/main[1]/div',
            itemCount: 3,
            fields: [
              { name: 'title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['Alpha'] },
              { name: 'url', kind: 'href', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['https://example.com/a'] },
              { name: 'summary', kind: 'text', selector: 'p', xpath: '/html[1]/body[1]/main[1]/div//p[1]', relativeXPath: './p[1]', samples: ['Summary'] }
            ],
            sampleRows: [{ title: 'Alpha', url: 'https://example.com/a', summary: 'Summary' }],
            reasons: ['test']
          }
        ]
      }
    });
    assert.equal(code, 0);
    const task = JSON.parse(await readFile(taskFile, 'utf8'));
    assert.deepEqual(task.fieldNames, ['headline', 'url']);
    assert.equal(task.recognition.candidateId, 'search_results_1');
    assert.equal(task.recognition.selectionSource, undefined);
    assert.doesNotMatch(task.xml, /Name&gt;summary/);
    const seenWorkDir = await readFile(seenWorkDirFile, 'utf8');
    await assert.rejects(access(seenWorkDir), { code: 'ENOENT' });
  } finally {
    chdir(previousCwd);
  }
});

test('buildTaskFromCandidate stores recognized detail plan metadata', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_detail_plan',
    taskName: 'Recognized Detail Plan',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        },
        {
          name: 'url',
          kind: 'href',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['https://example.com/a']
        }
      ],
      sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
      detailPlan: {
        mode: 'list_with_detail',
        urlField: 'url',
        sampleUrls: ['https://example.com/a'],
        fields: [
          {
            name: 'detail_content',
            kind: 'text',
            selector: 'article p',
            xpath: '/html[1]/body[1]/article[1]//p',
            relativeXPath: '/html[1]/body[1]/article[1]//p',
            samples: ['Body']
          }
        ],
        sampleRows: [{ detail_content: 'Body' }],
        templateCount: 1,
        status: 'planned',
        reasons: ['test detail plan']
      },
      reasons: ['test']
    }
  });

  assert.equal(task.recognition.detailPlan.mode, 'list_with_detail');
  assert.deepEqual(task.recognition.detailPlan.sampleUrls, ['https://example.com/a']);
  assert.deepEqual(task.recognition.detailPlan.fields.map((field) => field.name), ['detail_content']);
  assert.equal(task.recognition.detailPlan.status, 'planned');
  assert.deepEqual(task.fieldNames, ['title', 'url', 'detail_content']);
  assert.match(task.xml, /x:Name="ExtractItems"/);
  assert.match(task.xml, /Caption="Extract recognized list data"/);
  assert.match(task.xml, /x:Name="ClickDetail"/);
  assert.match(task.xml, /Caption="Click detail link"/);
  assert.match(task.xml, /OpenInNewWindow="true"/);
  assert.match(task.xml, /OpenByHref="false"/);
  assert.match(task.xml, /PageIndex="0"[^>]*ElementXPath="&lt;ActionItem&gt;&lt;AbsXpath&gt;\/a\[1\]/);
  assert.match(task.xml, /x:Name="ExtractDetail"/);
  assert.match(task.xml, /Caption="Extract recognized detail data"/);
  assert.match(task.xml, /PageIndex="1"/);
  assert.match(task.xml, /detail_content/);
  assert.match(task.xml, /Name&gt;detail_content/);
  assert.match(task.xml, /UseRelativeXPath&gt;false/);
  assert.match(task.xml, /MatchAll&gt;true/);
  assert.match(task.xml, /IsAppend&gt;true/);
});

test('buildTaskFromCandidate creates direct extraction XML for detail pages', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/article',
    taskId: 'recognized_detail',
    taskName: 'Recognized Detail',
    candidate: {
      id: 'detail_1',
      type: 'detail',
      title: 'Detail',
      confidence: 0.7,
      selector: 'article',
      xpath: '/html[1]/body[1]/article[1]',
      itemSelector: 'article',
      itemXPath: '/html[1]/body[1]/article[1]',
      itemCount: 1,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'h1',
          xpath: '/html[1]/body[1]/article[1]/h1[1]',
          samples: ['Demo']
        },
        {
          name: 'content',
          kind: 'text',
          selector: 'article p',
          xpath: '/html[1]/body[1]/article[1]//p',
          samples: ['Body']
        }
      ],
      sampleRows: [{ title: 'Demo', content: 'Body' }],
      reasons: ['test']
    }
  });

  assert.doesNotMatch(task.xml, /<ns0:LoopAction/);
  assert.match(task.xml, /UseLoopItem="false"/);
  assert.match(task.xml, /UseRelativeXPath&gt;false/);
});

test('buildTaskFromCandidate creates detail-only list navigation XML', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_detail_only',
    taskName: 'Recognized Detail Only',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        },
        {
          name: 'url',
          kind: 'href',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['https://example.com/a']
        }
      ],
      sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
      detailPlan: {
        mode: 'detail_only',
        urlField: 'url',
        sampleUrls: ['https://example.com/a'],
        fields: [
          {
            name: 'detail_content',
            kind: 'text',
            selector: 'article p',
            xpath: '/html[1]/body[1]/article[1]//p',
            samples: ['Body']
          }
        ],
        sampleRows: [{ detail_content: 'Body' }],
        templateCount: 1,
        status: 'planned',
        reasons: ['test detail plan']
      },
      reasons: ['test']
    }
  });

  assert.deepEqual(task.fieldNames, ['url', 'detail_content']);
  assert.doesNotMatch(task.xml, /x:Name="ExtractItems"/);
  assert.match(task.xml, /x:Name="ClickDetail"/);
  assert.match(task.xml, /PageIndex="0"[^>]*OpenInNewWindow="true"/);
  assert.match(task.xml, /x:Name="ExtractDetail"/);
  assert.match(task.xml, /PageIndex="1"/);
  assert.match(task.xml, /Name&gt;detail_content/);
});

test('buildTaskFromCandidate wraps list extraction with next-page click loop', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_pages',
    taskName: 'Recognized Pages',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > div.card:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/div',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/div//a[1]',
          relativeXPath: './a[1]',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ title: 'Alpha' }],
      reasons: ['test'],
      pagination: {
        type: 'next_page',
        xpath: '/html[1]/body[1]/nav[1]/a[2]',
        text: 'Next',
        confidence: 0.86,
        isAjax: false,
        scope: 'near_list',
        reasons: ['test pager']
      }
    }
  });

  assert.equal(task.recognition.paginationType, 'next_page');
  assert.match(task.xml, /x:Name="LoopPages"/);
  assert.match(task.xml, /LoopType="FixedItem"/);
  assert.match(task.xml, /FixedItem="&lt;ActionItem&gt;&lt;AbsXpath&gt;\/html\[1\]\/body\[1\]\/nav\[1\]\/a\[2\]/);
  assert.match(task.xml, /x:Name="LoopItems"/);
  assert.match(task.xml, /LoopType="VarilableItemList"/);
  assert.match(task.xml, /<ns0:ClickAction/);
  assert.match(task.xml, /UseLoopItem="true"/);
  assert.match(task.xml, /<ns0:ClickAction[^>]*ElementXPath=""/);
  assert.doesNotMatch(task.xml, /Caption="Click next page"[^>]*ElementXPath="&lt;ActionItem&gt;&lt;AbsXpath&gt;\/html\[1\]\/body\[1\]\/nav\[1\]\/a\[2\]/);
  assert.match(task.xml, /AjaxLoad="false"/);
  assert.match(task.xml, /ExecutedTimesLimitation="50"/);
});

test('buildTaskFromCandidate uses ajax load-more pagination loop', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'recognized_more',
    taskName: 'Recognized More',
    candidate: {
      id: 'repeated_card_1',
      type: 'repeated_card',
      title: 'Cards',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > article:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/article',
      itemCount: 4,
      fields: [
        {
          name: 'text',
          kind: 'text',
          selector: 'article',
          xpath: '/html[1]/body[1]/main[1]/article',
          relativeXPath: '.',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ text: 'Alpha' }],
      reasons: ['test'],
      pagination: {
        type: 'load_more',
        xpath: '/html[1]/body[1]/button[1]',
        text: 'Load more',
        confidence: 0.9,
        isAjax: true,
        scope: 'near_list',
        reasons: ['test more']
      }
    }
  });

  assert.equal(task.recognition.paginationType, 'load_more');
  assert.match(task.xml, /Caption="Loop load more button"/);
  assert.match(task.xml, /Click load more/);
  assert.match(task.xml, /没有更多/);
  assert.match(task.xml, /AjaxLoad="true"/);
  assert.match(task.xml, /ScrollDown="true"/);
  assert.match(task.xml, /ExecutedTimesLimitation="100"/);
});

test('buildTaskFromCandidate uses scroll-revealed load-more pagination loop', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/search',
    taskId: 'recognized_mixed_more',
    taskName: 'Recognized Mixed More',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Search results',
      confidence: 0.84,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > article:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/article',
      itemCount: 76,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'article',
          xpath: '/html[1]/body[1]/main[1]/article',
          relativeXPath: '.',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ title: 'Alpha' }],
      reasons: ['test'],
      pagination: {
        type: 'load_more',
        xpath: '/html[1]/body[1]/div[1]',
        text: 'Load more',
        confidence: 0.9,
        isAjax: true,
        scope: 'near_list',
        revealByScroll: true,
        reasons: ['load-more may be revealed after scrolling']
      }
    }
  });

  assert.equal(task.recognition.paginationType, 'load_more');
  assert.match(task.xml, /Caption="Loop scroll then load more"/);
  assert.match(task.xml, /x:Name="ScrollPage"/);
  assert.match(task.xml, /x:Name="TryLoadMore"/);
  assert.match(task.xml, /Caption="Click load more if visible"/);
  assert.match(task.xml, /ExecutedTimesLimitation="80"/);
  assert.match(task.xml, /ExecutedTimesLimitation="1"/);
  assert.equal(task.workflowSetting.repeatPageLoopCount, 12);
  assert.equal(task.workflowSetting.continuousJudgeCount, 3);
  assert.doesNotMatch(task.xml, /Caption="Loop load more button"/);
});

test('buildTaskFromCandidate uses scroll pagination without a load-more click', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/waterfall',
    taskId: 'recognized_scroll',
    taskName: 'Recognized Scroll',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Waterfall cards',
      confidence: 0.8,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'main > section:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/section',
      itemCount: 8,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'section',
          xpath: '/html[1]/body[1]/main[1]/section',
          relativeXPath: '.',
          samples: ['Alpha']
        }
      ],
      sampleRows: [{ title: 'Alpha' }],
      reasons: ['test'],
      pagination: {
        type: 'scroll',
        xpath: '',
        text: 'Scroll page',
        confidence: 0.42,
        isAjax: true,
        scope: 'global',
        reasons: ['long document without visible pager']
      }
    }
  });

  assert.equal(task.recognition.paginationType, 'scroll');
  assert.match(task.xml, /Caption="Loop scroll page"/);
  assert.match(task.xml, /LoopType="FixedItem"/);
  assert.match(task.xml, /x:Name="ScrollPage"/);
  assert.match(task.xml, /Caption="Scroll page"/);
  assert.match(task.xml, /ExecutedTimesLimitation="80"/);
  assert.match(task.xml, /ScrollTime="1"/);
  assert.match(task.xml, /IfStopScroll="true"/);
  assert.match(task.xml, /x:Name="TryGenericLoadMore"/);
  assert.match(task.xml, /Caption="Click generic load more if visible"/);
  assert.equal(task.workflowSetting.repeatPageLoopCount, 12);
  assert.equal(task.workflowSetting.continuousJudgeCount, 3);
  assert.doesNotMatch(task.xml, /ExecutedTimesLimitation="300"/);
  assert.doesNotMatch(task.xml, /ExecutedTimesLimitation="20"/);
  assert.doesNotMatch(task.xml, /LoopType="ScrollWeb"/);
  assert.doesNotMatch(task.xml, /Click load more/);
  assert.doesNotMatch(task.xml, /x:Name="ClickPage"/);
});

test('buildTaskFromCandidate keeps social card fields as extractable columns', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/waterfall',
    taskId: 'recognized_social_cards',
    taskName: 'Recognized Social Cards',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'Social cards',
      confidence: 0.86,
      selector: '#feeds',
      xpath: '/html[1]/body[1]/main[1]/section[1]',
      itemSelector: '#feeds > article:nth-of-type(1)',
      itemXPath: '/html[1]/body[1]/main[1]/section[1]/article',
      itemCount: 6,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'h3',
          xpath: '/html[1]/body[1]/main[1]/section[1]/article//h3[1]',
          relativeXPath: './/h3[1]',
          samples: ['春日穿搭记录']
        },
        {
          name: 'url',
          kind: 'href',
          selector: 'a',
          xpath: '/html[1]/body[1]/main[1]/section[1]/article//a[1]',
          relativeXPath: './/a[1]',
          samples: ['https://example.com/note/1']
        },
        {
          name: 'image',
          kind: 'src',
          selector: 'img',
          xpath: '/html[1]/body[1]/main[1]/section[1]/article//img[1]',
          relativeXPath: './/img[1]',
          samples: ['https://example.com/image/1.jpg']
        },
        {
          name: 'author',
          kind: 'text',
          selector: 'span',
          xpath: '/html[1]/body[1]/main[1]/section[1]/article//span[1]',
          relativeXPath: './/span[1]',
          operations: [
            { type: 'regex_replace', params: ['\\s*(?:[♡♥❤👍]\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?(?:万|千|亿|w|k|m)\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?))\\s*$', ''] },
            { type: 'trim', params: ['0'] }
          ],
          samples: ['小八 1.2万赞']
        },
        {
          name: 'likes',
          kind: 'text',
          selector: 'span',
          xpath: '/html[1]/body[1]/main[1]/section[1]/article//span[2]',
          relativeXPath: './/span[2]',
          samples: ['2.9万']
        }
      ],
      sampleRows: [{ title: '春日穿搭记录', url: 'https://example.com/note/1', image: 'https://example.com/image/1.jpg', author: '小八 1.2万赞', likes: '2.9万' }],
      reasons: ['test']
    }
  });

  assert.deepEqual(task.fieldNames, ['title', 'url', 'image', 'author', 'likes']);
  assert.match(task.xml, /&lt;Name&gt;image&lt;\/Name&gt;/);
  assert.match(task.xml, /&lt;ExtractType&gt;ExtractSrc&lt;\/ExtractType&gt;/);
  assert.match(task.xml, /&lt;Name&gt;author&lt;\/Name&gt;/);
  assert.match(task.xml, /RegReplace/);
  assert.match(task.xml, /&lt;Name&gt;likes&lt;\/Name&gt;/);
});

test('buildTaskFromCandidate preserves date regex extraction fields', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/news',
    taskId: 'recognized_dates',
    taskName: 'Recognized Dates',
    candidate: {
      id: 'search_results_1',
      type: 'search_results',
      title: 'News cards',
      confidence: 0.82,
      selector: 'main',
      xpath: '/html[1]/body[1]/main[1]',
      itemSelector: 'article',
      itemXPath: '/html[1]/body[1]/main[1]/article',
      itemCount: 3,
      fields: [
        {
          name: 'title',
          kind: 'text',
          selector: 'h2',
          xpath: '/html[1]/body[1]/main[1]/article//h2[1]',
          relativeXPath: './/h2[1]',
          samples: ['Launch notes']
        },
        {
          name: 'date',
          kind: 'text',
          selector: 'span',
          xpath: '/html[1]/body[1]/main[1]/article//span[1]',
          relativeXPath: './/span[1]',
          operations: [
            { type: 'regex_match', params: ['(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s*(?:分钟前|小时前|天前|days? ago)'] }
          ],
          samples: ['Updated May 27, 2026']
        }
      ],
      sampleRows: [{ title: 'Launch notes', date: 'May 27, 2026' }],
      reasons: ['test']
    }
  });

  assert.deepEqual(task.fieldNames, ['title', 'date']);
  assert.match(task.xml, /&lt;Name&gt;date&lt;\/Name&gt;/);
  assert.match(task.xml, /RegMatch/);
  assert.match(task.xml, /May/);
  assert.match(task.xml, /days\? ago/);
});

function fakePaginationPage({ bodyHeight, viewportHeight, itemXPath, rows, external = [], scrollY = 0 }) {
  return {
    async evaluate(fn, input) {
      const previousWindow = globalThis.window;
      const previousDocument = globalThis.document;
      const previousDOMRect = globalThis.DOMRect;
      const previousNode = globalThis.Node;
      const previousElement = globalThis.Element;
      const previousHTMLElement = globalThis.HTMLElement;
      const previousHTMLInputElement = globalThis.HTMLInputElement;
      const previousXPathResult = globalThis.XPathResult;
      let currentScrollY = scrollY;
      class Rect {
        constructor(left, top, width, height) {
          this.left = left;
          this.top = top;
          this.width = width;
          this.height = height;
          this.right = left + width;
          this.bottom = top + height;
        }
      }
      class FakeElement {
        constructor({ tag = 'div', text = '', attrs = {}, rect, children = [], parent = null }) {
          this.localName = tag;
          this.tagName = tag.toUpperCase();
          this.nodeName = this.tagName;
          this.textContent = text;
          this.children = [];
          this.parentElement = parent;
          this.nodeType = 1;
          this.style = {};
          this.id = attrs.id || '';
          this.className = attrs.className || '';
          this.attrs = attrs;
          this.rect = rect;
          for (const child of children) this.append(new FakeElement({ ...child, parent: this }));
        }
        append(child) {
          child.parentElement = this;
          this.children.push(child);
          return child;
        }
        getAttribute(name) {
          if (name === 'class') return this.className;
          if (name === 'aria-current') return this.attrs.ariaCurrent || '';
          return this.attrs[name] || '';
        }
        getAttributeNames() {
          return Object.keys(this.attrs).map((name) => name === 'className' ? 'class' : name);
        }
        getBoundingClientRect() {
          const { left, top, right, bottom } = this.rect;
          return new Rect(left, top - currentScrollY, right - left, bottom - top);
        }
        contains(element) {
          return this === element || this.children.some((child) => child.contains(element));
        }
        closest(selector) {
          let current = this;
          while (current) {
            if (selector.includes('pagination') && /pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page/i.test(current.className || '')) return current;
            if (selector.includes('nav') && current.localName === 'nav') return current;
            if (selector.includes('header') && current.localName === 'header') return current;
            if (selector.includes('footer') && current.localName === 'footer') return current;
            current = current.parentElement;
          }
          return null;
        }
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null;
        }
        querySelectorAll() {
          return flatten(this.children);
        }
      }
      const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.children)]);
      const rowElements = rows.map((row) => new FakeElement({ tag: 'article', ...row }));
      const externalElements = external.map((item) => new FakeElement({ tag: item.tag || 'a', ...item }));
      const body = new FakeElement({
        tag: 'body',
        text: '',
        attrs: {},
        rect: { left: 0, top: 0, right: 1200, bottom: bodyHeight },
        children: []
      });
      const section = body.append(new FakeElement({
        tag: 'section',
        text: '',
        attrs: { id: 'feed' },
        rect: { left: 60, top: 80, right: 980, bottom: Math.max(...rowElements.map((row) => row.rect.bottom), 100) },
        children: [],
        parent: body
      }));
      for (const row of rowElements) section.append(row);
      for (const item of externalElements.filter((item) => item.localName !== 'a' && item.localName !== 'button' || !/page|pager|pagination/i.test(item.className || ''))) {
        body.append(item);
      }
      const pager = body.append(new FakeElement({
        tag: 'nav',
        text: '',
        attrs: { className: 'pagination' },
        rect: { left: 280, top: bodyHeight - 520, right: 520, bottom: bodyHeight - 480 },
        children: [],
        parent: body
      }));
      for (const item of externalElements.filter((item) => item.parentElement !== body)) pager.append(item);
      const all = () => flatten([body]);
      const xpathFor = (element) => {
        const parts = [];
        let current = element;
        while (current) {
          const parent = current.parentElement;
          const same = parent ? parent.children.filter((item) => item.tagName === current.tagName) : [];
          parts.unshift(`${current.localName}[${same.indexOf(current) + 1 || 1}]`);
          current = parent;
        }
        return `/${parts.join('/')}`;
      };
      const document = {
        body,
        documentElement: { scrollHeight: bodyHeight, clientHeight: viewportHeight, scrollTop: currentScrollY, scrollLeft: 0 },
        querySelectorAll() {
          return all().filter((item) => item !== body && item.localName !== 'section');
        },
        evaluate(path) {
          const snapshot = path === itemXPath
            ? rowElements
            : path.includes('pagination') || path.includes('pager') || path.includes('//a')
              ? externalElements
              : externalElements.filter((item) => xpathFor(item) === path);
          return {
            snapshotLength: snapshot.length,
            snapshotItem(index) {
              return snapshot[index] || null;
            }
          };
        }
      };
      const window = {
        innerHeight: viewportHeight,
        innerWidth: 1200,
        scrollX: 0,
        get scrollY() {
          return currentScrollY;
        },
        scrollTo(_x, y) {
          currentScrollY = Number(y) || 0;
        },
        getComputedStyle() {
          return { display: 'block', visibility: 'visible', opacity: '1' };
        }
      };
      globalThis.window = window;
      globalThis.document = document;
      globalThis.DOMRect = Rect;
      globalThis.Node = { ELEMENT_NODE: 1 };
      globalThis.Element = FakeElement;
      globalThis.HTMLElement = FakeElement;
      globalThis.HTMLInputElement = class extends FakeElement {};
      globalThis.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7 };
      try {
        return fn(input);
      } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.DOMRect = previousDOMRect;
        globalThis.Node = previousNode;
        globalThis.Element = previousElement;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.HTMLInputElement = previousHTMLInputElement;
        globalThis.XPathResult = previousXPathResult;
      }
    }
  };
}

function newsMetricRow(index, metrics) {
  const top = 100 + index * 320;
  return {
    tag: 'article',
    text: '',
    attrs: { className: 'card' },
    rect: { left: 60, top, right: 660, bottom: top + 260 },
    children: [
      {
        tag: 'a',
        text: `新闻标题 ${index + 1}`,
        attrs: { href: `https://example.com/a${index + 1}`, className: 'title' },
        rect: { left: 80, top: top + 20, right: 520, bottom: top + 60 },
        children: [{ tag: 'h2', text: `新闻标题 ${index + 1}`, rect: { left: 80, top: top + 20, right: 520, bottom: top + 60 } }]
      },
      { tag: 'span', text: '央视新闻', attrs: { className: 'author' }, rect: { left: 80, top: top + 210, right: 150, bottom: top + 235 } },
      { tag: 'span', text: '12小时前', attrs: { className: 'date' }, rect: { left: 160, top: top + 210, right: 230, bottom: top + 235 } },
      metricNode('comment-icon', metrics[0], 380, top + 210),
      metricNode('star-icon', metrics[1], 480, top + 210),
      metricNode('share-icon', metrics[2], 580, top + 210)
    ]
  };
}

function metricNode(iconClass, value, left, top) {
  return {
    tag: 'span',
    text: '',
    attrs: { className: 'metric' },
    rect: { left, top, right: left + 70, bottom: top + 24 },
    children: [
      { tag: 'i', text: '', attrs: { className: iconClass }, rect: { left, top, right: left + 16, bottom: top + 16 } },
      { tag: 'span', text: value, attrs: { className: 'count' }, rect: { left: left + 22, top, right: left + 58, bottom: top + 20 } }
    ]
  };
}

function fakeRefinePage({ itemXPath, rows }) {
  return {
    async evaluate(fn, input) {
      const previousWindow = globalThis.window;
      const previousDocument = globalThis.document;
      const previousDOMRect = globalThis.DOMRect;
      const previousNode = globalThis.Node;
      const previousElement = globalThis.Element;
      const previousHTMLElement = globalThis.HTMLElement;
      const previousHTMLAnchorElement = globalThis.HTMLAnchorElement;
      const previousHTMLImageElement = globalThis.HTMLImageElement;
      const previousHTMLInputElement = globalThis.HTMLInputElement;
      const previousXPathResult = globalThis.XPathResult;
      class Rect {
        constructor(left, top, width, height) {
          this.left = left;
          this.top = top;
          this.width = width;
          this.height = height;
          this.right = left + width;
          this.bottom = top + height;
        }
      }
      class FakeElement {
        constructor({ tag = 'div', text = '', attrs = {}, rect, children = [], parent = null }) {
          this.localName = tag;
          this.tagName = tag.toUpperCase();
          this.nodeName = this.tagName;
          this.ownText = text;
          this.textContent = text;
          this.innerText = text;
          this.children = [];
          this.childNodes = [];
          this.parentElement = parent;
          this.nodeType = 1;
          this.id = attrs.id || '';
          this.className = attrs.className || '';
          this.attrs = attrs;
          this.rect = rect;
          this.href = attrs.href || '';
          this.src = attrs.src || '';
          this.currentSrc = attrs.src || '';
          this.naturalWidth = attrs.naturalWidth || 0;
          this.naturalHeight = attrs.naturalHeight || 0;
          this.width = rect ? rect.right - rect.left : 0;
          this.height = rect ? rect.bottom - rect.top : 0;
          if (text) this.childNodes.push({ nodeType: 3, textContent: text });
          for (const child of children) this.append(new FakeElement({ ...child, parent: this }));
          this.refreshText();
        }
        append(child) {
          child.parentElement = this;
          this.children.push(child);
          this.childNodes.push(child);
          this.refreshText();
          return child;
        }
        refreshText() {
          const childText = this.children.map((child) => child.textContent || '').join(' ');
          this.textContent = [this.ownText, childText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          this.innerText = this.textContent;
        }
        getAttribute(name) {
          if (name === 'class') return this.className;
          if (name === 'href') return this.href || this.attrs.href || '';
          return this.attrs[name] || '';
        }
        getAttributeNames() {
          return Object.keys(this.attrs).map((name) => name === 'className' ? 'class' : name);
        }
        getBoundingClientRect() {
          const { left, top, right, bottom } = this.rect;
          return new Rect(left, top, right - left, bottom - top);
        }
        contains(element) {
          return this === element || this.children.some((child) => child.contains(element));
        }
        matches(selector) {
          if (selector === 'a') return this.localName === 'a';
          if (selector === 'img') return this.localName === 'img';
          return matchesSimpleSelector(this, selector);
        }
        closest(selector) {
          let current = this;
          while (current) {
            if (matchesSelectorList(current, selector)) return current;
            current = current.parentElement;
          }
          return null;
        }
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null;
        }
        querySelectorAll(selector) {
          return flatten(this.children).filter((item) => matchesSelectorList(item, selector));
        }
      }
      const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.children)]);
      const rowElements = rows.map((row) => new FakeElement(row));
      const body = new FakeElement({
        tag: 'body',
        rect: { left: 0, top: 0, right: 1200, bottom: 2000 },
        children: []
      });
      const main = body.append(new FakeElement({
        tag: 'main',
        rect: { left: 0, top: 0, right: 1200, bottom: 2000 },
        children: [],
        parent: body
      }));
      const section = main.append(new FakeElement({
        tag: 'section',
        rect: { left: 40, top: 80, right: 700, bottom: 1200 },
        children: [],
        parent: main
      }));
      for (const row of rowElements) section.append(row);
      const all = () => flatten([body]);
      const document = {
        body,
        documentElement: { scrollHeight: 2000, clientHeight: 900 },
        querySelectorAll(selector) {
          return all().filter((item) => item !== body && matchesSelectorList(item, selector));
        },
        evaluate(path, context) {
          const root = context && context !== document ? context : body;
          const snapshot = path === itemXPath
            ? rowElements
            : evaluateSimplePath(path, root);
          return {
            snapshotLength: snapshot.length,
            snapshotItem(index) {
              return snapshot[index] || null;
            },
            singleNodeValue: snapshot[0] || null
          };
        }
      };
      const window = {
        innerHeight: 900,
        getComputedStyle() {
          return { display: 'block', visibility: 'visible', opacity: '1' };
        }
      };
      globalThis.window = window;
      globalThis.document = document;
      globalThis.DOMRect = Rect;
      globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
      globalThis.Element = FakeElement;
      globalThis.HTMLElement = FakeElement;
      globalThis.HTMLAnchorElement = FakeElement;
      globalThis.HTMLImageElement = FakeElement;
      globalThis.HTMLInputElement = class extends FakeElement {};
      globalThis.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7, FIRST_ORDERED_NODE_TYPE: 9 };
      try {
        return fn(input);
      } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.DOMRect = previousDOMRect;
        globalThis.Node = previousNode;
        globalThis.Element = previousElement;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.HTMLAnchorElement = previousHTMLAnchorElement;
        globalThis.HTMLImageElement = previousHTMLImageElement;
        globalThis.HTMLInputElement = previousHTMLInputElement;
        globalThis.XPathResult = previousXPathResult;
      }
    }
  };
}

function matchesSelectorList(element, selector) {
  return selector.split(',').map((item) => item.trim()).some((item) => matchesSimpleSelector(element, item));
}

function matchesSimpleSelector(element, selector) {
  if (!selector || selector === '*') return true;
  if (selector.includes(' ')) return matchesSimpleSelector(element, selector.split(/\s+/).at(-1));
  const scopeMatch = selector.replace(/^:scope\s*>\s*/, '').replace(/^:scope\s*/, '');
  if (scopeMatch.includes('>')) return matchesSimpleSelector(element, scopeMatch.split('>').at(-1).trim());
  const tagMatch = scopeMatch.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tagMatch && element.localName !== tagMatch.toLowerCase()) return false;
  for (const match of scopeMatch.matchAll(/\[class\*="([^"]+)" i\]/g)) {
    if (!String(element.className || '').toLowerCase().includes(match[1].toLowerCase())) return false;
  }
  for (const match of scopeMatch.matchAll(/\[([^=\]]+)="([^"]+)"\]/g)) {
    const attr = match[1];
    if (attr === 'class*') continue;
    if (String(element.getAttribute(attr) || '') !== match[2]) return false;
  }
  return true;
}

function evaluateSimplePath(path, context) {
  if (!path) return [];
  if (path === '.') return [context];
  const relative = path.replace(/^\.\//, '').replace(/^\.\/\//, '').replace(/^\/html\[1\]\/body\[1\]\//, '');
  if (relative.includes('//')) {
    const tagMatch = relative.match(/\/\/([a-zA-Z][\w-]*)(?:\[(\d+)\])?$/);
    if (!tagMatch) return [];
    const tag = tagMatch[1].toLowerCase();
    const index = tagMatch[2] ? Number(tagMatch[2]) - 1 : undefined;
    const matches = flattenElements([context]).filter((item) => item.localName === tag);
    return index === undefined ? matches : matches[index] ? [matches[index]] : [];
  }
  let current = [context];
  for (const segment of relative.split('/').filter(Boolean)) {
    const match = segment.match(/^([a-zA-Z][\w-]*)(?:\[(\d+)\])?$/);
    if (!match) return [];
    const tag = match[1].toLowerCase();
    const index = match[2] ? Number(match[2]) - 1 : undefined;
    const next = [];
    for (const item of current) {
      const children = (item.children || []).filter((child) => child.localName === tag);
      if (index === undefined) next.push(...children);
      else if (children[index]) next.push(children[index]);
    }
    current = next;
  }
  return current;
}

function flattenElements(items) {
  return items.flatMap((item) => [item, ...flattenElements(item.children || [])]);
}


function fakeObstructionPage({ bodyHeight, viewportHeight, elements, bodyOverflow = '', topElementId = '' }) {
  const hiddenIds = new Set();
  return {
    async evaluate(fn, input) {
      const previousWindow = globalThis.window;
      const previousDocument = globalThis.document;
      const previousNode = globalThis.Node;
      const previousElement = globalThis.Element;
      const previousHTMLElement = globalThis.HTMLElement;
      const previousSVGElement = globalThis.SVGElement;
      const previousHTMLInputElement = globalThis.HTMLInputElement;
      const previousXPathResult = globalThis.XPathResult;
      const previousGetComputedStyle = globalThis.getComputedStyle;
      class FakeElement {
        constructor({ tag = 'div', text = '', attrs = {}, rect, style = {}, children = [], parent = null }) {
          this.localName = tag;
          this.tagName = tag.toUpperCase();
          this.textContent = text;
          this.innerText = text;
          this.children = [];
          this.parentElement = parent;
          this.nodeType = 1;
          this.style = {};
          this.style.overflow = style.overflow || '';
          this.id = attrs.id || '';
          this.className = attrs.className || '';
          this.attrs = attrs;
          this.rect = rect;
          this.dataset = {};
          this.computedStyle = {
            display: this.id && hiddenIds.has(this.id) ? 'none' : 'block',
            visibility: 'visible',
            opacity: '1',
            position: style.position || 'static',
            zIndex: style.zIndex || 'auto',
            overflow: style.overflow || ''
          };
          this.style.setProperty = (name, value) => {
            this.style[name] = value;
            if (name === 'display') this.computedStyle.display = value;
          };
          for (const child of children) this.append(new FakeElement({ ...child, parent: this }));
        }
        append(child) {
          child.parentElement = this;
          this.children.push(child);
          return child;
        }
        getAttribute(name) {
          if (name === 'class') return this.className;
          if (name === 'role') return this.attrs.role || '';
          if (name === 'aria-modal') return this.attrs.ariaModal || '';
          if (name === 'aria-label') return this.attrs.ariaLabel || '';
          if (name === 'title') return this.attrs.title || '';
          if (name === 'data-testid') return this.attrs.dataTestid || '';
          return this.attrs[name] || '';
        }
        getBoundingClientRect() {
          const { left, top, right, bottom } = this.rect;
          return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
        contains(element) {
          return this === element || this.children.some((child) => child.contains(element));
        }
        querySelectorAll() {
          return flatten(this.children);
        }
        click() {
          this.clicked = true;
          let current = this.parentElement;
          while (current && current.localName !== 'body') {
            if (/modal|popup|mask|login|dialog/i.test(`${current.className || ''} ${current.getAttribute('role') || ''}`)) {
              if (current.attrs.persistOnClose) break;
              current.computedStyle.display = 'none';
              current.style.display = 'none';
              if (current.id) hiddenIds.add(current.id);
              break;
            }
            current = current.parentElement;
          }
        }
      }
      const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.children)]);
      const ancestorHidden = (element) => {
        let current = element;
        while (current) {
          if (current.computedStyle?.display === 'none' || current.id && hiddenIds.has(current.id)) return true;
          current = current.parentElement;
        }
        return false;
      };
      const body = new FakeElement({
        tag: 'body',
        rect: { left: 0, top: 0, right: 1200, bottom: bodyHeight },
        style: { overflow: bodyOverflow },
        children: elements
      });
      const documentElement = new FakeElement({
        tag: 'html',
        rect: { left: 0, top: 0, right: 1200, bottom: bodyHeight },
        style: { overflow: bodyOverflow },
        children: []
      });
      const all = () => flatten([body]);
      const findById = (id) => all().find((item) => item.id === id);
      const document = {
        body,
        documentElement,
        querySelectorAll() {
          return all().filter((item) => item !== body);
        },
        evaluate(path) {
          const result = evaluateFakeAbsoluteXPath(path, body);
          return {
            singleNodeValue: result[0] || null,
            snapshotLength: result.length,
            snapshotItem(index) {
              return result[index] || null;
            }
          };
        },
        elementFromPoint() {
          return topElementId ? findById(topElementId) || body : body;
        }
      };
      const window = {
        innerWidth: 1200,
        innerHeight: viewportHeight,
        getComputedStyle(element) {
          if (ancestorHidden(element)) {
            return { ...(element.computedStyle || {}), display: 'none', visibility: 'visible', opacity: '1', position: element.computedStyle?.position || 'static', zIndex: element.computedStyle?.zIndex || 'auto' };
          }
          return element.computedStyle || { display: 'block', visibility: 'visible', opacity: '1', position: 'static', zIndex: 'auto' };
        }
      };
      globalThis.window = window;
      globalThis.document = document;
      globalThis.getComputedStyle = window.getComputedStyle;
      globalThis.Node = { ELEMENT_NODE: 1 };
      globalThis.Element = FakeElement;
      globalThis.HTMLElement = FakeElement;
      globalThis.SVGElement = class extends FakeElement {};
      globalThis.HTMLInputElement = FakeElement;
      globalThis.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
      try {
        return fn(input);
      } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.getComputedStyle = previousGetComputedStyle;
        globalThis.Node = previousNode;
        globalThis.Element = previousElement;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.SVGElement = previousSVGElement;
        globalThis.HTMLInputElement = previousHTMLInputElement;
        globalThis.XPathResult = previousXPathResult;
      }
    }
  };
}

function recognizeOptionsForSearchScoring(url, keyword) {
  return {
    url,
    input: { q: keyword },
    manual: false,
    interactive: false,
    waitMs: 0,
    scrolls: 0,
    timeoutMs: 10_000,
    maxCandidates: 8,
    llmRank: false,
    dismissPopups: true
  };
}

function searchResultLikeElements({ className, itemTextPrefix }) {
  return [
    {
      tag: 'main',
      attrs: { className },
      rect: { left: 0, top: 80, right: 1000, bottom: 1200 },
      children: [1, 2, 3].map((index) => ({
        tag: 'article',
        text: `${itemTextPrefix} ${index} `.repeat(8),
        attrs: { className: `${className}-item` },
        rect: { left: 120, top: 120 + index * 120, right: 860, bottom: 200 + index * 120 },
        children: [
          {
            tag: 'a',
            text: `${itemTextPrefix} ${index}`,
            attrs: { href: `https://blog.csdn.net/example/article/details/${index}` },
            rect: { left: 140, top: 130 + index * 120, right: 520, bottom: 158 + index * 120 }
          }
        ]
      }))
    }
  ];
}

function fakeSearchPage({ url, title, bodyText, elements }) {
  return {
    async evaluate(fn, input) {
      const previousWindow = globalThis.window;
      const previousDocument = globalThis.document;
      const previousNode = globalThis.Node;
      const previousElement = globalThis.Element;
      const previousHTMLElement = globalThis.HTMLElement;
      const previousHTMLInputElement = globalThis.HTMLInputElement;
      const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
      const previousHTMLFormElement = globalThis.HTMLFormElement;
      const previousXPathResult = globalThis.XPathResult;
      const previousCSS = globalThis.CSS;
      class FakeElement {
        constructor({ tag = 'div', text = '', attrs = {}, rect = { left: 0, top: 0, right: 10, bottom: 10 }, children = [], parent = null }) {
          this.localName = tag;
          this.tagName = tag.toUpperCase();
          this.nodeType = 1;
          this.ownText = text;
          this.children = [];
          this.parentElement = parent;
          this.id = attrs.id || '';
          this.className = attrs.className || '';
          this.attrs = attrs;
          this.rect = rect;
          this.value = attrs.value || '';
          this.name = attrs.name || '';
          this.type = attrs.type || '';
          this.placeholder = attrs.placeholder || '';
          this.href = attrs.href || '';
          this.textContent = text;
          for (const child of children) this.append(new FakeElement({ ...child, parent: this }));
          this.refreshText();
        }
        append(child) {
          child.parentElement = this;
          this.children.push(child);
          this.refreshText();
          return child;
        }
        refreshText() {
          this.textContent = [this.ownText, ...this.children.map((child) => child.textContent || '')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        }
        getAttribute(name) {
          if (name === 'class') return this.className;
          if (name === 'href') return this.href || this.attrs.href || '';
          if (name === 'name') return this.name || this.attrs.name || '';
          if (name === 'type') return this.type || this.attrs.type || '';
          if (name === 'placeholder') return this.placeholder || this.attrs.placeholder || '';
          if (name === 'aria-label') return this.attrs.ariaLabel || '';
          if (name === 'title') return this.attrs.title || '';
          if (name === 'role') return this.attrs.role || '';
          if (name === 'contenteditable') return this.attrs.contenteditable || '';
          if (name === 'data-placeholder') return this.attrs.dataPlaceholder || '';
          if (name === 'data-name') return this.attrs.dataName || '';
          return this.attrs[name] || '';
        }
        getBoundingClientRect() {
          const { left, top, right, bottom } = this.rect;
          return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
        closest(selector) {
          let current = this;
          while (current) {
            if (matchesSelectorList(current, selector)) return current;
            current = current.parentElement;
          }
          return null;
        }
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null;
        }
        querySelectorAll(selector) {
          return flattenElements(this.children).filter((item) => matchesSelectorList(item, selector));
        }
      }
      class FakeInputElement extends FakeElement {}
      class FakeTextAreaElement extends FakeInputElement {}
      class FakeFormElement extends FakeElement {}
      const make = (item) => {
        const cls = item.tag === 'input' ? FakeInputElement : item.tag === 'textarea' ? FakeTextAreaElement : item.tag === 'form' ? FakeFormElement : FakeElement;
        const element = new cls({ ...item, children: [] });
        for (const child of item.children || []) element.append(make(child));
        element.refreshText();
        return element;
      };
      const body = new FakeElement({
        tag: 'body',
        text: bodyText,
        rect: { left: 0, top: 0, right: 1200, bottom: 1800 },
        children: []
      });
      for (const item of elements) body.append(make(item));
      const html = new FakeElement({
        tag: 'html',
        rect: { left: 0, top: 0, right: 1200, bottom: 1800 },
        children: []
      });
      html.append(body);
      const all = () => flattenElements([html]);
      const document = {
        body,
        title,
        documentElement: html,
        querySelector(selector) {
          return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
          return all().filter((item) => item !== html && item !== body && matchesSelectorList(item, selector));
        },
        evaluate(path) {
          const result = evaluateFakeAbsoluteXPath(path, body);
          return {
            singleNodeValue: result[0] || null,
            snapshotLength: result.length,
            snapshotItem(index) {
              return result[index] || null;
            }
          };
        }
      };
      const window = {
        innerWidth: 1200,
        innerHeight: 900,
        location: { href: url },
        getComputedStyle() {
          return { display: 'block', visibility: 'visible', opacity: '1' };
        }
      };
      globalThis.window = window;
      globalThis.document = document;
      globalThis.location = window.location;
      globalThis.Node = { ELEMENT_NODE: 1 };
      globalThis.Element = FakeElement;
      globalThis.HTMLElement = FakeElement;
      globalThis.HTMLInputElement = FakeInputElement;
      globalThis.HTMLTextAreaElement = FakeTextAreaElement;
      globalThis.HTMLFormElement = FakeFormElement;
      globalThis.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9, ORDERED_NODE_SNAPSHOT_TYPE: 7 };
      globalThis.CSS = { escape: (value) => String(value).replace(/"/g, '\\"') };
      try {
        return fn(input);
      } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.location = previousWindow?.location;
        globalThis.Node = previousNode;
        globalThis.Element = previousElement;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.HTMLInputElement = previousHTMLInputElement;
        globalThis.HTMLTextAreaElement = previousHTMLTextAreaElement;
        globalThis.HTMLFormElement = previousHTMLFormElement;
        globalThis.XPathResult = previousXPathResult;
        globalThis.CSS = previousCSS;
      }
    }
  };
}

function evaluateFakeAbsoluteXPath(path, body) {
  const normalized = path
    .replace(/^\/html\[1\]\/body\[1\]/, '')
    .replace(/^\/html\/body/, '')
    .replace(/^\/body\[1\]/, '')
    .replace(/^\/body/, '');
  if (!normalized || normalized === '/') return [body];
  let current = [body];
  for (const raw of normalized.split('/').filter(Boolean)) {
    const match = raw.match(/^([a-zA-Z][\w-]*)(?:\[(\d+)\])?$/);
    if (!match) return [];
    const tag = match[1].toLowerCase();
    const index = match[2] ? Number(match[2]) - 1 : 0;
    const next = [];
    for (const item of current) {
      const children = item.children.filter((child) => child.localName === tag);
      if (children[index]) next.push(children[index]);
    }
    current = next;
  }
  return current;
}
