import assert from 'node:assert/strict';
import { chdir, cwd } from 'node:process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildAgentContextForTesting, buildTaskFromAgentPlan, previewAgentPlanForTesting, defaultDetectedTaskNameForTesting, detectCommand, detectUrlCommand, resolveAgentScreenshotPathForTesting, resolveAvailableDetectedTaskFile, runInlineAgentDetectForTesting, splitRunUrlArgs } from '../dist/commands/detect.js';
import { EngineHost } from '../dist/runtime/engine-host.js';
import { setEngineHostFactoryForTesting } from '../dist/commands/run.js';
import { browserSessionPath, loadBrowserSession, saveBrowserSession } from '../dist/runtime/browser-session.js';
import { detectedTaskToCloudTaskInfo, encodeTaskXml } from '../dist/runtime/task-cloud-save.js';
import { hasLinuxDisplayEnvironment, requiresVirtualDisplay } from '../dist/runtime/virtual-display.js';
import { applyGoalScoresForTesting, augmentAdjacentMetadataFieldsForTesting, dedupeEquivalentCandidates, detectInteractivePaginationOptionsForTesting, detectPageObstructionsForTesting, detectPaginationForCandidatesForTesting, detectSearchResultBlocksForTesting, detectSemanticBusinessCardsForTesting, dismissPageObstructionsForTesting, filterDetectedBoilerplateCandidates, findSearchInputCandidatesForTesting, isPlausiblePaginationOptionForTesting, pageLooksLikeSearchResultForTesting, preferredPaginationForTesting, rankCandidatesForTesting, refineCandidateFieldsForTesting, resetManualOverlayHintKeysForTesting, resolveSearchSubmitButtonByGeometryForTesting, resolveSearchSubmitButtonForTesting, sanitizeCandidatePaginationByLayoutForTesting, scoreSearchResultPageForTesting, selectDetailUrlFieldForTesting, shouldPromptForLoginInterventionForTesting, writeManualOverlayHintOnceForTesting } from '../dist/runtime/detector/page-detector.js';
import { candidateIdsForAnnotatedScreenshotForTesting, candidateIdsForCandidateScreenshotsForTesting } from '../dist/runtime/detector/agent-visual-artifacts.js';
import { protectedSmartResultToCandidatesForTesting } from '../dist/runtime/detector/protected-smart.js';
import { buildTaskFromCandidate } from '../dist/runtime/detector/xml.js';

test('resolveAvailableDetectedTaskFile creates a default file without overwriting existing tasks', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'detector-output-'));
  try {
    chdir(dir);
    assert.equal(resolveAvailableDetectedTaskFile('detected_example.com'), resolve('detected_example.com.json'));
    await writeFile(resolve('detected_example.com.json'), '{}\n');
    assert.equal(resolveAvailableDetectedTaskFile('detected_example.com'), resolve('detected_example.com-1.json'));
  } finally {
    chdir(previousCwd);
  }
});

test('defaultDetectedTaskNameForTesting derives a Windows-safe name from URL without protocol', () => {
  assert.equal(
    defaultDetectedTaskNameForTesting('https://www.gc-zb.com/search/index.html'),
    'www.gc-zb.com_search_index.html'
  );
  assert.equal(
    defaultDetectedTaskNameForTesting('http://example.com/search?q=abc'),
    'example.com_search_q=abc'
  );
  assert.doesNotMatch(defaultDetectedTaskNameForTesting('https://example.com/a/b'), /https?:|[\\/]/);
});

test('resolveAgentScreenshotPathForTesting enables default full-page screenshots for agent workflows', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'detector-agent-shot-'));
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

test('agent annotated screenshots include all final boxed candidates while crops stay focused', () => {
  const boxed = (id, confidence, type = 'search_results') => ({
    id,
    type,
    title: id,
    confidence,
    selector: `#${id}`,
    xpath: `//*[@id="${id}"]`,
    itemSelector: `#${id} .item`,
    itemXPath: `//*[@id="${id}"]//*[@class="item"]`,
    itemCount: 3,
    fields: [
      {
        name: 'title',
        kind: 'text',
        selector: 'a',
        xpath: `//*[@id="${id}"]//a`,
        relativeXPath: './/a',
        samples: [id]
      }
    ],
    sampleRows: [{ title: id }],
    reasons: [],
    diagnostics: {
      matchCount: 3,
      boundingBox: { x: 0, y: 0, width: 100, height: 80 },
      sampleBoxes: [],
      textLength: 20,
      visualCoverage: 0.1,
      warnings: []
    }
  });
  const candidates = [
    boxed('first', 0.9),
    boxed('second', 0.8),
    boxed('third', 0.7),
    boxed('fourth', 0.6),
    boxed('search_form', 0.99, 'form'),
    { ...boxed('no_box', 0.95), diagnostics: { matchCount: 0, sampleBoxes: [], textLength: 0, visualCoverage: 0, warnings: ['itemXPath matched no visible elements'] } }
  ];

  assert.deepEqual(candidateIdsForAnnotatedScreenshotForTesting(candidates), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(candidateIdsForCandidateScreenshotsForTesting(candidates), ['first', 'second', 'third']);
});

test('detectedTaskToCloudTaskInfo uses client-compatible compressed xml payload', async () => {
  const xml = '<ns0:RootAction useKernelBrowser="false"><x>Title</x></ns0:RootAction>';
  const taskInfo = detectedTaskToCloudTaskInfo({
    taskId: 'detected_cloud',
    taskName: 'Detected Cloud',
    xml,
    disableImage: true,
    disableAD: true,
    workflowSetting: { repeatPageLoopCount: 12 }
  }, 'user-1');
  const compressed = Buffer.from(String(taskInfo.xoml), 'base64');
  assert.equal(compressed.readInt32LE(0), compressed.byteLength - 4);
  assert.equal(gunzipSync(compressed.subarray(4)).toString('ucs2'), xml);
  assert.equal(taskInfo.taskId, 'detected_cloud');
  assert.equal(taskInfo.taskName, 'Detected Cloud');
  assert.equal(taskInfo.taskGroupId, 1);
  assert.equal(taskInfo.userId, 'user-1');
  assert.equal(taskInfo.author, 'user-1');
  assert.equal(taskInfo.status, 1);
  assert.equal(taskInfo.taskType, 1);
  assert.equal(taskInfo.workFlowType, 1);
  assert.equal(taskInfo.disableImage, true);
  assert.equal(taskInfo.adBlockEnable, true);
  assert.deepEqual(taskInfo.workflowSetting, { repeatPageLoopCount: 12 });
  assert.equal(encodeTaskXml(xml), taskInfo.xoml);
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

test('detect rejects obsolete explicit screenshot flags', async () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await detectCommand(['https://example.com/list', '--prepare-agent', '--screenshot', 'custom.png', '--json', '--quiet']), 1);
    assert.equal(await detectCommand(['https://example.com/list', '--agent-screenshot', 'custom.png', '--json', '--quiet']), 1);
    assert.equal(await detectUrlCommand('https://example.com/list', ['--auto', '--screenshot', 'custom.png', '--json']), 1);
  } finally {
    console.log = previousLog;
  }
});

test('splitRunUrlArgs keeps run output separate from detect task output', () => {
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

  assert.deepEqual(split.detectArgs, [
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

test('detect --agent rejects missing agent command before page detection', async () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    const code = await detectCommand(['https://example.com/list', '--agent', '--json', '--quiet']);
    assert.equal(code, 1);
  } finally {
    console.log = previousLog;
  }
});

test('detect --run-sample is only valid for strict inline agent samples', async () => {
  const previousLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await detectCommand(['https://example.com/list', '--run-sample', '1', '--json', '--quiet']), 1);
    assert.equal(await detectCommand([
      'https://example.com/list',
      '--agent',
      '--agent-command',
      'node unused.mjs',
      '--run-sample',
      '1abc',
      '--json',
      '--quiet'
    ]), 1);
  } finally {
    console.log = previousLog;
  }
});

test('saveBrowserSession writes private cookie files and preserves covered hosts', async () => {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'detector-session-home-'));
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

  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/a' }, 'pagination', '确认翻页\n');
  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/b' }, 'pagination', '确认翻页\n');
  writeManualOverlayHintOnceForTesting(runtimeConsole, { url: () => 'https://example.com/b' }, 'candidate', '确认识别结果\n');

  assert.deepEqual(messages, ['确认翻页\n', '确认识别结果\n']);
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

test('protected Smart field cleanup removes action noise and preserves row mapping', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/article',
        fullColRate: 1,
        data: [
          ['Alpha Project', 'Beta Project'],
          ['https://example.com/alpha', 'https://example.com/beta'],
          ['https://example.com/login?return_to=%2Falpha', 'https://example.com/login?return_to=%2Fbeta'],
          ['Star', 'Star'],
          ['A useful package for scraping pages', 'A CLI helper for data extraction'],
          ['https://example.com/tag/scraping', 'https://example.com/tag/cli'],
          ['scraping', 'cli'],
          ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'],
          ['https://cdn.example.com/avatar-a.png', 'https://cdn.example.com/avatar-b.png'],
          ['2026-06-10', '2026-06-09'],
          ['1,234', '987']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/A[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/A[1]', Attribute: 'href' },
          { Name: 'tooltipped_链接', RelativeXPath: '/A[2]', Attribute: 'href' },
          { Name: 'dnone', RelativeXPath: '/SPAN[1]', Attribute: 'text' },
          { Name: '8fbbd57d', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'cf33f2b9_链接', RelativeXPath: '/UL[1]/LI[1]/A[1]', Attribute: 'href' },
          { Name: 'cf33f2b9', RelativeXPath: '/UL[1]/LI[1]/A[1]', Attribute: 'text' },
          { Name: '图片', RelativeXPath: '/IMG[1]', Attribute: 'src' },
          { Name: '头像', RelativeXPath: '/DIV[1]/IMG[1]', Attribute: 'src' },
          { Name: 'updatedat', RelativeXPath: '/TIME[1]', Attribute: 'text' },
          { Name: '下载', RelativeXPath: '/SPAN[2]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '描述',
    '标签链接',
    '标签',
    '图片',
    '时间',
    '下载'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'Alpha Project',
    '标题链接': 'https://example.com/alpha',
    '描述': 'A useful package for scraping pages',
    '标签链接': 'https://example.com/tag/scraping',
    '标签': 'scraping',
    '图片': 'https://cdn.example.com/a.png',
    '时间': '2026-06-10',
    '下载': '1,234'
  });
});

test('protected Smart field cleanup compacts repository-style source and navigation noise', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/article',
        fullColRate: 1,
        data: [
          ['freeCodeCamp', 'project-based-learning'],
          ['https://github.com/freeCodeCamp/freeCodeCamp?ref=topic', 'https://github.com/practical-tutorials/project-based-learning?ref=topic'],
          ['https://github.com/freeCodeCamp/freeCodeCamp?tab=readme', 'https://github.com/practical-tutorials/project-based-learning?tab=readme'],
          ['https://github.com/freeCodeCamp', 'https://github.com/practical-tutorials'],
          ['freeCodeCamp', 'practical-tutorials'],
          ['(github.com/freeCodeCamp)', '(github.com/practical-tutorials)'],
          ['https://news.ycombinator.com/from?site=github.com/freeCodeCamp', 'https://news.ycombinator.com/from?site=github.com/practical-tutorials'],
          ['github.com/freeCodeCamp', 'github.com/practical-tutorials'],
          ['Code', 'Code'],
          ['Sponsor', ''],
          ['Updated', 'Updated'],
          ['freeCodeCamp.org open-source codebase and curriculum.', 'The library for web and native user interfaces.'],
          ['447k', '246k']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/H3[1]/A[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/H3[1]/A[1]', Attribute: 'href' },
          { Name: 'overlay_链接', RelativeXPath: '/A[2]', Attribute: 'href' },
          { Name: 'link_链接', RelativeXPath: '/SPAN[1]/A[1]', Attribute: 'href' },
          { Name: 'link', RelativeXPath: '/SPAN[1]/A[1]', Attribute: 'text' },
          { Name: 'source', RelativeXPath: '/SPAN[2]', Attribute: 'text' },
          { Name: 'source_链接', RelativeXPath: '/SPAN[2]/A[1]', Attribute: 'href' },
          { Name: 'sourceText', RelativeXPath: '/SPAN[2]/A[1]/SPAN[1]', Attribute: 'text' },
          { Name: 'tabnav', RelativeXPath: '/NAV[1]/A[1]', Attribute: 'text' },
          { Name: 'valignmiddle', RelativeXPath: '/SPAN[3]', Attribute: 'text' },
          { Name: 'updatedat', RelativeXPath: '/SPAN[4]', Attribute: 'text' },
          { Name: 'colorfgmuted', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'counter', RelativeXPath: '/SPAN[5]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '作者链接',
    '作者',
    '来源链接',
    '来源',
    '数量'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'freeCodeCamp',
    '标题链接': 'https://github.com/freeCodeCamp/freeCodeCamp?ref=topic',
    '作者链接': 'https://github.com/freeCodeCamp',
    '作者': 'freeCodeCamp',
    '来源链接': 'https://news.ycombinator.com/from?site=github.com/freeCodeCamp',
    '来源': 'github.com/freeCodeCamp',
    '数量': '447k'
  });
});

test('protected Smart field cleanup renames ordinal and author samples while dropping commerce actions', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ol/li',
        fullColRate: 1,
        data: [
          ['Cancer review', 'Dementia study'],
          ['https://example.com/articles/1', 'https://example.com/articles/2'],
          ['1.', '2.'],
          ['Mclaughlin M, Sanal-Hayes NEM.', 'Wang CC, Liu HC, Lin WL.'],
          ['https://www.ebay.com/myb/WatchListAdd?item=1', 'https://www.ebay.com/myb/WatchListAdd?item=2'],
          ['今すぐ買う', '今すぐ買う']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/A[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/A[1]', Attribute: 'href' },
          { Name: 'flexshrink', RelativeXPath: '/SPAN[1]', Attribute: 'text' },
          { Name: 'usalist', RelativeXPath: '/DIV[1]', Attribute: 'text' },
          { Name: 'scard_watchheartclick_链接', RelativeXPath: '/BUTTON[1]', Attribute: 'href' },
          { Name: 'sucardcontainer_attributes_primary', RelativeXPath: '/BUTTON[2]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '编号',
    '作者'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'Cancer review',
    '标题链接': 'https://example.com/articles/1',
    '编号': '1.',
    '作者': 'Mclaughlin M, Sanal-Hayes NEM.'
  });
});

test('protected Smart field cleanup normalizes generated semantic fields', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/article',
        fullColRate: 1,
        data: [
          ['Plugin Alpha', 'Plugin Beta'],
          ['https://example.com/plugins/alpha', 'https://example.com/plugins/beta'],
          ['(7,440 total ratings )', '(120 total ratings )'],
          ['Grow organic traffic with schema automation and useful built-in SEO recommendations.', 'Improve search visibility with content checks and actionable indexing guidance.'],
          ['4+ million active installations', '200,000+ active installations'],
          ['Tested with 7.0', 'Tested with 6.9.4'],
          ['New York, NY, USA', 'San Francisco, CA, USA'],
          ['The AI platform for private markets investors', 'Supplying America industrial teams with critical materials'],
          ['SUMMER 2025', 'SUMMER 2025'],
          ['https://example.com/companies?industry=B2B', 'https://example.com/companies?industry=Industrials'],
          ['B2B', 'INDUSTRIALS'],
          ['View in Page ', 'View in Page '],
          ['90%', '82%'],
          ['•', '•'],
          ['Imported by ', 'Imported by '],
          ['1,776,917', '36,104']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/A[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/A[1]', Attribute: 'href' },
          { Name: 'ratingcount', RelativeXPath: '/SPAN[1]', Attribute: 'text' },
          { Name: 'time', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'activeinstalls', RelativeXPath: '/SPAN[2]', Attribute: 'text' },
          { Name: 'testedwith', RelativeXPath: '/SPAN[3]', Attribute: 'text' },
          { Name: 'my', RelativeXPath: '/DIV[1]', Attribute: 'text' },
          { Name: 'mb', RelativeXPath: '/DIV[2]', Attribute: 'text' },
          { Name: 'pill', RelativeXPath: '/SPAN[4]', Attribute: 'text' },
          { Name: 'pillwrapper_18olp_33_链接', RelativeXPath: '/A[2]', Attribute: 'href' },
          { Name: 'pill1', RelativeXPath: '/SPAN[5]', Attribute: 'text' },
          { Name: 'resultreadmore', RelativeXPath: '/SPAN[6]', Attribute: 'text' },
          { Name: 'jstilelink', RelativeXPath: '/SPAN[7]', Attribute: 'text' },
          { Name: 'wfull', RelativeXPath: '/SPAN[8]', Attribute: 'text' },
          { Name: 'imported', RelativeXPath: '/SPAN[9]', Attribute: 'text' },
          { Name: 'counter', RelativeXPath: '/SPAN[10]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '评分数',
    '描述',
    '安装量',
    '兼容版本',
    '位置',
    '描述2',
    '标签',
    '类型_链接',
    '评分',
    '数量'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'Plugin Alpha',
    '标题链接': 'https://example.com/plugins/alpha',
    '评分数': '(7,440 total ratings )',
    '描述': 'Grow organic traffic with schema automation and useful built-in SEO recommendations.',
    '安装量': '4+ million active installations',
    '兼容版本': 'Tested with 7.0',
    '位置': 'New York, NY, USA',
    '描述2': 'The AI platform for private markets investors',
    '标签': 'SUMMER 2025',
    '类型_链接': 'https://example.com/companies?industry=B2B',
    '评分': '90%',
    '数量': '1,776,917'
  });
});

test('protected Smart field cleanup removes parent text and collapses repeated category fields', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ol/li',
        fullColRate: 0.65,
        data: [
          [
            'NEW Senior Python AI/ML Engineer| Hybrid| Full-time P.R.GLOlinks Consulting Private Limited',
            'NEW Founding ML/Data Scientist (Remote, UK) MyDataValue'
          ],
          ['https://www.python.org/jobs/8090/', 'https://www.python.org/jobs/8089/'],
          ['Senior Python AI/ML Engineer| Hybrid| Full-time', 'Founding ML/Data Scientist (Remote, UK)'],
          ['https://www.python.org/jobs/location/bangalore-pune-india/', 'https://www.python.org/jobs/location/remote-london-uk-united-kingdom/'],
          ['Bangalore, Pune, India', 'Remote - London UK, United Kingdom'],
          ['AI/ML', 'Back end, Big Data, Machine Learning, ML Engineer'],
          ['https://www.python.org/jobs/type/back-end/', 'https://www.python.org/jobs/type/back-end/'],
          ['Back end', 'Back end'],
          ['https://www.python.org/jobs/type/big-data/', 'https://www.python.org/jobs/type/lead/'],
          ['Big Data', 'Lead'],
          ['08 June 2026', '03 June 2026'],
          ['https://www.python.org/jobs/category/developer-engineer/', 'https://www.python.org/jobs/category/researcher-scientist/']
        ],
        scheme: [
          { Name: '公司名', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-company-name")]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-company-name")]//A[1]', Attribute: 'href' },
          { Name: '标题', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-company-name")]//A[1]', Attribute: 'text' },
          { Name: '位置_链接', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-location")]//A[1]', Attribute: 'href' },
          { Name: '位置', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-location")]//A[1]', Attribute: 'text' },
          { Name: '类型', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-job-type")]', Attribute: 'text' },
          { Name: '类型_链接', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-job-type")]//A[1]', Attribute: 'href' },
          { Name: '类型2', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-job-type")]//A[1]', Attribute: 'text' },
          { Name: '类型_链接3', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-job-type")]//A[2]', Attribute: 'href' },
          { Name: '类型4', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-job-type")]//A[2]', Attribute: 'text' },
          { Name: '时间', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-posted")]//TIME[1]', Attribute: 'text' },
          { Name: '类别_链接', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"listing-company-category")]//A[1]', Attribute: 'href' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题链接',
    '标题',
    '位置_链接',
    '位置',
    '类型',
    '类型_链接',
    '时间'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题链接': 'https://www.python.org/jobs/8090/',
    '标题': 'Senior Python AI/ML Engineer| Hybrid| Full-time',
    '位置_链接': 'https://www.python.org/jobs/location/bangalore-pune-india/',
    '位置': 'Bangalore, Pune, India',
    '类型': 'AI/ML',
    '类型_链接': 'https://www.python.org/jobs/type/back-end/',
    '时间': '08 June 2026'
  });
});

test('protected Smart field cleanup removes search toggles and names citation metadata', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/div',
        fullColRate: 0.8,
        data: [
          ['StatPearls [Internet].', 'Database of Abstracts of Reviews of Effects (DARE): Quality-assessed Reviews [Internet].'],
          ['https://www.ncbi.nlm.nih.gov/books/NBK430685/?term=cancer', 'https://www.ncbi.nlm.nih.gov/books/NBK285222/?term=cancer'],
          ['https://www.ncbi.nlm.nih.gov/corehtml/pmc/pmcgifs/bookshelf/thumbs/th-statpearls.png', 'https://www.ncbi.nlm.nih.gov/corehtml/pmc/pmcgifs/bookshelf/thumbs/th-dare.png'],
          ['1.', '2.'],
          ['Cancer', 'Cancer'],
          ['Kufe DW, Pollock RE, Weichselbaum RR, et al., editors.', 'Adam MP, Bick S, Mirzaa GM, et al., editors.'],
          ['Treasure Island (FL): StatPearls Publishing; 2026 Jan-.', 'York (UK): Centre for Reviews and Dissemination (UK); 1995-.'],
          ['Top results in this book', 'Top results in this book'],
          ['Table of Contents', 'Table of Contents']
        ],
        scheme: [
          { Name: '标题', RelativeXPath: '/descendant-or-self::P[contains(@class,"title")]//A[1]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/descendant-or-self::P[contains(@class,"title")]//A[1]', Attribute: 'href' },
          { Name: '图片', RelativeXPath: '/descendant-or-self::DIV[contains(@class,"rsltimg")]//IMG[1]', Attribute: 'src' },
          { Name: '编号', RelativeXPath: '/descendant-or-self::DIV[contains(@class,"rprtnum")]//SPAN[1]', Attribute: 'text' },
          { Name: 'highlight', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"highlight")]', Attribute: 'text' },
          { Name: 'desc', RelativeXPath: '/descendant-or-self::P[contains(@class,"desc")]', Attribute: 'text' },
          { Name: 'details', RelativeXPath: '/descendant-or-self::P[contains(@class,"details")]', Attribute: 'text' },
          { Name: 'uincbitogglermastertext', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"ui-ncbitoggler-master-text h2rep")]', Attribute: 'text' },
          { Name: 'book_toc', RelativeXPath: '/descendant-or-self::A[contains(@class,"book_toc")]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '图片',
    '编号',
    '作者',
    '引用'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'StatPearls [Internet].',
    '标题链接': 'https://www.ncbi.nlm.nih.gov/books/NBK430685/?term=cancer',
    '图片': 'https://www.ncbi.nlm.nih.gov/corehtml/pmc/pmcgifs/bookshelf/thumbs/th-statpearls.png',
    '编号': '1.',
    '作者': 'Kufe DW, Pollock RE, Weichselbaum RR, et al., editors.',
    '引用': 'Treasure Island (FL): StatPearls Publishing; 2026 Jan-.'
  });
});

test('protected Smart field cleanup removes arxiv action/search-hit fragments', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ol/li',
        fullColRate: 1,
        data: [
          ['EEVEE: Towards Test-time Prompt Learning in the Real World for Self-Improving Agents', 'Data Journalist Agent: Transforming Data into Verifiable Multimodal Stories', 'Unidirectional Entropic Solutions of the Pressureless Euler Alignment System'],
          ['https://arxiv.org/abs/2606.11182', 'https://arxiv.org/abs/2606.11176', 'https://arxiv.org/abs/2606.11159'],
          ['arXiv:2606.11182', 'arXiv:2606.11176', 'arXiv:2606.11159'],
          [' [pdf, ps, other] ', ' [pdf, ps, other] ', ' [pdf, ps, other] '],
          ['cs.LG cs.AI', 'cs.CV cs.CL cs.CY cs.HC', 'math.AP'],
          ['Agents', 'Agent', 'Agentic'],
          ['https://arxiv.org/search/?searchtype=author&query=Xu%2C+W', 'https://arxiv.org/search/?searchtype=author&query=Lin%2C+K+Q', 'https://arxiv.org/search/?searchtype=author&query=Adeleke%2C+J+O'],
          ['Weixian Xu', 'Kevin Qinghong Lin', 'Joshua O. Adeleke'],
          ['In this paper, we propose EEVEE, the first multi-dataset test-time prompt learning framework for LLM agents.', 'Recent agents handle individual steps well in data-science workflows.', 'This paper studies communication protocols in pressureless Euler alignment systems.'],
          ['agents', 'agents', 'agents'],
          ['▽ More', '▽ More', '▽ More']
        ],
        scheme: [
          { Name: '标题', RelativeXPath: '/descendant-or-self::P[contains(@class,"title is-5 mathjax")]', Attribute: 'text' },
          { Name: '标题_链接', RelativeXPath: '/descendant-or-self::P[contains(@class,"list-title is-inline-block")]/A[1]', Attribute: 'href' },
          { Name: '标题1', RelativeXPath: '/descendant-or-self::P[contains(@class,"list-title is-inline-block")]/A[1]', Attribute: 'text' },
          { Name: '标题2', RelativeXPath: '/descendant-or-self::P[contains(@class,"list-title is-inline-block")]//SPAN[1]', Attribute: 'text' },
          { Name: '关键词', RelativeXPath: '/descendant-or-self::DIV[contains(@class,"tags is-inline-block")]', Attribute: 'text' },
          { Name: '标题6', RelativeXPath: '/descendant-or-self::p[@class="title is-5 mathjax"]/SPAN[contains(@class,"search-hit mathjax")]', Attribute: 'text' },
          { Name: '作者_链接', RelativeXPath: '/descendant-or-self::P[contains(@class,"authors")]//A[1]', Attribute: 'href' },
          { Name: '作者', RelativeXPath: '/descendant-or-self::P[contains(@class,"authors")]//A[1]', Attribute: 'text' },
          { Name: '摘要', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"abstract-short has-text-grey-dark mathjax")]', Attribute: 'text' },
          { Name: '摘要18', RelativeXPath: '/descendant-or-self::span[@class="abstract-short has-text-grey-dark mathjax"]/SPAN[contains(@class,"search-hit mathjax")]', Attribute: 'text' },
          { Name: '摘要19', RelativeXPath: '/descendant-or-self::span[@class="abstract-short has-text-grey-dark mathjax"]/A[contains(@class,"is-size-7")]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '编号',
    '关键词',
    '作者链接',
    '作者',
    '摘要'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'EEVEE: Towards Test-time Prompt Learning in the Real World for Self-Improving Agents',
    '标题链接': 'https://arxiv.org/abs/2606.11182',
    '编号': 'arXiv:2606.11182',
    '关键词': 'cs.LG cs.AI',
    '作者链接': 'https://arxiv.org/search/?searchtype=author&query=Xu%2C+W',
    '作者': 'Weixian Xu',
    '摘要': 'In this paper, we propose EEVEE, the first multi-dataset test-time prompt learning framework for LLM agents.'
  });
});

test('protected Smart field cleanup names package publisher and bullet metadata', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/section',
        fullColRate: 1,
        data: [
          ['react', 'react-is'],
          ['https://www.npmjs.com/package/react', 'https://www.npmjs.com/package/react-is'],
          ['React is a JavaScript library for building user interfaces.', 'Brand checking of React Elements.'],
          ['https://gh.io/npm-docs-trusted-publishers', 'https://www.npmjs.com/~ckifer'],
          ['GitHub Actions', 'ckifer'],
          ['• 19.2.7 • 9 days ago • 211991 dependents • MIT', '• 19.2.7 • 9 days ago • 4053 dependents • MIT'],
          ['570,288,918', '1,307,471,149']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/H3[1]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/H3[1]/A[1]', Attribute: 'href' },
          { Name: '8fbbd57d', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'link_链接', RelativeXPath: '/DIV[1]/A[1]', Attribute: 'href' },
          { Name: 'e98ba1cc', RelativeXPath: '/DIV[1]/A[1]', Attribute: 'text' },
          { Name: 'updatedat', RelativeXPath: '/SPAN[1]', Attribute: 'text' },
          { Name: 'counter', RelativeXPath: '/DIV[1]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '描述',
    '发布者链接',
    '发布者',
    '元信息',
    '数量'
  ]);
});

test('protected Smart field cleanup names repository language and extra contributor links', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/article',
        fullColRate: 1,
        data: [
          ['refactoringhq / tolaria', 'yikart / AiToEarn'],
          ['https://github.com/refactoringhq/tolaria', 'https://github.com/yikart/AiToEarn'],
          ['Desktop app to manage markdown knowledge bases', 'Let us use AI to Earn!'],
          ['TypeScript', 'TypeScript'],
          ['https://github.com/refactoringhq/tolaria/stargazers', 'https://github.com/yikart/AiToEarn/stargazers'],
          ['14,548', '20,245'],
          ['https://github.com/apps/github-actions', 'https://github.com/gaozhenqiang'],
          ['829 stars today', '402 stars today']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/A[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/A[1]', Attribute: 'href' },
          { Name: 'colorfgmuted', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'tmpmr', RelativeXPath: '/SPAN[1]/SPAN[2]', Attribute: 'text' },
          { Name: 'stargazers_链接', RelativeXPath: '/A[2]', Attribute: 'href' },
          { Name: 'stars', RelativeXPath: '/A[2]', Attribute: 'text' },
          { Name: 'link_链接', RelativeXPath: '/A[3]', Attribute: 'href' },
          { Name: 'stars_today', RelativeXPath: '/SPAN[2]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '描述',
    '语言',
    '星标链接',
    '星标数',
    '作者链接',
    '今日星标'
  ]);
});

test('protected Smart field cleanup names Stack Overflow stats and user fields', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/div/div',
        fullColRate: 1,
        data: [
          ['Python Geolocation Testing for Local Search Result Verification', 'Python multiprocessing works in but hangs in Windows Server', 'Fixing this error I am fine tuning a model using Unsloth'],
          ['https://stackoverflow.com/questions/79955924/python-geolocation-testing-for-local-search-result-verification', 'https://stackoverflow.com/questions/79954844/python-multiprocessing-works-in-but-hangs-in-windows-server', 'https://stackoverflow.com/questions/79954820/fixing-this-error-i-am-fine-tuning-a-model-using-unsloth'],
          ['0', '0', '-3'],
          ['0', '0', '0'],
          ['votes', 'votes', 'votes'],
          ['answers', 'answers', 'answers'],
          ['19', '71', '47'],
          ['views', 'views', 'views'],
          ['Local SEO has become increasingly complex as search engines personalize results based on geography.', 'I am running a Python script that uses multiprocessing.', 'I am training an Unsloth model in a Google Colab notebook.'],
          ['pythonproxygeolocationhttp-headersranking', 'python', 'pythonperformancemodelartificial-intelligence'],
          ['https://stackoverflow.com/users/32796360/usama-ansari', 'https://stackoverflow.com/users/32524965/husky', 'https://stackoverflow.com/users/3855935/cirsam'],
          ['USAMA Ansari', 'Husky', 'cirsam'],
          ['1', '9', '1'],
          ['asked 39 mins ago', 'asked 7 hours ago', 'asked 9 hours ago']
        ],
        scheme: [
          { Name: '字段', RelativeXPath: '/descendant-or-self::A[contains(@class,"s-link")]//SPAN[1]', Attribute: 'text' },
          { Name: '字段1', RelativeXPath: '/descendant-or-self::A[contains(@class,"s-link")]', Attribute: 'href' },
          { Name: '摘要', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item s-post-summary--stats-item__emphasized"]/SPAN[contains(@class,"s-post-summary--stats-item-number")]', Attribute: 'text' },
          { Name: '编号', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item  "]/SPAN[contains(@class,"s-post-summary--stats-item-number")]', Attribute: 'text' },
          { Name: '摘要2', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item s-post-summary--stats-item__emphasized"]/SPAN[contains(@class,"s-post-summary--stats-item-unit")]', Attribute: 'text' },
          { Name: '摘要3', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item  "]/SPAN[contains(@class,"s-post-summary--stats-item-unit")]', Attribute: 'text' },
          { Name: '编号2', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item "]/SPAN[contains(@class,"s-post-summary--stats-item-number")]', Attribute: 'text' },
          { Name: '摘要5', RelativeXPath: '/descendant-or-self::div[@class="s-post-summary--stats-item "]/SPAN[contains(@class,"s-post-summary--stats-item-unit")]', Attribute: 'text' },
          { Name: '摘要6', RelativeXPath: '/descendant-or-self::DIV[contains(@class,"s-post-summary--content-excerpt")]', Attribute: 'text' },
          { Name: '关键词', RelativeXPath: '/descendant-or-self::UL[contains(@class,"js-post-tag-list-wrapper")]', Attribute: 'text' },
          { Name: '字段2', RelativeXPath: '/descendant-or-self::DIV[contains(@class,"s-user-card s-user-card__minimal")]/A[1]', Attribute: 'href' },
          { Name: 'flexitem', RelativeXPath: '/descendant-or-self::A[@class="flex--item"]//SPAN[1]', Attribute: 'text' },
          { Name: '编号3', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"todo-no-class-here")]', Attribute: 'text' },
          { Name: '时间', RelativeXPath: '/descendant-or-self::TIME[contains(@class,"s-user-card--time")]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '票数',
    '回答数',
    '浏览数',
    '摘要',
    '关键词',
    '作者链接',
    '作者',
    '声望',
    '时间'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'Python Geolocation Testing for Local Search Result Verification',
    '标题链接': 'https://stackoverflow.com/questions/79955924/python-geolocation-testing-for-local-search-result-verification',
    '票数': '0',
    '回答数': '0',
    '浏览数': '19',
    '摘要': 'Local SEO has become increasingly complex as search engines personalize results based on geography.',
    '关键词': 'pythonproxygeolocationhttp-headersranking',
    '作者链接': 'https://stackoverflow.com/users/32796360/usama-ansari',
    '作者': 'USAMA Ansari',
    '声望': '1',
    '时间': 'asked 39 mins ago'
  });
});

test('protected Smart field cleanup names OpenLibrary metadata and drops availability actions', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ul/li',
        fullColRate: 1,
        data: [
          ['Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow', 'Machine learning: a probabilistic perspective', 'Machine learning: the new AI'],
          ['https://openlibrary.org/works/OL20709638W/Hands-On_Machine_Learning_with_Scikit-Learn_Keras_and_TensorFlow?edition=key%3A/books/OL40322335M', 'https://openlibrary.org/works/OL16571885W/Machine_learning?edition=key%3A/books/OL25259559M', 'https://openlibrary.org/works/OL19723604W/Machine_learning?edition=key%3A/books/OL26936724M'],
          ['https://covers.openlibrary.org/b/id/13141163-M.jpg', 'https://covers.openlibrary.org/b/id/14330525-M.jpg', 'https://covers.openlibrary.org/b/id/12660847-M.jpg'],
          ['来自Aurélien Géron', '来自Kevin P. Murphy和Kevin P. Murphy', '来自Ethem Alpaydin'],
          ['https://openlibrary.org/authors/OL3897679A/Aur%C3%A9lien_G%C3%A9ron', 'https://openlibrary.org/authors/OL7102592A/Kevin_P._Murphy', 'https://openlibrary.org/authors/OL1396574A/Ethem_Alpaydin'],
          ['3.6 (9 ratings)', '4.0 (2 ratings)', '3.7 (3 ratings)'],
          ['477 Want to read', '63 Want to read', '45 Want to read'],
          ['首次出版于2019', '首次出版于2012', '首次出版于2016'],
          ['4 个版本', '4 个版本', '4 个版本'],
          ['1 本电子书', '1 本电子书', '2 本电子书'],
          ['查找图书馆', '仅供预览', '仅供预览']
        ],
        scheme: [
          { Name: '标题', RelativeXPath: '/descendant-or-self::A[contains(@class,"results")]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/descendant-or-self::A[contains(@class,"results")]', Attribute: 'href' },
          { Name: '图片', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"bookcover")]//IMG[1]', Attribute: 'src' },
          { Name: '作者', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"bookauthor")]', Attribute: 'text' },
          { Name: '作者链接', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"bookauthor")]//A[1]', Attribute: 'href' },
          { Name: '评分数', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"ratingsByline")]//SPAN[5]', Attribute: 'text' },
          { Name: '评分', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"ratingsByline")][2]', Attribute: 'text' },
          { Name: '引用', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"resultDetails")]//SPAN[1]', Attribute: 'text' },
          { Name: '引用2', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"resultDetails")]/SPAN[2]/A[1]', Attribute: 'text' },
          { Name: '引用3', RelativeXPath: '/descendant-or-self::SPAN[contains(@class,"resultDetails")]/SPAN[3]/A[1]', Attribute: 'text' },
          { Name: '顶', RelativeXPath: '/descendant-or-self::div[@class="searchResultItemCTA-lending"]/DIV[contains(@class,"cta-button-group")]//A[1]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '图片',
    '作者',
    '作者链接',
    '评分数',
    '想读',
    '出版信息',
    '版本',
    '电子书'
  ]);
  assert.deepEqual(candidate.sampleRows[0], {
    '标题': 'Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow',
    '标题链接': 'https://openlibrary.org/works/OL20709638W/Hands-On_Machine_Learning_with_Scikit-Learn_Keras_and_TensorFlow?edition=key%3A/books/OL40322335M',
    '图片': 'https://covers.openlibrary.org/b/id/13141163-M.jpg',
    '作者': 'Aurélien Géron',
    '作者链接': 'https://openlibrary.org/authors/OL3897679A/Aur%C3%A9lien_G%C3%A9ron',
    '评分数': '3.6 (9 ratings)',
    '想读': '477 Want to read',
    '出版信息': '首次出版于2019',
    '版本': '4 个版本',
    '电子书': '1 本电子书'
  });
});

test('protected Smart field cleanup keeps linked story text as title even when it contains prices', () => {
  const [candidate] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/center/table/tr[@class="athing"]',
        fullColRate: 1,
        data: [
          ['1.', '2.', '3.'],
          ['https://github.com/apple/container/blob/main/docs/container-machine.md', 'https://www.anthropic.com/news/claude-fable-5-mythos-5', 'https://arstechnica.com/cars/2026/05/how-do-you-design-a-30000-electric-pickup-inside-fords-skunkworks/'],
          ['macOS Container Machines', 'Claude Fable 5', "How do you design a $30k electric pickup? Inside Ford's skunkworks"],
          ['https://news.ycombinator.com/from?site=github.com/apple', 'https://news.ycombinator.com/from?site=anthropic.com', 'https://news.ycombinator.com/from?site=arstechnica.com'],
          ['github.com/apple', 'anthropic.com', 'arstechnica.com']
        ],
        scheme: [
          { Name: 'rank', RelativeXPath: '/TD[1]/SPAN[1]', Attribute: 'text' },
          { Name: 'titlelink', RelativeXPath: '/TD[3]/SPAN[1]/A[1]', Attribute: 'href' },
          { Name: 'title', RelativeXPath: '/TD[3]/SPAN[1]/A[1]', Attribute: 'text' },
          { Name: 'sitebit comhead_链接', RelativeXPath: '/TD[3]/SPAN[1]/SPAN[1]/A[1]', Attribute: 'href' },
          { Name: 'sitestr', RelativeXPath: '/TD[3]/SPAN[1]/SPAN[1]/A[1]/SPAN[1]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(candidate.fields.map((field) => field.name), [
    '编号',
    '标题链接',
    '标题',
    '来源链接',
    '来源'
  ]);
  assert.equal(candidate.sampleRows[0]['标题'], 'macOS Container Machines');
});

test('protected Smart field cleanup skips sparse ad rows and names job/package/product metadata', () => {
  const [jobs] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/table/tbody/tr',
        fullColRate: 0.7,
        data: [
          ['https://remoteok.com/nomad-health-individual', 'https://remoteok.com/remote-jobs/remote-data-scientist-example-1133043', 'https://remoteok.com/remote-jobs/remote-data-analyst-example-1133044'],
          ['https://remoteok.com/assets/safetywing.png', 'https://cdn.example.com/company-a.png', 'https://cdn.example.com/company-b.png'],
          ['', 'Data Scientist', 'Data Analyst'],
          ['', 'Acme Data', 'Little Caesars Pizza'],
          ['', '🌏 Worldwide', '🌏 Probably worldwide'],
          ['', '💰 Upgrade to Premium to see salary', '💰 Upgrade to Premium to see salary'],
          ['', 'https://remoteok.com/remote-analyst+python-jobs', 'https://remoteok.com/remote-full-stack+python-jobs'],
          ['', 'Analyst', 'Full Stack'],
          ['', '1d', '2d'],
          ['', '🇨🇦 Canada', '🇺🇸 United States']
        ],
        scheme: [
          { Name: '💵_Salary_🎪_Benefits🦴_Sort_by🆕_Latest_jobs💵_Highest_paid👀_Most_viewed✅_Most_applied🔥_Hottest🎪_Most_benefits🐍_Python_❌_Clear_202_results_链接', RelativeXPath: '/TD[1]/A[1]', Attribute: 'href' },
          { Name: '💵_Salary_🎪_Benefits🦴_Sort_by🆕_Latest_jobs💵_Highest_paid👀_Most_viewed✅_Most_applied🔥_Hottest🎪_Most_benefits🐍_Python_❌_Clear_202_results', RelativeXPath: '/TD[1]/A[1]/IMG[1]', Attribute: 'src' },
          { Name: '标题', RelativeXPath: '/TD[2]/A[1]/H2[1]', Attribute: 'text' },
          { Name: '字段', RelativeXPath: '/TD[2]/SPAN[1]', Attribute: 'text' },
          { Name: '字段3', RelativeXPath: '/TD[2]/DIV[1]', Attribute: 'text' },
          { Name: '字段4', RelativeXPath: '/TD[2]/DIV[2]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/TD[3]/A[1]', Attribute: 'href' },
          { Name: '字段5', RelativeXPath: '/TD[3]/A[1]/DIV[1]/H3[1]', Attribute: 'text' },
          { Name: '时间', RelativeXPath: '/TD[4]/TIME[1]', Attribute: 'text' },
          { Name: '标题2', RelativeXPath: '/TD[2]/DIV[1]/A[1]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(jobs.fields.map((field) => field.name), [
    '标题链接',
    '图片',
    '标题',
    '公司',
    '位置',
    '薪资',
    '标签链接',
    '标签',
    '时间',
    '国家'
  ]);
  assert.equal(jobs.sampleRows[0]['标题'], 'Data Scientist');
  assert.equal(jobs.sampleRows[0]['标题链接'], 'https://remoteok.com/remote-jobs/remote-data-scientist-example-1133043');

  const [packages] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ul/li',
        fullColRate: 1,
        data: [
          ['serde', 'serde-saphyr'],
          ['https://crates.io/crates/serde', 'https://crates.io/crates/serde-saphyr'],
          ['v1.0.228', 'v0.0.27'],
          ['A generic serialization/deserialization framework', 'YAML serializer for Serde'],
          ['All-Time Downloads : 1,066,651,755', 'All-Time Downloads : 1,394,154'],
          ['Recent Downloads : 203,004,432', 'Recent Downloads : 1,199,675'],
          ['https://serde.rs/', 'https://docs.rs/serde-saphyr/latest/serde_saphyr/'],
          ['https://docs.rs/serde', 'https://github.com/example/serde-saphyr']
        ],
        scheme: [
          { Name: '标题', RelativeXPath: '/A[1]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/A[1]', Attribute: 'href' },
          { Name: 'version', RelativeXPath: '/SPAN[1]', Attribute: 'text' },
          { Name: '描述', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: '下载', RelativeXPath: '/SPAN[2]', Attribute: 'text' },
          { Name: '下载1', RelativeXPath: '/SPAN[3]', Attribute: 'text' },
          { Name: 'quicklinks_链接', RelativeXPath: '/A[2]', Attribute: 'href' },
          { Name: 'quicklinks_链接2', RelativeXPath: '/A[3]', Attribute: 'href' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(packages.fields.map((field) => field.name), [
    '标题',
    '标题链接',
    '版本',
    '描述',
    '总下载',
    '近期下载',
    '主页链接',
    '文档链接'
  ]);

  const [books] = protectedSmartResultToCandidatesForTesting({
    List: [{
      type: 3,
      sort: 1,
      element: {
        xpath: '/html/body/main/ol/li',
        fullColRate: 1,
        data: [
          ["It's Only the Himalayas", 'Full Moon over Noahs Ark'],
          ['https://books.toscrape.com/catalogue/its-only-the-himalayas_981/index.html', 'https://books.toscrape.com/catalogue/full-moon_811/index.html'],
          ['£45.17', '£49.43'],
          ['In stock', 'In stock']
        ],
        scheme: [
          { Name: '标题', RelativeXPath: '/H3[1]/A[1]', Attribute: 'text' },
          { Name: '标题链接', RelativeXPath: '/H3[1]/A[1]', Attribute: 'href' },
          { Name: 'price', RelativeXPath: '/P[1]', Attribute: 'text' },
          { Name: 'instock', RelativeXPath: '/P[2]', Attribute: 'text' }
        ]
      }
    }]
  }, 1);

  assert.deepEqual(books.fields.map((field) => field.name), ['标题', '标题链接', '价格', '库存状态']);
});

test('goal ranking keeps rich result candidates above label-only blocks', () => {
  const ranked = applyGoalScoresForTesting([
    {
      id: 'protected_smart_2',
      type: 'repeated_card',
      title: 'Protected Smart label block',
      confidence: 0.99,
      selector: '',
      xpath: '/html/body/main/section/div',
      itemSelector: '',
      itemXPath: '/html/body/main/section/div',
      itemCount: 183,
      fields: [
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/main/section/div/p', relativeXPath: './p', samples: ['18 pages. To be published in ICML 2026'] },
        { name: 'hastextblackbis', kind: 'text', selector: '', xpath: '/html/body/main/section/div/b', relativeXPath: './b', samples: ['Authors:', 'Submitted', 'Comments:'] }
      ],
      sampleRows: [
        { '标题': '', hastextblackbis: 'Authors:' },
        { '标题': '18 pages. To be published in ICML 2026', hastextblackbis: '' },
        { '标题': '', hastextblackbis: 'Submitted' }
      ],
      reasons: ['test']
    },
    {
      id: 'protected_smart_1',
      type: 'search_results',
      title: 'Protected Smart paper results',
      confidence: 0.99,
      selector: '',
      xpath: '/html/body/main/ol/li',
      itemSelector: '',
      itemXPath: '/html/body/main/ol/li',
      itemCount: 50,
      fields: [
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['ABC-Bench: An Agentic Bio-Capabilities Benchmark for Biosecurity'] },
        { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['https://arxiv.org/abs/2606.11150'] },
        { name: '摘要', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/p', relativeXPath: './p', samples: ['A benchmark paper with enough abstract text to identify this as a real result row.'] }
      ],
      sampleRows: [
        {
          '标题': 'ABC-Bench: An Agentic Bio-Capabilities Benchmark for Biosecurity',
          '标题链接': 'https://arxiv.org/abs/2606.11150',
          '摘要': 'A benchmark paper with enough abstract text to identify this as a real result row.'
        }
      ],
      reasons: ['test']
    }
  ], '采集页面主要列表数据');

  assert.equal(ranked[0].id, 'protected_smart_1');
});

test('goal ranking keeps rich records above taxonomy filter links', () => {
  const ranked = applyGoalScoresForTesting([
    {
      id: 'protected_smart_5',
      type: 'search_results',
      title: 'Protected Smart taxonomy filters',
      confidence: 0.99,
      selector: '',
      xpath: '/html/body/main/aside',
      itemSelector: '',
      itemXPath: '/html/body/main/aside/a',
      itemCount: 68,
      fields: [
        { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/main/aside/a', relativeXPath: './a', samples: ['https://www.python.org/jobs/type/back-end/', 'https://www.python.org/jobs/type/big-data/'] },
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/main/aside/a', relativeXPath: './a', samples: ['Back end', 'Big Data'] }
      ],
      sampleRows: [
        { '标题链接': 'https://www.python.org/jobs/type/back-end/', '标题': 'Back end' },
        { '标题链接': 'https://www.python.org/jobs/type/big-data/', '标题': 'Big Data' }
      ],
      reasons: ['Detected by protected SmartProxy resource', 'fullColRate=1.00'],
      layout: {
        role: 'main',
        score: 0.84,
        mainScore: 0.84,
        sidebarPenalty: 0,
        boilerplatePenalty: 0,
        visualCoverage: 0.88,
        textDensity: 0.01,
        linkDensity: 0,
        centerDistance: 0.27,
        reasons: []
      }
    },
    {
      id: 'protected_smart_1',
      type: 'search_results',
      title: 'Protected Smart job records',
      confidence: 0.99,
      selector: '',
      xpath: '/html/body/main/ol/li',
      itemSelector: '',
      itemXPath: '/html/body/main/ol/li',
      itemCount: 25,
      fields: [
        { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['https://www.python.org/jobs/8090/', 'https://www.python.org/jobs/8089/'] },
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['Senior Python AI/ML Engineer', 'Founding ML/Data Scientist'] },
        { name: '位置', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/span', relativeXPath: './span', samples: ['Bangalore, Pune, India', 'Remote - London UK, United Kingdom'] },
        { name: '类型', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/em', relativeXPath: './em', samples: ['AI/ML', 'Back end'] },
        { name: '时间', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/time', relativeXPath: './time', samples: ['08 June 2026', '03 June 2026'] }
      ],
      sampleRows: [
        {
          '标题链接': 'https://www.python.org/jobs/8090/',
          '标题': 'Senior Python AI/ML Engineer',
          '位置': 'Bangalore, Pune, India',
          '类型': 'AI/ML',
          '时间': '08 June 2026'
        }
      ],
      reasons: ['Detected by protected SmartProxy resource', 'fullColRate=0.65'],
      layout: {
        role: 'main',
        score: 0.84,
        mainScore: 0.91,
        sidebarPenalty: 0,
        boilerplatePenalty: 0.12,
        visualCoverage: 0.91,
        textDensity: 0.1,
        linkDensity: 0.68,
        centerDistance: 0.2,
        reasons: []
      }
    }
  ], '采集页面主要列表数据');

  assert.equal(ranked[0].id, 'protected_smart_1');
});

test('goal ranking keeps job records above refined category link candidates', () => {
  const categoryCandidate = {
    id: 'fallback_search_results_1',
    type: 'search_results',
    title: 'Refined category links',
    confidence: 0.99,
    selector: '',
    xpath: '/html/body/main/ol/li',
    itemSelector: '',
    itemXPath: '/html/body/main/ol/li',
    itemCount: 24,
    fields: [
      { name: 'title', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/span[3]/a', relativeXPath: './span[3]/a[1]', samples: ['Developer / Engineer', 'Researcher / Scientist', 'Manager / Executive'] },
      { name: 'url', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/span[3]/a', relativeXPath: './span[3]/a[1]', samples: ['https://www.python.org/jobs/category/developer-engineer/', 'https://www.python.org/jobs/category/researcher-scientist/', 'https://www.python.org/jobs/category/manager-executive/'] },
      { name: 'date', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/time', relativeXPath: './span[2]/time[1]', samples: ['08 June 2026', '03 June 2026', '02 June 2026'] },
      { name: 'author', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/span[4]', relativeXPath: './span[4]', samples: ['AI/ML', 'Back end', 'Database'] }
    ],
    sampleRows: [
      {
        title: 'Developer / Engineer',
        url: 'https://www.python.org/jobs/category/developer-engineer/',
        date: '08 June 2026',
        author: 'AI/ML'
      }
    ],
    reasons: ['Sibling elements share the same DOM shape', 'Fields refined from repeated item structure'],
    layout: {
      role: 'main',
      score: 0.82,
      mainScore: 0.9,
      sidebarPenalty: 0,
      boilerplatePenalty: 0.12,
      visualCoverage: 0.91,
      textDensity: 0.1,
      linkDensity: 0.68,
      centerDistance: 0.2,
      reasons: []
    }
  };
  const jobCandidate = {
    id: 'protected_smart_1',
    type: 'search_results',
    title: 'Protected Smart job records',
    confidence: 0.99,
    selector: '',
    xpath: '/html/body/main/ol/li',
    itemSelector: '',
    itemXPath: '/html/body/main/ol/li',
    itemCount: 25,
    fields: [
      { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['https://www.python.org/jobs/8089/', 'https://www.python.org/jobs/8088/'] },
      { name: '描述', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['Founding ML/Data Scientist (Remote, UK)', 'Tech Lead (Python) | Remote - LATAM | Full-time'] },
      { name: '位置', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/span', relativeXPath: './span', samples: ['Remote - London UK, United Kingdom', 'LATAM, LATAM, LATAM'] },
      { name: '类型_链接', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/em/a', relativeXPath: './em/a', samples: ['https://www.python.org/jobs/type/back-end/', 'https://www.python.org/jobs/type/database/'] },
      { name: '时间', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/time', relativeXPath: './time', samples: ['03 June 2026', '02 June 2026'] }
    ],
    sampleRows: [
      {
        '标题链接': 'https://www.python.org/jobs/8089/',
        '描述': 'Founding ML/Data Scientist (Remote, UK)',
        '位置': 'Remote - London UK, United Kingdom',
        '类型_链接': 'https://www.python.org/jobs/type/back-end/',
        '时间': '03 June 2026'
      }
    ],
    reasons: ['Detected by protected SmartProxy resource', 'fullColRate=0.65'],
    layout: {
      ...categoryCandidate.layout,
      score: 0.84,
      mainScore: 0.91
    }
  };

  const ranked = applyGoalScoresForTesting([categoryCandidate, jobCandidate], '采集招聘职位列表');

  assert.equal(ranked[0].id, 'protected_smart_1');
});

test('auto ranking keeps gc-zb announcement records above category navigation', () => {
  const categoryNavCandidate = {
    id: 'protected_smart_4',
    type: 'repeated_card',
    title: 'Protected Smart category navigation',
    confidence: 0.99,
    selector: '',
    xpath: '/html/body/div[4]/div[1]/a',
    itemSelector: '',
    itemXPath: '/html/body/div[4]/div[1]/a',
    itemCount: 45,
    fields: [
      { name: '标题', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[1]/a', relativeXPath: './a', samples: ['招标采购', '前期项目', '结果公告'] },
      { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[1]/a', relativeXPath: './a', samples: ['https://www.gc-zb.com/search.html?cateId=0&ucode=', 'https://www.gc-zb.com/search.html?cateId=2&ucode=', 'https://www.gc-zb.com/search.html?cateId=1&ucode='] }
    ],
    sampleRows: [
      { '标题': '招标采购', '标题链接': 'https://www.gc-zb.com/search.html?cateId=0&ucode=' },
      { '标题': '前期项目', '标题链接': 'https://www.gc-zb.com/search.html?cateId=2&ucode=' },
      { '标题': '结果公告', '标题链接': 'https://www.gc-zb.com/search.html?cateId=1&ucode=' }
    ],
    reasons: ['Detected by protected SmartProxy resource', 'fullColRate=1.00'],
    layout: {
      role: 'main',
      score: 0.86,
      mainScore: 0.86,
      sidebarPenalty: 0,
      boilerplatePenalty: 0,
      visualCoverage: 0.21,
      textDensity: 0.02,
      linkDensity: 0.94,
      centerDistance: 0.2,
      reasons: []
    }
  };
  const announcementCandidate = {
    id: 'protected_smart_3',
    type: 'search_results',
    title: 'Protected Smart announcement records',
    confidence: 0.99,
    selector: '',
    xpath: '/html/body/div[4]/div[2]/ul/li',
    itemSelector: '',
    itemXPath: '/html/body/div[4]/div[2]/ul/li',
    itemCount: 20,
    fields: [
      { name: '标题', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[2]/ul/li/span[1]', relativeXPath: './span[1]', samples: ['[招标公告]', '[招标公告]', '[结果公告]'] },
      { name: '字段', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[2]/ul/li/span[2]', relativeXPath: './span[2]', samples: ['[广东]', '[北京]', '[上海]'] },
      { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[2]/ul/li/a', relativeXPath: './a', samples: ['https://www.gc-zb.com/markinfo/123456789.html', 'https://www.gc-zb.com/markinfo/987654321.html', 'https://www.gc-zb.com/markinfo/456789123.html'] },
      { name: '标题2', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[2]/ul/li/a', relativeXPath: './a', samples: ['PA1大修19台電機檢修-公告', '中国电信北京公司2026年通信工程施工服务招标公告', '上海某项目设备采购中标结果公告'] },
      { name: '时间', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[2]/ul/li/span[3]', relativeXPath: './span[3]', samples: ['2026-06-17', '2026-06-16', '2026-06-15'] }
    ],
    sampleRows: [
      {
        '标题': '[招标公告]',
        '字段': '[广东]',
        '标题链接': 'https://www.gc-zb.com/markinfo/123456789.html',
        '标题2': 'PA1大修19台電機檢修-公告',
        '时间': '2026-06-17'
      },
      {
        '标题': '[招标公告]',
        '字段': '[北京]',
        '标题链接': 'https://www.gc-zb.com/markinfo/987654321.html',
        '标题2': '中国电信北京公司2026年通信工程施工服务招标公告',
        '时间': '2026-06-16'
      }
    ],
    reasons: ['Detected by protected SmartProxy resource', 'fullColRate=0.72'],
    layout: {
      role: 'main',
      score: 0.82,
      mainScore: 0.8,
      sidebarPenalty: 0.02,
      boilerplatePenalty: 0,
      visualCoverage: 0.36,
      textDensity: 0.22,
      linkDensity: 0.54,
      centerDistance: 0.18,
      reasons: []
    }
  };
  const categoryGridCandidate = {
    id: 'protected_smart_2',
    type: 'search_results',
    title: 'Protected Smart category grid',
    confidence: 0.99,
    selector: '',
    xpath: '/html/body/div[4]/div[1]/div',
    itemSelector: '',
    itemXPath: '/html/body/div[4]/div[1]/div',
    itemCount: 6,
    fields: [
      { name: '标题', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[1]', relativeXPath: './a[1]', samples: ['招标采购', 'VIP项目', '招采预测'] },
      { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[1]', relativeXPath: './a[1]', samples: ['https://www.gc-zb.com/search.html?cateId=0&ucode=', 'https://www.gc-zb.com/search.html?cateId=9&ucode=', 'https://www.gc-zb.com/search.html?activeName=seventh&ucode='] },
      { name: '字段', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[2]', relativeXPath: './a[2]', samples: ['前期项目', '独家项目', '渠道拓展'] },
      { name: '链接', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[2]', relativeXPath: './a[2]', samples: ['https://www.gc-zb.com/search.html?cateId=1&ucode=', 'https://www.gc-zb.com/search.html?activeName=eleventh&ucode=', 'https://www.gc-zb.com/ground/channel.html?ucode='] },
      { name: '字段2', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[3]', relativeXPath: './a[3]', samples: ['结果公告', '审批项目', '商机挖掘'] },
      { name: '链接2', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[3]', relativeXPath: './a[3]', samples: ['https://www.gc-zb.com/search.html?cateId=2&ucode=', 'https://www.gc-zb.com/search.html?activeName=eighth&cateId=10&ucode=', 'https://www.gc-zb.com/ground/excavate.html?ucode=&activeName=fifth'] },
      { name: '字段3', kind: 'text', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[4]', relativeXPath: './a[4]', samples: ['变更公告', '环评项目', '市场分析'] },
      { name: '链接3', kind: 'href', selector: '', xpath: '/html/body/div[4]/div[1]/div/a[4]', relativeXPath: './a[4]', samples: ['https://www.gc-zb.com/search.html?cateId=3&ucode=', 'https://www.gc-zb.com/search.html?activeName=eighth&cateId=11&ucode=', 'https://www.gc-zb.com/ground/marketAnalysis.html?ucode='] }
    ],
    sampleRows: [
      {
        '标题': '招标采购',
        '标题链接': 'https://www.gc-zb.com/search.html?cateId=0&ucode=',
        '字段': '前期项目',
        '链接': 'https://www.gc-zb.com/search.html?cateId=1&ucode=',
        '字段2': '结果公告',
        '链接2': 'https://www.gc-zb.com/search.html?cateId=2&ucode=',
        '字段3': '变更公告',
        '链接3': 'https://www.gc-zb.com/search.html?cateId=3&ucode='
      }
    ],
    reasons: ['Detected by protected SmartProxy resource', 'fullColRate=0.67'],
    layout: {
      ...categoryNavCandidate.layout,
      score: 0.82,
      mainScore: 0.89,
      textDensity: 0.18,
      linkDensity: 1
    }
  };

  assert.equal(rankCandidatesForTesting([categoryGridCandidate, categoryNavCandidate, announcementCandidate])[0].id, 'protected_smart_3');
  assert.equal(applyGoalScoresForTesting([categoryGridCandidate, categoryNavCandidate, announcementCandidate], '采集招标公告列表')[0].id, 'protected_smart_3');
});

test('filterDetectedBoilerplateCandidates removes standalone pagination controls', () => {
  const records = {
    id: 'protected_smart_1',
    type: 'table',
    title: 'Team table',
    confidence: 0.98,
    selector: '',
    xpath: '/html/body/main/table/tbody/tr',
    itemSelector: '',
    itemXPath: '/html/body/main/table/tbody/tr',
    itemCount: 25,
    fields: [
      { name: 'team', kind: 'text', selector: '', xpath: '/html/body/main/table/tbody/tr/td[1]', relativeXPath: './td[1]', samples: ['Boston Bruins', 'Buffalo Sabres'] },
      { name: 'year', kind: 'text', selector: '', xpath: '/html/body/main/table/tbody/tr/td[2]', relativeXPath: './td[2]', samples: ['1990', '1990'] },
      { name: 'wins', kind: 'text', selector: '', xpath: '/html/body/main/table/tbody/tr/td[3]', relativeXPath: './td[3]', samples: ['44', '31'] }
    ],
    sampleRows: [{ team: 'Boston Bruins', year: '1990', wins: '44' }],
    reasons: ['Detected by protected SmartProxy resource']
  };
  const pager = {
    id: 'protected_smart_2',
    type: 'search_results',
    title: 'Pagination links',
    confidence: 0.98,
    selector: '',
    xpath: '//ul[contains(@class,"pagination")]/li',
    itemSelector: '',
    itemXPath: '//ul[contains(@class,"pagination")]/li',
    itemCount: 24,
    fields: [
      { name: '来源链接', kind: 'href', selector: '', xpath: '//ul[contains(@class,"pagination")]/li/a', relativeXPath: './a', samples: ['https://example.com/list?page_num=1', 'https://example.com/list?page_num=2', 'https://example.com/list?page_num=3'] },
      { name: '编号', kind: 'text', selector: '', xpath: '//ul[contains(@class,"pagination")]/li/a', relativeXPath: './a', samples: ['1', '2', '3'] }
    ],
    sampleRows: [
      { '来源链接': 'https://example.com/list?page_num=1', '编号': '1' },
      { '来源链接': 'https://example.com/list?page_num=2', '编号': '2' },
      { '来源链接': 'https://example.com/list?page_num=3', '编号': '3' }
    ],
    reasons: ['Detected by protected SmartProxy resource']
  };

  const filtered = filterDetectedBoilerplateCandidates([pager, records]);

  assert.deepEqual(filtered.map((candidate) => candidate.id), ['protected_smart_1']);
});

test('goal ranking keeps real search results above footer/header navigation', () => {
  const ranked = applyGoalScoresForTesting([
    {
      id: 'protected_smart_footer',
      type: 'search_results',
      title: 'Protected Smart footer links',
      confidence: 0.99,
      selector: '',
      xpath: '/html/body/footer',
      itemSelector: '',
      itemXPath: '/html/body/footer/a',
      itemCount: 17,
      fields: [
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/footer/a', relativeXPath: './a', samples: ['About', 'Blog', 'Careers'] },
        { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/footer/a', relativeXPath: './a', samples: ['https://developer.mozilla.org/en-US/about', 'https://developer.mozilla.org/en-US/blog/'] }
      ],
      sampleRows: [
        { '标题': 'About', '标题链接': 'https://developer.mozilla.org/en-US/about' },
        { '标题': 'Blog', '标题链接': 'https://developer.mozilla.org/en-US/blog/' }
      ],
      reasons: ['Detected by protected SmartProxy resource'],
      layout: {
        role: 'footer',
        score: 0.2,
        mainScore: 0.32,
        sidebarPenalty: 0,
        boilerplatePenalty: 0.7,
        visualCoverage: 0.18,
        textDensity: 0.1,
        linkDensity: 0.9,
        centerDistance: 0.2,
        reasons: []
      }
    },
    {
      id: 'fallback_search_results_1',
      type: 'search_results',
      title: 'Search/list results',
      confidence: 0.87,
      selector: '',
      xpath: '/html/body/main/ol',
      itemSelector: '',
      itemXPath: '/html/body/main/ol/li',
      itemCount: 10,
      fields: [
        { name: '标题', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['Fetch API', 'BackgroundFetchManager: fetch() method'] },
        { name: '标题链接', kind: 'href', selector: '', xpath: '/html/body/main/ol/li/a', relativeXPath: './a', samples: ['https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'https://developer.mozilla.org/en-US/docs/Web/API/BackgroundFetchManager/fetch'] },
        { name: '描述', kind: 'text', selector: '', xpath: '/html/body/main/ol/li/p', relativeXPath: './p', samples: ['Find out more about using the Fetch API features in Using Fetch and deferred fetch.'] }
      ],
      sampleRows: [
        {
          '标题': 'Fetch API',
          '标题链接': 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
          '描述': 'Find out more about using the Fetch API features in Using Fetch and deferred fetch.'
        }
      ],
      reasons: ['Fallback detector candidate'],
      layout: {
        role: 'main',
        score: 0.8,
        mainScore: 0.9,
        sidebarPenalty: 0,
        boilerplatePenalty: 0.05,
        visualCoverage: 0.72,
        textDensity: 0.24,
        linkDensity: 0.22,
        centerDistance: 0.12,
        reasons: []
      }
    }
  ], '采集 MDN 搜索结果列表');

  assert.equal(ranked[0].id, 'fallback_search_results_1');
});

test('semantic business detector prefers GoYellow-style business cards over nearby-city SEO links', async () => {
  const page = fakeSearchResultBlockPage({
    elements: [
      {
        tag: 'main',
        attrs: { className: 'result-container-main' },
        rect: { left: 0, top: 80, right: 1200, bottom: 1300 },
        children: [
          {
            tag: 'section',
            attrs: { className: 'result-list' },
            rect: { left: 150, top: 240, right: 930, bottom: 760 },
            children: [
              goYellowBusinessRow(1, 'Förg - Sandner', 'https://www.goyellow.de/home/bauunternehmen-foerg-sandner-bayerisch-gmain--bstl34.html', 'Baugewerbe und Hausbau', 'Obere Bahnhofstr. 3, 83457 Bayerisch Gmain', 'https://www.goyellow.de/images/categories/default-1.svg'),
              goYellowBusinessRow(2, 'Förg Johann Baugeschäft', 'https://www.goyellow.de/home/bauunternehmen-foerg-bayerisch-gmain--31p6l.html', 'Baugewerbe und Hausbau', 'Obere Bahnhofstr. 3, 83457 Bayerisch Gmain', 'https://www.goyellow.de/images/categories/default-5.svg')
            ]
          },
          {
            tag: 'div',
            text: 'Weitere Orte in der Nähe',
            attrs: { className: 'resultlistseolinks toplocalities' },
            rect: { left: 150, top: 950, right: 930, bottom: 1120 },
            children: [
              { tag: 'a', text: 'Bad Reichenhall', attrs: { href: 'https://www.goyellow.de/deutschland/bayern/bad-reichenhall', title: 'Bad Reichenhall' }, rect: { left: 180, top: 990, right: 300, bottom: 1012 } },
              { tag: 'a', text: 'Piding', attrs: { href: 'https://www.goyellow.de/deutschland/bayern/piding', title: 'Piding' }, rect: { left: 180, top: 1018, right: 240, bottom: 1040 } },
              { tag: 'a', text: 'Schneizlreuth', attrs: { href: 'https://www.goyellow.de/deutschland/bayern/schneizlreuth', title: 'Schneizlreuth' }, rect: { left: 180, top: 1046, right: 300, bottom: 1068 } },
              { tag: 'a', text: 'Bischofswiesen', attrs: { href: 'https://www.goyellow.de/deutschland/bayern/bischofswiesen', title: 'Bischofswiesen' }, rect: { left: 180, top: 1074, right: 320, bottom: 1096 } }
            ]
          }
        ]
      }
    ]
  });

  const [business] = await detectSemanticBusinessCardsForTesting(page);

  assert.equal(business.type, 'search_results');
  assert.equal(business.itemCount, 2);
  assert.deepEqual(business.fields.map((field) => field.name), ['business_name', 'detail_url', 'category', 'address', 'logo_url']);
  assert.equal(business.sampleRows[0].business_name, 'Förg - Sandner');
  assert.equal(business.sampleRows[0].address, 'Obere Bahnhofstr. 3, 83457 Bayerisch Gmain');

  const seoLinks = {
    id: 'fallback_search_results_1',
    type: 'search_results',
    title: 'Nearby city links',
    confidence: 0.99,
    selector: 'div.resultlistseolinks',
    xpath: '/html/body/main/div[2]',
    itemSelector: 'a',
    itemXPath: '/html/body/main/div[2]/a',
    itemCount: 4,
    fields: [
      { name: 'title', kind: 'text', selector: 'a', xpath: '/html/body/main/div[2]/a', relativeXPath: '.', samples: ['Bad Reichenhall', 'Piding', 'Schneizlreuth'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/div[2]/a', relativeXPath: '.', samples: ['https://www.goyellow.de/deutschland/bayern/bad-reichenhall', 'https://www.goyellow.de/deutschland/bayern/piding', 'https://www.goyellow.de/deutschland/bayern/schneizlreuth'] }
    ],
    sampleRows: [
      { title: 'Bad Reichenhall', url: 'https://www.goyellow.de/deutschland/bayern/bad-reichenhall' },
      { title: 'Piding', url: 'https://www.goyellow.de/deutschland/bayern/piding' }
    ],
    reasons: ['Fallback detector candidate']
  };
  const ranked = applyGoalScoresForTesting([
    { id: 'semantic_business_1', title: 'Semantic business records', ...business },
    seoLinks
  ], '采集搜索结果列表前10个商家，字段包括商家名称、详情链接、地址、电话、网站、类别/描述');

  assert.equal(ranked[0].id, 'semantic_business_1');
});

test('semantic business detector skips broad result containers that wrap business cards', async () => {
  const page = fakeSearchResultBlockPage({
    elements: [
      {
        tag: 'main',
        attrs: { className: 'result-container-main row' },
        rect: { left: 0, top: 80, right: 1200, bottom: 1300 },
        children: [
          goYellowBusinessRow(1, 'Förg - Sandner', 'https://www.goyellow.de/home/bauunternehmen-foerg-sandner-bayerisch-gmain--bstl34.html', 'Baugewerbe und Hausbau', 'Obere Bahnhofstr. 3, 83457 Bayerisch Gmain', 'https://www.goyellow.de/images/categories/default-1.svg'),
          goYellowBusinessRow(2, 'Förg Johann Baugeschäft', 'https://www.goyellow.de/home/bauunternehmen-foerg-bayerisch-gmain--31p6l.html', 'Baugewerbe und Hausbau', 'Obere Bahnhofstr. 3, 83457 Bayerisch Gmain', 'https://www.goyellow.de/images/categories/default-5.svg')
        ]
      }
    ]
  });

  const [business] = await detectSemanticBusinessCardsForTesting(page);

  assert.equal(business.itemCount, 2);
  assert.equal(business.itemSelector.includes('gyresultrecord'), true);
  assert.equal(business.sampleRows[0].business_name, 'Förg - Sandner');
  assert.equal(business.sampleRows[1].business_name, 'Förg Johann Baugeschäft');
});

test('detectSearchResultBlocks finds MDN-style result cards with title links and summaries', async () => {
  const page = fakeSearchResultBlockPage({
    elements: [
      {
        tag: 'header',
        text: 'References Learn Plus Curriculum Blog',
        attrs: { className: 'top-navigation' },
        rect: { left: 0, top: 0, right: 1200, bottom: 72 },
        children: [
          { tag: 'a', text: 'References', attrs: { href: 'https://developer.mozilla.org/en-US/docs/Web' }, rect: { left: 20, top: 18, right: 110, bottom: 42 } },
          { tag: 'a', text: 'Learn', attrs: { href: 'https://developer.mozilla.org/en-US/learn' }, rect: { left: 120, top: 18, right: 180, bottom: 42 } }
        ]
      },
      {
        tag: 'main',
        attrs: { className: 'search-page' },
        rect: { left: 0, top: 80, right: 1200, bottom: 1100 },
        children: [
          {
            tag: 'section',
            attrs: { className: 'search-results-list' },
            rect: { left: 160, top: 120, right: 980, bottom: 840 },
            children: [
              mdnResultRow(1, 'Fetch API', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'Web APIs', 'Find out more about using the Fetch API features in Using Fetch and deferred fetch.'),
              mdnResultRow(2, 'BackgroundFetchManager: fetch() method', 'https://developer.mozilla.org/en-US/docs/Web/API/BackgroundFetchManager/fetch', 'Web APIs', 'The fetch() method starts a background fetch operation and returns a promise for the registration.'),
              mdnResultRow(3, 'Request: cache property', 'https://developer.mozilla.org/en-US/docs/Web/API/Request/cache', 'HTTP', 'The cache read-only property of the Request interface contains the cache mode of the request.')
            ]
          }
        ]
      }
    ]
  });

  const candidates = await detectSearchResultBlocksForTesting(page);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].type, 'search_results');
  assert.equal(candidates[0].itemCount, 3);
  assert.deepEqual(candidates[0].fields.map((field) => field.name), ['title', 'url', 'summary', 'category']);
  assert.equal(candidates[0].sampleRows[0].title, 'Fetch API');
  assert.match(candidates[0].sampleRows[0].summary, /Using Fetch/);
  assert.match(candidates[0].fields.find((field) => field.name === 'url')?.samples[0], /Fetch_API/);
});

test('detectSearchResultBlocks scans open shadow roots for SPA search results', async () => {
  const page = fakeSearchResultBlockPage({
    elements: [
      {
        tag: 'div',
        attrs: { id: 'content', className: 'site-search' },
        rect: { left: 0, top: 80, right: 1200, bottom: 980 },
        children: [
          {
            tag: 'mdn-site-search',
            attrs: { className: 'mdn-site-search' },
            rect: { left: 120, top: 120, right: 980, bottom: 900 },
            shadow: [
              {
                tag: 'div',
                attrs: { className: 'search-results-list' },
                rect: { left: 160, top: 140, right: 960, bottom: 860 },
                children: [
                  mdnResultRow(1, 'Fetch API', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'Web APIs', 'Find out more about using the Fetch API features in Using Fetch and deferred fetch.'),
                  mdnResultRow(2, 'Window: fetch() method', 'https://developer.mozilla.org/en-US/docs/Web/API/Window/fetch', 'Web APIs', 'The fetch() method starts the process of fetching a resource from the network.'),
                  mdnResultRow(3, 'Request: cache property', 'https://developer.mozilla.org/en-US/docs/Web/API/Request/cache', 'HTTP', 'The cache read-only property of the Request interface contains the cache mode of the request.')
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  const candidates = await detectSearchResultBlocksForTesting(page);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].itemCount, 3);
  assert.match(candidates[0].itemXPath, /mdn-site-search/);
  assert.match(candidates[0].reasons.join(' '), /Shadow DOM/);
  assert.equal(candidates[0].sampleRows[0].title, 'Fetch API');
  assert.match(candidates[0].sampleRows[0].url, /Fetch_API/);
});

test('filterDetectedBoilerplateCandidates removes legal footer records but keeps ordinary link collections', () => {
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

  const filtered = filterDetectedBoilerplateCandidates([footer, links, mixedLegalFooter, layoutFooter]);
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

test('detectPaginationForCandidates does not attach global scroll to sidebar or ad widgets', async () => {
  const main = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Job rows',
    confidence: 0.9,
    selector: '#jobs',
    xpath: '/html/body/main/section',
    itemSelector: 'article.job',
    itemXPath: '/html/body/main/section/article',
    itemCount: 32,
    fields: [
      { name: '标题', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Engineer'] },
      { name: '标题链接', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/jobs/1'] }
    ],
    sampleRows: [{ '标题': 'Engineer', '标题链接': 'https://example.com/jobs/1' }],
    reasons: ['test'],
    layout: {
      role: 'main',
      score: 0.86,
      mainScore: 0.88,
      sidebarPenalty: 0,
      boilerplatePenalty: 0,
      visualCoverage: 0.74,
      textDensity: 0.4,
      linkDensity: 0.3,
      centerDistance: 0.12,
      reasons: []
    }
  };
  const ad = {
    ...main,
    id: 'protected_smart_ad',
    title: 'Ad tags',
    itemCount: 3,
    fields: [
      { name: '标题', kind: 'text', selector: 'a', xpath: '/html/body/aside/a', relativeXPath: './a', samples: ['Design', 'Sys Admin', 'VFX'] },
      { name: '标签链接', kind: 'href', selector: 'a', xpath: '/html/body/aside/a', relativeXPath: './a', samples: ['https://example.com/tags/design'] }
    ],
    sampleRows: [{ '标题': 'Design', '标签链接': 'https://example.com/tags/design' }],
    layout: {
      role: 'ad',
      score: 0.2,
      mainScore: 0.2,
      sidebarPenalty: 0.6,
      boilerplatePenalty: 0.2,
      visualCoverage: 0.04,
      textDensity: 0.2,
      linkDensity: 0.9,
      centerDistance: 0.8,
      reasons: []
    }
  };
  const page = fakePaginationPage({
    bodyHeight: 5200,
    viewportHeight: 900,
    itemXPath: main.itemXPath,
    rows: Array.from({ length: main.itemCount }, (_, index) => ({
      text: `Job ${index + 1}`,
      rect: { left: 80, top: 100 + index * 90, right: 720, bottom: 160 + index * 90 },
      children: []
    }))
  });

  const [mainWithPagination, adWithPagination] = await detectPaginationForCandidatesForTesting(page, [main, ad], {
    snapshots: [],
    sawActiveLoadMore: false,
    sawGrowth: true,
    maxArticleLikeCount: 64,
    maxContentHeight: 15000,
    maxPageHeight: 7800,
    grewArticleLikeCount: 32,
    grewContentHeight: 7000,
    grewPageHeight: 2400,
    reachedBottom: false
  });

  assert.equal(mainWithPagination.pagination.type, 'scroll');
  assert.equal(adWithPagination.pagination, undefined);
});

test('detectPaginationForCandidates does not infer scroll for already-complete large static lists', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Top ranked movies',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 250,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test']
  };
  const page = fakePaginationPage({
    bodyHeight: 32000,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows: Array.from({ length: candidate.itemCount }, (_, index) => ({
      text: `Movie ${index + 1}`,
      rect: { left: 80, top: 100 + index * 120, right: 720, bottom: 190 + index * 120 },
      children: []
    }))
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: true,
    sawGrowth: true,
    maxArticleLikeCount: 977,
    maxContentHeight: 9000,
    maxPageHeight: 32000,
    grewArticleLikeCount: 727,
    grewContentHeight: 6316,
    grewPageHeight: 3051,
    reachedBottom: false,
    bestActiveLoadMoreText: 'See more information about The Godfather',
    bestActiveLoadMoreXPath: '/html/body/main/section/article[2]/button[1]'
  });

  assert.equal(withPagination.pagination, undefined);
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

test('detectPaginationForCandidates does not attach global next pager to sidebar candidates', async () => {
  const main = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Primary rows',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 25,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
    reasons: ['test'],
    layout: {
      role: 'main',
      score: 0.8,
      mainScore: 0.8,
      sidebarPenalty: 0,
      boilerplatePenalty: 0,
      visualCoverage: 0.6,
      textDensity: 0.4,
      linkDensity: 0.4,
      centerDistance: 0.1,
      reasons: []
    }
  };
  const sidebar = {
    ...main,
    id: 'protected_smart_sidebar',
    title: 'Sidebar links',
    xpath: '/html/body/aside/ul/li',
    itemXPath: '/html/body/aside/ul/li',
    itemCount: 12,
    sampleRows: [{ title: 'how-to document', url: 'https://example.com/howto' }],
    layout: {
      role: 'sidebar',
      score: 0.35,
      mainScore: 0.35,
      sidebarPenalty: 0.52,
      boilerplatePenalty: 0.05,
      visualCoverage: 0.08,
      textDensity: 0.2,
      linkDensity: 0.9,
      centerDistance: 0.74,
      reasons: []
    }
  };
  const rows = Array.from({ length: main.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 80, right: 720, bottom: 160 + index * 80 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 2600,
    viewportHeight: 900,
    itemXPath: main.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'page active', ariaCurrent: 'page' }, rect: { left: 300, top: 2220, right: 330, bottom: 2250 } },
      { text: '2', attrs: { className: 'page' }, rect: { left: 340, top: 2220, right: 370, bottom: 2250 } },
      { text: 'Next', attrs: { className: 'page next' }, rect: { left: 380, top: 2220, right: 450, bottom: 2250 } }
    ]
  });

  const [mainWithPagination, sidebarWithPagination] = await detectPaginationForCandidatesForTesting(page, [main, sidebar]);

  assert.equal(mainWithPagination.pagination.type, 'next_page');
  assert.equal(sidebarWithPagination.pagination, undefined);
});

test('sanitizeCandidatePaginationByLayout removes global pagination from non-main candidates', () => {
  const pagination = {
    type: 'next_page',
    xpath: '//a[normalize-space(.)="Next"]',
    text: 'Next',
    confidence: 0.94,
    isAjax: false,
    scope: 'global',
    reasons: ['numeric pager sequence']
  };
  const main = {
    id: 'main',
    type: 'search_results',
    title: 'Main list',
    confidence: 0.9,
    selector: '#main',
    xpath: '/html/body/main/section',
    itemSelector: 'article',
    itemXPath: '/html/body/main/section/article',
    itemCount: 25,
    fields: [{ name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] }],
    sampleRows: [{ title: 'Alpha' }],
    reasons: ['test'],
    pagination: { ...pagination, scope: 'near_list' },
    layout: {
      role: 'main',
      score: 0.8,
      mainScore: 0.8,
      sidebarPenalty: 0,
      boilerplatePenalty: 0,
      visualCoverage: 0.6,
      textDensity: 0.4,
      linkDensity: 0.4,
      centerDistance: 0.1,
      reasons: []
    }
  };
  const sidebar = {
    ...main,
    id: 'sidebar',
    title: 'Sidebar images',
    itemCount: 16,
    fields: [{ name: '图片', kind: 'src', selector: 'img', xpath: '/html/body/aside/img', relativeXPath: './img', samples: ['https://example.com/logo.png'] }],
    sampleRows: [{ '图片': 'https://example.com/logo.png' }],
    pagination,
    layout: {
      role: 'sidebar',
      score: 0.35,
      mainScore: 0.35,
      sidebarPenalty: 0.52,
      boilerplatePenalty: 0.05,
      visualCoverage: 0.08,
      textDensity: 0.2,
      linkDensity: 0.9,
      centerDistance: 0.74,
      reasons: []
    }
  };
  const footer = {
    ...sidebar,
    id: 'footer',
    title: 'Footer links',
    layout: {
      ...sidebar.layout,
      role: 'footer',
      sidebarPenalty: 0,
      boilerplatePenalty: 0.62
    }
  };

  const [mainOut, sidebarOut, footerOut] = sanitizeCandidatePaginationByLayoutForTesting([main, sidebar, footer]);

  assert.equal(mainOut.pagination.type, 'next_page');
  assert.equal(sidebarOut.pagination, undefined);
  assert.equal(footerOut.pagination, undefined);
});

test('detectPaginationForCandidates falls back to candidate-scoped bottom pager scan', async () => {
  const candidate = {
    id: 'protected_smart_1',
    type: 'table',
    title: 'Team table',
    confidence: 0.9,
    selector: '#teams',
    xpath: '/html/body/main/table/tbody/tr',
    itemSelector: 'tr.team',
    itemXPath: '/html/body/main/table/tbody/tr',
    itemCount: 25,
    fields: [
      { name: 'team', kind: 'text', selector: 'td.name', xpath: '/html/body/main/table/tbody/tr/td[1]', relativeXPath: './td[1]', samples: ['Boston Bruins'] },
      { name: 'year', kind: 'text', selector: 'td.year', xpath: '/html/body/main/table/tbody/tr/td[2]', relativeXPath: './td[2]', samples: ['1990'] }
    ],
    sampleRows: [{ team: 'Boston Bruins', year: '1990' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    tag: 'tr',
    text: `Team ${index + 1} 1990`,
    attrs: { className: 'team' },
    rect: { left: 390, top: 500 + index * 37, right: 1530, bottom: 532 + index * 37 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 1800,
    viewportHeight: 1200,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      ...Array.from({ length: 24 }, (_, index) => ({
        tag: 'a',
        text: String(index + 1),
        attrs: { href: `https://example.com/forms/?page_num=${index + 1}`, className: index === 0 ? 'page active' : 'page' },
        rect: { left: 405 + index * 36, top: 1460, right: 438 + index * 36, bottom: 1494 }
      })),
      { tag: 'a', text: '»', attrs: { href: 'https://example.com/forms/?page_num=2', className: 'page next', 'aria-label': 'Next' }, rect: { left: 405, top: 1494, right: 438, bottom: 1528 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'next_page');
  assert.equal(withPagination.pagination.scope, 'near_list');
  assert.match(withPagination.pagination.text, /»|2/);
  assert.match(withPagination.pagination.reasons.join(' '), /candidate-scoped fallback pagination scan/);
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

test('detectPaginationForCandidates finds compact sibling bottom numeric pager', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Book results',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/section',
    itemSelector: 'article.book',
    itemXPath: '/html/body/section/article',
    itemCount: 20,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/section/article/h3', relativeXPath: './h3', samples: ['The Hobbit'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/section/article/a', relativeXPath: './a', samples: ['https://example.com/books/1'] },
      { name: 'summary', kind: 'text', selector: 'p', xpath: '/html/body/section/article/p', relativeXPath: './p', samples: ['4.3 rating, 3809 want to read'] }
    ],
    sampleRows: [{ title: 'The Hobbit', url: 'https://example.com/books/1', summary: '4.3 rating, 3809 want to read' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Book ${index + 1}`,
    rect: { left: 170, top: 140 + index * 112, right: 760, bottom: 226 + index * 112 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 3300,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows,
    external: [
      { text: '1', attrs: { className: 'current', ariaCurrent: 'page' }, rect: { left: 540, top: 2460, right: 558, bottom: 2482 } },
      { text: '2', attrs: {}, rect: { left: 576, top: 2460, right: 594, bottom: 2482 } },
      { text: '3', attrs: {}, rect: { left: 612, top: 2460, right: 630, bottom: 2482 } },
      { text: '4', attrs: {}, rect: { left: 648, top: 2460, right: 666, bottom: 2482 } },
      { text: '...', attrs: {}, rect: { left: 684, top: 2460, right: 710, bottom: 2482 } },
      { text: '93', attrs: {}, rect: { left: 728, top: 2460, right: 752, bottom: 2482 } },
      { text: '>', attrs: { href: 'https://example.com/search?page=2' }, rect: { left: 772, top: 2460, right: 790, bottom: 2482 } }
    ]
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination.type, 'next_page');
  assert.equal(withPagination.pagination.scope, 'near_list');
  assert.match(withPagination.pagination.text, /^(2|>)$/);
  assert.match(withPagination.pagination.reasons.join(' '), /numeric pager sequence|pager arrow after numeric pages|candidate-scoped fallback/);
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

test('pagination filter rejects per-record see-more expanders', () => {
  assert.equal(isPlausiblePaginationOptionForTesting({
    type: 'load_more',
    xpath: '/html/body/main/ul/li[2]/button[1]',
    text: 'See more information about The Godfather',
    confidence: 0.94,
    isAjax: true,
    scope: 'near_list',
    reasons: ['Detected by protected SmartProxy pagination']
  }), false);

  assert.equal(isPlausiblePaginationOptionForTesting({
    type: 'load_more',
    xpath: '//button[contains(normalize-space(.), "Show more results")]',
    text: 'Show more results',
    confidence: 0.7,
    isAjax: true,
    scope: 'global',
    reasons: ['load-more text or attributes']
  }), true);
});

test('detectPaginationForCandidates drops protected per-record see-more pagination', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Movie rows',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 25,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['The Godfather'] },
      { name: 'url', kind: 'href', selector: 'a', xpath: '/html/body/main/section/article/a', relativeXPath: './a', samples: ['https://example.com/title/tt0068646'] }
    ],
    sampleRows: [{ title: 'The Godfather', url: 'https://example.com/title/tt0068646' }],
    reasons: ['test'],
    pagination: {
      type: 'load_more',
      xpath: '/html/body/main/section/article[2]/button[1]',
      text: 'See more information about The Godfather',
      confidence: 0.94,
      isAjax: true,
      scope: 'near_list',
      reasons: ['Detected by protected SmartProxy pagination']
    }
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Movie ${index + 1}`,
    rect: { left: 80, top: 100 + index * 80, right: 720, bottom: 160 + index * 80 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 2600,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate]);

  assert.equal(withPagination.pagination, undefined);
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

test('detectPaginationForCandidates ignores menu-like see-more text from scroll probe', async () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Reference rows',
    confidence: 0.9,
    selector: '#results',
    xpath: '/html/body/main/section',
    itemSelector: 'article.result',
    itemXPath: '/html/body/main/section/article',
    itemCount: 10,
    fields: [
      { name: 'title', kind: 'text', selector: 'h3', xpath: '/html/body/main/section/article/h3', relativeXPath: './h3', samples: ['Alpha'] }
    ],
    sampleRows: [{ title: 'Alpha' }],
    reasons: ['test']
  };
  const rows = Array.from({ length: candidate.itemCount }, (_, index) => ({
    text: `Result ${index + 1}`,
    rect: { left: 80, top: 100 + index * 70, right: 720, bottom: 150 + index * 70 },
    children: []
  }));
  const page = fakePaginationPage({
    bodyHeight: 2200,
    viewportHeight: 900,
    itemXPath: candidate.itemXPath,
    rows
  });

  const [withPagination] = await detectPaginationForCandidatesForTesting(page, [candidate], {
    snapshots: [],
    sawActiveLoadMore: true,
    sawGrowth: true,
    maxArticleLikeCount: 10,
    maxContentHeight: 9000,
    maxPageHeight: 2800,
    grewArticleLikeCount: 0,
    grewContentHeight: 3000,
    grewPageHeight: 600,
    bestActiveLoadMoreText: 'Tutorials References Exercises Certificates Menu Search field See More Sign In Upgrade Spaces Practice',
    bestActiveLoadMoreXPath: '/html/body/header/div[1]'
  });

  assert.notEqual(withPagination.pagination?.type, 'load_more');
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
  const options = detectOptionsForSearchScoring('https://www.csdn.net/', 'openai');
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

test('dismissPageObstructionsForTesting closes dismissible premium overlays', async () => {
  const page = fakeObstructionPage({
    bodyHeight: 2200,
    viewportHeight: 900,
    topElementId: 'premium-modal',
    elements: [
      {
        tag: 'main',
        text: 'Remote developer jobs Senior Engineer Backend Developer',
        attrs: { id: 'jobs' },
        rect: { left: 0, top: 0, right: 1200, bottom: 1600 },
        style: { position: 'static', zIndex: 'auto' },
        children: []
      },
      {
        tag: 'div',
        text: 'Unlock your remote career potential with Remote OK Premium Get instant access',
        attrs: { id: 'premium-modal', className: 'modal premium overlay', role: 'dialog' },
        rect: { left: 320, top: 140, right: 980, bottom: 760 },
        style: { position: 'fixed', zIndex: '1000' },
        children: [
          {
            tag: 'button',
            text: '×',
            attrs: { className: 'close' },
            rect: { left: 940, top: 150, right: 970, bottom: 180 },
            style: { position: 'static', zIndex: 'auto' }
          }
        ]
      }
    ]
  });

  const detected = await detectPageObstructionsForTesting(page);
  assert.equal(detected[0]?.type, 'paywall');
  assert.equal(detected[0]?.canHide, true);

  const results = await dismissPageObstructionsForTesting(page);

  assert.equal(results.length, 1, results);
  assert.equal(results[0].type, 'paywall');
  assert.equal(results[0].action, 'click');
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

test('auto detect does not prompt for manual login intervention just because the terminal is interactive', () => {
  assert.equal(shouldPromptForLoginInterventionForTesting(detectOptionsForSearchScoring('https://www.baidu.com/', '李小龙')), false);
  assert.equal(shouldPromptForLoginInterventionForTesting({
    ...detectOptionsForSearchScoring('https://www.baidu.com/', '李小龙'),
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

test('augmentAdjacentMetadataFieldsForTesting adds split-row forum metadata', async () => {
  const candidate = {
    id: 'protected_smart_1',
    type: 'search_results',
    title: 'Split row stories',
    confidence: 0.98,
    selector: '',
    xpath: '//table/tbody/tr[contains(@class,"item")]',
    itemSelector: '',
    itemXPath: '//table/tbody/tr[contains(@class,"item")]',
    itemCount: 3,
    fields: [
      { name: '编号', kind: 'text', selector: '', xpath: '//table/tbody/tr/td[1]/span', relativeXPath: './td[1]/span[1]', samples: ['1.', '2.', '3.'] },
      { name: '标题链接', kind: 'href', selector: '', xpath: '//table/tbody/tr/td[2]/a', relativeXPath: './td[2]/a[1]', samples: ['https://example.com/1'] },
      { name: '标题', kind: 'text', selector: '', xpath: '//table/tbody/tr/td[2]/a', relativeXPath: './td[2]/a[1]', samples: ['Alpha launch'] }
    ],
    sampleRows: [
      { '编号': '1.', '标题链接': 'https://example.com/1', '标题': 'Alpha launch' },
      { '编号': '2.', '标题链接': 'https://example.com/2', '标题': 'Beta release' },
      { '编号': '3.', '标题链接': 'https://example.com/3', '标题': 'Gamma notes' }
    ],
    reasons: ['Detected by protected SmartProxy resource']
  };
  const page = fakeRefinePage({
    itemXPath: candidate.itemXPath,
    itemRowIndexes: [0, 2, 4],
    rows: [
      storyTitleRow(0, '1.', 'Alpha launch', 'https://example.com/1'),
      storyMetadataRow(0, '468 points', 'alice', '8 hours ago', '175 comments'),
      storyTitleRow(1, '2.', 'Beta release', 'https://example.com/2'),
      storyMetadataRow(1, '132 points', 'bob', '4 hours ago', '25 comments'),
      storyTitleRow(2, '3.', 'Gamma notes', 'https://example.com/3'),
      storyMetadataRow(2, '147 points', 'carol', '59 minutes ago', '29 comments')
    ]
  });

  const [augmented] = await augmentAdjacentMetadataFieldsForTesting(page, [candidate]);

  assert.deepEqual(augmented.fields.slice(-4).map((field) => field.name), ['score', 'author', 'date', 'comments']);
  assert.equal(augmented.fields.find((field) => field.name === 'score')?.relativeXPath, './following-sibling::*[1]/td[2]/span[1]');
  assert.equal(augmented.fields.find((field) => field.name === 'author')?.relativeXPath, './following-sibling::*[1]/td[2]/a[1]');
  assert.equal(augmented.fields.find((field) => field.name === 'date')?.relativeXPath, './following-sibling::*[1]/td[2]/span[2]');
  assert.equal(augmented.fields.find((field) => field.name === 'comments')?.relativeXPath, './following-sibling::*[1]/td[2]/a[2]');
  assert.deepEqual(augmented.sampleRows[0], {
    '编号': '1.',
    '标题链接': 'https://example.com/1',
    '标题': 'Alpha launch',
    score: '468 points',
    author: 'alice',
    date: '8 hours ago',
    comments: '175 comments'
  });
});

test('augmentAdjacentMetadataFieldsForTesting keeps partial metadata rows aligned', async () => {
  const candidate = {
    id: 'protected_smart_1',
    type: 'search_results',
    title: 'Split row stories',
    confidence: 0.98,
    selector: '',
    xpath: '//table/tbody/tr[contains(@class,"item")]',
    itemSelector: '',
    itemXPath: '//table/tbody/tr[contains(@class,"item")]',
    itemCount: 4,
    fields: [
      { name: '编号', kind: 'text', selector: '', xpath: '//table/tbody/tr/td[1]/span', relativeXPath: './td[1]/span[1]', samples: ['1.', '2.', '3.'] },
      { name: '标题链接', kind: 'href', selector: '', xpath: '//table/tbody/tr/td[2]/a', relativeXPath: './td[2]/a[1]', samples: ['https://example.com/1'] },
      { name: '标题', kind: 'text', selector: '', xpath: '//table/tbody/tr/td[2]/a', relativeXPath: './td[2]/a[1]', samples: ['Alpha launch'] }
    ],
    sampleRows: [
      { '编号': '1.', '标题链接': 'https://example.com/1', '标题': 'Alpha launch' },
      { '编号': '2.', '标题链接': 'https://example.com/2', '标题': 'Beta release' },
      { '编号': '3.', '标题链接': 'https://example.com/3', '标题': 'Gamma notes' },
      { '编号': '4.', '标题链接': 'https://example.com/4', '标题': 'Delta notes' }
    ],
    reasons: ['Detected by protected SmartProxy resource']
  };
  const page = fakeRefinePage({
    itemXPath: candidate.itemXPath,
    itemRowIndexes: [0, 1, 3, 5],
    rows: [
      storyTitleRow(0, '1.', 'Alpha launch', 'https://example.com/1'),
      storyTitleRow(1, '2.', 'Beta release', 'https://example.com/2'),
      storyMetadataRow(1, '132 points', 'bob', '4 hours ago', '25 comments'),
      storyTitleRow(2, '3.', 'Gamma notes', 'https://example.com/3'),
      storyMetadataRow(2, '147 points', 'carol', '59 minutes ago', '29 comments'),
      storyTitleRow(3, '4.', 'Delta notes', 'https://example.com/4'),
      storyMetadataRow(3, '91 points', 'dana', '31 minutes ago', '11 comments')
    ]
  });

  const [augmented] = await augmentAdjacentMetadataFieldsForTesting(page, [candidate]);

  assert.equal(augmented.sampleRows[0].score, undefined);
  assert.equal(augmented.sampleRows[1].score, '132 points');
  assert.equal(augmented.sampleRows[1].author, 'bob');
  assert.equal(augmented.sampleRows[2].author, 'carol');
});

test('buildTaskFromCandidate creates a local task JSON payload accepted by task provider shape', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'detected_example',
    taskName: 'Detected Example',
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

  assert.equal(task.taskId, 'detected_example');
  assert.deepEqual(task.fieldNames, ['title', 'url']);
  assert.match(task.xml, /<ns0:NavigateAction/);
  assert.match(task.xml, /<ns0:NavigateAction[^>]*x:Name="Navigate1"[^>]*Name="Navigate1"/);
  assert.match(task.xml, /<ns0:LoopAction/);
  assert.match(task.xml, /<ns0:LoopAction[^>]*x:Name="LoopItems"[^>]*Name="LoopItems"/);
  assert.match(task.xml, /LoopType="VarilableItemList"/);
  assert.match(task.xml, /<ns0:ExtractDataAction/);
  assert.match(task.xml, /<ns0:ExtractDataAction[^>]*x:Name="ExtractItems"[^>]*Name="ExtractItems"/);
  assert.match(task.xml, /&lt;Name&gt;title&lt;\/Name&gt;/);
  assert.match(task.xml, /&lt;ExtractType&gt;ExtractText&lt;\/ExtractType&gt;/);
  assert.match(task.xml, /&lt;Name&gt;url&lt;\/Name&gt;/);
  assert.match(task.xml, /ExtractHref/);
  assert.match(task.xml, /&lt;RelativeXpath&gt;\/a\[1\]&lt;\/RelativeXpath&gt;/);
  assert.doesNotMatch(task.xml, /&lt;RelativeXpath&gt;\.\/a\[1\]&lt;\/RelativeXpath&gt;/);
});

test('buildTaskFromCandidate preserves sibling-axis relative extraction fields', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/news',
    taskId: 'detected_split_rows',
    taskName: 'Detected Split Rows',
    candidate: {
      id: 'protected_smart_1',
      type: 'search_results',
      title: 'Split rows',
      confidence: 0.9,
      selector: '',
      xpath: '//table/tbody/tr[contains(@class,"item")]',
      itemSelector: '',
      itemXPath: '//table/tbody/tr[contains(@class,"item")]',
      itemCount: 3,
      fields: [
        { name: 'title', kind: 'text', selector: 'a', xpath: '//table/tbody/tr/td[2]/a', relativeXPath: './td[2]/a[1]', samples: ['Alpha'] },
        { name: 'score', kind: 'text', selector: 'span', xpath: '//table/tbody/tr/following-sibling::*[1]/td[2]/span[1]', relativeXPath: './following-sibling::*[1]/td[2]/span[1]', samples: ['468 points'] }
      ],
      sampleRows: [{ title: 'Alpha', score: '468 points' }],
      reasons: ['test']
    }
  });

  assert.deepEqual(task.fieldNames, ['title', 'score']);
  assert.match(task.xml, /&lt;Name&gt;score&lt;\/Name&gt;/);
  assert.match(task.xml, /&lt;RelativeXpath&gt;following-sibling::\*\[1\]\/td\[2\]\/span\[1\]&lt;\/RelativeXpath&gt;/);
  assert.doesNotMatch(task.xml, /&lt;RelativeXpath&gt;\/following-sibling::/);
});

test('buildTaskFromCandidate preserves search input and submit actions before extraction', () => {
  const task = buildTaskFromCandidate({
    url: 'https://www.baidu.com/s?wd=%E6%9D%8E%E5%B0%8F%E9%BE%99',
    taskId: 'detected_baidu_search',
    taskName: 'Detected Baidu Search',
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

  assert.equal(task.detection.url, 'https://www.baidu.com/s?wd=%E6%9D%8E%E5%B0%8F%E9%BE%99');
  assert.equal(task.detection.search?.startUrl, 'https://www.baidu.com/');
  assert.equal(task.detection.search?.inputs[0]?.xpath, '/html[1]/body[1]/div[1]/form[1]/span[1]/input[1]');
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
    taskId: 'detected_enter_search',
    taskName: 'Detected Enter Search',
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
    taskId: 'detected_same_url_search',
    taskName: 'Detected Same URL Search',
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
    taskId: 'detected_popup',
    taskName: 'Detected Popup',
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
  assert.equal(task.detection.popupDismissals.length, 2);
});

test('buildTaskFromCandidate only emits paywall dismissal clicks after manual confirmation', () => {
  const candidate = {
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
  };

  const unconfirmed = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'detected_popup_unconfirmed',
    taskName: 'Detected Popup Unconfirmed',
    candidate,
    popupDismissals: [
      {
        type: 'paywall',
        action: 'click',
        xpath: '/html[1]/body[1]/div[2]/button[1]',
        text: '×',
        confidence: 0.9,
        removed: true,
        reasons: ['auto detected paywall']
      }
    ]
  });

  const confirmed = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'detected_popup_confirmed',
    taskName: 'Detected Popup Confirmed',
    candidate,
    popupDismissals: [
      {
        type: 'paywall',
        action: 'click',
        xpath: '/html[1]/body[1]/div[2]/button[1]',
        text: '×',
        confidence: 0.9,
        removed: true,
        confirmedByUser: true,
        reasons: ['confirmed by manual popup prompt']
      }
    ]
  });

  assert.doesNotMatch(unconfirmed.xml, /Dismiss paywall popup/);
  assert.match(confirmed.xml, /x:Name="DismissPopup1"/);
  assert.match(confirmed.xml, /Caption="Dismiss paywall popup"/);
});

test('buildTaskFromCandidate stores only a browser session reference', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'detected_session',
    taskName: 'Detected Session',
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

  assert.deepEqual(task.detection.session, {
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
    agentScreenshot: {
      path: '/tmp/example.full.png',
      fullPage: true,
      annotatedPath: '/tmp/example.full.annotated.png',
      candidateScreenshots: [
        {
          candidateId: 'search_results_1',
          path: '/tmp/example.search_results_1.crop.png',
          rank: 1,
          boundingBox: { x: 10, y: 20, width: 300, height: 200 }
        }
      ]
    },
    pageVisualElements: [
      {
        id: 'pv_1_main_missing_title',
        scope: 'page',
        source: 'page_visible_dom',
        annotationLabel: 'P1',
        label: 'link:Missing candidate title',
        tagName: 'a',
        kind: 'text',
        role: 'link',
        selector: 'a.result-title',
        xpath: '/html[1]/body[1]/main[1]/section[1]/article[1]/a[1]',
        boundingBox: { x: 60, y: 360, width: 280, height: 28 },
        visible: true,
        clickable: true,
        sample: 'Missing candidate title',
        samples: ['Missing candidate title'],
        samplesByKind: {
          text: ['Missing candidate title'],
          href: ['https://example.com/missing']
        },
        attributes: { href: 'https://example.com/missing' },
        confidence: 0.91,
        regionRole: 'main'
      }
    ],
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
        visualElements: [
          {
            id: 've_search_results_1_1_price',
            candidateId: 'search_results_1',
            scope: 'visible_dom',
            source: 'visible_dom',
            annotationLabel: 'V1',
            label: 'text:$19.99',
            tagName: 'span',
            kind: 'text',
            role: 'text',
            selector: 'span.price',
            xpath: '/html[1]/body[1]/main[1]/div//span[1]',
            relativeXPath: './span[1]',
            boundingBox: { x: 40, y: 90, width: 80, height: 20 },
            visible: true,
            clickable: false,
            sample: '$19.99',
            samples: ['$19.99', '$29.99'],
            samplesByKind: { text: ['$19.99', '$29.99'] },
            rowCoverage: { matchedRows: 2, filledRows: 2, totalRows: 2, fillRate: 1 },
            confidence: 0.86
          }
        ],
        sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
        reasons: ['test']
      }
    ]
  }, '采新闻列表');

  assert.equal(context.schemaVersion, 'octopus.detect.agent-context.v1');
  assert.equal(context.goal, '采新闻列表');
  assert.equal(context.recommendedCandidateId, 'search_results_1');
  assert.equal(context.screenshot.path, '/tmp/example.full.png');
  assert.equal(context.screenshot.annotatedPath, '/tmp/example.full.annotated.png');
  assert.equal(context.visualArtifacts.annotatedScreenshotPath, '/tmp/example.full.annotated.png');
  assert.equal(context.visualArtifacts.candidateScreenshots[0].path, '/tmp/example.search_results_1.crop.png');
  assert.equal(context.pageVisualElements[0].id, 'pv_1_main_missing_title');
  assert.equal(context.pageVisualElements[0].annotationLabel, 'P1');
  assert.ok(context.visualElements.length >= 2);
  assert.equal(context.visualElements[0].candidateId, 'search_results_1');
  assert.equal(context.visualElements[0].fieldName, 'title');
  assert.equal(context.visualElements[0].id, context.candidates[0].fields[0].elementId);
  assert.equal(context.visualElements[0].fieldId, context.candidates[0].fields[0].fieldId);
  assert.equal(context.visualElements[0].scope, 'field');
  assert.equal(context.visualElements[0].role, 'text');
  assert.equal(context.visualElements[1].role, 'link');
  const visibleDom = context.visualElements.find((item) => item.source === 'visible_dom');
  assert.equal(visibleDom.annotationLabel, 'V1');
  assert.equal(visibleDom.label, 'text:$19.99');
  assert.equal(visibleDom.rowCoverage.fillRate, 1);
  assert.equal(context.decisionSummary.recommendedCandidateId, 'search_results_1');
  assert.equal(context.decisionSummary.candidates[0].candidateId, 'search_results_1');
  assert.equal(context.decisionSummary.candidates[0].fields[0].elementId, context.visualElements[0].id);
  assert.equal(context.decisionSummary.candidates[0].visibleDomHints[0].elementId, 've_search_results_1_1_price');
  assert.equal(context.decisionSummary.candidates[0].visibleDomHints[0].annotationLabel, 'V1');
  assert.equal(context.decisionSummary.candidates[0].visual.candidateScreenshotPath, '/tmp/example.search_results_1.crop.png');
  assert.ok(context.decisionSummary.useTheseVisualInputs.some((item) => item.includes('annotatedScreenshotPath')));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.goal'));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.decisionSummary'));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.visualArtifacts.candidateScreenshots'));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.visualElements'));
  assert.ok(context.decisionPolicy.requiredInputs.includes('context.pageVisualElements when candidates miss the correct visible region'));
  assert.match(context.decisionPolicy.taskTargetRule, /infer the primary task target/);
  assert.match(context.decisionPolicy.taskTargetRule, /Do not hard-code detail extraction/);
  assert.match(context.decisionPolicy.taskTargetRule, /largest list/);
  assert.match(context.decisionPolicy.taskTargetRule, /explicit/);
  assert.match(context.decisionPolicy.taskTargetRule, /vague or absent/);
  assert.match(context.decisionPolicy.rankingRule, /full-page screenshot/);
  assert.match(context.instruction, /Before selecting any candidate/);
  assert.match(context.instruction, /live visible structure/);
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

  assert.equal(preview.schemaVersion, 'octopus.detect.agent-preview.v1');
  assert.equal(preview.pass, false);
  assert.equal(preview.detail.fields[0].name, 'body');
  assert.match(preview.warnings.join('\n'), /content text looks short/);
  assert.match(preview.recommendedFixes.join('\n'), /parent container/);
});

test('previewAgentPlanForTesting does not warn for loop-relative list field matches', () => {
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
          {
            name: 'title',
            kind: 'text',
            selector: 'a',
            xpath: '/html/body/main/article/a',
            relativeXPath: './a',
            samples: ['Alpha'],
            diagnostics: {
              matchCount: 10,
              textLength: 200,
              paragraphCount: 0,
              hasStyleNoise: false,
              sampleText: 'Alpha',
              warnings: ['xpath matched 10 elements; runtime may use the first element unless XPath targets a container']
            }
          },
          {
            name: 'url',
            kind: 'href',
            selector: 'a',
            xpath: '/html/body/main/article/a',
            relativeXPath: './a',
            samples: ['https://example.com/a'],
            diagnostics: {
              matchCount: 10,
              textLength: 200,
              paragraphCount: 0,
              hasStyleNoise: false,
              sampleText: 'Alpha',
              warnings: ['xpath matched 10 elements; runtime may use the first element unless XPath targets a container']
            }
          }
        ],
        sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
        reasons: ['test']
      }
    ]
  });
  const preview = previewAgentPlanForTesting({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: ['title', 'url']
      }
    }
  });

  assert.equal(preview.pass, true);
  assert.equal(preview.fields[0].runtimeScope, 'loop_item');
  assert.match(preview.fields[0].notes.join('\n'), /relative to each loop item/);
  assert.doesNotMatch(preview.warnings.join('\n'), /runtime may use the first element/);
  assert.doesNotMatch(preview.recommendedFixes.join('\n'), /XPath matches multiple elements/);
});

test('previewAgentPlanForTesting requires visual review when screenshot is available', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    agentScreenshot: {
      path: '/tmp/context.fullpage.png',
      fullPage: true,
      annotatedPath: '/tmp/context.fullpage.annotated.png',
      candidateScreenshots: [
        {
          candidateId: 'search_results_1',
          path: '/tmp/context.search_results_1.crop.png',
          rank: 1,
          boundingBox: { x: 0, y: 0, width: 600, height: 400 }
        }
      ]
    },
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
        reasons: ['test']
      }
    ]
  });

  const withoutReview = previewAgentPlanForTesting({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: ['title', 'url']
      }
    }
  });
  assert.equal(withoutReview.pass, false);
  assert.match(withoutReview.warnings.join('\n'), /visualReview/);
  assert.match(withoutReview.recommendedFixes.join('\n'), /screenshot/);

  const withReview = previewAgentPlanForTesting({
    context,
    plan: {
      visualReview: {
        reviewed: true,
        screenshotPath: '/tmp/context.fullpage.png',
        annotatedScreenshotPath: '/tmp/context.fullpage.annotated.png',
        candidateScreenshotPath: '/tmp/context.search_results_1.crop.png',
        selectedCandidateId: 'search_results_1',
        evidence: [
          'The selected candidate is the visible main list.',
          'The title and url fields align with the visible card title links.'
        ],
        checks: {
          mainRegionVerified: true,
          fieldsVerified: true,
          paginationVerified: true,
          excludedRegions: ['sidebar', 'ads']
        }
      },
      selection: {
        candidateId: 'search_results_1',
        fields: ['title', 'url']
      }
    }
  });
  assert.equal(withReview.pass, true);
  assert.equal(withReview.visualReview.reviewed, true);
});

test('previewAgentPlanForTesting blocks sidebar candidates for primary content goals', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/detail',
    finalUrl: 'https://example.com/detail',
    title: 'Example detail',
    capturedAt: '2026-05-28T00:00:00.000Z',
    agentScreenshot: {
      path: '/tmp/context.fullpage.png',
      fullPage: true,
      annotatedPath: '/tmp/context.fullpage.annotated.png',
      candidateScreenshots: [
        {
          candidateId: 'sidebar_recommendations_1',
          path: '/tmp/context.sidebar_recommendations_1.crop.png',
          rank: 1,
          boundingBox: { x: 900, y: 300, width: 260, height: 500 }
        }
      ]
    },
    candidates: [
      {
        id: 'sidebar_recommendations_1',
        type: 'repeated_card',
        title: 'Nearby recommendations',
        confidence: 0.82,
        selector: 'aside',
        xpath: '/html/body/aside',
        itemSelector: 'aside .card',
        itemXPath: '/html/body/aside/div',
        itemCount: 5,
        fields: [
          { name: 'name', kind: 'text', selector: '.name', xpath: '/html/body/aside/div/span[1]', relativeXPath: './span[1]', samples: ['Nearby shop'] },
          { name: 'rating', kind: 'text', selector: '.rating', xpath: '/html/body/aside/div/span[2]', relativeXPath: './span[2]', samples: ['5.0'] }
        ],
        sampleRows: [{ name: 'Nearby shop', rating: '5.0' }],
        reasons: ['test'],
        layout: {
          role: 'sidebar',
          score: 0.1,
          mainScore: 0.2,
          sidebarPenalty: 0.8,
          boilerplatePenalty: 0,
          visualCoverage: 0.1,
          textDensity: 0.2,
          linkDensity: 0.5,
          centerDistance: 0.8,
          reasons: ['side-column layout']
        }
      }
    ]
  }, 'extract current page primary detail content including title, rating, address, and body, ignore sidebar recommendations');

  const preview = previewAgentPlanForTesting({
    context,
    plan: {
      visualReview: {
        reviewed: true,
        screenshotPath: '/tmp/context.fullpage.png',
        annotatedScreenshotPath: '/tmp/context.fullpage.annotated.png',
        candidateScreenshotPath: '/tmp/context.sidebar_recommendations_1.crop.png',
        selectedCandidateId: 'sidebar_recommendations_1',
        evidence: ['The agent incorrectly claims this is the main region.'],
        checks: {
          mainRegionVerified: true,
          fieldsVerified: true,
          excludedRegions: ['navigation']
        }
      },
      selection: {
        candidateId: 'sidebar_recommendations_1',
        fields: ['name', 'rating']
      }
    }
  });

  assert.equal(preview.pass, false);
  assert.match(preview.warnings.join('\n'), /goal\/layout mismatch/);
  assert.match(preview.recommendedFixes.join('\n'), /pageVisualElements/);
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
    taskId: 'detected_agent',
    taskName: 'Detected Agent'
  });

  assert.deepEqual(task.fieldNames, ['headline', 'url', 'body']);
  assert.equal(task.detection.candidateId, 'search_results_1');
  assert.equal(task.detection.detailPlan.mode, 'list_with_detail');
  assert.deepEqual(task.detection.detailPlan.fields.map((field) => field.name), ['body']);
  assert.match(task.xml, /Name&gt;headline/);
  assert.match(task.xml, /Name&gt;body/);
  assert.match(task.xml, /x:Name="ClickDetail"/);
  assert.doesNotMatch(task.xml, /Name&gt;summary/);
});

test('buildTaskFromAgentPlan accepts visual element ids for field choices', () => {
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
            samples: ['Alpha'],
            diagnostics: {
              matchCount: 3,
              textLength: 20,
              paragraphCount: 0,
              hasStyleNoise: false,
              boundingBox: { x: 20, y: 40, width: 240, height: 24 },
              sampleText: 'Alpha',
              warnings: []
            }
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
  const titleElementId = context.visualElements.find((item) => item.fieldName === 'title')?.id;
  const urlElementId = context.visualElements.find((item) => item.fieldName === 'url')?.id;
  const detailElementId = context.visualElements.find((item) => item.fieldName === 'detail_content')?.id;

  const preview = previewAgentPlanForTesting({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: [
          { elementId: titleElementId, as: 'headline' },
          { elementId: urlElementId, as: 'url' }
        ],
        detail: {
          mode: 'list_with_detail',
          urlField: 'url',
          fields: [
            { elementId: detailElementId, as: 'body' }
          ]
        }
      }
    }
  });
  assert.equal(preview.fields[0].name, 'headline');
  assert.equal(preview.fields[0].sourceName, 'title');
  assert.equal(preview.fields[1].name, 'url');
  assert.equal(preview.fields[1].sourceName, undefined);
  assert.equal(preview.detail.fields[0].name, 'body');

  const task = buildTaskFromAgentPlan({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: [
          { elementId: titleElementId, as: 'headline' },
          { elementId: urlElementId, as: 'url' }
        ],
        detail: {
          mode: 'list_with_detail',
          urlField: 'url',
          fields: [
            { elementId: detailElementId, as: 'body' }
          ]
        }
      }
    },
    taskId: 'detected_agent_element_ids',
    taskName: 'Detected Agent Element IDs'
  });

  assert.deepEqual(task.fieldNames, ['headline', 'url', 'body']);
  assert.match(task.xml, /Name&gt;headline/);
  assert.match(task.xml, /Name&gt;body/);
  assert.doesNotMatch(task.xml, /Name&gt;summary/);
});

test('buildTaskFromAgentPlan can promote visible DOM visual elements into fields', () => {
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
          }
        ],
        visualElements: [
          {
            id: 've_search_results_1_price',
            candidateId: 'search_results_1',
            scope: 'visible_dom',
            source: 'visible_dom',
            annotationLabel: 'V1',
            label: 'text:$19.99',
            tagName: 'span',
            kind: 'text',
            role: 'text',
            selector: 'span.price',
            xpath: '/html[1]/body[1]/main[1]/div//span[1]',
            relativeXPath: './span[1]',
            boundingBox: { x: 20, y: 70, width: 80, height: 20 },
            visible: true,
            clickable: false,
            sample: '$19.99',
            samples: ['$19.99', '$29.99', '$39.99'],
            samplesByKind: { text: ['$19.99', '$29.99', '$39.99'] },
            rowCoverage: { matchedRows: 3, filledRows: 3, totalRows: 3, fillRate: 1 },
            confidence: 0.9
          },
          {
            id: 've_search_results_1_link',
            candidateId: 'search_results_1',
            scope: 'visible_dom',
            source: 'visible_dom',
            annotationLabel: 'V2',
            label: 'link:Alpha',
            tagName: 'a',
            kind: 'text',
            role: 'link',
            selector: 'a.title',
            xpath: '/html[1]/body[1]/main[1]/div//a[1]',
            relativeXPath: './a[1]',
            boundingBox: { x: 20, y: 40, width: 200, height: 24 },
            visible: true,
            clickable: true,
            sample: 'Alpha',
            samples: ['Alpha', 'Beta'],
            samplesByKind: {
              text: ['Alpha', 'Beta'],
              href: ['https://example.com/a', 'https://example.com/b']
            },
            attributes: { href: 'https://example.com/a' },
            rowCoverage: { matchedRows: 2, filledRows: 2, totalRows: 2, fillRate: 1 },
            confidence: 0.82
          }
        ],
        sampleRows: [{ title: 'Alpha' }],
        reasons: ['test']
      }
    ]
  });

  const preview = previewAgentPlanForTesting({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: [
          'title',
          { elementId: 've_search_results_1_price', as: 'price' },
          { elementId: 've_search_results_1_link', as: 'url', kind: 'href' }
        ]
      }
    }
  });

  assert.equal(preview.pass, true);
  assert.equal(preview.fields[1].name, 'price');
  assert.deepEqual(preview.fields[1].samples, ['$19.99', '$29.99', '$39.99']);
  assert.equal(preview.fields[2].name, 'url');
  assert.equal(preview.fields[2].kind, 'href');
  assert.deepEqual(preview.fields[2].samples, ['https://example.com/a', 'https://example.com/b']);

  const task = buildTaskFromAgentPlan({
    context,
    plan: {
      selection: {
        candidateId: 'search_results_1',
        fields: [
          'title',
          { elementId: 've_search_results_1_price', as: 'price' },
          { elementId: 've_search_results_1_link', as: 'url', kind: 'href' }
        ]
      }
    },
    taskId: 'detected_agent_visible_dom',
    taskName: 'Detected Agent Visible DOM'
  });

  assert.deepEqual(task.fieldNames, ['title', 'price', 'url']);
  assert.match(task.xml, /Name&gt;price/);
  assert.match(task.xml, /Name&gt;url/);
  assert.match(task.xml, /ExtractHref/);
});

test('buildTaskFromAgentPlan can create a synthetic candidate from page visual elements', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    pageVisualElements: [
      {
        id: 'pv_1_missing_title',
        scope: 'page',
        source: 'page_visible_dom',
        annotationLabel: 'P1',
        label: 'link:Missing candidate title',
        tagName: 'a',
        kind: 'text',
        role: 'link',
        selector: 'a.result-title',
        xpath: '/html[1]/body[1]/main[1]/section[1]/article[1]/a[1]',
        boundingBox: { x: 80, y: 320, width: 360, height: 28 },
        visible: true,
        clickable: true,
        sample: 'Missing candidate title',
        samples: ['Missing candidate title'],
        samplesByKind: {
          text: ['Missing candidate title'],
          href: ['https://example.com/missing']
        },
        attributes: { href: 'https://example.com/missing' },
        confidence: 0.92,
        regionRole: 'main'
      },
      {
        id: 'pv_2_missing_summary',
        scope: 'page',
        source: 'page_visible_dom',
        annotationLabel: 'P2',
        label: 'text:Missing summary',
        tagName: 'p',
        kind: 'text',
        role: 'text',
        selector: 'p.summary',
        xpath: '/html[1]/body[1]/main[1]/section[1]/article[1]/p[1]',
        boundingBox: { x: 80, y: 360, width: 480, height: 44 },
        visible: true,
        clickable: false,
        sample: 'Missing summary',
        samples: ['Missing summary'],
        samplesByKind: { text: ['Missing summary'] },
        attributes: {},
        confidence: 0.84,
        regionRole: 'main'
      }
    ],
    candidates: [
      {
        id: 'sidebar_links_1',
        type: 'link_collection',
        title: 'Sidebar links',
        confidence: 0.6,
        selector: 'aside',
        xpath: '/html[1]/body[1]/aside[1]',
        itemXPath: '/html[1]/body[1]/aside[1]/a',
        itemCount: 5,
        fields: [
          { name: 'sidebar_title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/aside[1]/a', relativeXPath: '.', samples: ['Sidebar'] }
        ],
        sampleRows: [{ sidebar_title: 'Sidebar' }],
        reasons: ['wrong region']
      }
    ]
  });

  const plan = {
    selection: {
      customCandidate: {
        id: 'agent_main_results',
        type: 'search_results',
        title: 'Agent selected main results',
        xpath: '/html[1]/body[1]/main[1]/section[1]',
        itemXPath: '/html[1]/body[1]/main[1]/section[1]/article',
        fieldElementIds: ['pv_1_missing_title', 'pv_2_missing_summary'],
        evidence: ['The screenshot shows the requested list in main content, but detector only returned sidebar links.']
      },
      fields: [
        { elementId: 'P1', as: 'title' },
        { elementId: 'P1', as: 'url', kind: 'href' },
        { elementId: 'P2', as: 'summary' }
      ],
      pagination: null
    }
  };

  const preview = previewAgentPlanForTesting({ context, plan });
  assert.equal(preview.pass, true);
  assert.equal(preview.candidateId, 'agent_main_results');
  assert.deepEqual(preview.fields.map((field) => field.name), ['title', 'url', 'summary']);

  const task = buildTaskFromAgentPlan({
    context,
    plan,
    taskId: 'detected_agent_custom',
    taskName: 'Detected Agent Custom'
  });

  assert.equal(task.detection.candidateId, 'agent_main_results');
  assert.deepEqual(task.fieldNames, ['title', 'url', 'summary']);
  assert.match(task.xml, /Loop detected items/);
  assert.match(task.xml, /Name&gt;url/);
  assert.match(task.xml, /ExtractHref/);
  assert.doesNotMatch(task.xml, /sidebar_title/);
});

test('buildTaskFromAgentPlan derives relative XPath for direct custom candidate fields', () => {
  const context = buildAgentContextForTesting({
    url: 'https://example.com/list',
    finalUrl: 'https://example.com/list',
    title: 'Example',
    capturedAt: '2026-05-28T00:00:00.000Z',
    candidates: []
  });

  const plan = {
    selection: {
      customCandidate: {
        id: 'agent_direct_xpath_results',
        type: 'repeated_card',
        title: 'Agent direct XPath results',
        xpath: '/html[1]/body[1]/main[1]/section[1]/article',
        itemXPath: '/html[1]/body[1]/main[1]/section[1]/article',
        itemCount: 3,
        fields: [
          {
            name: 'title',
            kind: 'text',
            xpath: '/html[1]/body[1]/main[1]/section[1]/article[1]/h2[1]',
            samples: ['Alpha']
          },
          {
            name: 'summary',
            kind: 'text',
            xpath: '/html[1]/body[1]/main[1]/section[1]/article[1]/p[1]',
            samples: ['First summary']
          }
        ],
        evidence: ['Agent selected the main list from the screenshot and supplied exact field XPath.']
      },
      pagination: null
    }
  };

  const preview = previewAgentPlanForTesting({ context, plan });
  assert.equal(preview.pass, true);
  assert.equal(preview.fields[0].runtimeScope, 'loop_item');
  assert.equal(preview.fields[0].xpath, '/html[1]/body[1]/main[1]/section[1]/article[1]/h2[1]');
  assert.deepEqual(preview.fields.map((field) => field.name), ['title', 'summary']);

  const task = buildTaskFromAgentPlan({
    context,
    plan,
    taskId: 'detected_agent_direct_xpath',
    taskName: 'Detected Agent Direct XPath'
  });

  assert.deepEqual(task.fieldNames, ['title', 'summary']);
  assert.match(task.xml, /RelativeXpath&gt;\/h2\[1\]/);
  assert.match(task.xml, /RelativeXpath&gt;\/p\[1\]/);
});

test('runInlineAgentDetectForTesting lets an external command generate and apply a plan', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'detector-inline-agent-'));
  const agentScript = join(dir, 'agent.mjs');
  const taskFile = join(dir, 'task.json');
  const seenWorkDirFile = join(dir, 'seen-workdir.txt');
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  const originalBaseUrl = process.env.OCTO_ENGINE_API_BASE_URL;
  const saveRequests = [];
  await writeFile(agentScript, `
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const context = JSON.parse(await readFile(process.env.OCTOPARSE_AGENT_CONTEXT, 'utf8'));
await writeFile(${JSON.stringify(seenWorkDirFile)}, dirname(process.env.OCTOPARSE_AGENT_CONTEXT));
const plan = {
  schemaVersion: 'octopus.detect.agent-plan.v1',
  visualReview: {
    reviewed: true,
    screenshotPath: context.screenshot.path,
    annotatedScreenshotPath: context.screenshot.annotatedPath,
    candidateScreenshotPath: context.visualArtifacts?.candidateScreenshots?.find((item) => item.candidateId === context.recommendedCandidateId)?.path,
    selectedCandidateId: context.recommendedCandidateId,
    evidence: [
      'The selected candidate is the visible main list.',
      'The headline and url fields align with visible title links.'
    ],
    checks: {
      mainRegionVerified: true,
      fieldsVerified: true,
      paginationVerified: true,
      excludedRegions: ['sidebar', 'navigation', 'ads']
    }
  },
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
    process.env.OCTO_ENGINE_API_KEY = 'detect-save-key';
    process.env.OCTO_ENGINE_API_BASE_URL = 'https://example.invalid';
    globalThis.fetch = mockDetectedTaskCloudSave(saveRequests);
    const code = await runInlineAgentDetectForTesting({
      args: ['--agent-command', `${process.execPath} ${agentScript}`, '--output', taskFile],
      quiet: true,
      result: {
        url: 'https://example.com/list',
        finalUrl: 'https://example.com/list',
        title: 'Example',
        capturedAt: '2026-05-28T00:00:00.000Z',
        agentScreenshot: {
          path: join(dir, 'context.fullpage.png'),
          fullPage: true,
          annotatedPath: join(dir, 'context.fullpage.annotated.png'),
          candidateScreenshots: [
            {
              candidateId: 'search_results_1',
              path: join(dir, 'context.search_results_1.crop.png'),
              rank: 1,
              boundingBox: { x: 0, y: 0, width: 640, height: 420 }
            }
          ]
        },
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
    assert.equal(task.detection.candidateId, 'search_results_1');
    assert.equal(task.detection.selectionSource, undefined);
    assert.doesNotMatch(task.xml, /Name&gt;summary/);
    assert.equal(saveRequests.length, 1);
    assert.match(saveRequests[0].body.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(saveRequests[0].body.taskName, 'example.com_list');
    assert.equal(saveRequests[0].body.taskGroupId, 23);
    assert.equal(saveRequests[0].headers['x-api-key'], 'detect-save-key');
    const cloudXml = decodeCloudTaskXml(saveRequests[0].body.xoml);
    assert.equal(cloudXml, task.xml);
    assert.match(cloudXml, /<ns0:NavigateAction[^>]*x:Name="Navigate1"[^>]*Name="Navigate1"/);
    const seenWorkDir = await readFile(seenWorkDirFile, 'utf8');
    await assert.rejects(access(seenWorkDir), { code: 'ENOENT' });
  } finally {
    chdir(previousCwd);
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OCTO_ENGINE_API_BASE_URL;
    else process.env.OCTO_ENGINE_API_BASE_URL = originalBaseUrl;
  }
});

test('runInlineAgentDetectForTesting can embed a sample run in one json envelope', async () => {
  const previousCwd = cwd();
  const dir = await mkdtemp(join(tmpdir(), 'detector-inline-agent-sample-'));
  const agentScript = join(dir, 'agent.mjs');
  const taskFile = join(dir, 'task.json');
  const runOutput = join(dir, 'runs');
  const lines = [];
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTO_ENGINE_API_KEY;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  await writeFile(agentScript, `
import { readFile, writeFile } from 'node:fs/promises';
const context = JSON.parse(await readFile(process.env.OCTOPARSE_AGENT_CONTEXT, 'utf8'));
await writeFile(process.env.OCTOPARSE_AGENT_PLAN, JSON.stringify({
  schemaVersion: 'octopus.detect.agent-plan.v1',
  visualReview: {
    reviewed: true,
    screenshotPath: context.screenshot.path,
    annotatedScreenshotPath: context.screenshot.annotatedPath,
    candidateScreenshotPath: context.visualArtifacts?.candidateScreenshots?.find((item) => item.candidateId === context.recommendedCandidateId)?.path,
    selectedCandidateId: context.recommendedCandidateId,
    evidence: [
      'The selected candidate is the visible main list.',
      'The title and url fields align with visible card title links.'
    ],
    checks: {
      mainRegionVerified: true,
      fieldsVerified: true,
      paginationVerified: true,
      excludedRegions: ['sidebar', 'navigation', 'ads']
    }
  },
  selection: {
    candidateId: context.recommendedCandidateId,
    fields: ['title', 'url'],
    pagination: null
  }
}, null, 2));
`);

  const workflowEvents = {
    ExtraData: 'extraData',
    Log: 'log',
    Stopped: 'stopped',
    Captcha: 'captcha',
    GetProxy: 'getProxy',
    DownloadFile: 'downloadFile',
    CollectProxyLog: 'collectProxyLog'
  };
  class FakeWorkflow extends EventEmitter {
    async start() {
      setImmediate(() => {
        this.emit(workflowEvents.ExtraData, {
          data: {
            total: 1,
            rowData: { title: 'Alpha', url: 'https://example.com/a' }
          }
        });
        setTimeout(() => {
          this.emit(workflowEvents.Stopped, { data: { status: 'completed' } });
        }, 20);
      });
    }

    stop() {}
    stopTask() {}
    pauseTask() {}
    resumeTask() {}
    close() {}
  }
  class FakeBridgeHub extends EventEmitter {
    async createSessionBridge() {
      return {};
    }

    async waitForSessionConnected() {}
    close() {}
  }

  try {
    chdir(dir);
    process.env.OCTO_ENGINE_API_KEY = 'runtime-key';
    globalThis.fetch = mockDetectedTaskCloudSave([]);
    setEngineHostFactoryForTesting(() => new EngineHost({
      default: FakeWorkflow,
      WorkflowEvents: workflowEvents,
      resolveChrome: async () => ({ executablePath: process.execPath })
    }, () => new FakeBridgeHub()));
    console.log = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    process.stdout.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    process.stderr.write = (() => true);

    const code = await runInlineAgentDetectForTesting({
      args: [
        '--agent-command',
        `${process.execPath} ${agentScript}`,
        '--yes',
        '--output',
        taskFile,
        '--run-sample',
        '1',
        '--run-output',
        runOutput
      ],
      json: true,
      result: {
        url: 'https://example.com/list',
        finalUrl: 'https://example.com/list',
        title: 'Example',
        capturedAt: '2026-05-28T00:00:00.000Z',
        agentScreenshot: {
          path: join(dir, 'context.fullpage.png'),
          fullPage: true,
          annotatedPath: join(dir, 'context.fullpage.annotated.png'),
          candidateScreenshots: [
            {
              candidateId: 'search_results_1',
              path: join(dir, 'context.search_results_1.crop.png'),
              rank: 1,
              boundingBox: { x: 0, y: 0, width: 640, height: 420 }
            }
          ]
        },
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
            itemCount: 1,
            fields: [
              { name: 'title', kind: 'text', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['Alpha'] },
              { name: 'url', kind: 'href', selector: 'a', xpath: '/html[1]/body[1]/main[1]/div//a[1]', relativeXPath: './a[1]', samples: ['https://example.com/a'] }
            ],
            sampleRows: [{ title: 'Alpha', url: 'https://example.com/a' }],
            reasons: ['test']
          }
        ]
      }
    });
    assert.equal(code, 0);
    const jsonLines = lines.filter((line) => line.trim().startsWith('{'));
    assert.equal(jsonLines.length, 1, lines.join('\n'));
    const payload = JSON.parse(jsonLines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.sampleRun.requestedRows, 1);
    assert.equal(payload.data.sampleRun.exitCode, 0);
    assert.equal(payload.data.sampleRun.envelope.ok, true);
    assert.equal(payload.data.sampleRun.envelope.data.total, 1);
    assert.equal(payload.data.sampleRun.summary.totalRows, 1);
    assert.equal(payload.data.sampleRun.summary.sampledRows[0].title, 'Alpha');
    assert.equal(payload.data.sampleRun.summary.fieldFillRates.title, 1);
    assert.equal(payload.data.sampleRun.summary.missingFieldsByRow.length, 0);
  } finally {
    chdir(previousCwd);
    setEngineHostFactoryForTesting(undefined);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTO_ENGINE_API_KEY;
    else process.env.OCTO_ENGINE_API_KEY = originalApiKey;
  }
});

test('buildTaskFromCandidate stores detected detail plan metadata', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/list',
    taskId: 'detected_detail_plan',
    taskName: 'Detected Detail Plan',
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

  assert.equal(task.detection.detailPlan.mode, 'list_with_detail');
  assert.deepEqual(task.detection.detailPlan.sampleUrls, ['https://example.com/a']);
  assert.deepEqual(task.detection.detailPlan.fields.map((field) => field.name), ['detail_content']);
  assert.equal(task.detection.detailPlan.status, 'planned');
  assert.deepEqual(task.fieldNames, ['title', 'url', 'detail_content']);
  assert.match(task.xml, /x:Name="ExtractItems"/);
  assert.match(task.xml, /Caption="Extract detected list data"/);
  assert.match(task.xml, /x:Name="ClickDetail"/);
  assert.match(task.xml, /Caption="Click detail link"/);
  assert.match(task.xml, /OpenInNewWindow="true"/);
  assert.match(task.xml, /OpenByHref="false"/);
  assert.match(task.xml, /PageIndex="0"[^>]*ElementXPath="&lt;ActionItem&gt;&lt;AbsXpath&gt;\/a\[1\]/);
  assert.match(task.xml, /x:Name="ExtractDetail"/);
  assert.match(task.xml, /Caption="Extract detected detail data"/);
  assert.match(task.xml, /PageIndex="1"/);
  assert.match(task.xml, /detail_content/);
  assert.match(task.xml, /Name&gt;detail_content/);
  assert.match(task.xml, /UseRelativeXPath&gt;false/);
  assert.match(task.xml, /MatchAll&gt;true/);
  assert.match(task.xml, /IsAppend&gt;true/);
});

test('selectDetailUrlFieldForTesting accepts non-url href fields for detail prompts', () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search/list results',
    confidence: 0.8,
    selector: 'main',
    xpath: '/html/body/main',
    itemSelector: 'article',
    itemXPath: '/html/body/main/article',
    itemCount: 3,
    fields: [
      { name: 'title', kind: 'text', selector: 'a', xpath: '/html/body/main/article/a', relativeXPath: './a', samples: ['Alpha'] },
      { name: 'titleLink', kind: 'href', selector: 'a', xpath: '/html/body/main/article/a', relativeXPath: './a', samples: ['https://example.com/a'] }
    ],
    sampleRows: [{ title: 'Alpha', titleLink: 'https://example.com/a' }],
    reasons: ['test']
  };

  assert.equal(selectDetailUrlFieldForTesting(candidate)?.name, 'titleLink');
});

test('selectDetailUrlFieldForTesting still prefers url over other href fields', () => {
  const candidate = {
    id: 'search_results_1',
    type: 'search_results',
    title: 'Search/list results',
    confidence: 0.8,
    selector: 'main',
    xpath: '/html/body/main',
    itemSelector: 'article',
    itemXPath: '/html/body/main/article',
    itemCount: 3,
    fields: [
      { name: 'titleLink', kind: 'href', selector: 'a.title', xpath: '/html/body/main/article/a[1]', relativeXPath: './a[1]', samples: ['https://example.com/title'] },
      { name: 'url', kind: 'href', selector: 'a.detail', xpath: '/html/body/main/article/a[2]', relativeXPath: './a[2]', samples: ['https://example.com/detail'] }
    ],
    sampleRows: [{ titleLink: 'https://example.com/title', url: 'https://example.com/detail' }],
    reasons: ['test']
  };

  assert.equal(selectDetailUrlFieldForTesting(candidate)?.name, 'url');
});

test('buildTaskFromCandidate creates direct extraction XML for detail pages', () => {
  const task = buildTaskFromCandidate({
    url: 'https://example.com/article',
    taskId: 'detected_detail',
    taskName: 'Detected Detail',
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
    taskId: 'detected_detail_only',
    taskName: 'Detected Detail Only',
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
    taskId: 'detected_pages',
    taskName: 'Detected Pages',
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

  assert.equal(task.detection.paginationType, 'next_page');
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
    taskId: 'detected_more',
    taskName: 'Detected More',
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

  assert.equal(task.detection.paginationType, 'load_more');
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
    taskId: 'detected_mixed_more',
    taskName: 'Detected Mixed More',
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

  assert.equal(task.detection.paginationType, 'load_more');
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
    taskId: 'detected_scroll',
    taskName: 'Detected Scroll',
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

  assert.equal(task.detection.paginationType, 'scroll');
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
    taskId: 'detected_social_cards',
    taskName: 'Detected Social Cards',
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
    taskId: 'detected_dates',
    taskName: 'Detected Dates',
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
          this.classList = String(this.className || '').split(/\s+/).filter(Boolean);
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

function storyTitleRow(index, rank, title, href) {
  const top = 100 + index * 90;
  return {
    tag: 'tr',
    text: '',
    attrs: { className: 'item' },
    rect: { left: 60, top, right: 760, bottom: top + 34 },
    children: [
      {
        tag: 'td',
        text: '',
        rect: { left: 60, top, right: 110, bottom: top + 34 },
        children: [{ tag: 'span', text: rank, rect: { left: 70, top: top + 8, right: 96, bottom: top + 26 } }]
      },
      {
        tag: 'td',
        text: '',
        rect: { left: 120, top, right: 760, bottom: top + 34 },
        children: [{ tag: 'a', text: title, attrs: { href, className: 'title' }, rect: { left: 130, top: top + 8, right: 430, bottom: top + 26 } }]
      }
    ]
  };
}

function storyMetadataRow(index, score, author, age, comments) {
  const top = 134 + index * 90;
  return {
    tag: 'tr',
    text: '',
    attrs: { className: 'subtext' },
    rect: { left: 60, top, right: 760, bottom: top + 28 },
    children: [
      { tag: 'td', text: '', rect: { left: 60, top, right: 110, bottom: top + 28 } },
      {
        tag: 'td',
        text: '',
        rect: { left: 120, top, right: 760, bottom: top + 28 },
        children: [
          { tag: 'span', text: score, attrs: { className: 'score' }, rect: { left: 130, top: top + 5, right: 205, bottom: top + 22 } },
          { tag: 'a', text: author, attrs: { href: `https://example.com/user/${author}`, className: 'hnuser' }, rect: { left: 230, top: top + 5, right: 280, bottom: top + 22 } },
          { tag: 'span', text: age, attrs: { className: 'age' }, rect: { left: 300, top: top + 5, right: 390, bottom: top + 22 } },
          { tag: 'a', text: comments, attrs: { href: `https://example.com/item?id=${index + 1}`, className: 'comments' }, rect: { left: 430, top: top + 5, right: 540, bottom: top + 22 } }
        ]
      }
    ]
  };
}

function fakeRefinePage({ itemXPath, rows, itemRowIndexes }) {
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
      const itemRows = Array.isArray(itemRowIndexes) ? itemRowIndexes.map((index) => rowElements[index]).filter(Boolean) : rowElements;
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
            ? itemRows
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
  const scopeMatch = selector.replace(/^:scope\s*>\s*/, '').replace(/^:scope\s*/, '');
  if (scopeMatch.includes('>')) return matchesSimpleSelector(element, scopeMatch.split('>').at(-1).trim());
  const withoutAttributeSelectors = scopeMatch.replace(/\[[^\]]+\]/g, '');
  if (withoutAttributeSelectors.trim().includes(' ')) return matchesSimpleSelector(element, scopeMatch.split(/\s+/).at(-1));
  const tagMatch = scopeMatch.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tagMatch && element.localName !== tagMatch.toLowerCase()) return false;
  for (const className of scopeMatch.matchAll(/\.([\w-]+)/g)) {
    if (!String(element.className || '').split(/\s+/).includes(className[1])) return false;
  }
  for (const match of scopeMatch.matchAll(/\[class\*="([^"]+)" i\]/g)) {
    if (!String(element.className || '').toLowerCase().includes(match[1].toLowerCase())) return false;
  }
  for (const match of scopeMatch.matchAll(/\[([^=\]\*]+)\*="([^"]+)"(?:\s+i)?\]/g)) {
    if (!String(element.getAttribute(match[1]) || '').toLowerCase().includes(match[2].toLowerCase())) return false;
  }
  for (const match of scopeMatch.matchAll(/\[([^=\]]+)="([^"]+)"\]/g)) {
    const attr = match[1];
    if (attr.endsWith('*')) continue;
    if (String(element.getAttribute(attr) || '') !== match[2]) return false;
  }
  for (const match of scopeMatch.matchAll(/\[([^=\]\*]+)\]/g)) {
    const attr = match[1].trim();
    if (attr === 'class' || attr.includes('"')) continue;
    if (element.getAttribute(attr) === undefined || element.getAttribute(attr) === null) return false;
  }
  return true;
}

function evaluateSimplePath(path, context) {
  if (!path) return [];
  if (path === '.') return [context];
  const relative = path.replace(/^\.\//, '').replace(/^\.\/\//, '').replace(/^\/html\[1\]\/body\[1\]\//, '');
  const siblingMatch = relative.match(/^following-sibling::\*\[(\d+)\](?:\/(.+))?$/);
  if (siblingMatch) {
    const parent = context.parentElement;
    if (!parent) return [];
    const siblings = parent.children || [];
    const index = siblings.indexOf(context);
    const target = siblings[index + Number(siblingMatch[1])];
    if (!target) return [];
    return siblingMatch[2] ? evaluateSimplePath(siblingMatch[2], target) : [target];
  }
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

function detectOptionsForSearchScoring(url, keyword) {
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

function mdnResultRow(index, title, href, category, summary) {
  const top = 150 + index * 170;
  return {
    tag: 'div',
    attrs: { className: 'document-search-result search-result' },
    rect: { left: 180, top, right: 940, bottom: top + 130 },
    children: [
      {
        tag: 'a',
        attrs: { href, className: 'result-title' },
        rect: { left: 190, top: top + 8, right: 780, bottom: top + 36 },
        children: [
          { tag: 'h2', text: title, rect: { left: 190, top: top + 8, right: 780, bottom: top + 36 } }
        ]
      },
      {
        tag: 'span',
        text: category,
        attrs: { className: 'result-category' },
        rect: { left: 190, top: top + 44, right: 340, bottom: top + 66 }
      },
      {
        tag: 'p',
        text: summary,
        attrs: { className: 'result-summary' },
        rect: { left: 190, top: top + 72, right: 900, bottom: top + 122 }
      }
    ]
  };
}

function goYellowBusinessRow(index, name, href, category, address, logo) {
  const top = 260 + index * 190;
  return {
    tag: 'article',
    attrs: {
      className: 'article gyresultrecord',
      itemtype: 'https://schema.org/LocalBusiness https://schema.org/HomeAndConstructionBusiness',
      itemscope: '',
      dataSeourl: href.replace('https://www.goyellow.de', ''),
      title: `Zur Detailseite von ${name} in Bayerisch Gmain`
    },
    rect: { left: 170, top, right: 860, bottom: top + 150 },
    children: [
      {
        tag: 'div',
        attrs: { className: 'gyresultrecord__categories' },
        rect: { left: 190, top: top + 12, right: 380, bottom: top + 38 },
        children: [
          { tag: 'span', text: category, attrs: { className: 'gyresultrecord__categories-element' }, rect: { left: 190, top: top + 12, right: 360, bottom: top + 36 } }
        ]
      },
      {
        tag: 'h2',
        attrs: { className: 'gyresultrecord__locname', itemprop: 'name' },
        rect: { left: 190, top: top + 46, right: 520, bottom: top + 76 },
        children: [
          { tag: 'a', text: name, attrs: { href, className: 'gyresultrecord__locname-a', itemprop: 'url' }, rect: { left: 190, top: top + 46, right: 520, bottom: top + 74 } }
        ]
      },
      {
        tag: 'div',
        text: address,
        attrs: { className: 'postal-address' },
        rect: { left: 190, top: top + 86, right: 570, bottom: top + 112 }
      },
      {
        tag: 'img',
        attrs: { src: logo, itemprop: 'contentUrl', alt: `${name} logo` },
        rect: { left: 650, top: top + 28, right: 770, bottom: top + 120 }
      }
    ]
  };
}

function fakeSearchResultBlockPage({ elements }) {
  return {
    async evaluate(fn, input) {
      const previousWindow = globalThis.window;
      const previousDocument = globalThis.document;
      const previousNode = globalThis.Node;
      const previousElement = globalThis.Element;
      const previousHTMLElement = globalThis.HTMLElement;
      const previousHTMLAnchorElement = globalThis.HTMLAnchorElement;
      const previousShadowRoot = globalThis.ShadowRoot;
      const previousXPathResult = globalThis.XPathResult;
      const previousCSS = globalThis.CSS;
      class FakeShadowRoot {
        constructor({ children = [], host }) {
          this.host = host;
          this.children = [];
          this.childNodes = [];
          this.parentElement = null;
          for (const child of children) this.append(new FakeElement({ ...child, parent: null, rootNode: this }));
        }
        append(child) {
          child.parentElement = null;
          child.rootNode = this;
          this.children.push(child);
          this.childNodes.push(child);
          return child;
        }
        querySelectorAll(selector) {
          return flattenElements(this.children).filter((item) => matchesSelectorList(item, selector));
        }
      }
      class FakeElement {
        constructor({ tag = 'div', text = '', attrs = {}, rect = { left: 0, top: 0, right: 10, bottom: 10 }, children = [], shadow = [], parent = null, rootNode = null }) {
          this.localName = tag;
          this.tagName = tag.toUpperCase();
          this.nodeName = this.tagName;
          this.nodeType = 1;
          this.ownText = text;
          this.children = [];
          this.childNodes = [];
          this.parentElement = parent;
          this.rootNode = rootNode;
          this.id = attrs.id || '';
          this.className = attrs.className || '';
          this.classList = String(this.className || '').split(/\s+/).filter(Boolean);
          this.attrs = attrs;
          this.rect = rect;
          this.href = attrs.href || '';
          this.src = attrs.src || '';
          this.currentSrc = attrs.src || '';
          this.textContent = text;
          this.innerText = text;
          if (text) this.childNodes.push({ nodeType: 3, textContent: text });
          for (const child of children) this.append(new FakeElement({ ...child, parent: this }));
          this.shadowRoot = shadow.length ? new FakeShadowRoot({ children: shadow, host: this }) : null;
          this.refreshText();
        }
        append(child) {
          child.parentElement = this;
          child.rootNode = this.rootNode;
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
          if (name === 'role') return this.attrs.role || '';
          if (name === 'aria-label') return this.attrs.ariaLabel || '';
          if (name === 'title') return this.attrs.title || '';
          if (name === 'alt') return this.attrs.alt || '';
          if (name === 'src') return this.src || this.attrs.src || '';
          if (name === 'itemtype') return this.attrs.itemtype || '';
          if (name === 'itemprop') return this.attrs.itemprop || '';
          if (name === 'itemscope') return this.attrs.itemscope || '';
          if (name === 'data-seourl') return this.attrs.dataSeourl || '';
          return this.attrs[name] || '';
        }
        getBoundingClientRect() {
          const { left, top, right, bottom } = this.rect;
          return { left, top, right, bottom, width: right - left, height: bottom - top };
        }
        contains(element) {
          return this === element || this.children.some((child) => child.contains(element));
        }
        getRootNode() {
          if (this.rootNode) return this.rootNode;
          let current = this;
          while (current.parentElement) current = current.parentElement;
          return document;
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
      const body = new FakeElement({
        tag: 'body',
        rect: { left: 0, top: 0, right: 1200, bottom: 1400 },
        children: elements
      });
      const html = new FakeElement({
        tag: 'html',
        rect: { left: 0, top: 0, right: 1200, bottom: 1400 },
        children: []
      });
      html.append(body);
      const all = () => flattenElements([html]);
      const document = {
        body,
        documentElement: html,
        querySelectorAll(selector) {
          return all().filter((item) => item !== html && item !== body && matchesSelectorList(item, selector));
        }
      };
      const window = {
        innerWidth: 1200,
        innerHeight: 900,
        getComputedStyle() {
          return { display: 'block', visibility: 'visible', opacity: '1' };
        }
      };
      globalThis.window = window;
      globalThis.document = document;
      globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
      globalThis.Element = FakeElement;
      globalThis.HTMLElement = FakeElement;
      globalThis.HTMLAnchorElement = FakeElement;
      globalThis.ShadowRoot = FakeShadowRoot;
      globalThis.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7, FIRST_ORDERED_NODE_TYPE: 9 };
      globalThis.CSS = { escape: (value) => String(value).replace(/"/g, '\\"') };
      try {
        return fn(input);
      } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.Node = previousNode;
        globalThis.Element = previousElement;
        globalThis.HTMLElement = previousHTMLElement;
        globalThis.HTMLAnchorElement = previousHTMLAnchorElement;
        globalThis.ShadowRoot = previousShadowRoot;
        globalThis.XPathResult = previousXPathResult;
        globalThis.CSS = previousCSS;
      }
    }
  };
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

function mockDetectedTaskCloudSave(saveRequests) {
  return async (url, init = {}) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint === '/api/account/getAccount') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          userId: 'user_detect_save',
          email: 'detect@example.com'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (endpoint === '/api/TaskGroup/Default') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: 23
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (endpoint === '/api/task/saveTaskInfo') {
      const body = JSON.parse(String(init.body ?? '{}'));
      saveRequests.push({
        headers: init.headers ?? {},
        body
      });
      return new Response(JSON.stringify({
        isSuccess: true,
        data: 1,
        taskCount: 1,
        taskCountLimit: 100
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

function decodeCloudTaskXml(xoml) {
  const compressed = Buffer.from(String(xoml), 'base64');
  assert.equal(compressed.readInt32LE(0), compressed.byteLength - 4);
  return gunzipSync(compressed.subarray(4)).toString('ucs2');
}
