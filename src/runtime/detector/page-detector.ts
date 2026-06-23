import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import prompts from 'prompts';
import { BridgeHub } from '../bridge-hub.js';
import type { Browser, Page } from 'puppeteer-core';
import { detectDeptaListGroups, type DeptaListGroup } from './depta/browser-detector.js';
import { defaultSessionNameForUrl, saveBrowserSession, sessionOriginForUrl } from '../browser-session.js';
import type { ChromeResolveStatus } from '../chrome-progress.js';
import { hasLinuxDisplayEnvironment, startVirtualDisplayIfNeeded, type VirtualDisplayHandle } from '../virtual-display.js';
import { captureAgentScreenshot } from './agent-visual-artifacts.js';
import { isFooterLikeSelector, isLegalBoilerplateText, isStrongLegalBoilerplateText, isWeakBoilerplateText } from './candidate-boilerplate.js';
import { attachAgentDiagnostics } from './candidate-diagnostics.js';
import { applyLayoutScores } from './candidate-layout.js';
import { attachCandidateVisualElements } from './candidate-visual-elements.js';
import { applyGoalScores, dedupeEquivalentCandidates, filterDetectedBoilerplateCandidates, rankCandidates } from './candidate-ranking.js';
import { detectProtectedSmartCandidates } from './protected-smart.js';
import type { PageDetectionResult, DetectedCandidate, DetectedDetailMode, DetectedDetailPlan, DetectedField, DetectedFieldDiagnostics, DetectedLlmRankInput, DetectedPagination, DetectedPopupDismissal, DetectedSearchPlan, DetectOptions } from './types.js';

export { dedupeEquivalentCandidates, filterDetectedBoilerplateCandidates } from './candidate-ranking.js';

export function applyGoalScoresForTesting(candidates: DetectedCandidate[], goal: string): DetectedCandidate[] {
  return applyGoalScores(candidates, goal);
}

export function rankCandidatesForTesting(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return rankCandidates(candidates);
}

const require = createRequire(import.meta.url);
const puppeteer = require('rebrowser-puppeteer-core') as typeof import('puppeteer-core');
const EngineModule = require('@octopus/engine') as {
  resolveChrome: (options?: { onStatus?: (status: ChromeResolveStatus) => void }) => Promise<{ executablePath: string }>;
};

interface RawCandidate {
  type: DetectedCandidate['type'];
  selector: string;
  xpath: string;
  itemSelector?: string;
  itemXPath?: string;
  itemCount: number;
  fields: DetectedField[];
  sampleRows: Record<string, string>[];
  reasons: string[];
  confidence: number;
}

type ExtensionCommandResponse = {
  success: true;
  data?: unknown;
} | {
  success: false;
  error: string;
};

interface DetectorExtensionBridge {
  runtimeConfig: { sessionId: string; wsUrl: string };
  sendActionCommand(command: Record<string, unknown>): Promise<ExtensionCommandResponse>;
  resolveTabId(pageUrl: string): number | undefined;
  close(): void;
}

interface ManualStartDecision {
  dismissPopups: boolean;
  allowSessionSave: boolean;
}

interface LoginInterventionResult {
  handled: boolean;
  allowSessionSave: boolean;
  ignoreFuturePrompts?: boolean;
  popupDismissals?: DetectedPopupDismissal[];
}

function mergeLoginIntervention(a: LoginInterventionResult, b: LoginInterventionResult): LoginInterventionResult {
  const popupDismissals = [...(a.popupDismissals ?? []), ...(b.popupDismissals ?? [])];
  return {
    handled: a.handled || b.handled,
    allowSessionSave: a.allowSessionSave && b.allowSessionSave,
    ...(popupDismissals.length ? { popupDismissals } : {}),
    ...(a.ignoreFuturePrompts || b.ignoreFuturePrompts ? { ignoreFuturePrompts: true } : {})
  };
}

function updateSearchPlanFinalUrl(searchPlan: DetectedSearchPlan | undefined, page: Page): DetectedSearchPlan | undefined {
  return searchPlan ? { ...searchPlan, finalUrl: page.url() } : undefined;
}

function writeManualOverlayHintOnce(runtimeConsole: SuppressedRuntimeConsole, page: Page | undefined, key: string, message: string): void {
  void page;
  const scopedKey = key;
  if (manualOverlayHintKeys.has(scopedKey)) return;
  manualOverlayHintKeys.add(scopedKey);
  runtimeConsole.writeStderr(message);
}

export class DetectionLoginRequiredError extends Error {
  readonly code = 'LOGIN_SESSION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'DetectionLoginRequiredError';
  }
}

interface SearchInputCandidate {
  xpath: string;
  name: string;
  type: string;
  placeholder: string;
  value: string;
  formAction: string;
  buttonXPath?: string;
  buttonText?: string;
  score: number;
  reasons: string[];
}

interface SearchSubmitInputRef {
  name: string;
  xpath: string;
}

interface SearchSubmitButton {
  xpath: string;
  text?: string;
  score?: number;
  reasons?: string[];
}

type ManualOverlayAction = string;

interface ManualOverlayChoice {
  title: string;
  value: ManualOverlayAction;
  description?: string;
  primary?: boolean;
}

interface ManualOverlaySelection {
  action?: ManualOverlayAction;
  selectedXPath?: string;
  selectedText?: string;
}

const manualOverlayHintKeys = new Set<string>();

type NewPageWatcher = Promise<Page | undefined> & {
  cancel?: () => void;
};

interface ScrollProbeSummary {
  snapshots: ScrollProbeSnapshot[];
  sawActiveLoadMore: boolean;
  sawGrowth: boolean;
  maxArticleLikeCount: number;
  maxContentHeight: number;
  maxPageHeight: number;
  grewArticleLikeCount?: number;
  grewContentHeight?: number;
  grewPageHeight?: number;
  reachedBottom?: boolean;
  bestActiveLoadMoreText?: string;
  bestActiveLoadMoreXPath?: string;
}

export async function detectPage(options: DetectOptions): Promise<PageDetectionResult> {
  const runtimeConsole = suppressDetectorRuntimeConsole();
  let host: ExtensionDetectorHost | null = null;
  try {
    host = await ExtensionDetectorHost.start(options);
    let ignoreLoginInterventionPrompts = false;
    const handleLoginIntervention = async (reason: string): Promise<LoginInterventionResult> => {
      if (ignoreLoginInterventionPrompts) return { handled: false, allowSessionSave: false, ignoreFuturePrompts: true };
      const result = await handleLoginInterventionIfNeeded(host!, options, runtimeConsole, reason);
      if (result.ignoreFuturePrompts) ignoreLoginInterventionPrompts = true;
      return result;
    };
    let page = host.page;
    page.setDefaultTimeout(options.timeoutMs);
    await waitForPageSettled(page, options.waitMs);
    const popupDismissals: DetectedPopupDismissal[] = [];
    const manualPopupPromptKeys = new Set<string>();
    let loginIntervention = await handleLoginIntervention('login requirement detected after opening the page');
    popupDismissals.push(...loginIntervention.popupDismissals ?? []);
    page = host.page;
    if (options.dismissPopups && !options.manual) {
      popupDismissals.push(...await dismissPageObstructions(page));
      if (popupDismissals.length) await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    let searchPlan: DetectedSearchPlan | undefined;
    if (options.input && Object.keys(options.input).length) {
      await adoptBestPageForSearchInput(host, options).catch(() => undefined);
      page = host.page;
      const searchInputOverrides = options.manual ? await confirmSearchInputsInteractively(host, options, runtimeConsole) : undefined;
      if (options.manual) {
        searchPlan = await submitInputsManually(host, options, runtimeConsole, searchInputOverrides);
        page = host.page;
      } else {
        searchPlan = await submitInputs(host, options, searchInputOverrides);
        page = host.page;
        await waitForPageSettled(page, options.waitMs);
        let afterSearchLogin = await handleLoginIntervention('login requirement detected after search');
        popupDismissals.push(...afterSearchLogin.popupDismissals ?? []);
        page = host.page;
        loginIntervention = mergeLoginIntervention(loginIntervention, afterSearchLogin);
        searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
        if (!await pageLooksLikeSearchResult(page, options).catch(() => false)) {
          searchPlan = await retrySearchWithEnter(host, options, searchPlan);
          page = host.page;
          await waitForPageSettled(page, options.waitMs);
          const retryLogin = await handleLoginIntervention('login requirement detected after retrying search');
          popupDismissals.push(...retryLogin.popupDismissals ?? []);
          page = host.page;
          loginIntervention = mergeLoginIntervention(loginIntervention, retryLogin);
          afterSearchLogin = mergeLoginIntervention(afterSearchLogin, retryLogin);
          searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
        }
        if (afterSearchLogin.handled) {
          if (!await pageLooksLikeSearchResult(host.page, options)) {
            await host.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs }).catch(() => undefined);
            await waitForPageSettled(host.page, options.waitMs);
            searchPlan = await submitInputs(host, options, searchInputOverrides);
            page = host.page;
            await waitForPageSettled(host.page, options.waitMs);
            const replayLogin = await handleLoginIntervention('login requirement still detected after replaying search post-login');
            popupDismissals.push(...replayLogin.popupDismissals ?? []);
            page = host.page;
            loginIntervention = mergeLoginIntervention(loginIntervention, replayLogin);
            searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
          }
        }
        if (!await pageLooksLikeSearchResult(page, options).catch(() => false)) {
          throw new Error('Search did not reach a result page for the current keyword. Confirm the search opened the result page, or pass the search-result URL directly and retry.');
        }
      }
      const preDetectionLogin = await handleLoginIntervention('login/verification requirement detected before extraction detection');
      popupDismissals.push(...preDetectionLogin.popupDismissals ?? []);
      page = host.page;
      loginIntervention = mergeLoginIntervention(loginIntervention, preDetectionLogin);
      searchPlan = updateSearchPlanFinalUrl(searchPlan, page);
      if (options.dismissPopups && !options.manual) popupDismissals.push(...await dismissPageObstructions(page));
    }
    let manualStartDecision: ManualStartDecision = { dismissPopups: false, allowSessionSave: true };
    const allowPopupDismissal = options.dismissPopups && (!options.manual || manualStartDecision.dismissPopups);
    if (allowPopupDismissal) popupDismissals.push(...await dismissPageObstructions(page));
    const scrollProbe = await autoScroll(page, options.scrolls);
    await waitForPageSettled(page, Math.min(options.waitMs, 1000));
    if (allowPopupDismissal) popupDismissals.push(...await dismissPageObstructions(page));
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    const effectiveOptions = { ...options, interactive: options.interactive || options.manual };
    let candidates = await detectCandidates(page, effectiveOptions, scrollProbe);
    if (options.dismissPopups && options.manual) {
      popupDismissals.push(...await confirmManualPopupDismissal(page, runtimeConsole, manualPopupPromptKeys));
      if (popupDismissals.length) {
        await waitForPageSettled(page, Math.min(options.waitMs, 800));
        candidates = await detectCandidates(page, effectiveOptions, scrollProbe);
      }
    }
    const llmRankInput = options.llmRank ? buildLlmRankInput(candidates, options.goal) : undefined;
    let selectedCandidateIds: string[] = [];
    if (effectiveOptions.interactive && candidates.length) {
      selectedCandidateIds = await chooseCandidateInteractively(page, candidates, runtimeConsole);
      if (selectedCandidateIds.length) {
        const selectedSet = new Set(selectedCandidateIds);
        candidates = [
          ...candidates.filter((candidate) => selectedSet.has(candidate.id)),
          ...candidates.filter((candidate) => !selectedSet.has(candidate.id))
        ];
        const selectedPagination = await choosePaginationInteractively(page, candidates.filter((candidate) => selectedSet.has(candidate.id)), runtimeConsole, scrollProbe);
        candidates = candidates.map((candidate) => selectedSet.has(candidate.id)
          ? { ...candidate, pagination: selectedPagination }
          : candidate);
        const detailPlans = await chooseDetailPlanInteractively(page, candidates.filter((candidate) => selectedSet.has(candidate.id)), runtimeConsole, options.timeoutMs);
        if (detailPlans.size) {
          candidates = candidates.map((candidate) => {
            const detailPlan = detailPlans.get(candidate.id);
            return detailPlan ? { ...candidate, detailPlan } : candidate;
          });
        }
      }
    }
    candidates = await attachAgentDiagnostics(page, candidates).catch(() => candidates);
    if (options.agentScreenshotPath) {
      candidates = await attachCandidateVisualElements(page, candidates).catch(() => candidates);
    }
    const agentScreenshot = options.agentScreenshotPath
      ? await captureAgentScreenshot(page, options.agentScreenshotPath, candidates).catch(() => undefined)
      : undefined;
    const canOfferSessionSave = loginIntervention.handled && loginIntervention.allowSessionSave;
    const shouldSaveSession = options.saveSession || (canOfferSessionSave && await chooseSaveSessionInBrowser(page, runtimeConsole)
        .catch(() => chooseSaveSessionInteractively(runtimeConsole)));
    const savedSession = shouldSaveSession
      ? await saveSessionForPage(page, options.sessionName || defaultSessionNameForUrl(options.url), options.url)
      : undefined;
    return {
      url: options.url,
      finalUrl: page.url(),
      title: await page.title(),
      capturedAt: new Date().toISOString(),
      candidates,
      ...(searchPlan ? { searchPlan: { ...searchPlan, finalUrl: page.url() } } : {}),
      ...(savedSession ? { savedSession } : {}),
      selectedCandidateId: selectedCandidateIds[0],
      selectedCandidateIds,
      ...(llmRankInput ? { llmRankInput } : {}),
      ...(agentScreenshot ? { agentScreenshot } : {}),
      ...(popupDismissals.length ? { popupDismissals: dedupePopupDismissals(popupDismissals) } : {})
    };
  } finally {
    await host?.close();
    runtimeConsole.restoreOriginal();
  }
}

async function chooseSaveSessionInteractively(runtimeConsole: SuppressedRuntimeConsole): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  try {
    const action = await runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => 'Save the current site login session for later extraction tasks?',
      readState: async () => undefined,
      choices: () => [
        { title: 'Save login session and write a session reference into the generated task file', value: 'save' },
        { title: 'Do not save; use it only for this detection run', value: 'skip' }
      ]
    });
    return action === 'save';
  } finally {
    runtimeConsole.suppress();
  }
}

async function chooseSaveSessionInBrowser(page: Page, runtimeConsole: SuppressedRuntimeConsole): Promise<boolean> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'save-session', '\nUse the browser overlay to confirm whether to save the login session.\n');
  try {
    await showManualOverlay(page, {
      title: 'Save login session',
      message: 'Save the current site login session for later extraction tasks?',
      choices: [
        { title: 'Save login session', value: 'save-session', primary: true },
        { title: 'Do not save', value: 'skip-session' }
      ]
    });
    const selection = await waitForManualOverlayAction(page);
    await clearManualOverlayAction(page);
    return selection?.action === 'save-session';
  } finally {
    await removeManualOverlay(page).catch(() => undefined);
  }
}

async function submitInputsManually(
  host: ExtensionDetectorHost,
  options: DetectOptions,
  runtimeConsole: SuppressedRuntimeConsole,
  inputOverrides?: Map<string, SearchInputCandidate>
): Promise<DetectedSearchPlan | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return submitInputs(host, options, inputOverrides);
  runtimeConsole.restore();
  try {
    await showManualOverlay(host.page, {
      title: 'Filling search keyword',
      message: 'Page state confirmed; entering the keyword into the search field.',
      status: Object.entries(options.input ?? {}).map(([name, value]) => `${name}: ${value}`).join('  '),
      choices: [
        { title: 'Processing...', value: 'wait', primary: true }
      ]
    }).catch(() => undefined);
    const replayed = await inputSearchFieldsOnly(host, options, inputOverrides);
    if (!replayed?.inputs.length) return undefined;
    const selected = await chooseSearchSubmitButtonInBrowserOrCli(host.page, replayed.inputs, runtimeConsole);
    if (!selected?.xpath) throw new Error('User canceled search button confirmation');
    await showManualOverlay(host.page, {
      title: 'Submitting search',
      message: 'Search button recorded; submitting search and waiting for the result page.',
      status: selected.text ? `Button: ${truncateText(selected.text, 24)}` : `Button: ${selected.xpath}`,
      choices: [
        { title: 'Processing...', value: 'wait', primary: true }
      ],
      selectedXPath: selected.xpath,
      selectedText: selected.text,
      highlightXPaths: replayed.inputs.map((input) => input.xpath)
    }).catch(() => undefined);
    const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
    const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
    const clicked = await clickRecordedSearchSubmit(host, selected, options.timeoutMs, replayed.inputs).catch(() => selected);
    await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
    await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
    await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
    await waitForPageSettled(host.page, options.waitMs);
    await removeManualOverlay(host.page).catch(() => undefined);
    if (!await pageLooksLikeSearchResult(host.page, options).catch(() => false) && !await pageHasSearchLoginGate(host.page).catch(() => false)) {
      throw new Error('Search did not reach a result page for the current keyword. Confirm the search button is correct, or pass the search-result URL directly and retry.');
    }
    return {
      ...replayed,
      finalUrl: host.page.url(),
      submit: { mode: 'click', xpath: clicked?.xpath || selected.xpath, ...(clicked?.text || selected.text ? { text: clicked?.text || selected.text } : {}) }
    };
  } finally {
    await removeManualOverlay(host.page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

async function chooseSearchSubmitButtonInBrowserOrCli(
  page: Page,
  inputs: SearchSubmitInputRef[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<SearchSubmitButton | undefined> {
  const browserOverlayReady = await showSearchSubmitPickerInBrowser(page, inputs, undefined, runtimeConsole)
    .then(() => true)
    .catch(() => false);
  let selected: SearchSubmitButton | undefined;
  while (true) {
    const overlay = browserOverlayReady
      ? await waitForSearchSubmitOverlayAction(page, inputs, selected, runtimeConsole).catch(() => undefined)
      : undefined;
    const cli = overlay ? undefined : await chooseSearchSubmitInCli(page, inputs, selected, runtimeConsole).catch(() => undefined);
    const action = overlay?.action ?? cli?.action;
    selected = overlay?.selected ?? cli?.selected ?? selected ?? await searchSubmitButtonFromManualOverlay(page).catch(() => undefined);
    if (action === 'wait') {
      if (browserOverlayReady) await showSearchSubmitPickerInBrowser(page, inputs, selected, runtimeConsole);
      continue;
    }
    if (action === 'cancel' || !action) return undefined;
    if (selected?.xpath) return selected;
  }
}

async function showSearchSubmitPickerInBrowser(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'search-submit', '\nUse the browser overlay to click and confirm the search button.\n');
  await showManualOverlay(page, {
    title: 'Click search button',
    message: [
      'Keyword has been entered. Click the page search button; this click only records the button and will not navigate immediately.',
      'After selecting it, click "Confirm and run search".'
    ].join('\n'),
    status: selected?.xpath ? `Current selection: ${selected.xpath}${selected.text ? ` (${truncateText(selected.text, 24)})` : ''}` : 'Current selection: none',
    choices: [
      { title: selected?.xpath ? 'Confirm and run search' : 'Waiting for search button selection', value: selected?.xpath ? 'confirm' : 'wait', primary: Boolean(selected?.xpath) },
      { title: 'Keep selecting a search button on the page', value: 'wait' },
      { title: 'Cancel search detection', value: 'cancel' }
    ],
    selectedXPath: selected?.xpath,
    selectedText: selected?.text,
    highlightXPaths: inputs.map((input) => input.xpath),
    mode: 'pick-search-submit',
    inputXPaths: inputs.map((input) => input.xpath)
  });
}

async function waitForSearchSubmitOverlayAction(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<{ action: ManualOverlayAction; selected?: SearchSubmitButton } | undefined> {
  while (true) {
    if (page.isClosed()) return undefined;
    const state = await readManualOverlaySelection(page);
    const latest = await searchSubmitButtonFromManualOverlay(page).catch(() => selected);
    if (latest?.xpath && latest.xpath !== selected?.xpath) {
      await showSearchSubmitPickerInBrowser(page, inputs, latest, runtimeConsole);
      await clearManualOverlayAction(page);
      selected = latest;
      continue;
    }
    if (state?.action) {
      await clearManualOverlayAction(page);
      return { action: state.action, selected: latest };
    }
    await delay(150);
  }
}

async function searchSubmitButtonFromManualOverlay(page: Page): Promise<SearchSubmitButton | undefined> {
  const state = await readManualOverlaySelection(page);
  if (!state?.selectedXPath) return undefined;
  return {
    xpath: state.selectedXPath,
    ...(state.selectedText ? { text: state.selectedText } : {}),
    score: 2,
    reasons: ['manual picked search submit']
  };
}

async function chooseSearchSubmitInCli(
  page: Page,
  inputs: SearchSubmitInputRef[],
  selected: SearchSubmitButton | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<{ action: ManualOverlayAction; selected?: SearchSubmitButton }> {
  await installSearchSubmitPickerOverlay(page, inputs.map((input) => input.xpath));
  try {
    let current = selected;
    const action = await runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => [
        'Click the search button in the browser; this click will be intercepted, only the button XPath will be recorded, and it will run automatically after confirmation.',
        `Current selection: ${current?.xpath ? `${current.xpath}${current.text ? ` (${truncateText(current.text, 24)})` : ''}` : 'none'}`
      ].join('\n'),
      readState: async () => {
        current = await readSearchSubmitPickerSelection(page).catch(() => current);
      },
      choices: () => [
        { title: current?.xpath ? 'Confirm this search button and run search' : 'Waiting for search button selection', value: current?.xpath ? 'confirm' : 'wait' },
        { title: 'Cancel search detection', value: 'cancel' }
      ]
    });
    return { action, selected: current };
  } finally {
    await removeSearchSubmitPickerOverlay(page).catch(() => undefined);
  }
}

async function inputSearchFieldsOnly(
  host: ExtensionDetectorHost,
  options: DetectOptions,
  inputOverrides?: Map<string, Pick<SearchInputCandidate, 'xpath'>>
): Promise<DetectedSearchPlan | undefined> {
  const entries = Object.entries(options.input ?? {});
  const inputs: DetectedSearchPlan['inputs'] = [];
  for (const [name, value] of entries) {
    const inputXPath = inputOverrides?.get(name)?.xpath || await findInputXPath(host.page, name);
    if (!inputXPath) continue;
    inputs.push({ name, value, xpath: inputXPath });
    await host.command({
      action: 'input',
      frame: { isIframe: false },
      target: { type: 'xpath', xpath: inputXPath },
      timeoutMs: options.timeoutMs,
      payload: {
        text: value,
        mode: 'type',
        clearBeforeInput: true,
        submit: 'none',
        dispatchEvents: ['input', 'change']
      }
    }).catch((error) => {
      if (!options.manual) throw error;
    });
    if (await searchInputNeedsDomEntry(host.page, inputXPath).catch(() => false)) {
      await setSearchInputValueByDom(host.page, inputXPath, value).catch(() => undefined);
    }
  }
  if (!inputs.length) return undefined;
  return {
    startUrl: options.url,
    finalUrl: host.page.url(),
    inputs
  };
}

interface SuppressedRuntimeConsole {
  suppress(): void;
  restore(): void;
  restoreOriginal(): void;
  writeStderr(message: string): void;
  question(prompt?: string): Promise<string>;
}

function isDetectorRuntimeNoise(message: string): boolean {
  return /\[WorkflowAgent\].*target\s+销毁:\s*other/i.test(message)
    || /\[WorkflowAgent\].*target\s+destroyed:\s*other/i.test(message);
}

function suppressDetectorRuntimeConsole(): SuppressedRuntimeConsole {
  if (process.env.OCTOPARSE_SHOW_RUNTIME_STDIO === '1') {
    return {
      suppress() {},
      restore() {},
      restoreOriginal() {},
      writeStderr(message: string) {
        process.stderr.write(message);
      },
      async question(prompt = '') {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(prompt);
        } finally {
          rl.close();
        }
      }
    };
  }
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let suppressed = false;
  const filteredStdoutWrite = ((chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
    if (text && isDetectorRuntimeNoise(text)) return true;
    return originalStdoutWrite(chunk as never, ...(args as []));
  }) as typeof process.stdout.write;
  const filteredStderrWrite = ((chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
    if (text && isDetectorRuntimeNoise(text)) return true;
    return originalStderrWrite(chunk as never, ...(args as []));
  }) as typeof process.stderr.write;
  const suppress = () => {
    if (suppressed) return;
    process.stdout.write = (((chunk: unknown, ...args: unknown[]) => {
      const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
      if (process.env.OCTOPARSE_TRACKING_DEBUG === '1' && text.startsWith('[detect-debug]')) {
        return filteredStdoutWrite(chunk as never, ...(args as []));
      }
      return true;
    }) as typeof process.stdout.write);
    process.stderr.write = (((chunk: unknown, ...args: unknown[]) => {
      const text = typeof chunk === 'string' || Buffer.isBuffer(chunk) ? String(chunk) : '';
      if (process.env.OCTOPARSE_TRACKING_DEBUG === '1' && text.startsWith('[detect-debug]')) {
        return filteredStderrWrite(chunk as never, ...(args as []));
      }
      return true;
    }) as typeof process.stderr.write);
    suppressed = true;
  };
  const restore = () => {
    if (!suppressed) return;
    process.stdout.write = filteredStdoutWrite;
    process.stderr.write = filteredStderrWrite;
    suppressed = false;
  };
  const restoreOriginal = () => {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    suppressed = false;
  };
  suppress();
  return {
    suppress,
    restore,
    restoreOriginal,
    writeStderr(message: string) {
      originalStderrWrite(message);
    },
    async question(prompt = '') {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: { write: originalStderrWrite } as NodeJS.WritableStream });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    }
  };
}

class ExtensionDetectorHost {
  private constructor(
    private readonly browserInstance: Browser,
    private readonly runtimeExtensionPath: string | undefined,
    private readonly bridgeHub: BridgeHub,
    private readonly extensionBridge: DetectorExtensionBridge,
    public page: Page,
    private tabId: number,
    private readonly virtualDisplay: VirtualDisplayHandle
  ) {}

  static async start(options: DetectOptions): Promise<ExtensionDetectorHost> {
    assertDetectDisplayAvailable(options);
    const virtualDisplay = await startVirtualDisplayForDetection(options);
    const runId = `detect_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const bridgeHub = new BridgeHub();
    const extensionBridge = await bridgeHub.createSessionBridge(runId) as DetectorExtensionBridge;
    let browser: Browser | undefined;
    let runtimeExtensionPath: string | undefined;

    try {
      const chromePath = options.chromePath ?? (await EngineModule.resolveChrome({ onStatus: options.onChromeStatus })).executablePath;
      runtimeExtensionPath = await prepareDetectorRuntimeExtension(runId, extensionBridge);
      browser = await launchDetectorBrowser(chromePath, runtimeExtensionPath);
      await bridgeHub.waitForSessionConnected(runId, Math.min(options.timeoutMs, 30_000));
      const page = await openDetectorTargetPage(browser, options.url, options.timeoutMs);
      const tabId = await waitForTabId(extensionBridge, page, options.timeoutMs);
      await readyCheck(extensionBridge, tabId, Math.min(options.timeoutMs, 15_000)).catch(() => undefined);
      return new ExtensionDetectorHost(browser, runtimeExtensionPath, bridgeHub, extensionBridge, page, tabId, virtualDisplay);
    } catch (error) {
      await browser?.close().catch(() => undefined);
      if (runtimeExtensionPath) await rm(runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
      bridgeHub.close();
      await virtualDisplay.close();
      throw error;
    }
  }

  async refreshTabId(): Promise<number> {
    this.tabId = await waitForTabId(this.extensionBridge, this.page, 10_000);
    return this.tabId;
  }

  async usePage(page: Page): Promise<void> {
    this.page = page;
    await this.refreshTabId();
  }

  browser(): Browser | undefined {
    return this.browserInstance;
  }

  async command(command: Record<string, unknown>): Promise<ExtensionCommandResponse> {
    const response = await this.extensionBridge.sendActionCommand({
      ...command,
      tabId: await this.refreshTabId()
    });
    if (!response.success) {
      throw new Error(response.error || `${command.action} command failed`);
    }
    return response;
  }

  async close(): Promise<void> {
    const browserProcess = this.browserInstance.process?.() as ChildProcess | null | undefined;
    silenceBrowserProcess(browserProcess);
    try {
      await this.browserInstance.close();
    } catch {
      // best-effort cleanup
    }
    await waitForBrowserProcessExit(browserProcess, 1500);
    this.bridgeHub.close();
    if (this.runtimeExtensionPath) await rm(this.runtimeExtensionPath, { recursive: true, force: true }).catch(() => undefined);
    await this.virtualDisplay.close();
  }
}

function assertDetectDisplayAvailable(options: DetectOptions): void {
  if (process.platform !== 'linux' || (!options.manual && !options.interactive)) return;
  if (hasLinuxDisplayEnvironment()) return;
  throw new Error('Linux manual detection requires a visible browser environment, but no X server or WAYLAND_DISPLAY is available. Run it in a desktop session or provide a visible display through xvfb-run/VNC; non-manual detection uses Xvfb automatically.');
}

async function startVirtualDisplayForDetection(options: DetectOptions): Promise<VirtualDisplayHandle> {
  if (options.manual || options.interactive) {
    return {
      enabled: false,
      async close() {}
    };
  }
  return startVirtualDisplayIfNeeded();
}

async function prepareDetectorRuntimeExtension(runId: string, extensionBridge: DetectorExtensionBridge): Promise<string> {
  const engineDist = dirname(require.resolve('@octopus/engine'));
  const templatePath = join(engineDist, 'extension');
  const runtimePath = join(tmpdir(), 'octoparse-engine-extension', `${runId}-${Date.now()}`);
  await mkdir(dirname(runtimePath), { recursive: true });
  await cp(templatePath, runtimePath, { recursive: true });
  await writeFile(join(runtimePath, 'runtime-config.json'), `${JSON.stringify(extensionBridge.runtimeConfig, null, 2)}\n`, 'utf8');
  return runtimePath;
}

async function launchDetectorBrowser(chromePath: string, runtimeExtensionPath: string): Promise<Browser> {
  return puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    defaultViewport: null,
    dumpio: false,
    ignoreDefaultArgs: ['--enable-automation', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-notifications',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationControlled',
      '--allow-running-insecure-content',
      '--disable-features=IsolateOrigins,HttpsFirstBalancedModeAutoEnable,NetworkService,Translate,AcceptCHFrame,MediaRouter,OptimizationHints,ProcessPerSiteUpToMainFrameThreshold,IsolateSandboxedIframes,HttpsUpgrades',
      '--enable-features=SharedArrayBuffer,TabFreeze,TabDiscarding',
      '--prerender-from-omnibox=disabled',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--silent-debugger-extension-api',
      '--window-size=1920,1200',
      '--js-flags=--expose-gc',
      '--disk-cache-size=524288000',
      '--aggressive-cache-discard',
      `--user-agent=${defaultUserAgent()}`,
      `--load-extension=${runtimeExtensionPath}`,
      `--disable-extensions-except=${runtimeExtensionPath}`,
      '--no-first-run',
      '--disable-default-apps'
    ]
  }) as Promise<Browser>;
}

function silenceBrowserProcess(child: ChildProcess | null | undefined): void {
  child?.stdout?.unpipe(process.stdout);
  child?.stderr?.unpipe(process.stderr);
  child?.stdout?.removeAllListeners('data');
  child?.stderr?.removeAllListeners('data');
}

async function waitForBrowserProcessExit(child: ChildProcess | null | undefined, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    delay(timeoutMs)
  ]);
}

async function waitForDetectorPage(browser: Browser, url: string, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const targetHost = safeHost(url);
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const exact = pages.find((page) => page.url() === url);
    if (exact) return exact;
    const sameHost = pages.find((page) => safeHost(page.url()) === targetHost && !/^about:blank/i.test(page.url()));
    if (sameHost) return sameHost;
    const nonBlank = pages.find((page) => !/^about:blank/i.test(page.url()));
    if (nonBlank && !targetHost) return nonBlank;
    await delay(200);
  }
  const pages = await browser.pages();
  return pages[0] ?? await browser.newPage();
}

async function openDetectorTargetPage(browser: Browser, url: string, timeoutMs: number): Promise<Page> {
  const page = await waitForDetectorPage(browser, DETECTOR_PARKING_URL, Math.min(timeoutMs, 5000));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return page;
}

async function waitForTabId(extensionBridge: DetectorExtensionBridge, page: Page, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = [page.url(), page.url().replace(/\/$/, '')];
    for (const url of candidates) {
      const tabId = extensionBridge.resolveTabId(url);
      if (tabId !== undefined) return tabId;
    }
    await delay(200);
  }
  throw new Error(`extension tab was not registered for ${page.url()}`);
}

async function readyCheck(extensionBridge: DetectorExtensionBridge, tabId: number, timeoutMs: number): Promise<void> {
  const response = await extensionBridge.sendActionCommand({
    action: 'ready-check',
    tabId,
    frame: { isIframe: false },
    timeoutMs,
    payload: { mode: 'base-load' }
  });
  if (!response.success) throw new Error(response.error);
}

async function waitForManualContinue(page: Page, targetUrl: string, runtimeConsole: SuppressedRuntimeConsole): Promise<ManualStartDecision> {
  while (true) {
    runtimeConsole.restore();
    const currentUrl = page.url();
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\nOpened target page: ${targetUrl}\n`);
      runtimeConsole.writeStderr(`Current page: ${currentUrl}\n`);
      runtimeConsole.writeStderr('If the site redirects to a login page, complete login in the browser. Press Enter when the target data is visible to start detection...\n');
      await runtimeConsole.question('');
      runtimeConsole.suppress();
      return { dismissPopups: false, allowSessionSave: true };
    }

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: [
        `Opened target page: ${targetUrl}`,
        currentUrl !== targetUrl ? `Current page: ${currentUrl}` : '',
        'If the site redirects to a login page, complete login in the browser. If it does not return automatically after login, reopen the target page.'
      ].filter(Boolean).join('\n'),
      choices: [
        { title: 'I am logged in and can see the target data; start detection', value: 'detect-logged-in' },
        { title: 'The current page does not require login; start detection', value: 'detect-public' },
        { title: 'Reopen target page', value: 'reload-target' },
        { title: 'Try dismissing the login popup and continue without logging in', value: 'dismiss-popups' },
        { title: 'Cancel', value: 'cancel' }
      ],
      initial: 0
    });
    runtimeConsole.suppress();

    if (response.action === 'reload-target') {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await waitForPageSettled(page, 1000);
      continue;
    }
    if (response.action === 'dismiss-popups') return { dismissPopups: true, allowSessionSave: false };
    if (response.action === 'detect-public') return { dismissPopups: false, allowSessionSave: false };
    if (response.action === 'detect-logged-in') return { dismissPopups: false, allowSessionSave: true };
    throw new Error('User canceled manual detection');
  }
}

async function saveSessionForPage(page: Page, sessionName: string, targetUrl: string) {
  const origin = sessionOriginForUrl(targetUrl);
  const hosts = Array.from(new Set([
    new URL(origin).hostname,
    hostFromUrl(page.url())
  ].filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase())));
  const cookies = await page.browserContext().cookies().catch(() => []);
  const scoped = cookies.filter((cookie) => hosts.some((host) => cookieMatchesHost(cookie.domain, host)));
  return saveBrowserSession({
    name: sessionName,
    origin,
    hosts,
    cookies: scoped
  });
}

function cookieMatchesHost(domain: string | undefined, host: string): boolean {
  const normalized = (domain || '').replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase();
  if (!normalized) return false;
  return normalized === normalizedHost || normalizedHost.endsWith(`.${normalized}`);
}

function hostFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function waitForPageSettled(page: Page, waitMs: number): Promise<void> {
  await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', { timeout: waitMs }).catch(() => undefined);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await waitForLoadingPlaceholders(page, Math.max(1200, Math.min(5000, waitMs * 3))).catch(() => undefined);
}

async function waitForLoadingPlaceholders(page: Page, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  const hasLoading = await page.evaluate(() => {
    const text = ((document.body as HTMLElement | null)?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    return /\bloading\b|loading search results|加载中|正在加载|请稍候|please wait/i.test(text);
  }).catch(() => false);
  if (!hasLoading) return;
  await page.waitForFunction(() => {
    function text(element: Element | null | undefined): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const bodyText = text(document.body);
    const stillLoading = /\bloading\b|loading search results|加载中|正在加载|请稍候|please wait/i.test(bodyText);
    const likelyRows = Array.from(document.querySelectorAll('main article,main li,main [class*="result" i],main [class*="crate" i],main [class*="package" i],[role="main"] article,[role="main"] li,[role="main"] [class*="result" i]'))
      .filter(visible)
      .filter((element) => {
        const value = text(element);
        return value.length >= 24 && Boolean(element.querySelector('a'));
      });
    return !stillLoading || likelyRows.length >= 2;
  }, { timeout: timeoutMs, polling: 250 }).catch(() => undefined);
}

async function handleLoginInterventionIfNeeded(host: ExtensionDetectorHost, options: DetectOptions, runtimeConsole: SuppressedRuntimeConsole, reason: string): Promise<LoginInterventionResult> {
  let page = host.page;
  const obstruction = (await detectPageObstructions(page).catch(() => []))
    .find((item) => item.type === 'login' || item.type === 'captcha' || item.type === 'paywall');
  const hasSubstantialContent = await pageHasSubstantialSearchOrContent(page).catch(() => false);
  if (obstruction?.type === 'paywall' && obstruction.closeXPath && obstruction.canHide) {
    return { handled: false, allowSessionSave: true };
  }
  const obstructionText = `${obstruction?.popupText || ''} ${obstruction?.closeText || ''} ${obstruction?.reasons.join(' ') || ''}`;
  const blocksWithVerification = Boolean(obstruction && /(验证|验证码|手机号|手机号码|获取验证码|人机|captcha|verification|verify|phone|mobile)/i.test(obstructionText));
  if (!obstruction && hasSubstantialContent) {
    return { handled: false, allowSessionSave: true };
  }
  if (obstruction?.type === 'login' && hasSubstantialContent && obstruction.confidence < 0.82 && !blocksWithVerification) {
    return { handled: false, allowSessionSave: true };
  }
  const loginPage = obstruction ? undefined : await detectLoginLikePage(page).catch(() => undefined);
  if (!obstruction && !loginPage) return { handled: false, allowSessionSave: true };

  const message = loginPage
    ? `${reason}: the current page looks like a login page (${loginPage.reason}).`
    : `${reason}: detected ${popupTypeLabel(obstruction?.type)} popup.`;
  const interactive = shouldPromptForLoginIntervention(options);
  if (!interactive) {
    throw new DetectionLoginRequiredError(`${message} Open the page with --manual to complete login; add --save-session to save the session before automatic detection.`);
  }

  runtimeConsole.restore();
  try {
    const searchTriggeredLogin = /search|replay/i.test(reason);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\n${message}\nComplete login/verification in the opened browser, then press Enter when a searchable or extractable page is visible...\n`);
      await runtimeConsole.question('');
      runtimeConsole.suppress();
      await adoptBestPageAfterLogin(host, options).catch(() => undefined);
      page = host.page;
      await waitForPageSettled(page, options.waitMs);
      return { handled: true, allowSessionSave: true };
    }
    const initialAction: 'continue' | 'continue-without-login' = searchTriggeredLogin || !(obstruction?.type === 'login' && hasSubstantialContent)
      ? 'continue'
      : 'continue-without-login';
    const action = await chooseLoginInterventionInBrowser(host, message, initialAction, runtimeConsole)
      .catch(async () => {
        const response = await prompts({
          type: 'select',
          name: 'action',
          message: [
            message,
            'Complete login/verification in the browser, then return here to continue.'
          ].join('\n'),
          choices: [
            { title: 'Login is not needed; continue detection', value: 'continue-without-login' },
            { title: 'I completed login/verification; continue detection', value: 'continue' },
            { title: 'Cancel', value: 'cancel' }
          ],
          initial: initialAction === 'continue' ? 1 : 0
        });
        return response.action || 'cancel';
      });
    if (action === 'cancel' || !action) throw new Error('User canceled detection after login');
    if (action === 'continue') {
      await adoptBestPageAfterLogin(host, options).catch(() => undefined);
      page = host.page;
    }
    const popupDismissals = action === 'continue-without-login' && obstruction?.type === 'login'
      ? await dismissPageObstructions(page, { includeLogin: true }).catch(() => [])
      : [];
    if (popupDismissals.length) {
      await waitForPageSettled(page, Math.min(options.waitMs, 800));
    }
    await waitForPageSettled(page, options.waitMs);
    return {
      handled: action === 'continue',
      allowSessionSave: action === 'continue',
      ...(popupDismissals.length ? { popupDismissals } : {}),
      ...(action === 'continue-without-login' ? { ignoreFuturePrompts: true } : {})
    };
  } finally {
    await removeManualOverlaysFromBrowser(host.browser()).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

function shouldPromptForLoginIntervention(options: DetectOptions): boolean {
  return options.manual || options.interactive;
}

async function confirmManualPopupDismissal(page: Page, runtimeConsole: SuppressedRuntimeConsole, promptedKeys = new Set<string>()): Promise<DetectedPopupDismissal[]> {
  const item = (await detectPageObstructions(page).catch(() => []))
    .find((candidate) => candidate.closeXPath && candidate.canHide && candidate.type !== 'captcha');
  if (!item?.closeXPath) return [];
  const promptKey = `${item.type}:${item.popupXPath}:${item.closeXPath}`;
  if (promptedKeys.has(promptKey)) return [];
  promptedKeys.add(promptKey);

  writeManualOverlayHintOnce(runtimeConsole, page, 'popup-dismissal', '\nPage popup detected. Choose how to handle it in the browser overlay.\n');
  await showManualOverlay(page, {
    title: 'Page popup detected',
    message: [
      `Detected type: ${popupTypeLabel(item.type)}`,
      item.popupText ? `Content: ${truncateText(item.popupText, 90)}` : '',
      item.closeText ? `Close button: ${truncateText(item.closeText, 40)}` : '',
      'If this is a login, verification, or permission prompt that must stay open, do not close it.'
    ].filter(Boolean).join('\n'),
    status: item.closeText || item.closeXPath,
    selectedXPath: item.closeXPath,
    selectedText: item.closeText,
    choices: [
      {
        title: 'Keep popup, continue detection',
        value: 'keep',
        primary: true,
        description: 'No close action will be written; use for login, verification, permission, or uncertain popups.'
      },
      {
        title: 'Close and write to task',
        value: 'dismiss',
        description: 'Clicks the close button; use for ads, subscriptions, or prompts that do not affect login.'
      },
      { title: 'Cancel manual detection', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page).catch(() => undefined);
  await removeManualOverlay(page).catch(() => undefined);
  if (selection?.action === 'cancel') throw new Error('User canceled manual detection');
  if (selection?.action !== 'dismiss') return [];

  const clicked = await clickXPath(page, item.closeXPath).catch(() => false);
  if (!clicked) return [];
  const removed = await waitForPopupRemoved(page, item.popupXPath, 900).catch(() => false);
  if (!removed) return [];
  return [{
    type: item.type,
    action: 'click',
    xpath: item.closeXPath,
    text: item.closeText || item.popupText,
    confidence: item.confidence,
    removed: true,
    confirmedByUser: true,
    reasons: [...item.reasons, 'confirmed by manual popup prompt']
  }];
}

async function chooseLoginInterventionInBrowser(
  host: ExtensionDetectorHost,
  message: string,
  initialAction: 'continue' | 'continue-without-login',
  runtimeConsole: SuppressedRuntimeConsole
): Promise<'continue' | 'continue-without-login' | 'cancel'> {
  writeManualOverlayHintOnce(runtimeConsole, host.page, 'login', '\nUse the browser overlay to confirm login/verification status.\n');
  const overlayOptions = {
    title: 'Login/verification confirmation',
    message: [
      message,
      initialAction === 'continue-without-login'
        ? 'If this is only a login popup and does not block the current page content, you can continue; this detection run will not pause for the same popup type again.'
        : 'After continuing, the best page will be selected again and page content will be checked.'
    ].join('\n'),
    choices: [
      { title: 'Logged in/verified, continue', value: 'continue', primary: initialAction === 'continue' },
      { title: 'No login needed, continue', value: 'continue-without-login', primary: initialAction === 'continue-without-login' },
      { title: 'Cancel detection', value: 'cancel' }
    ]
  } satisfies Parameters<typeof showManualOverlay>[1];
  const browser = host.browser();
  const injectedUrls = new Map<Page, string>();
  const startedAt = Date.now();
  while (true) {
    let injectedAny = false;
    const pages = browser
      ? (await browser.pages().catch(() => [host.page])).filter((page) => !page.isClosed())
      : [host.page].filter((page) => !page.isClosed());
    for (const candidatePage of pages) {
      const selection = await readManualOverlaySelection(candidatePage).catch(() => undefined);
      if (selection?.action) {
        await clearManualOverlayAction(candidatePage).catch(() => undefined);
        if (candidatePage !== host.page && !candidatePage.isClosed()) await host.usePage(candidatePage).catch(() => undefined);
        if (selection.action === 'continue' || selection.action === 'continue-without-login') return selection.action;
        return 'cancel';
      }
      const currentUrl = candidatePage.url();
      if (selection && injectedUrls.get(candidatePage) === currentUrl) continue;
      await showManualOverlay(candidatePage, overlayOptions)
        .then(() => {
          injectedUrls.set(candidatePage, currentUrl);
          injectedAny = true;
        })
        .catch(() => undefined);
    }
    if (!injectedUrls.size && !injectedAny && Date.now() - startedAt > 1500) throw new Error('manual login overlay injection failed');
    await delay(150);
  }
}

async function adoptBestPageAfterLogin(host: ExtensionDetectorHost, options: DetectOptions): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  await delay(500);
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (!pages.length) return;
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    index,
    score: await scorePostLoginPage(page, options, index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === -Infinity) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

async function scorePostLoginPage(page: Page, options: DetectOptions, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="login" i],[class*="passport" i],[class*="mask" i]')).some(visible);
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const searchInput = Array.from(document.querySelectorAll('input[type="search"],input[name="q"],input[name="wd"],input[name*="search" i],input[type="text"],textarea')).some(visible);
    const keyword = input.keyword.toLowerCase();
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1200)}`);
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 3;
    } catch {}
    if (!/login|signin|passport|sso|auth/i.test(url)) score += 1.4;
    else score -= 4;
    if (keyword && `${url} ${title} ${text}`.toLowerCase().includes(keyword)) score += 2;
    if (searchUrlLike) score += 3.2;
    if (resultSemantic) score += 2.2;
    if (resultBlocks.length >= 2) score += 2.5;
    if (searchInput) score += 1;
    if (input.keyword && exactEntryUrl) score -= 7;
    if (input.keyword && !searchUrlLike && !resultSemantic && contentDetailUrlLike(url)) score -= 8;
    if (loginInput || modal && /登录|登陆|注册|验证码|手机号|微信登录|扫码|login|sign in|register|verification/i.test(text)) score -= 5;
    score += input.index / Math.max(1, input.total) * 0.25;
    return score;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, {
    url: options.url,
    keyword: Object.values(options.input ?? {})[0] ?? '',
    index,
    total
  });
}

async function adoptBestPageForSearchInput(host: ExtensionDetectorHost, options: DetectOptions): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (pages.length <= 1) return;
  await Promise.all(pages.map((page) => waitForPageSettled(page, Math.min(options.waitMs, 800)).catch(() => undefined)));
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    score: await scoreSearchInputPage(page, options, index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 1.2) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

async function scoreSearchInputPage(page: Page, options: DetectOptions, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const editable = Array.from(document.querySelectorAll('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'))
      .filter(visible);
    const searchLikeInput = editable.some((element) => {
      const attrs = [
        element.localName,
        (element as HTMLElement).id,
        (element as HTMLElement).className,
        element.getAttribute('name') || '',
        element.getAttribute('type') || '',
        element.getAttribute('role') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('data-placeholder') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ');
      return /搜索|搜|查询|关键词|search|query|keyword|searchbox/i.test(attrs);
    });
    const loginInput = editable.some((element) => /password|tel|phone|mobile|code|验证码|手机|密码|login|signin/i.test([
      element.getAttribute('type') || '',
      element.getAttribute('name') || '',
      element.getAttribute('placeholder') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || ''
    ].join(' ')));
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
    const url = location.href;
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 1.2;
    } catch {}
    if (searchLikeInput) score += 2.2;
    else if (editable.length) score += 0.4;
    if (/搜索|查询|Search|search/i.test(text)) score += 0.4;
    if (/login|signin|passport|sso|auth/i.test(url) || loginInput) score -= 3.5;
    score += input.index / Math.max(1, input.total) * 0.15;
    return score;
  }, {
    url: options.url,
    index,
    total
  });
}

async function adoptBestPageAfterSearch(host: ExtensionDetectorHost, options: DetectOptions, beforePages: Set<Page>): Promise<void> {
  const browser = host.browser();
  if (!browser) return;
  await delay(500);
  const deadline = Date.now() + Math.min(options.timeoutMs, 8000);
  let pages: Page[] = [];
  while (Date.now() < deadline) {
    pages = (await browser.pages()).filter((page) => !page.isClosed());
    if (pages.some((page) => !beforePages.has(page))) break;
    if (await pageLooksLikeSearchResult(host.page, options).catch(() => false)) break;
    await delay(250);
  }
  if (!pages.length) pages = (await browser.pages()).filter((page) => !page.isClosed());
  if (!pages.length) return;
  await Promise.all(pages.map((page) => waitForPageSettled(page, Math.min(options.waitMs, 1200)).catch(() => undefined)));
  const scored = await Promise.all(pages.map(async (page, index) => ({
    page,
    score: await scoreSearchResultPage(page, options, !beforePages.has(page), index, pages.length).catch(() => -Infinity)
  })));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 2.5) return;
  if (best.page !== host.page) await host.usePage(best.page);
}

async function scoreSearchResultPage(page: Page, options: DetectOptions, isNewPage: boolean, index: number, total: number): Promise<number> {
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4);
    const searchInput = Array.from(document.querySelectorAll('input[type="search"],input[name="q"],input[name="wd"],input[name*="search" i],input[type="text"],textarea')).some(visible);
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const keyword = input.keyword.toLowerCase();
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1200)}`);
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    let score = 0;
    try {
      const pageHost = new URL(url).hostname.replace(/^www\./, '');
      const targetHost = new URL(input.url).hostname.replace(/^www\./, '');
      if (pageHost === targetHost || pageHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${pageHost}`)) score += 2;
    } catch {}
    if (input.isNewPage) score += 1.5;
    if (keyword && `${url} ${title} ${text}`.toLowerCase().includes(keyword)) score += 2.4;
    if (searchUrlLike) score += 3.2;
    if (resultSemantic) score += 2.2;
    if (resultBlocks.length >= 2) score += 2.2;
    if (links.length >= 2) score += 0.8;
    if (searchInput && resultBlocks.length < 2) score -= 0.5;
    if (input.keyword && exactEntryUrl) score -= 7;
    if (input.keyword && !searchUrlLike && !resultSemantic && contentDetailUrlLike(url)) score -= 8;
    if (/login|signin|passport|sso|auth/i.test(url) || loginInput) score -= 5;
    score += input.index / Math.max(1, input.total) * 0.2;
    return score;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, {
    url: options.url,
    keyword: Object.values(options.input ?? {})[0] ?? '',
    isNewPage,
    index,
    total
  });
}

function watchNewPage(browser: Browser | undefined, beforePages: Set<Page>, timeoutMs: number): NewPageWatcher {
  if (!browser) return Promise.resolve(undefined);
  let cancelWatcher: (() => void) | undefined;
  const watcher = new Promise<Page | undefined>((resolve) => {
    let settled = false;
    const finish = (page: Page | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off('targetcreated', onTargetCreated);
      resolve(page);
    };
    const timer = setTimeout(() => finish(undefined), Math.max(1000, timeoutMs));
    const onTargetCreated = async (target: any) => {
      if (settled) return;
      if (typeof target.type === 'function' && target.type() !== 'page') return;
      const page = await target.page?.().catch?.(() => undefined) ?? await target.page?.();
      if (!page || beforePages.has(page) || page.isClosed()) return;
      finish(page);
    };
    cancelWatcher = () => finish(undefined);
    browser.on('targetcreated', onTargetCreated);
  }) as NewPageWatcher;
  watcher.cancel = () => cancelWatcher?.();
  return watcher;
}

async function adoptNewSearchPage(host: ExtensionDetectorHost, options: DetectOptions, newPagePromise: NewPageWatcher): Promise<void> {
  if (await pageLooksLikeSearchResult(host.page, options).catch(() => false) || await pageHasSearchLoginGate(host.page).catch(() => false)) {
    newPagePromise.cancel?.();
    return;
  }
  const quickTimeout = Math.max(350, Math.min(1200, options.waitMs));
  const page = await Promise.race([
    newPagePromise,
    delay(quickTimeout).then(() => undefined)
  ]);
  if (!page) newPagePromise.cancel?.();
  if (!page || page.isClosed()) return;
  await waitForPageSettled(page, Math.min(options.waitMs, 1500)).catch(() => undefined);
  const url = page.url();
  if (!url || /^about:blank$/i.test(url) || /^chrome-extension:/i.test(url)) return;
  const score = await scoreSearchResultPage(page, options, true, 0, 1).catch(() => -Infinity);
  if (score < 1.5) return;
  await host.usePage(page);
}

async function pageLooksLikeSearchResult(page: Page, options: DetectOptions): Promise<boolean> {
  const keyword = Object.values(options.input ?? {})[0] ?? '';
  return page.evaluate((input) => {
    const url = location.href;
    const title = document.title || '';
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const keyword = input.keyword.toLowerCase();
    const keywordMatches = !keyword || `${url} ${title} ${text}`.toLowerCase().includes(keyword);
    if (!keywordMatches || resultBlocks.length < 2) return false;
    if (!keyword) return true;
    const searchUrlLike = /(^|[/?#&=_.-])(search|so|query|result|results|keyword|wd|q)([/?#&=_.-]|$)/i.test(url);
    const resultSemantic = /搜索结果|搜索到|相关结果|全部结果|找到.*结果|Search Results|results for|search results/i.test(`${title} ${text.slice(0, 1600)}`);
    const resultClassBlocks = resultBlocks.filter((element) => {
      const attrs = [
        element.localName,
        (element as HTMLElement).id,
        (element as HTMLElement).className,
        element.getAttribute('role') || ''
      ].join(' ');
      return /search|result|query|list/i.test(attrs);
    });
    const exactEntryUrl = normalizeComparableUrl(url) === normalizeComparableUrl(input.url) && !/[?&](q|wd|query|keyword|search|s)=/i.test(url);
    if (exactEntryUrl && !resultSemantic && !searchUrlLike) return false;
    if (contentDetailUrlLike(url) && !searchUrlLike && !resultSemantic) return false;
    return searchUrlLike || resultSemantic || resultClassBlocks.length >= 2;
    function contentDetailUrlLike(value: string): boolean {
      try {
        const path = new URL(value).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function normalizeComparableUrl(value: string): string {
      try {
        const parsed = new URL(value);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch {
        return value.replace(/[#?].*$/, '').replace(/\/$/, '');
      }
    }
  }, { keyword, url: options.url }).catch(() => false);
}

async function pageHasSubstantialSearchOrContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const contentBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4);
    return text.length >= 1200 && contentBlocks.length >= 3 && links.length >= 3;
  });
}

async function detectLoginLikePage(page: Page): Promise<{ reason: string } | undefined> {
  return page.evaluate(() => {
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const url = location.href;
    const title = document.title || '';
    function visible(element: Element | null): boolean {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const password = Array.from(document.querySelectorAll('input[type="password"]')).find(visible);
    const phone = Array.from(document.querySelectorAll('input[type="tel"],input[name*="phone" i],input[name*="mobile" i]')).find(visible);
    const code = Array.from(document.querySelectorAll('input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="验证"]')).find(visible);
    const dataCandidates = document.querySelectorAll('article,main,section,table,ul,ol,[class*="list" i],[class*="result" i],[class*="content" i]');
    const links = Array.from(document.querySelectorAll('a')).filter((item) => (item.textContent || '').trim().length > 4);
    const hasSubstantialContent = text.length > 900 || dataCandidates.length >= 3 || links.length >= 8;
    if (/login|signin|passport|sso/i.test(url)) return { reason: 'url contains login/auth path' };
    if (!hasSubstantialContent && password) return { reason: 'visible password input found' };
    if (!hasSubstantialContent && phone && /登录|登陆|验证码|手机号|注册|login|sign in|verification/i.test(text)) return { reason: 'visible phone/code login form found' };
    if (!hasSubstantialContent && code && /登录|登陆|验证码|手机号|注册|login|sign in|verification/i.test(text)) return { reason: 'visible verification code input found' };
    if (!hasSubstantialContent && /登录|登陆|注册|手机号登录|扫码登录|微信登录|账号密码|sign in|log in|register/i.test(`${title} ${text}`) && text.length < 1200) {
      return { reason: 'login semantic text dominates page' };
    }
    return undefined;
  });
}

function popupTypeLabel(type: DetectedPopupDismissal['type'] | undefined): string {
  if (type === 'login') return 'login';
  if (type === 'captcha') return 'captcha/verification';
  if (type === 'paywall') return 'paywall/permission';
  return 'login/verification';
}

async function dismissPageObstructions(page: Page, options: { includeLogin?: boolean } = {}): Promise<DetectedPopupDismissal[]> {
  const results: DetectedPopupDismissal[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const detected = await detectPageObstructions(page);
    const item = detected[0];
    if (!item) break;
    if ((item.type === 'login' && !options.includeLogin) || item.type === 'captcha' || item.type === 'paywall' && !item.closeXPath) break;
    if (item.closeXPath) {
      const clicked = await clickXPath(page, item.closeXPath).catch(() => false);
      if (clicked) {
        const removed = await waitForPopupRemoved(page, item.popupXPath, 900).catch(() => false);
        if (removed) {
          results.push({
            type: item.type,
            action: 'click',
            xpath: item.closeXPath,
            text: item.closeText || item.popupText,
            confidence: item.confidence,
            removed: true,
            reasons: item.reasons
          });
          continue;
        }
      }
    }
    if (item.type === 'login' || item.type === 'paywall') break;
    await page.keyboard.press('Escape').catch(() => undefined);
    await delay(200);
    const escaped = await page.evaluate((popupXPath) => {
      const result = document.evaluate(popupXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue instanceof HTMLElement ? result.singleNodeValue : null;
      if (!element) return true;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    }, item.popupXPath).catch(() => false);
    if (escaped) {
      results.push({
        type: item.type,
        action: 'escape',
        xpath: item.popupXPath,
        text: item.popupText,
        confidence: item.confidence,
        removed: true,
        reasons: item.reasons
      });
      continue;
    }
    if (!item.canHide) break;
    const hidden = await page.evaluate((popupXPath) => {
      const result = document.evaluate(popupXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue instanceof HTMLElement ? result.singleNodeValue : null;
      if (!element) return false;
      element.dataset.octoparsePopupHidden = 'true';
      element.style.setProperty('display', 'none', 'important');
      if (document.body) document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
      return true;
    }, item.popupXPath).catch(() => false);
    if (!hidden) break;
    results.push({
      type: item.type,
      action: 'hide',
      xpath: item.popupXPath,
      text: item.popupText,
      confidence: item.confidence,
      removed: true,
      reasons: item.reasons
    });
    await delay(200);
  }
  return results;
}

async function waitForPopupRemoved(page: Page, popupXPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (await popupIsRemoved(page, popupXPath).catch(() => false)) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return popupIsRemoved(page, popupXPath).catch(() => false);
}

async function popupIsRemoved(page: Page, popupXPath: string): Promise<boolean> {
  return page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue instanceof HTMLElement || result.singleNodeValue instanceof SVGElement
      ? result.singleNodeValue
      : null;
    if (!element) return true;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width < 8 || rect.height < 8 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
  }, popupXPath);
}

async function detectPageObstructions(page: Page): Promise<Array<{
  popupXPath: string;
  popupText: string;
  type: DetectedPopupDismissal['type'];
  confidence: number;
  closeXPath?: string;
  closeText?: string;
  reasons: string[];
  canHide: boolean;
}>> {
  const detected = await page.evaluate(() => {
    type PopupType = DetectedPopupDismissal['type'];
    type Candidate = {
      popupXPath: string;
      popupText: string;
      type: PopupType;
      confidence: number;
      closeXPath?: string;
      closeText?: string;
      reasons: string[];
      canHide: boolean;
    };
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const viewportArea = viewportWidth * viewportHeight;
    const closeTextPattern = /^(×|x|X|关闭|关 闭|取消|跳过|暂不|稍后|以后再说|我知道了|知道了|不登录|先逛逛|close|skip|not now|later|maybe later)$/i;
    const unsafeTextPattern = /(登录|登陆|注册|手机号|验证码|获取验证码|同意|授权|支付|购买|开通|login|sign in|sign up|register|verify|submit|continue|agree)/i;
    const loginPattern = /(登录|登陆|注册|手机号|验证码|扫码|二维码|微信|账号|密码|login|sign in|sign up|register|phone|verification|qr|account|password|auth)/i;
    const cookiePattern = /(cookie|cookies|隐私|privacy|同意使用|接受全部|accept all)/i;
    const adPattern = /(广告|推广|赞助|下载.?app|打开.?app|advert|sponsor|promotion|install app)/i;
    const captchaPattern = /(验证码|滑块|captcha|验证你是真人|人机验证)/i;
    const paywallPattern = /(付费|会员|订阅|开通|阅读全文|继续阅读|paywall|subscribe|premium)/i;

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('data-testid') || ''
      ].join(' ');
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        const same = parent ? Array.from(parent.children).filter((item) => item.tagName === current?.tagName) : [];
        parts.unshift(`${tag}[${same.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return `/${parts.join('/')}`;
    }

    function popupType(value: string): PopupType {
      if (loginPattern.test(value)) return 'login';
      if (captchaPattern.test(value)) return 'captcha';
      if (cookiePattern.test(value)) return 'cookie';
      if (paywallPattern.test(value)) return 'paywall';
      if (adPattern.test(value)) return 'ad';
      return 'unknown';
    }

    function zIndexOf(element: Element): number {
      const raw = window.getComputedStyle(element as HTMLElement).zIndex;
      const parsed = Number.parseInt(raw || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function topHitRate(element: Element): number {
      const points = [
        [0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
        [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]
      ];
      let hits = 0;
      for (const [xRatio, yRatio] of points) {
        const top = document.elementFromPoint(viewportWidth * xRatio, viewportHeight * yRatio);
        if (top && (top === element || element.contains(top))) hits += 1;
      }
      return hits / points.length;
    }

    function closeScore(element: Element, popup: Element): number {
      const value = [
        text(element),
        attrText(element)
      ].join(' ').trim();
      const rect = element.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const topRightCompact = rect.width <= 80
        && rect.height <= 80
        && rect.left >= popupRect.right - 140
        && rect.top <= popupRect.top + 140;
      const iconOnlyClose = topRightCompact && (value === '' || /^(svg|path|g|i|span|div)\b/i.test(value) || Boolean(element.querySelector?.('svg,path,use,i')));
      let score = 0;
      if (closeTextPattern.test(value)) score += 0.55;
      if (/(close|dismiss|cancel|skip|关闭|取消|跳过|不登录|稍后|later)/i.test(value)) score += 0.28;
      if (/^(button|a)$/i.test(element.localName) || (element as HTMLElement).onclick || element.getAttribute('role') === 'button') score += 0.12;
      if (rect.width <= 72 && rect.height <= 72) score += 0.1;
      if (topRightCompact) score += 0.22;
      if (iconOnlyClose) score += 0.16;
      if (unsafeTextPattern.test(value) && !/(关闭|取消|跳过|不登录|稍后|not now|close|skip|later)/i.test(value)) score -= 0.7;
      if (rect.width < 8 || rect.height < 8) score -= 0.2;
      return score;
    }

    function closeClickTarget(element: Element, popup: Element): Element {
      let current: Element | null = element;
      for (let depth = 0; current && current !== popup && depth < 5; depth += 1, current = current.parentElement) {
        const value = `${text(current)} ${attrText(current)}`.trim();
        const rect = current.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const compactTopRight = rect.width <= 96
          && rect.height <= 96
          && rect.left >= popupRect.right - 160
          && rect.top <= popupRect.top + 160;
        const explicitClose = /(close|dismiss|cancel|skip|关闭|取消|跳过|不登录|稍后|later)/i.test(value);
        const clickable = /^(button|a)$/i.test(current.localName)
          || (current as HTMLElement).onclick
          || current.getAttribute('role') === 'button';
        if (explicitClose || clickable && compactTopRight) return current;
      }
      return element;
    }

    function findCloseButton(popup: Element): { element: Element; score: number; text: string } | undefined {
      const selectors = [
        '[aria-label],[title],[role="button"]',
        'button,a,input[type="button"],input[type="submit"]',
        '[class*="close" i],[class*="cancel" i],[class*="dismiss" i],[class*="skip" i]',
        'svg,path,span,div'
      ].join(',');
      return Array.from(popup.querySelectorAll(selectors))
        .filter((element) => element instanceof HTMLElement || element instanceof SVGElement)
        .filter(visible)
        .map((element) => {
          const target = closeClickTarget(element, popup);
          return {
            element: target,
            score: Math.max(closeScore(element, popup), closeScore(target, popup)),
            text: text(target) || text(element) || (target as HTMLElement).getAttribute?.('aria-label') || (target as HTMLElement).getAttribute?.('title') || (element as HTMLElement).getAttribute?.('aria-label') || (element as HTMLElement).getAttribute?.('title') || ''
          };
        })
        .filter((item) => item.score >= 0.35)
        .sort((a, b) => b.score - a.score)[0];
    }

    const root = document.body || document.documentElement;
    if (!root) return [];
    const raw = Array.from(root.querySelectorAll('*'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const areaRatio = Math.min(rect.width, viewportWidth) * Math.min(rect.height, viewportHeight) / viewportArea;
        const attrs = attrText(element);
        const bodyText = text(element).slice(0, 500);
        const value = `${attrs} ${bodyText}`;
        const fixedLike = style.position === 'fixed' || style.position === 'sticky';
        const zIndex = zIndexOf(element);
        const centered = rect.left < viewportWidth * 0.72 && rect.right > viewportWidth * 0.28 && rect.top < viewportHeight * 0.75 && rect.bottom > viewportHeight * 0.18;
        const modalAttrSemantic = /(dialog|modal|popup|pop|mask|overlay|login|signin|auth)/i.test(attrs) || element.getAttribute('aria-modal') === 'true' || element.getAttribute('role') === 'dialog';
        const contentSemantic = loginPattern.test(bodyText) || cookiePattern.test(bodyText) || adPattern.test(bodyText) || captchaPattern.test(bodyText) || paywallPattern.test(bodyText);
        const semantic = modalAttrSemantic || contentSemantic;
        const hitRate = fixedLike || semantic || zIndex >= 10 ? topHitRate(element) : 0;
        const scrollLocked = document.body?.style.overflow === 'hidden' || document.documentElement.style.overflow === 'hidden';
        const hasLoginInput = typeof element.querySelector === 'function'
          ? Boolean(element.querySelector('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]'))
          : false;
        const hasOverlayEvidence = fixedLike || zIndex >= 10 || modalAttrSemantic || scrollLocked;
        const hasObstructionEvidence = hasOverlayEvidence && (hitRate >= 0.35 || centered || areaRatio >= 0.12 || scrollLocked);
        const type = popupType(value);
        const explicitModalAttrSemantic = /(dialog|modal|popup|pop|mask|overlay|signin|auth)/i.test(attrs) || element.getAttribute('aria-modal') === 'true' || element.getAttribute('role') === 'dialog';
        const loginContainerAttrSemantic = /(login|passport)/i.test(attrs);
        const strongLoginObstruction = type !== 'login'
          || hasLoginInput
          || explicitModalAttrSemantic && (centered || hitRate >= 0.25 || areaRatio >= 0.08)
          || loginContainerAttrSemantic && (fixedLike || zIndex >= 10) && centered && areaRatio >= 0.04
          || scrollLocked && (centered || areaRatio >= 0.12)
          || fixedLike && centered && areaRatio >= 0.08;
        let confidence = 0;
        const reasons: string[] = [];
        if (fixedLike) {
          confidence += 0.18;
          reasons.push('fixed/sticky positioning');
        }
        if (zIndex >= 10) {
          confidence += 0.14;
          reasons.push('elevated z-index');
        }
        if (areaRatio >= 0.18) {
          confidence += Math.min(0.24, areaRatio * 0.3);
          reasons.push('large viewport coverage');
        }
        if (centered) {
          confidence += 0.18;
          reasons.push('center viewport overlap');
        }
        if (semantic) {
          confidence += 0.22;
          reasons.push('modal/login semantic text or attributes');
        }
        if (hasLoginInput) {
          confidence += 0.2;
          reasons.push('login input found');
        }
        if (hitRate >= 0.35) {
          confidence += 0.18;
          reasons.push('topmost element at viewport sample points');
        }
        if (scrollLocked) {
          confidence += 0.08;
          reasons.push('page scroll locked');
        }
        if (!hasObstructionEvidence) confidence = 0;
        if (!strongLoginObstruction) confidence = 0;
        return { element, rect, confidence, reasons, value, type, areaRatio };
      })
      .filter((item) => item.confidence >= 0.52)
      .sort((a, b) => b.confidence - a.confidence || b.areaRatio - a.areaRatio);

    const output: Candidate[] = [];
    const used = new Set<Element>();
    for (const item of raw) {
      if (used.has(item.element)) continue;
      if (raw.some((other) => other !== item && other.element.contains(item.element) && other.confidence >= item.confidence + 0.08)) continue;
      const close = findCloseButton(item.element);
      if (item.type === 'unknown' && !close) continue;
      output.push({
        popupXPath: xpath(item.element),
        popupText: text(item.element).slice(0, 180),
        type: item.type,
        confidence: Number(Math.min(0.98, item.confidence).toFixed(2)),
        ...(close ? { closeXPath: xpath(close.element), closeText: close.text.slice(0, 60) } : {}),
        reasons: item.reasons,
        canHide: item.type !== 'captcha' && item.type !== 'unknown' && (item.type !== 'paywall' || Boolean(close))
      });
      used.add(item.element);
      if (output.length >= 3) break;
    }
    return output;
  });
  return detected;
}

async function clickXPath(page: Page, xpath: string): Promise<boolean> {
  return await page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    if (!element) return false;
    let target: Element | null = element;
    for (let depth = 0; target && depth < 5; depth += 1, target = target.parentElement) {
      const html = target as HTMLElement;
      const attrs = [
        target.localName,
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        target.getAttribute('role') || '',
        target.getAttribute('aria-label') || '',
        target.getAttribute('title') || ''
      ].join(' ');
      if (/^(button|a)$/i.test(target.localName) || html.onclick || target.getAttribute('role') === 'button' || /close|cancel|dismiss|skip|button|btn|关闭|取消|跳过/i.test(attrs)) {
        break;
      }
    }
    target ||= element;
    const rect = target.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    if (typeof target.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      const PointerEventCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      target.dispatchEvent(new PointerEventCtor('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new PointerEventCtor('pointerup', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
    }
    if (typeof (target as HTMLElement).click === 'function') {
      (target as HTMLElement).click();
    } else if (typeof target.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      target.dispatchEvent(new MouseEvent('click', eventInit));
    } else {
      return false;
    }
    return true;
  }, xpath);
}

function dedupePopupDismissals(items: DetectedPopupDismissal[]): DetectedPopupDismissal[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.action}:${item.type}:${item.xpath ?? ''}:${item.text ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function autoScroll(page: Page, scrolls: number): Promise<ScrollProbeSummary> {
  const maxScrolls = Math.max(0, scrolls);
  const snapshots: ScrollProbeSnapshot[] = [];
  let previous: ScrollProbeSnapshot | undefined;
  let stableCount = 0;
  const initial = await captureScrollProbeSnapshot(page).catch(() => undefined);
  if (initial) snapshots.push(initial);
  for (let index = 0; index < maxScrolls; index += 1) {
    await scrollPageByViewport(page).catch(() => undefined);
    await delay(350);
    const snapshot = await captureScrollProbeSnapshot(page).catch(() => undefined);
    if (!snapshot) continue;
    snapshots.push(snapshot);
    if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
      process.stderr.write(`[detect-debug] scroll probe ${index + 1}/${maxScrolls}: ${JSON.stringify(snapshot)}\n`);
    }
    if (snapshot.hasActiveLoadMore) {
      stableCount = 0;
      previous = snapshot;
      continue;
    }
    if (previous && scrollProbeStable(previous, snapshot)) stableCount += 1;
    else stableCount = 0;
    previous = snapshot;
    if (snapshot.atBottom || stableCount >= 2) break;
  }
  await scrollPageToTop(page).catch(() => undefined);
  const summary = summarizeScrollProbe(snapshots);
  if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
    process.stderr.write(`[detect-debug] scroll probe summary: ${JSON.stringify({ ...summary, snapshots: summary.snapshots.length })}\n`);
  }
  return summary;
}

async function scrollPageByViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const viewport = window.innerHeight || document.documentElement.clientHeight || 800;
    const current = window.scrollY || root.scrollTop || 0;
    window.scrollTo({ top: current + Math.max(240, Math.floor(viewport * 0.86)), left: 0, behavior: 'instant' });
  });
}

async function scrollPageToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  });
}

interface ScrollProbeSnapshot {
  scrollY: number;
  viewportHeight: number;
  pageHeight: number;
  contentHeight: number;
  articleLikeCount: number;
  activeLoadMoreCount: number;
  activeLoadMoreTexts: string[];
  activeLoadMoreXPaths: string[];
  hasActiveLoadMore: boolean;
  atBottom: boolean;
}

function summarizeScrollProbe(snapshots: ScrollProbeSnapshot[]): ScrollProbeSummary {
  const first = snapshots[0];
  const maxArticleLikeCount = snapshots.reduce((max, item) => Math.max(max, item.articleLikeCount), 0);
  const maxContentHeight = snapshots.reduce((max, item) => Math.max(max, item.contentHeight), 0);
  const maxPageHeight = snapshots.reduce((max, item) => Math.max(max, item.pageHeight), 0);
  const sawActiveLoadMore = snapshots.some((item) => item.hasActiveLoadMore);
  const grewArticleLikeCount = first ? Math.max(0, maxArticleLikeCount - first.articleLikeCount) : 0;
  const grewContentHeight = first ? Math.max(0, maxContentHeight - first.contentHeight) : 0;
  const grewPageHeight = first ? Math.max(0, maxPageHeight - first.pageHeight) : 0;
  const sawGrowth = grewArticleLikeCount >= 2 || grewContentHeight >= 600 || grewPageHeight >= 240;
  const reachedBottom = snapshots.some((item) => item.atBottom);
  const bestActiveLoadMoreText = snapshots
    .flatMap((item) => item.activeLoadMoreTexts)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  const bestActiveLoadMoreXPath = snapshots
    .flatMap((item) => item.activeLoadMoreXPaths)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return {
    snapshots,
    sawActiveLoadMore,
    sawGrowth,
    maxArticleLikeCount,
    maxContentHeight,
    maxPageHeight,
    grewArticleLikeCount,
    grewContentHeight,
    grewPageHeight,
    reachedBottom,
    ...(bestActiveLoadMoreText ? { bestActiveLoadMoreText } : {}),
    ...(bestActiveLoadMoreXPath ? { bestActiveLoadMoreXPath } : {})
  };
}

async function captureScrollProbeSnapshot(page: Page): Promise<ScrollProbeSnapshot> {
  return page.evaluate(() => {
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const pageHeight = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement.clientHeight || 0
    );
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (element: Element): string => {
      if (element instanceof HTMLInputElement) return (element.value || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    };
    const attrText = (element: Element): string => {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('type') || ''
      ].join(' ');
    };
    const xpath = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    };
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const loadMorePattern = /(加载更多|查看更多|显示更多|点击加载|load more|show more|see more|loadmore|load-more)/i;
    const activeLoadMoreElements = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"],[role="button"],[onclick],[class*="load" i],[class*="more" i],span,div'))
      .filter(visible)
      .filter((element) => {
        const combined = `${text(element)} ${attrText(element)}`;
        return loadMorePattern.test(combined) && !loadMoreEndPattern.test(combined);
      });
    const activeLoadMoreCount = activeLoadMoreElements.length;
    const activeLoadMoreTexts = activeLoadMoreElements
      .map((element) => text(element) || attrText(element))
      .map((value) => value.replace(/\s+/g, ' ').trim())
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 3);
    const activeLoadMoreXPaths = activeLoadMoreElements
      .map((element) => xpath(element))
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .slice(0, 3);
    const articleLikeCount = Array.from(document.querySelectorAll('article,li,tr,[class*="result" i],[class*="item" i],[class*="article" i],[class*="card" i],[class*="blog" i]'))
      .filter(visible)
      .filter((element) => text(element).length >= 24).length;
    const bodyTextLength = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().length;
    return {
      scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      viewportHeight,
      pageHeight,
      contentHeight: bodyTextLength,
      articleLikeCount,
      activeLoadMoreCount,
      activeLoadMoreTexts,
      activeLoadMoreXPaths,
      hasActiveLoadMore: activeLoadMoreCount > 0,
      atBottom: (window.scrollY || document.documentElement.scrollTop || 0) + viewportHeight >= pageHeight - 32
    };
  });
}

function scrollProbeStable(previous: ScrollProbeSnapshot, next: ScrollProbeSnapshot): boolean {
  const pageHeightStable = Math.abs(next.pageHeight - previous.pageHeight) < 80;
  const contentStable = Math.abs(next.contentHeight - previous.contentHeight) < 120;
  const itemStable = Math.abs(next.articleLikeCount - previous.articleLikeCount) <= 1;
  const stuck = Math.abs(next.scrollY - previous.scrollY) < 20;
  return (pageHeightStable && contentStable && itemStable) || stuck;
}

async function detectCandidates(page: Page, options: DetectOptions, scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  if (!options.legacyDetector) {
    const outputLimit = options.interactive ? Math.max(options.maxCandidates, 24) : options.maxCandidates;
    const refinementLimit = candidateRefinementLimit(outputLimit);
    const protectedSmart = await detectProtectedSmartCandidates(page, { maxCandidates: refinementLimit, baseUrl: options.apiBaseUrl });
    const fallback = await detectFallbackListCandidates(page, refinementLimit, options.interactive);
    if (!protectedSmart.length && !fallback.length) {
      throw new Error('No list candidates were detected. Use --legacy-detector only for debugging the old detector.');
    }
    const merged = dedupeEquivalentCandidates([...protectedSmart, ...fallback]);
    const withAdjacentMetadata = await augmentAdjacentMetadataFields(page, merged).catch(() => merged);
    const withPagination = await detectPaginationForCandidates(page, withAdjacentMetadata, scrollProbe);
    const withDiagnostics = await attachAgentDiagnostics(page, withPagination).catch(() => withPagination);
    const withLayoutScores = await applyLayoutScores(page, withDiagnostics);
    const sanitized = sanitizeCandidatePaginationByLayout(withLayoutScores);
    const filtered = filterDetectedBoilerplateCandidates(sanitized);
    const ranked = options.goal ? applyGoalScores(filtered, options.goal) : rankCandidates(filtered);
    return options.llmRank ? applyLlmRankPreparation(ranked.slice(0, outputLimit), options.goal) : ranked.slice(0, outputLimit);
  }

  const candidates = await detectRawCandidates(page, options.interactive);

  const seen = new Set<string>();
  const outputLimit = options.interactive ? Math.max(options.maxCandidates, 24) : options.maxCandidates;
  const refinementLimit = candidateRefinementLimit(outputLimit);
  const sorted = candidates
    .filter((candidate) => {
      const key = `${candidate.type}:${candidate.selector}:${candidate.itemSelector ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return candidate.itemCount > 0 && candidate.fields.length > 0;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, refinementLimit);

  const detected = sorted.map((candidate, index) => ({
    id: `${candidate.type}_${index + 1}`,
    title: candidateTitle(candidate),
    ...candidate
  }));
  const withPagination = await detectPaginationForCandidates(page, detected, scrollProbe);
  const withRefinedFields = await refineCandidateFields(page, withPagination);
  const withAdjacentMetadata = await augmentAdjacentMetadataFields(page, withRefinedFields).catch(() => withRefinedFields);
  const withLayoutScores = await applyLayoutScores(page, withAdjacentMetadata);
  const sanitized = sanitizeCandidatePaginationByLayout(withLayoutScores);
  const filtered = filterDetectedBoilerplateCandidates(sanitized);
  const deduped = dedupeEquivalentCandidates(filtered);
  const ranked = options.goal ? applyGoalScores(deduped, options.goal) : rankCandidates(deduped);
  const limited = ranked.slice(0, outputLimit);
  return options.llmRank ? applyLlmRankPreparation(limited, options.goal) : limited;
}

function candidateRefinementLimit(outputLimit: number): number {
  return Math.max(outputLimit, Math.min(64, Math.max(32, outputLimit * 3)));
}

async function detectRawCandidates(page: Page, interactive = false): Promise<RawCandidate[]> {
  const candidates: RawCandidate[] = [];
  candidates.push(...await detectTables(page));
  candidates.push(...await detectRepeatedCards(page));
  candidates.push(...await detectSearchResultBlocks(page));
  candidates.push(...await detectDeptaCandidates(page));
  if (interactive) {
    candidates.push(...await detectInteractiveElementGroups(page));
  }
  candidates.push(...await detectDetails(page));
  candidates.push(...await detectForms(page));
  candidates.push(...await detectLinkCollections(page));
  return candidates;
}

async function detectFallbackListCandidates(page: Page, limit: number, interactive = false): Promise<DetectedCandidate[]> {
  const raw = await detectRawCandidates(page, interactive);
  const seen = new Set<string>();
  const sorted = raw
    .filter((candidate) => candidate.type === 'table' || candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection')
    .filter((candidate) => {
      const key = `${candidate.type}:${candidate.selector}:${candidate.itemSelector ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return candidate.itemCount > 0 && candidate.fields.length > 0;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.max(limit, 12));
  if (!sorted.length) return [];
  const detected = sorted.map((candidate, index) => ({
    id: `fallback_${candidate.type}_${index + 1}`,
    title: `${candidateTitle(candidate)} (fallback)`,
    ...candidate,
    confidence: Number(Math.max(0.1, candidate.confidence - 0.06).toFixed(2)),
    reasons: [...candidate.reasons, 'Fallback detector candidate']
  }));
  const refined = await refineCandidateFields(page, detected);
  return rankCandidates(refined).slice(0, limit);
}

async function chooseCandidateInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole): Promise<string[]> {
  const selectable = candidates.filter((candidate) => candidate.type === 'table' || candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection');
  if (!selectable.length) return [];
  let currentIndex = 0;
  let currentCandidate = selectable[currentIndex];
  let keepManualOverlayForNextStep = false;
  await installCandidateOverlay(page, [currentCandidate]);
  const browserOverlayReady = await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole)
    .then(() => true)
    .catch(() => false);
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\nHighlighted recommended detection result 1/${selectable.length} in the browser: ${formatCandidateSummary(currentCandidate)}.\n`);
      runtimeConsole.writeStderr('Return to the terminal to continue with the current recommended result.\n');
      await runtimeConsole.question('');
      return [currentCandidate.id];
    }

    lastCandidateSelection = await readOverlaySelection(page).catch(() => []);
    while (true) {
      const action = browserOverlayReady
        ? await waitForCandidateManualAction(page, selectable, currentIndex, currentCandidate, runtimeConsole)
        : await runLiveSelectMenu({
          write: (value) => runtimeConsole.writeStderr(value),
          title: () => [
            `Current detection result: ${currentIndex + 1}/${selectable.length}`,
            formatCandidateSummary(currentCandidate),
            'Only the current result is highlighted in the browser; switch results as needed, then confirm before configuring pagination.'
          ].filter(Boolean).join('\n'),
          readState: async () => {
            lastCandidateSelection = await readOverlaySelection(page);
          },
          choices: () => [
            { title: 'Confirm this detection result and continue to pagination', value: 'confirm' },
            { title: `Switch to next detection result (${((currentIndex + 1) % selectable.length) + 1}/${selectable.length})`, value: 'next' },
            { title: `Switch to previous detection result (${((currentIndex - 1 + selectable.length) % selectable.length) + 1}/${selectable.length})`, value: 'prev' },
            { title: 'Cancel manual detection', value: 'cancel' }
          ]
        });
      await clearManualOverlayAction(page).catch(() => undefined);

      if (action === 'next' || action === 'prev') {
        currentIndex = action === 'next'
          ? (currentIndex + 1) % selectable.length
          : (currentIndex - 1 + selectable.length) % selectable.length;
        currentCandidate = selectable[currentIndex];
        lastCandidateSelection = [];
        await installCandidateOverlay(page, [currentCandidate]);
        if (browserOverlayReady) await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole);
        continue;
      }
      if (action === 'confirm') {
        const latest = await readOverlaySelection(page);
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: 'Analyzing pagination',
            message: 'Detection result confirmed; detecting next-page, load-more, or scroll pagination.',
            status: 'Processing, please wait.'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return latest.length ? latest : [currentCandidate.id];
      }
      throw new Error('User canceled manual detection');
    }
  } finally {
    if (!keepManualOverlayForNextStep) await removeManualOverlay(page).catch(() => undefined);
    await removeCandidateOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

async function showCandidateChoiceInBrowser(
  page: Page,
  selectable: DetectedCandidate[],
  currentIndex: number,
  currentCandidate: DetectedCandidate,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'candidate', '\nUse the browser overlay to confirm the detection result.\n');
  const selected = await readOverlaySelection(page).catch(() => []);
  await showManualOverlay(page, {
    title: `Detection Result ${currentIndex + 1}/${selectable.length}`,
    message: [
      formatCandidateSummary(currentCandidate),
      'Only the current result is highlighted in the browser; switch results as needed, then confirm to configure pagination.'
    ].join('\n'),
    status: selected.length ? `Selected: ${selected.join(', ')}` : `Selected: ${currentCandidate.id}`,
    choices: [
      { title: 'Confirm current detection result', value: 'confirm', primary: true },
      { title: `Next (${((currentIndex + 1) % selectable.length) + 1}/${selectable.length})`, value: 'next' },
      { title: `Previous (${((currentIndex - 1 + selectable.length) % selectable.length) + 1}/${selectable.length})`, value: 'prev' },
      { title: 'Cancel manual detection', value: 'cancel' }
    ]
  });
}

async function waitForCandidateManualAction(
  page: Page,
  selectable: DetectedCandidate[],
  currentIndex: number,
  currentCandidate: DetectedCandidate,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  let selected = await readOverlaySelection(page).catch(() => []);
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readOverlaySelection(page).catch(() => selected);
    if (latest.join('\n') !== selected.join('\n')) {
      selected = latest;
      lastCandidateSelection = latest;
      await showCandidateChoiceInBrowser(page, selectable, currentIndex, currentCandidate, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

function formatCandidateSummary(candidate: DetectedCandidate): string {
  const fields = candidate.fields.slice(0, 8).map((field) => field.name).join(', ');
  return `${detectorCandidateTypeLabel(candidate.type)}, ${candidate.itemCount} items${fields ? `, fields: ${fields}` : ''}`;
}

async function choosePaginationInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole, scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination | undefined> {
  const restoreViewport = await preparePaginationDetectionViewport(page, candidates).catch(() => undefined);
  const options = await detectInteractivePaginationOptions(page, candidates, scrollProbe);
  if (!options.length) {
    await restoreViewport?.().catch(() => undefined);
    await showManualProgressOverlay(page, {
      title: 'No pagination detected',
      message: 'No usable next-page or load-more control was detected; this task will continue as a single-page extraction.',
      status: 'Continuing task generation, please wait.'
    }).catch(() => undefined);
    runtimeConsole.writeStderr('\nNo usable next-page/load-more control was detected; this task will be generated as a single-page extraction.\n');
    return undefined;
  }
  await restoreViewport?.().catch(() => undefined);
  if (process.env.OCTOPARSE_TRACKING_DEBUG === '1') {
    const diagnostics = await capturePaginationDiagnostics(page).catch(() => []);
    runtimeConsole.writeStderr(`\n[detect-debug] pagination options: ${JSON.stringify(options.map((option) => ({
      type: option.type,
      text: option.text,
      confidence: option.confidence,
      xpath: option.xpath,
      reasons: option.reasons
    })), null, 2)}\n`);
    runtimeConsole.writeStderr(`[detect-debug] bottom clickable/text candidates: ${JSON.stringify(diagnostics, null, 2)}\n`);
  }

  await installPaginationOverlay(page, options);
  let keepManualOverlayForNextStep = false;
  try {
    const recommended = options[0];
    lastPaginationSelection = await readPaginationOverlaySelection(page).catch(() => undefined) || paginationKey(recommended);
    const browserOverlayReady = await showPaginationChoiceInBrowser(page, options, lastPaginationSelection, runtimeConsole)
      .then(() => true)
      .catch(() => false);
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      runtimeConsole.writeStderr(`\nHighlighted possible pagination controls in the browser; without interaction, the recommended pagination will be used: ${formatSelectedPagination(paginationKey(recommended), options)}.\n`);
      await runtimeConsole.question('');
      const selected = await readPaginationOverlaySelection(page);
      return selected ? options.find((option) => paginationKey(option) === selected) : recommended;
    }

    while (true) {
      const action = browserOverlayReady
        ? await waitForPaginationManualAction(page, options, lastPaginationSelection, runtimeConsole)
        : await runLiveSelectMenu({
          write: (value) => runtimeConsole.writeStderr(value),
          title: () => [
            'Click an orange PAGE/MORE marker in the browser to switch pagination controls.',
            `Current pagination: ${formatSelectedPagination(lastPaginationSelection, options)}`
          ].join('\n'),
          readState: async () => {
            lastPaginationSelection = await readPaginationOverlaySelection(page);
          },
          choices: () => [
            { title: lastPaginationSelection ? 'Confirm recommended pagination' : 'Waiting for browser selection', value: lastPaginationSelection ? 'confirm' : 'wait' },
            { title: 'Extract single page without pagination', value: 'single-page' },
            { title: 'Cancel manual detection', value: 'cancel' }
          ]
        });
      await clearManualOverlayAction(page).catch(() => undefined);

      if (action === 'wait') continue;
      if (action === 'single-page') {
        await clearPaginationOverlaySelection(page).catch(() => undefined);
        lastPaginationSelection = undefined;
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: 'Continuing task generation',
            message: 'Single-page extraction selected; preparing the next step.',
            status: 'Processing, please wait.'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return undefined;
      }
      if (action === 'confirm') {
        const latest = await readPaginationOverlaySelection(page);
        const selected = latest || lastPaginationSelection || paginationKey(recommended);
        if (browserOverlayReady) {
          await showManualProgressOverlay(page, {
            title: 'Continuing task generation',
            message: 'Pagination confirmed; preparing detail extraction or task generation.',
            status: 'Processing, please wait.'
          }).then(() => {
            keepManualOverlayForNextStep = true;
          }).catch(() => undefined);
        }
        return selected ? options.find((option) => paginationKey(option) === selected) : recommended;
      }
      throw new Error('User canceled manual detection');
    }
  } finally {
    if (!keepManualOverlayForNextStep) await removeManualOverlay(page).catch(() => undefined);
    await removePaginationOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

async function showPaginationChoiceInBrowser(
  page: Page,
  options: DetectedPagination[],
  selectedKey: string | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'pagination', '\nUse the browser overlay to confirm pagination settings.\n');
  await showManualOverlay(page, {
    title: 'Confirm Pagination',
    message: 'Click an orange PAGE/MORE/SCROLL marker on the page to switch pagination controls.',
    status: `Current pagination: ${formatSelectedPagination(selectedKey, options)}`,
    choices: [
      { title: selectedKey ? 'Confirm current pagination' : 'Waiting for browser selection', value: selectedKey ? 'confirm' : 'wait', primary: Boolean(selectedKey) },
      { title: 'Extract single page', value: 'single-page' },
      { title: 'Cancel manual detection', value: 'cancel' }
    ]
  });
}

async function showManualProgressOverlay(page: Page, options: {
  title: string;
  message?: string;
  status?: string;
}): Promise<void> {
  await showManualOverlay(page, {
    title: options.title,
    message: options.message,
    status: options.status,
    choices: []
  });
}

async function waitForPaginationManualAction(
  page: Page,
  options: DetectedPagination[],
  selectedKey: string | undefined,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readPaginationOverlaySelection(page).catch(() => selectedKey);
    if (latest !== selectedKey) {
      selectedKey = latest;
      lastPaginationSelection = latest;
      await showPaginationChoiceInBrowser(page, options, selectedKey, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

let lastCandidateSelection: string[] = [];
let lastPaginationSelection: string | undefined;
let lastDetailFieldSelection: string[] = [];

async function chooseDetailPlanInteractively(page: Page, candidates: DetectedCandidate[], runtimeConsole: SuppressedRuntimeConsole, timeoutMs: number): Promise<Map<string, DetectedDetailPlan>> {
  const output = new Map<string, DetectedDetailPlan>();
  for (const candidate of candidates) {
    const urlField = selectDetailUrlField(candidate);
    if (!urlField) continue;
    const sampleUrls = Array.from(new Set([
      ...candidate.sampleRows.map((row) => row[urlField.name]),
      ...urlField.samples
    ].filter(isHttpUrl))).slice(0, 3);
    if (!sampleUrls.length) continue;
    const mode = await chooseDetailModeInteractively(page, candidate, urlField.name, sampleUrls, runtimeConsole);
    if (mode === 'list_only') continue;
    const detail = await inspectDetailSampleManually(page, sampleUrls[0], runtimeConsole, timeoutMs).catch((error) => ({
      fields: [],
      sampleRows: [],
      reasons: [`Detail page sample detection failed: ${error instanceof Error ? error.message : String(error)}`]
    }));
    output.set(candidate.id, {
      mode,
      urlField: urlField.name,
      sampleUrls: sampleUrls.slice(0, 1),
      fields: detail.fields,
      sampleRows: detail.sampleRows,
      templateCount: detail.fields.length ? 1 : 0,
      status: 'planned',
      reasons: [
        'Detail page fields were selected manually; generated tasks will open a new tab per row to extract details',
        ...detail.reasons
      ]
    });
  }
  return output;
}

function selectDetailUrlField(candidate: DetectedCandidate): DetectedField | undefined {
  const hrefFields = candidate.fields.filter((field) => field.kind === 'href' && fieldHasHttpSample(candidate, field));
  return hrefFields.find((field) => field.name === 'url') ?? hrefFields[0];
}

function fieldHasHttpSample(candidate: DetectedCandidate, field: DetectedField): boolean {
  return field.samples.some(isHttpUrl) || candidate.sampleRows.some((row) => isHttpUrl(row[field.name]));
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

async function chooseDetailModeInteractively(page: Page, candidate: DetectedCandidate, urlFieldName: string, sampleUrls: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<DetectedDetailMode> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'list_only';
  try {
    return await chooseDetailModeInBrowser(page, candidate, urlFieldName, sampleUrls, runtimeConsole).catch(() => runLiveSelectMenu({
      write: (value) => runtimeConsole.writeStderr(value),
      title: () => [
        `Candidate ${candidate.id} contains detail URL field "${urlFieldName}".`,
        `Sample: ${truncateText(sampleUrls[0] || '', 90)}`,
        'Choose extraction mode:'
      ].join('\n'),
      readState: async () => undefined,
      choices: () => [
        { title: 'Extract list fields only', value: 'list_only' },
        { title: 'Extract list plus detail page content', value: 'list_with_detail' },
        { title: 'Extract detail pages from list URLs only', value: 'detail_only' }
      ]
    }));
  } finally {
    await removeManualOverlay(page).catch(() => undefined);
    runtimeConsole.suppress();
  }
}

async function chooseDetailModeInBrowser(
  page: Page,
  candidate: DetectedCandidate,
  urlFieldName: string,
  sampleUrls: string[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<DetectedDetailMode> {
  writeManualOverlayHintOnce(runtimeConsole, page, `detail-mode:${candidate.id}`, '\nUse the browser overlay to confirm detail page extraction mode.\n');
  await showManualOverlay(page, {
    title: 'Detail Page Extraction Mode',
    message: [
      `Candidate ${candidate.id} contains detail URL field "${urlFieldName}".`,
      `Sample: ${truncateText(sampleUrls[0] || '', 90)}`
    ].join('\n'),
    choices: [
      { title: 'Extract list fields only', value: 'list_only', primary: true },
      { title: 'Extract list plus detail page content', value: 'list_with_detail' },
      { title: 'Extract detail pages from list URLs only', value: 'detail_only' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  if (selection?.action === 'list_with_detail' || selection?.action === 'detail_only') return selection.action;
  return 'list_only';
}

async function inspectDetailSamples(page: Page, urls: string[], timeoutMs: number): Promise<{ fields: DetectedField[]; sampleRows: Record<string, string>[]; reasons: string[] }> {
  const browser = page.browser();
  const currentUrl = page.url();
  const sampled = urls.slice(0, 3);
  const rows: Record<string, string>[] = [];
  let templateFields: DetectedField[] = [];
  const reasons: string[] = [];
  for (const url of sampled) {
    const detailPage = await browser.newPage();
    try {
      detailPage.setDefaultTimeout(timeoutMs);
      await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await waitForPageSettled(detailPage, 1200);
      const candidates = await detectDetails(detailPage);
      const detail = candidates[0];
      if (!detail) {
        reasons.push(`No detail fields detected: ${url}`);
        continue;
      }
      if (!templateFields.length) {
        templateFields = detail.fields.map((field) => ({
          ...field,
          name: `detail_${field.name}`
        }));
      }
      rows.push(Object.fromEntries(detail.fields.map((field) => [`detail_${field.name}`, field.samples[0] || ''])));
    } finally {
      await detailPage.close().catch(() => undefined);
    }
  }
  await page.bringToFront().catch(() => undefined);
  if (page.url() !== currentUrl) {
    await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => undefined);
  }
  if (templateFields.length) reasons.push(`Detected fields from ${rows.length} detail page sample(s): ${templateFields.map((field) => field.name).join(', ')}`);
  return { fields: templateFields, sampleRows: rows, reasons };
}

async function inspectDetailSampleManually(page: Page, url: string, runtimeConsole: SuppressedRuntimeConsole, timeoutMs: number): Promise<{ fields: DetectedField[]; sampleRows: Record<string, string>[]; reasons: string[] }> {
  const browser = page.browser();
  const detailPage = await browser.newPage();
  try {
    detailPage.setDefaultTimeout(timeoutMs);
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitForPageSettled(detailPage, 1200);
    await detailPage.bringToFront().catch(() => undefined);
    await installDetailFieldOverlay(detailPage);
    try {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        runtimeConsole.writeStderr('\nOpened one detail page sample. Click the detail fields or regions to extract in the browser, then return to the terminal to continue.\n');
        await runtimeConsole.question('');
      } else {
        lastDetailFieldSelection = await readDetailFieldSelection(detailPage).catch(() => []);
        const browserOverlayReady = await showDetailFieldChoiceInBrowser(detailPage, lastDetailFieldSelection, runtimeConsole)
          .then(() => true)
          .catch(() => false);
        while (true) {
          const action = browserOverlayReady
            ? await waitForDetailFieldManualAction(detailPage, lastDetailFieldSelection, runtimeConsole)
            : await runLiveSelectMenu({
              write: (value) => runtimeConsole.writeStderr(value),
              title: () => [
                'Opened one detail page sample.',
                'Click the detail fields or regions to extract in the browser; for article body, click the content container, and for images, click the image directly.',
                `Selected: ${formatSelectedDetailFields(lastDetailFieldSelection)}`
              ].join('\n'),
              readState: async () => {
                lastDetailFieldSelection = await readDetailFieldSelection(detailPage);
              },
              choices: () => [
                { title: lastDetailFieldSelection.length ? 'Confirm current detail fields' : 'Waiting for browser selection', value: lastDetailFieldSelection.length ? 'confirm' : 'wait' },
                { title: 'Clear detail fields and select again', value: 'clear' },
                { title: 'Cancel manual detection', value: 'cancel' }
              ]
            });
          await clearManualOverlayAction(detailPage).catch(() => undefined);

          if (action === 'wait') continue;
          if (action === 'clear') {
            await clearDetailFieldSelection(detailPage).catch(() => undefined);
            lastDetailFieldSelection = [];
            if (browserOverlayReady) await showDetailFieldChoiceInBrowser(detailPage, lastDetailFieldSelection, runtimeConsole);
            continue;
          }
          if (action === 'confirm') break;
          throw new Error('User canceled manual detection');
        }
      }

      const selected = await readDetailFieldObjects(detailPage);
      if (!selected.length) return { fields: [], sampleRows: [], reasons: ['No detail page fields selected by the user'] };
      const fields = selectedDetailFields(selected);
      const row = Object.fromEntries(fields.map((field) => [field.name, field.samples[0] || '']));
      return {
        fields,
        sampleRows: [row],
        reasons: [`Manually selected fields from one detail page sample: ${fields.map((field) => field.name).join(', ')}`]
      };
    } finally {
      await removeManualOverlay(detailPage).catch(() => undefined);
      await removeDetailFieldOverlay(detailPage).catch(() => undefined);
    }
  } finally {
    await detailPage.close().catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }
}

async function showDetailFieldChoiceInBrowser(page: Page, selectedFields: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<void> {
  writeManualOverlayHintOnce(runtimeConsole, page, 'detail-fields', '\nUse the browser overlay to confirm detail fields.\n');
  await showManualOverlay(page, {
    title: 'Confirm Detail Fields',
    message: 'Click the detail fields or regions to extract on the page; for article body, click the content container, and for images, click the image directly.',
    status: `Selected: ${formatSelectedDetailFields(selectedFields)}`,
    choices: [
      { title: selectedFields.length ? 'Confirm current detail fields' : 'Waiting for browser selection', value: selectedFields.length ? 'confirm' : 'wait', primary: Boolean(selectedFields.length) },
      { title: 'Clear detail fields', value: 'clear' },
      { title: 'Cancel manual detection', value: 'cancel' }
    ]
  });
}

async function waitForDetailFieldManualAction(page: Page, selectedFields: string[], runtimeConsole: SuppressedRuntimeConsole): Promise<ManualOverlayAction> {
  while (true) {
    if (page.isClosed()) return 'cancel';
    const latest = await readDetailFieldSelection(page).catch(() => selectedFields);
    if (latest.join('\n') !== selectedFields.join('\n')) {
      selectedFields = latest;
      lastDetailFieldSelection = latest;
      await showDetailFieldChoiceInBrowser(page, selectedFields, runtimeConsole);
      await clearManualOverlayAction(page);
      continue;
    }
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state.action;
    await delay(150);
  }
}

async function runLiveSelectMenu<T extends string>(options: {
  write: (value: string) => void;
  title: () => string;
  readState: () => Promise<void>;
  choices: () => Array<{ title: string; value: T }>;
}): Promise<T> {
  const input = process.stdin;
  const wasRaw = input.isRaw;
  let selectedIndex = 0;
  let lineCount = 0;
  let stopped = false;
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  let rendering = false;
  let lastRendered = '';

  const clear = () => {
    if (!lineCount) return;
    options.write(`\x1b[${lineCount}A`);
    for (let index = 0; index < lineCount; index += 1) {
      options.write('\x1b[2K');
      if (index < lineCount - 1) options.write('\x1b[1B');
    }
    options.write(`\x1b[${Math.max(0, lineCount - 1)}A\r`);
  };

  const render = async () => {
    if (stopped || rendering) return;
    rendering = true;
    try {
      await options.readState().catch(() => undefined);
      const choices = options.choices();
      if (selectedIndex >= choices.length) selectedIndex = Math.max(0, choices.length - 1);
      const lines = [
        ...options.title().split('\n'),
        ...choices.map((choice, index) => `${index === selectedIndex ? '›' : ' '} ${choice.title}`)
      ];
      const rendered = lines.join('\n');
      if (rendered === lastRendered) return;
      clear();
      options.write(`${rendered}\n`);
      lineCount = lines.length;
      lastRendered = rendered;
    } finally {
      rendering = false;
    }
  };

  const cleanup = () => {
    stopped = true;
    clearInterval(interval);
    input.off('data', onData);
    if (input.isTTY) input.setRawMode(wasRaw);
    input.pause();
    clear();
  };

  const onData = (chunk: Buffer) => {
    const value = chunk.toString('utf8');
    const choices = options.choices();
    if (value === '\u0003') {
      cleanup();
      rejectValue?.(new Error('User canceled manual detection'));
      return;
    }
    if (value === '\u001b[A') {
      selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
      void render();
      return;
    }
    if (value === '\u001b[B') {
      selectedIndex = (selectedIndex + 1) % choices.length;
      void render();
      return;
    }
    if (value === '\r' || value === '\n') {
      const selected = choices[selectedIndex];
      if (!selected) return;
      cleanup();
      resolveValue?.(selected.value);
      return;
    }
  };

  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.on('data', onData);
  const interval = setInterval(() => {
    void render();
  }, 700);
  await render();
  return new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
}

async function showManualOverlay(page: Page, options: {
  title: string;
  message?: string;
  status?: string;
  choices: ManualOverlayChoice[];
  selectedXPath?: string;
  selectedText?: string;
  highlightXPaths?: string[];
  mode?: 'normal' | 'pick-search-submit';
  inputXPaths?: string[];
}): Promise<void> {
  await page.evaluate((payload) => {
    type ManualOverlayAction = string;
    type ManualOverlayChoice = {
      title: string;
      value: ManualOverlayAction;
      description?: string;
      primary?: boolean;
    };
    type ManualOverlayState = {
      action?: ManualOverlayAction;
      selectedXPath?: string;
      selectedText?: string;
    };
    const w = window as typeof window & {
      __octopusManualOverlayState?: ManualOverlayState;
      __octopusManualOverlayCleanup?: () => void;
      __octopusManualOverlayRenderCleanup?: () => void;
      __octopusManualOverlayPosition?: { left: number; top: number };
      __octopusManualOverlayIgnoreClickUntil?: number;
    };

    const xpath = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    };
    const byXPath = (path: string): Element | null => {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    };
    const textOf = (element: Element): string => (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const attrsOf = (element: Element): string => [
      element.localName,
      String((element as HTMLElement).id || ''),
      String((element as HTMLElement).className || ''),
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || ''
    ].join(' ');
    const childAttrsOf = (element: Element): string => Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
      .map((child) => attrsOf(child))
      .join(' ');
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const rightSideControl = (input: Element, button: Element): boolean => {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(52, inputRect.height * 0.8);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 180 && buttonRect.left <= inputRect.right + 240;
      const insideInputRight = buttonRect.right <= inputRect.right + 80 && buttonRect.left >= inputRect.left + inputRect.width * 0.42;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    };
    const inputElements = (payload.inputXPaths || []).map(byXPath).filter((element): element is Element => Boolean(element));
    const targetFor = (element: Element): Element => {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const candidate = current;
        const attrs = attrsOf(candidate);
        const style = window.getComputedStyle(candidate as HTMLElement);
        const rect = candidate.getBoundingClientRect();
        const compact = rect.width >= 8 && rect.height >= 8 && rect.width <= 180 && rect.height <= 180;
        const tapTarget = rect.width >= 24 && rect.height >= 24 && rect.width <= 120 && rect.height <= 120;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const tooBroad = rect.width > 320 || rect.height > 220;
        const semantic = /search|query|submit|button|btn|搜索|查询/i.test(`${attrs} ${textOf(candidate)} ${childAttrsOf(candidate)}`);
        const icon = /icon|suffix|append|magnif|glass|lens|svg|path|use/i.test(`${candidate.localName} ${attrs} ${childAttrsOf(candidate)}`);
        const nearInput = inputElements.some((input) => rightSideControl(input, candidate));
        let score = 0;
        if (/^(button|input)$/i.test(candidate.tagName)) score += 3.5;
        if (/^a$/i.test(candidate.tagName)) score += 1.2;
        if (candidate.getAttribute('role') === 'button') score += 3;
        if (candidate.getAttribute('onclick') || candidate.getAttribute('tabindex')) score += 2;
        if (style.cursor === 'pointer') score += 2.4;
        if (semantic) score += 1.6;
        if (icon) score += 0.8;
        if (nearInput) score += 1.4;
        if (tapTarget && nearInput) score += 1.2;
        if (candidate !== element && candidate.contains(element) && compact) score += 0.65;
        if (tinyGlyph) score -= 1.8;
        if (compact) score += 0.6;
        else if (tooBroad) score -= 1.8;
        if (!visible(candidate)) score = 0;
        if (score >= 1.2) candidates.push({ element: candidate, score: score - depth * 0.04 });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    };

    const previousSelectedXPath = payload.selectedXPath;
    const previousSelectedText = payload.selectedText;
    const previousState = w.__octopusManualOverlayState || {};
    w.__octopusManualOverlayRenderCleanup?.();
    w.__octopusManualOverlayState = {
      ...(previousState.selectedXPath ? { selectedXPath: previousState.selectedXPath } : {}),
      ...(previousState.selectedText ? { selectedText: previousState.selectedText } : {}),
      ...(previousSelectedXPath ? { selectedXPath: previousSelectedXPath } : {}),
      ...(previousSelectedText ? { selectedText: previousSelectedText } : {})
    };

    const existingHost = document.querySelector('[data-octopus-manual-overlay="true"]');
    const host = existingHost instanceof HTMLElement ? existingHost : document.createElement('div');
    host.setAttribute('data-octopus-manual-overlay', 'true');
    const savedPosition = w.__octopusManualOverlayPosition;
    if (!existingHost) {
      Object.assign(host.style, {
        position: 'fixed',
        left: `${Math.max(8, Math.min(window.innerWidth - 80, savedPosition?.left ?? 16))}px`,
        top: `${Math.max(8, Math.min(window.innerHeight - 80, savedPosition?.top ?? 96))}px`,
        zIndex: '2147483647',
        width: 'min(420px, calc(100vw - 32px))',
        pointerEvents: 'auto'
      });
    } else {
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'auto';
    }
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        box-sizing: border-box;
        width: 100%;
        color: #e5e2e1;
        background: rgba(19, 19, 19, 0.85);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        line-height: 1.45;
        overflow: hidden;
      }
      .header {
        padding: 16px 16px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        cursor: move;
        user-select: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .title {
        margin: 0;
        color: #e5e2e1;
        font-weight: 700;
        font-size: 13px;
        line-height: 1.2;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .active-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: 'JetBrains Mono', Courier, monospace;
        font-size: 9px;
        color: #4edea3;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        margin-top: 2px;
      }
      .pulse-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background-color: #4edea3;
        box-shadow: 0 0 0 0 rgba(78, 222, 163, 0.4);
        animation: pulse-dot 2s infinite;
      }
      @keyframes pulse-dot {
        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(78, 222, 163, 0.7); }
        70% { transform: scale(1); box-shadow: 0 0 0 5px rgba(78, 222, 163, 0); }
        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(78, 222, 163, 0); }
      }
      .message {
        margin-top: 6px;
        color: #c2c6d6;
        font-size: 12px;
        line-height: 1.4;
        white-space: pre-wrap;
      }
      .status {
        margin: 12px 16px 0;
        padding: 10px 12px;
        color: #c2c6d6;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
        word-break: break-all;
        font-family: 'JetBrains Mono', Courier, monospace;
        font-size: 11px;
        line-height: 1.4;
      }
      .status.processing {
        color: #adc6ff;
        background: rgba(173, 198, 255, 0.08);
        border-color: rgba(173, 198, 255, 0.2);
      }
      .status.processing::after {
        content: "_";
        animation: blink 1s step-end infinite;
      }
      @keyframes blink {
        from, to { color: transparent; }
        50% { color: inherit; }
      }
      .actions {
        display: grid;
        gap: 8px;
        padding: 12px 16px 16px;
      }
      button {
        appearance: none;
        box-sizing: border-box;
        width: 100%;
        min-height: 38px;
        padding: 10px 14px;
        border-radius: 8px;
        font: inherit;
        text-align: left;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
      }
      button:active:not(:disabled) {
        transform: scale(0.98);
      }
      button:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      button.primary {
        color: #002e6a;
        background: #adc6ff;
        border: 1px solid #adc6ff;
        font-weight: 600;
        text-align: center;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 12px rgba(173, 198, 255, 0.15);
      }
      button.primary:hover:not(:disabled) {
        background: #c2d6ff;
        border-color: #c2d6ff;
      }
      button.secondary {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        color: #e5e2e1;
      }
      button.secondary:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.12);
      }
      button.danger {
        color: #ffb4ab;
        background: rgba(255, 180, 171, 0.08);
        border: 1px solid rgba(255, 180, 171, 0.2);
      }
      button.danger:hover:not(:disabled) {
        background: rgba(255, 180, 171, 0.14);
        border-color: rgba(255, 180, 171, 0.3);
      }
      button.loading {
        text-align: center;
        align-items: center;
        justify-content: center;
      }
      .desc {
        display: block;
        color: #c2c6d6;
        font-size: 11px;
        line-height: 1.3;
        word-break: break-all;
        opacity: 0.6;
      }
      button.primary .desc {
        color: #002e6a;
        opacity: 0.8;
      }
      .mark {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        border: 2px dashed #adc6ff;
        background: rgba(173, 198, 255, 0.08);
        border-radius: 6px;
        transition: all 0.2s ease;
      }
      .mark.selected {
        border: 2px solid #4edea3;
        background: rgba(78, 222, 163, 0.12);
        box-shadow: 0 0 12px rgba(78, 222, 163, 0.25);
      }
      .progress-mode {
        position: relative;
      }
      /* Scanning Laser Line */
      .progress-mode::before {
        content: '';
        position: absolute;
        top: 0;
        left: -50%;
        width: 50%;
        height: 2px;
        background: linear-gradient(90deg, transparent, #4edea3, #adc6ff, transparent);
        animation: laser-sweep 2s infinite linear;
        z-index: 10;
      }
      @keyframes laser-sweep {
        0% { left: -50%; }
        100% { left: 100%; }
      }
      
      /* HUD Spinner */
      .loader-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px 16px 28px;
        position: relative;
        background: rgba(255, 255, 255, 0.01);
      }
      .hud-ring {
        width: 52px;
        height: 52px;
        border: 2px solid rgba(173, 198, 255, 0.1);
        border-top: 2px solid #adc6ff;
        border-bottom: 2px solid #4edea3;
        border-radius: 50%;
        animation: spin-clockwise 1.2s infinite linear;
        position: relative;
      }
      .hud-ring::before {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        right: 3px;
        bottom: 3px;
        border: 1px dashed rgba(78, 222, 163, 0.25);
        border-radius: 50%;
        animation: spin-counter-clockwise 4s infinite linear;
      }
      .hud-core {
        position: absolute;
        width: 14px;
        height: 14px;
        background: #adc6ff;
        border-radius: 50%;
        box-shadow: 0 0 10px #adc6ff;
        animation: pulse-core 1.5s infinite ease-in-out;
      }
      @keyframes spin-clockwise {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes spin-counter-clockwise {
        0% { transform: rotate(360deg); }
        100% { transform: rotate(0deg); }
      }
      @keyframes pulse-core {
        0%, 100% { transform: scale(0.85); opacity: 0.5; box-shadow: 0 0 6px #adc6ff; background: #adc6ff; }
        50% { transform: scale(1.15); opacity: 1; box-shadow: 0 0 16px #adc6ff, 0 0 24px #4edea3; background: #4edea3; }
      }
      button.loading {
        text-align: center;
        align-items: center;
        justify-content: center;
        background: linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.04) 75%);
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite linear;
        color: #adc6ff;
        border-color: rgba(173, 198, 255, 0.3);
      }
      button.loading::before {
        content: '';
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(173, 198, 255, 0.2);
        border-top-color: #adc6ff;
        border-radius: 50%;
        animation: spin-clockwise 0.8s infinite linear;
        margin-bottom: 4px;
      }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `;
    const panel = document.createElement('div');
    panel.className = 'panel';
    const header = document.createElement('div');
    header.className = 'header';
    header.title = 'Drag to move overlay';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = payload.title;
    header.appendChild(title);

    const badge = document.createElement('div');
    badge.className = 'active-badge';
    const dot = document.createElement('span');
    dot.className = 'pulse-dot';
    const badgeText = document.createElement('span');
    badgeText.textContent = 'Active Process';
    badge.appendChild(dot);
    badge.appendChild(badgeText);
    header.appendChild(badge);

    if (payload.message) {
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = payload.message;
      header.appendChild(message);
    }
    panel.appendChild(header);
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = payload.status || '';
    if (payload.status) panel.appendChild(status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const choices = payload.choices as ManualOverlayChoice[];
    if (choices.length === 0) {
      panel.classList.add('progress-mode');
    }
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = choice.primary ? 'primary' : choice.value === 'cancel' ? 'danger' : 'secondary';
      button.textContent = choice.title;
      if (choice.description) {
        const desc = document.createElement('span');
        desc.className = 'desc';
        desc.textContent = choice.description;
        button.appendChild(desc);
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        panel.classList.add('progress-mode');
        actions.querySelectorAll('button').forEach((item) => {
          item.disabled = true;
          item.classList.remove('primary', 'secondary', 'danger');
          item.classList.add('secondary');
        });
        button.classList.add('loading');
        button.textContent = choice.value === 'cancel' ? 'Canceling...' : 'Processing...';
        if (!status.isConnected) panel.insertBefore(status, actions);
        status.className = 'status processing';
        status.textContent = choice.value === 'cancel' ? 'Canceling detection, please wait.' : 'Action received, processing, please wait.';
        w.__octopusManualOverlayState = {
          ...(w.__octopusManualOverlayState || {}),
          action: choice.value
        };
      });
      actions.appendChild(button);
    }
    if (choices.length === 0) {
      const loaderContainer = document.createElement('div');
      loaderContainer.className = 'loader-container';
      const hudRing = document.createElement('div');
      hudRing.className = 'hud-ring';
      const hudCore = document.createElement('div');
      hudCore.className = 'hud-core';
      loaderContainer.appendChild(hudRing);
      loaderContainer.appendChild(hudCore);
      panel.appendChild(loaderContainer);
    } else {
      panel.appendChild(actions);
    }
    root.replaceChildren(style, panel);
    if (!host.isConnected) document.body.appendChild(host);

    let dragStart: { x: number; y: number; left: number; top: number } | undefined;
    const clampPosition = (left: number, top: number) => {
      const rect = host.getBoundingClientRect();
      return {
        left: Math.max(8, Math.min(window.innerWidth - Math.min(80, rect.width), left)),
        top: Math.max(8, Math.min(window.innerHeight - Math.min(48, rect.height), top))
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragStart) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const next = clampPosition(dragStart.left + event.clientX - dragStart.x, dragStart.top + event.clientY - dragStart.y);
      host.style.left = `${next.left}px`;
      host.style.top = `${next.top}px`;
      w.__octopusManualOverlayPosition = next;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragStart) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        w.__octopusManualOverlayIgnoreClickUntil = Date.now() + 350;
      }
      dragStart = undefined;
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
    };
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const rect = host.getBoundingClientRect();
      dragStart = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerup', onPointerUp, true);
    });

    const markers: HTMLElement[] = [];
    const addMarker = (path: string, selected = false) => {
      const element = byXPath(path);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const marker = document.createElement('div');
      marker.className = selected ? 'mark selected' : 'mark';
      Object.assign(marker.style, {
        left: `${Math.max(0, rect.left - 3)}px`,
        top: `${Math.max(0, rect.top - 3)}px`,
        width: `${Math.max(8, rect.width + 6)}px`,
        height: `${Math.max(8, rect.height + 6)}px`
      });
      document.body.appendChild(marker);
      markers.push(marker);
    };
    for (const path of payload.highlightXPaths || []) addMarker(path, false);
    if (previousSelectedXPath) addMarker(previousSelectedXPath, true);

    const onClick = (event: MouseEvent) => {
      const path = event.composedPath();
      if (Date.now() < (w.__octopusManualOverlayIgnoreClickUntil || 0)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      if (payload.mode !== 'pick-search-submit') return;
      const raw = event.target instanceof Element ? event.target : undefined;
      if (!raw || path.includes(host)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFor(raw);
      const selectedXPath = xpath(target);
      w.__octopusManualOverlayState = {
        ...(w.__octopusManualOverlayState || {}),
        selectedXPath,
        selectedText: textOf(target)
      };
      markers.forEach((marker) => marker.remove());
      markers.length = 0;
      addMarker(selectedXPath, true);
    };
    document.addEventListener('click', onClick, true);

    w.__octopusManualOverlayRenderCleanup = () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      markers.forEach((marker) => marker.remove());
      delete w.__octopusManualOverlayRenderCleanup;
    };
    w.__octopusManualOverlayCleanup = () => {
      w.__octopusManualOverlayRenderCleanup?.();
      host.remove();
      delete w.__octopusManualOverlayCleanup;
    };
  }, options);
}

async function readManualOverlaySelection(page: Page): Promise<ManualOverlaySelection | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusManualOverlayState?: {
        action?: ManualOverlayAction;
        selectedXPath?: string;
        selectedText?: string;
      };
    };
    const state = w.__octopusManualOverlayState;
    if (!state) return undefined;
    return {
      ...(state.action ? { action: state.action } : {}),
      ...(state.selectedXPath ? { selectedXPath: state.selectedXPath } : {}),
      ...(state.selectedText ? { selectedText: state.selectedText } : {})
    };
  }).catch(() => undefined);
}

async function clearManualOverlayAction(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusManualOverlayState?: { action?: ManualOverlayAction; selectedXPath?: string; selectedText?: string } };
    if (w.__octopusManualOverlayState) delete w.__octopusManualOverlayState.action;
  }).catch(() => undefined);
}

async function removeManualOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & {
      __octopusManualOverlayCleanup?: () => void;
      __octopusManualOverlayRenderCleanup?: () => void;
      __octopusManualOverlayState?: unknown;
    };
    w.__octopusManualOverlayCleanup?.();
    delete w.__octopusManualOverlayRenderCleanup;
    delete w.__octopusManualOverlayState;
  }).catch(() => undefined);
}

async function removeManualOverlaysFromBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) return;
  const pages = await browser.pages().catch(() => []);
  await Promise.all(pages.filter((page) => !page.isClosed()).map((page) => removeManualOverlay(page).catch(() => undefined)));
}

async function waitForManualOverlayAction(page: Page, timeoutMs = 0): Promise<ManualOverlaySelection | undefined> {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    if (page.isClosed()) return undefined;
    const state = await readManualOverlaySelection(page);
    if (state?.action) return state;
    await delay(150);
  }
  return undefined;
}

export async function showManualOverlayForTesting(page: Page, options: Parameters<typeof showManualOverlay>[1]): Promise<void> {
  await showManualOverlay(page, options);
}

export async function readManualOverlaySelectionForTesting(page: Page): Promise<ManualOverlaySelection | undefined> {
  return readManualOverlaySelection(page);
}

export function resetManualOverlayHintKeysForTesting(): void {
  manualOverlayHintKeys.clear();
}

export function writeManualOverlayHintOnceForTesting(runtimeConsole: SuppressedRuntimeConsole, page: Page | undefined, key: string, message: string): void {
  writeManualOverlayHintOnce(runtimeConsole, page, key, message);
}

async function installSearchSubmitPickerOverlay(page: Page, inputXPaths: string[] = []): Promise<void> {
  await page.evaluate((knownInputXPaths) => {
    type SearchSubmitSelection = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
    const w = window as typeof window & {
      __octopusSearchSubmitSelection?: SearchSubmitSelection;
      __octopusSearchSubmitCleanup?: () => void;
    };
    w.__octopusSearchSubmitCleanup?.();
    w.__octopusSearchSubmitSelection = undefined;

    const xpath = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    };
    const byXPath = (path: string): Element | null => {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
    };
    const textOf = (element: Element): string => (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const attrsOf = (element: Element): string => [
      element.localName,
      String((element as HTMLElement).id || ''),
      String((element as HTMLElement).className || ''),
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || ''
    ].join(' ');
    const childAttrsOf = (element: Element): string => Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
      .map((child) => attrsOf(child))
      .join(' ');
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const rightSideControl = (input: Element, button: Element): boolean => {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(52, inputRect.height * 0.8);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 180 && buttonRect.left <= inputRect.right + 240;
      const insideInputRight = buttonRect.right <= inputRect.right + 80 && buttonRect.left >= inputRect.left + inputRect.width * 0.42;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    };
    const inputElements = knownInputXPaths.map(byXPath).filter((element): element is Element => Boolean(element));
    const targetFor = (element: Element): Element => {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const candidate = current;
        const attrs = attrsOf(candidate);
        const style = window.getComputedStyle(candidate as HTMLElement);
        const rect = candidate.getBoundingClientRect();
        const compact = rect.width >= 8 && rect.height >= 8 && rect.width <= 180 && rect.height <= 180;
        const tapTarget = rect.width >= 24 && rect.height >= 24 && rect.width <= 120 && rect.height <= 120;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const tooBroad = rect.width > 320 || rect.height > 220;
        const semantic = /search|query|submit|button|btn|搜索|查询/i.test(`${attrs} ${textOf(candidate)} ${childAttrsOf(candidate)}`);
        const icon = /icon|suffix|append|magnif|glass|lens|svg|path|use/i.test(`${candidate.localName} ${attrs} ${childAttrsOf(candidate)}`);
        const nearInput = inputElements.some((input) => rightSideControl(input, candidate));
        let score = 0;
        if (/^(button|input)$/i.test(candidate.tagName)) score += 3.5;
        if (/^a$/i.test(candidate.tagName)) score += 1.2;
        if (candidate.getAttribute('role') === 'button') score += 3;
        if (candidate.getAttribute('onclick') || candidate.getAttribute('tabindex')) score += 2;
        if (style.cursor === 'pointer') score += 2.4;
        if (semantic) score += 1.6;
        if (icon) score += 0.8;
        if (nearInput) score += 1.4;
        if (tapTarget && nearInput) score += 1.2;
        if (candidate !== element && candidate.contains(element) && compact) score += 0.65;
        if (tinyGlyph) score -= 1.8;
        if (compact) score += 0.6;
        else if (tooBroad) score -= 1.8;
        if (!visible(candidate)) score = 0;
        if (score >= 1.2) candidates.push({ element: candidate, score: score - depth * 0.04 });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        const aArea = aRect.width * aRect.height;
        const bArea = bRect.width * bRect.height;
        return (b.score - a.score) || (bArea - aArea);
      });
      return candidates[0]?.element || element;
    };

    const banner = document.createElement('div');
    banner.textContent = 'Click the search button to record the task action; this click will be intercepted and will not navigate immediately.';
    Object.assign(banner.style, {
      position: 'fixed',
      left: '16px',
      right: '16px',
      top: '16px',
      zIndex: '2147483600',
      padding: '10px 12px',
      color: '#111827',
      background: '#fde68a',
      border: '1px solid #f59e0b',
      borderRadius: '6px',
      font: '13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.18)',
      pointerEvents: 'none'
    });
    document.body.appendChild(banner);

    const marker = document.createElement('div');
    Object.assign(marker.style, {
      position: 'fixed',
      zIndex: '2147483599',
      pointerEvents: 'none',
      border: '2px solid #f97316',
      background: 'rgba(249,115,22,.12)',
      borderRadius: '4px',
      display: 'none'
    });
    document.body.appendChild(marker);

    const onClick = (event: MouseEvent) => {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const raw = event.target instanceof Element ? event.target : undefined;
      if (!raw || raw === banner || raw === marker) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const target = targetFor(raw);
      const rect = target.getBoundingClientRect();
      Object.assign(marker.style, {
        display: 'block',
        left: `${Math.max(0, rect.left - 3)}px`,
        top: `${Math.max(0, rect.top - 3)}px`,
        width: `${Math.max(8, rect.width + 6)}px`,
        height: `${Math.max(8, rect.height + 6)}px`
      });
      w.__octopusSearchSubmitSelection = {
        xpath: xpath(target),
        ...(textOf(target) ? { text: textOf(target) } : {}),
        score: 2,
        reasons: ['manual picked search submit']
      };
    };
    document.addEventListener('click', onClick, true);
    w.__octopusSearchSubmitCleanup = () => {
      document.removeEventListener('click', onClick, true);
      banner.remove();
      marker.remove();
      delete w.__octopusSearchSubmitSelection;
      delete w.__octopusSearchSubmitCleanup;
    };
  }, inputXPaths);
}

async function readSearchSubmitPickerSelection(page: Page): Promise<SearchSubmitButton | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusSearchSubmitSelection?: {
        xpath: string;
        text?: string;
        score: number;
        reasons: string[];
      };
    };
    return w.__octopusSearchSubmitSelection;
  });
}

async function removeSearchSubmitPickerOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusSearchSubmitCleanup?: () => void };
    w.__octopusSearchSubmitCleanup?.();
  });
}

function formatSelectedCandidates(ids: string[], candidates: DetectedCandidate[]): string {
  if (!ids.length) return 'none';
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return ids.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) return id;
    const fields = candidate.fields.slice(0, 4).map((field) => field.name).join(',');
    return `${id} ${detectorCandidateTypeLabel(candidate.type)} ${candidate.itemCount} items${fields ? ` [${fields}]` : ''}`;
  }).join('; ');
}

function formatSelectedDetailFields(fields: string[]): string {
  return fields.length ? fields.join(', ') : 'none';
}

function selectedDetailFields(selected: Array<{
  suggestedName: string;
  kind: 'text' | 'href' | 'src';
  xpath: string;
  selector: string;
  sample: string;
  diagnostics?: DetectedFieldDiagnostics;
}>): DetectedField[] {
  const counts = new Map<string, number>();
  return selected
    .filter((field) => field.xpath && field.sample)
    .map((field) => {
      const baseName = sanitizeDetailFieldName(field.suggestedName);
      const count = (counts.get(baseName) ?? 0) + 1;
      counts.set(baseName, count);
      const name = count === 1 ? `detail_${baseName}` : `detail_${baseName}_${count}`;
      return {
        name,
        kind: field.kind,
        selector: field.selector,
        xpath: field.xpath,
        relativeSelector: field.selector,
        relativeXPath: field.xpath,
        ...(baseName === 'content' ? { operations: contentCleanupOperations() } : {}),
        ...(field.diagnostics ? { diagnostics: field.diagnostics } : {}),
        samples: [field.sample]
      };
    });
}

function contentCleanupOperations(): DetectedField['operations'] {
  return [
    { type: 'regex_replace', params: ['\\.data_color_scheme_dark\\{[\\s\\S]*$', ''] },
    { type: 'regex_replace', params: ['--weui-[\\s\\S]*$', ''] },
    { type: 'trim', params: ['0'] }
  ];
}

function sanitizeDetailFieldName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'field';
}

function formatSelectedPagination(key: string | undefined, options: DetectedPagination[]): string {
  if (!key) return 'single-page extraction';
  const option = options.find((item) => paginationKey(item) === key);
  if (!option) return key;
  const label = option.type === 'load_more' ? 'load more' : option.type === 'scroll' ? 'scroll loading' : 'next page';
  const mode = option.revealByScroll ? ', reveal by scrolling first' : '';
  const text = option.text ? ` "${truncateText(option.text, 28)}"` : '';
  return `${label}${mode}${text}, confidence ${Math.round(option.confidence * 100)}%`;
}

function detectorCandidateTypeLabel(type: DetectedCandidate['type']): string {
  if (type === 'table') return 'table';
  if (type === 'search_results') return 'results list';
  if (type === 'repeated_card') return 'repeated cards';
  if (type === 'link_collection') return 'link collection';
  if (type === 'detail') return 'detail page';
  if (type === 'form') return 'input/search form';
  return type;
}

function truncateText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

async function capturePaginationDiagnostics(page: Page): Promise<Array<{ tag: string; text: string; className: string; role: string; ariaLabel: string; title: string; xpath: string; rect: { top: number; left: number; width: number; height: number } }>> {
  return page.evaluate(() => {
    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === tag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    const pattern = /(加载|更多|查看更多|更多结果|展开|下一页|next|more|load|show)/i;
    return Array.from(document.querySelectorAll('a,button,input,[role="button"],[onclick],div,span,li'))
      .filter(visible)
      .filter((element) => {
        const html = element as HTMLElement;
        const combined = [
          text(element),
          html.id,
          html.className,
          html.getAttribute('role'),
          html.getAttribute('aria-label'),
          html.getAttribute('title'),
          html.getAttribute('data-type'),
          html.getAttribute('data-name')
        ].join(' ');
        return pattern.test(combined);
      })
      .map((element) => {
        const html = element as HTMLElement;
        const rect = element.getBoundingClientRect();
        return {
          tag: element.localName,
          text: text(element).slice(0, 80),
          className: String(html.className || '').slice(0, 120),
          role: html.getAttribute('role') || '',
          ariaLabel: html.getAttribute('aria-label') || '',
          title: html.getAttribute('title') || '',
          xpath: xpath(element),
          rect: {
            top: Math.round(rect.top + window.scrollY),
            left: Math.round(rect.left + window.scrollX),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        };
      })
      .slice(-30);
  });
}

async function preparePaginationDetectionViewport(page: Page, candidates: DetectedCandidate[]): Promise<(() => Promise<void>) | undefined> {
  const targets = candidates.map((candidate) => candidate.itemXPath || candidate.xpath).filter(Boolean);
  if (!targets.length) return undefined;
  const originalY = await page.evaluate(() => window.scrollY).catch(() => undefined);
  const scrollTargets = await page.evaluate((xpaths) => {
    function evaluateXPath(path: string): Element[] {
      try {
        const result = document.evaluate(path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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
    const elements = xpaths.flatMap((xpath) => evaluateXPath(xpath)).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const pageBottom = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0
    ) - window.innerHeight;
    const targets: number[] = [];
    const bottom = Math.max(...elements.slice(0, 120).map((element) => element.getBoundingClientRect().bottom + window.scrollY));
    if (Number.isFinite(bottom)) targets.push(Math.max(0, Math.min(bottom - window.innerHeight * 0.45, pageBottom)));
    targets.push(Math.max(0, pageBottom - window.innerHeight * 0.15));
    return Array.from(new Set(targets.map((value) => Math.round(value)))).filter((value) => Math.abs(value - window.scrollY) >= 80);
  }, targets).catch(() => [] as number[]);
  if (!scrollTargets.length) return undefined;
  for (const targetY of scrollTargets.slice(0, 2)) {
    await page.evaluate((y) => window.scrollTo(0, y), targetY).catch(() => undefined);
    await delay(550);
  }
  return async () => {
    if (typeof originalY === 'number') {
      await page.evaluate((y) => window.scrollTo(0, y), originalY).catch(() => undefined);
    }
  };
}

async function detectInteractivePaginationOptions(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination[]> {
  const selected = candidates.map((candidate) => ({
    id: candidate.id,
    xpath: candidate.xpath,
    itemXPath: candidate.itemXPath || candidate.xpath,
    type: candidate.type,
    itemCount: candidate.itemCount,
    pagination: candidate.pagination
  }));
  const detected = await page.evaluate((items) => {
    type PageOption = {
      type: 'next_page' | 'load_more' | 'scroll';
      xpath: string;
      text: string;
      confidence: number;
      isAjax: boolean;
      scope: 'near_list' | 'global';
      revealByScroll?: boolean;
      reasons: string[];
    };
    type ItemInfo = {
      id: string;
      xpath: string;
      itemXPath: string;
      type: string;
      itemCount: number;
    };
    const nextTextPattern = /^(下一页|下页|后一页|后页|next|>|›|»|→)$/i;
    const prevTextPattern = /^(上一页|上页|前一页|前页|prev|previous|<|‹|«|←)$/i;
    const loadMorePattern = /(加载更多|查看更多|显示更多|点击加载|load more|show more|see more)/i;
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const nextAttrPattern = /(next|pager-next|page-next|pagination-next|nextpage|btn-next|arrow-right)/i;
    const prevAttrPattern = /(prev|previous|pager-prev|page-prev|pagination-prev|btn-prev|arrow-left|left|disabled)/i;
    const pagerSelector = '[class*="pagination" i],[class*="pager" i],[class*="paginator" i],[class*="pagebar" i],[class*="page-nav" i],[class*="pages" i],[class*="el-pagination" i],[class*="ant-pagination" i],[class*="ivu-page" i],nav,ul,ol';
    const scanSelector = [
      'a',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[onclick]',
      '[class*="load" i]',
      '[class*="more" i]',
      '[aria-label*="more" i]',
      '[aria-label*="更多" i]',
      '[title*="more" i]',
      '[title*="更多" i]',
      'span',
      'div',
      'li'
    ].join(',');

    function text(element: Element | null): string {
      if (!element) return '';
      if (element instanceof HTMLInputElement) return (element.value || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('role'),
        html.getAttribute('rel'),
        html.getAttribute('aria-label'),
        html.getAttribute('title'),
        ...html.getAttributeNames().filter((name) => /^data-/i.test(name)).map((name) => html.getAttribute(name) || '')
      ].join(' ');
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function documentRect(element: Element): DOMRect {
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      return new DOMRect(rect.left + scrollX, rect.top + scrollY, rect.width, rect.height);
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }

    function xpathLiteral(value: string): string {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat('${value.split("'").join(`',"'",'`)}')`;
    }

    function lowerXPath(expression: string): string {
      return `translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    }

    function safeNextPredicate(): string {
      const classExpr = lowerXPath('concat(" ", normalize-space(@class), " ")');
      const ariaExpr = lowerXPath('@aria-disabled');
      const textExpr = lowerXPath('normalize-space(.)');
      return [
        `not(contains(${classExpr}, " disabled "))`,
        `not(contains(${classExpr}, " prev "))`,
        `not(contains(${classExpr}, " previous "))`,
        `not(${ariaExpr}="true")`,
        `not(contains(${textExpr}, "没有更多"))`,
        `not(contains(${textExpr}, "暂无更多"))`,
        `not(contains(${textExpr}, "已到底"))`,
        `not(contains(${textExpr}, "到底了"))`,
        `not(contains(${textExpr}, "加载完毕"))`,
        `not(contains(${textExpr}, "no more"))`,
        `not(contains(${textExpr}, "all loaded"))`,
        `not(contains(${textExpr}, "end of"))`
      ].join(' and ');
    }

    function activeLoadMoreTextPredicate(): string {
      const textExpr = lowerXPath('normalize-space(.)');
      const positive = [
        `contains(${textExpr}, "加载更多")`,
        `contains(${textExpr}, "查看更多")`,
        `contains(${textExpr}, "显示更多")`,
        `contains(${textExpr}, "点击加载")`,
        `contains(${textExpr}, "load more")`,
        `contains(${textExpr}, "show more")`,
        `contains(${textExpr}, "see more")`
      ].join(' or ');
      const negative = [
        `not(contains(${textExpr}, "see more information"))`,
        `not(contains(${textExpr}, "more information about"))`,
        `not(contains(${textExpr}, "details about"))`,
        `not(contains(${textExpr}, "view details"))`,
        `not(contains(${textExpr}, "查看详情"))`,
        `not(contains(${textExpr}, "详细信息"))`
      ].join(' and ');
      return `(${positive}) and ${negative}`;
    }

    function loadMoreRecordExpanderText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalized) return false;
      return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:view|show)\s+details?\b/i.test(normalized)
        || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
    }

    function reliableLoadMoreText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 72 || loadMoreRecordExpanderText(normalized)) return false;
      return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(normalized);
    }

    function loadMoreState(element: Element): { active: boolean; hasText: boolean; end: boolean } {
      const value = text(element);
      const attrs = attrText(element);
      const combined = `${value} ${attrs}`;
      const hasText = reliableLoadMoreText(value);
      const hasAttr = /loadmore|load-more/i.test(attrs);
      const end = loadMoreEndPattern.test(combined);
      return { active: !end && !loadMoreRecordExpanderText(value) && (hasText || hasAttr), hasText, end };
    }

    function stablePaginationXPath(element: Element, type: 'next_page' | 'load_more', fallback: string): string {
      const tag = element.localName.toLowerCase();
      const value = text(element);
      const html = element as HTMLElement;
      const predicates: string[] = [];
      const safe = safeNextPredicate();
      const attrMatches = type === 'load_more'
        ? (raw: string) => /loadmore|load-more|more/i.test(raw)
        : (raw: string) => nextAttrPattern.test(raw) && !prevAttrPattern.test(raw);
      const textMatches = type === 'load_more'
        ? (raw: string) => reliableLoadMoreText(raw)
        : (raw: string) => nextTextPattern.test(raw) && !prevTextPattern.test(raw);
      const push = (predicate: string) => {
        const full = type === 'load_more'
          ? `${predicate} and (${activeLoadMoreTextPredicate()}) and ${safe}`
          : `${predicate} and ${safe}`;
        if (!predicates.includes(full)) predicates.push(full);
      };

      if (html.id && attrMatches(html.id)) push(`@id=${xpathLiteral(html.id)}`);
      for (const name of ['rel', 'aria-label', 'title', 'alt', 'value']) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      for (const token of Array.from(html.classList || [])) {
        if (attrMatches(token)) push(`contains(concat(" ", normalize-space(@class), " "), ${xpathLiteral(` ${token} `)})`);
      }
      for (const name of html.getAttributeNames().filter((item) => /^data-/i.test(item))) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      if (type === 'load_more' && reliableLoadMoreText(value)) {
        const textExpr = lowerXPath('normalize-space(.)');
        const positiveTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'load more', 'show more', 'see more'];
        push(`(${positiveTexts.map((item) => `contains(${textExpr}, ${xpathLiteral(item.toLowerCase())})`).join(' or ')})`);
      } else if (value && textMatches(value)) {
        push(`normalize-space(.)=${xpathLiteral(value)}`);
      }

      const section = element.closest(pagerSelector) || pagerGroupFor(element);
      const candidates: string[] = [];
      if (section) {
        const sectionXPath = xpath(section);
        candidates.push(...predicates.map((predicate) => `${sectionXPath}//${tag}[${predicate}]`));
      }
      candidates.push(...predicates.map((predicate) => `//${tag}[${predicate}]`));

      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.length === 1 && matches[0] === element) return candidate;
      }
      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.includes(element)) return candidate;
      }
      return fallback;
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
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

    function firstClickable(element: Element): Element {
      if (/^(a|button|input)$/i.test(element.localName)) return element;
      return element.querySelector('a,button,input[type="button"],input[type="submit"]') || element;
    }

    function numericValue(element: Element): number | null {
      const value = text(element).match(/^\d{1,5}$/)?.[0];
      return value ? Number(value) : null;
    }

    function numericDescendants(element: Element): Element[] {
      return Array.from(element.querySelectorAll('a,button,input[type="button"],input[type="submit"],span,li,div'))
        .filter(visible)
        .filter((item) => numericValue(item) !== null);
    }

    function explicitPagerContext(element: Element): boolean {
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const attrs = attrText(current);
        if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs)) return true;
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) return true;
      }
      return false;
    }

    function horizontalFilterOrCarousel(element: Element, listRect: DOMRect | undefined): boolean {
      if (explicitPagerContext(element)) return false;
      const value = text(element);
      const box = documentRect(element);
      const arrowOnly = value === '' || /^[›»>→]$/.test(value);
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const html = current as HTMLElement;
        const attrsAndText = `${attrText(current)} ${(html.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260)}`;
        const horizontalScrollable = Number(html.scrollWidth || 0) > Number(html.clientWidth || box.width || 0) + 24;
        const filterLike = /(filter|filters|筛选|过滤|排序|sort|分类|category|categories|tag|tags|标签|tab|tabs|chip|chips|carousel|swiper|slider|横向|频道|导航|menu|dropdown|select|selector|员工人数|盈利情况|学生|行业|地区|公司|融资|规模|综合|最新|最热|推荐)/i.test(attrsAndText);
        if ((horizontalScrollable || filterLike) && arrowOnly) return true;
      }
      if (!listRect) return false;
      const aboveListEnd = box.bottom < listRect.bottom - Math.max(160, listRect.height * 0.18);
      return arrowOnly && aboveListEnd && /(arrow-right|right|next)/i.test(attrText(element));
    }

    function isAjax(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      const onclick = element.getAttribute('onclick') || element.getAttribute('onClick') || '';
      const attrs = attrText(element);
      return Boolean(onclick) || !href || href === '#' || href === '/' || /^javascript:/i.test(href) || /ajax|loadmore|load-more/i.test(attrs) || element.localName !== 'a';
    }

    function listRectFor(item: { xpath: string; itemXPath: string }): DOMRect | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 100);
      const roots = elements.length ? elements : evaluateXPath(item.xpath).filter(visible).slice(0, 1);
      if (!roots.length) return undefined;
      const rects = roots.map((element) => documentRect(element));
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    }

    function insideListItem(element: Element, item: ItemInfo): boolean {
      if (!item.itemXPath) return false;
      return evaluateXPath(item.itemXPath).slice(0, 160).some((row) => row === element || row.contains(element));
    }

    function commonListContainer(item: { xpath: string; itemXPath: string }): Element | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 100);
      if (elements.length >= 2) {
        let current: Element | null = elements[0].parentElement;
        while (current && current !== document.body) {
          if (elements.every((element) => current?.contains(element))) return current;
          current = current.parentElement;
        }
      }
      return evaluateXPath(item.xpath).find(visible) || elements[0];
    }

    function nearList(element: Element, rect?: DOMRect): boolean {
      if (!rect) return true;
      const box = documentRect(element);
      const below = box.top >= rect.top + Math.min(80, rect.height * 0.2);
      const close = box.top <= rect.bottom + Math.max(520, window.innerHeight * 0.9);
      const horizontal = box.right >= rect.left - 120 && box.left <= rect.right + 120;
      return below && close && horizontal;
    }

    function scrollRevealNeeded(item: ItemInfo | undefined, rect: DOMRect | undefined): boolean {
      if (!item || !rect) return false;
      const pageHeight = Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
      const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const longPage = pageHeight > viewportHeight * 1.8;
      const listLike = item.type === 'repeated_card' || item.type === 'search_results';
      const enoughItems = item.itemCount >= 12;
      const currentY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      const reachesViewportBottom = rect.bottom > currentY + viewportHeight * 0.55;
      return longPage && listLike && enoughItems && reachesViewportBottom;
    }

    function baseScore(element: Element, rect: DOMRect | undefined, scope: 'near_list' | 'global'): number {
      const box = documentRect(element);
      const viewportBox = element.getBoundingClientRect();
      let score = scope === 'near_list' ? 0.48 : 0.36;
      if (rect && box.top >= rect.bottom - 80 && box.top <= rect.bottom + Math.max(520, window.innerHeight * 0.9)) score += 0.18;
      if (element.closest(pagerSelector)) score += 0.12;
      if (viewportBox.top > window.innerHeight * 0.45 || viewportBox.top > 300) score += 0.06;
      return score;
    }

    function isPageSection(element: Element, listRect: DOMRect | undefined): boolean {
      if (!visible(element)) return false;
      const box = documentRect(element);
      if (listRect) {
        const withinBottomBand = box.top >= listRect.bottom - Math.max(120, listRect.height * 0.05)
          && box.top <= listRect.bottom + Math.max(720, window.innerHeight * 1.05);
        const compactPagerNearList = box.top >= listRect.top + Math.min(80, listRect.height * 0.2)
          && box.top <= listRect.bottom + Math.max(320, window.innerHeight * 0.45)
          && box.height <= 96;
        if (!withinBottomBand && !compactPagerNearList) return false;
      }
      const attrs = attrText(element);
      const numbers = numericDescendants(element);
      const sectionText = text(element);
      const hasPageAttr = /(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs);
      const hasPagerShape = numbers.length >= 2 && sectionText.length < 160;
      return hasPageAttr || hasPagerShape;
    }

    function findPageSectionInSubtree(element: Element, listRect: DOMRect | undefined, recursive = true): Element | undefined {
      for (const child of Array.from(element.children)) {
        if (child.nodeName.toLowerCase() === 'svg') continue;
        if (isPageSection(child, listRect)) return child;
        if (recursive) {
          const found = findPageSectionInSubtree(child, listRect, true);
          if (found) return found;
        }
      }
      return undefined;
    }

    function findNearPageSections(listContainer: Element | undefined, listRect: DOMRect | undefined): Element[] {
      if (!listContainer) return [];
      const output: Element[] = [];
      const push = (element: Element | undefined) => {
        if (element && !output.includes(element)) output.push(element);
      };

      const children = Array.from(listContainer.children);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child.nodeName.toLowerCase() === 'svg') continue;
        if (isPageSection(child, listRect)) push(child);
        push(findPageSectionInSubtree(child, listRect, children.length - index < 3));
        if (output.length) return output;
      }

      let current: Element | null = listContainer;
      for (let level = 0; current && current.parentElement && current.parentElement !== document.body && level < 7; level += 1) {
        let sibling = current.nextElementSibling;
        while (sibling) {
          if (sibling.nodeName.toLowerCase() !== 'svg') {
            if (isPageSection(sibling, listRect)) push(sibling);
            const html = sibling as HTMLElement;
            const textLength = (html.innerText || sibling.textContent || '').trim().length;
            const htmlLength = html.innerHTML.length;
            if (!output.length && ((htmlLength > 10 && htmlLength < 2400) || textLength < 160)) {
              push(findPageSectionInSubtree(sibling, listRect, true));
            }
            if (output.length) return output;
          }
          sibling = sibling.nextElementSibling;
        }

        const currentText = ((current as HTMLElement).innerText || current.textContent || '').trim();
        const parentText = ((current.parentElement as HTMLElement).innerText || current.parentElement.textContent || '').trim();
        if (parentText.length - currentText.length > 700) break;
        current = current.parentElement;
      }
      return output;
    }

    function findBottomPagerSections(item: ItemInfo, listRect: DOMRect | undefined): Element[] {
      if (!listRect) return [];
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 160);
      const roots = [commonListContainer(item), evaluateXPath(item.xpath).find(visible), ...rows.map((row) => row.parentElement)]
        .filter((element): element is Element => Boolean(element));
      const output: Element[] = [];
      const push = (element: Element | undefined) => {
        if (element && !output.includes(element)) output.push(element);
      };
      const belowList = (element: Element): boolean => {
        const box = documentRect(element);
        return box.top >= listRect.top + Math.min(80, listRect.height * 0.2)
          && box.top <= listRect.bottom + Math.max(760, window.innerHeight * 1.15)
          && box.right >= listRect.left - 180
          && box.left <= listRect.right + 180;
      };

      for (const root of roots) {
        let current: Element | null = root;
        for (let level = 0; current && current !== document.body && level < 7; level += 1, current = current.parentElement) {
          const siblings = Array.from(current.parentElement?.children ?? []);
          const startIndex = siblings.indexOf(current) + 1;
          for (const sibling of siblings.slice(Math.max(0, startIndex), startIndex + 8)) {
            if (!(sibling instanceof Element) || !belowList(sibling)) continue;
            if (isPageSection(sibling, listRect)) push(sibling);
            push(findPageSectionInSubtree(sibling, listRect, true));
          }
        }
      }

      const candidates = Array.from(document.querySelectorAll('nav,ul,ol,div,span'))
        .filter((element): element is Element => element instanceof Element)
        .filter((element) => belowList(element))
        .filter((element) => isPageSection(element, listRect));
      for (const element of candidates) push(element);
      return output;
    }

    function optionFor(element: Element, type: 'next_page' | 'load_more', rect: DOMRect | undefined, scope: 'near_list' | 'global', reason: string, item?: ItemInfo): PageOption | null {
      const clickable = firstClickable(element);
      const value = text(clickable) || text(element);
      const attrs = `${attrText(element)} ${attrText(clickable)}`;
      if (prevTextPattern.test(value) || prevAttrPattern.test(attrs)) return null;
      let confidence = baseScore(clickable, rect, scope);
      const reasons = [reason];
      if (type === 'next_page') {
        const explicitNextText = nextTextPattern.test(value);
        const explicitNextAttr = nextAttrPattern.test(attrs);
        const inPager = Boolean(clickable.closest(pagerSelector)) || explicitPagerContext(clickable) || explicitPagerContext(element);
        if (horizontalFilterOrCarousel(clickable, rect) || horizontalFilterOrCarousel(element, rect)) return null;
        if (!explicitNextText && explicitNextAttr && !inPager && !explicitPagerContext(clickable)) confidence -= 0.24;
        if (!explicitNextText && explicitNextAttr && value.length > 20 && !inPager) return null;
        if (!explicitNextText && !explicitNextAttr && value.length > 20) return null;
        if (explicitNextText) confidence += 0.28;
        if (explicitNextAttr) confidence += 0.2;
        if (inPager) {
          confidence += 0.08;
          reasons.push('pager section context');
        }
      } else {
        const state = loadMoreState(element);
        if (!state.active) return null;
        if (state.hasText) confidence += 0.34;
        else confidence += 0.12;
      }
      if (value.length > 40) confidence -= 0.2;
      if (confidence < 0.5) return null;
      return {
        type,
        xpath: stablePaginationXPath(clickable, type, xpath(clickable)),
        text: value || clickable.getAttribute('aria-label') || clickable.getAttribute('title') || '',
        confidence: Math.min(0.98, confidence),
        isAjax: type === 'load_more' || isAjax(clickable),
        scope,
        ...(type === 'load_more' && scrollRevealNeeded(item, rect) ? { revealByScroll: true } : {}),
        reasons
      };
    }

    function pageButtonLike(element: Element): boolean {
      const value = text(element);
      const attrs = attrText(element);
      const box = element.getBoundingClientRect();
      if (numericValue(element) !== null) return true;
      if (nextTextPattern.test(value) || prevTextPattern.test(value)) return true;
      if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrs)) return true;
      if (nextAttrPattern.test(attrs) && explicitPagerContext(element)) return true;
      if (value === '' && box.width <= 96 && box.height <= 72) return true;
      if (/^[›»>→]$/.test(value)) return true;
      return value.length > 0 && value.length <= 8 && box.width <= 120 && box.height <= 80;
    }

    function pagerArrowOptions(elements: Element[], rect: DOMRect | undefined, scope: 'near_list' | 'global', sourceItem?: ItemInfo): PageOption[] {
      const sections = new Map<Element, Element[]>();
      for (const element of elements) {
        if (numericValue(element) === null) continue;
        const section = pagerGroupFor(element);
        if (!section) continue;
        sections.set(section, [...(sections.get(section) ?? []), element]);
      }
      const output: PageOption[] = [];
      for (const [section, nums] of sections) {
        if (nums.length < 2) continue;
        const orderedNums = nums
          .map((element) => ({ element, rect: documentRect(element) }))
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
        const lastNum = orderedNums[orderedNums.length - 1];
        const centerY = lastNum.rect.top + lastNum.rect.height / 2;
        const candidates = Array.from(section.querySelectorAll(scanSelector))
          .filter(visible)
          .map((element) => ({ element, clickable: firstClickable(element), rect: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => {
            if (!pageButtonLike(item.element) && !pageButtonLike(item.clickable)) return false;
            if (numericValue(item.element) !== null) return false;
            if (prevTextPattern.test(item.value) || prevAttrPattern.test(item.attrs)) return false;
            if (item.value === '...' || item.value === '…') return false;
            const sameLine = Math.abs((item.rect.top + item.rect.height / 2) - centerY) < Math.max(24, lastNum.rect.height);
            const afterNumbers = item.rect.left >= lastNum.rect.right - 4;
            return sameLine && afterNumbers;
          })
          .sort((a, b) => a.rect.left - b.rect.left);
        const arrow = candidates.find((item) => nextTextPattern.test(item.value) || nextAttrPattern.test(`${item.attrs} ${attrText(item.clickable)}`));
        if (!arrow) continue;
        const option = optionFor(arrow.clickable, 'next_page', rect, scope, 'pager arrow after numeric pages', sourceItem);
        if (option) output.push({ ...option, confidence: Math.max(option.confidence, 0.82) });
      }
      return output;
    }

    function pagerGroupFor(element: Element): Element | undefined {
      let current: Element | null = element.parentElement;
      let best: Element | undefined;
      for (let level = 0; current && current !== document.body && level < 5; level += 1) {
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) {
          best = current;
        }
        if (/(pager|pagination|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(attrText(current))) {
          best = current;
          break;
        }
        current = current.parentElement;
      }
      return best || element.parentElement || undefined;
    }

    function scan(item: ItemInfo | undefined, rect: DOMRect | undefined, scope: 'near_list' | 'global'): PageOption[] {
      const elements = Array.from(document.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((element) => item ? !insideListItem(element, item) : true)
        .filter((element) => nearList(element, rect));
      const output: PageOption[] = [];
      for (const element of elements) {
        const value = text(element);
        const attrs = attrText(element);
        if (loadMoreState(element).active) {
          const option = optionFor(element, 'load_more', rect, scope, 'load-more text or attributes', item);
          if (option) output.push(option);
        }
        if (nextTextPattern.test(value) || (nextAttrPattern.test(attrs) && value.length <= 20)) {
          const option = optionFor(element, 'next_page', rect, scope, 'next-page text or attributes', item);
          if (option) output.push(option);
        }
      }
      output.push(...pagerArrowOptions(elements, rect, scope, item));
      return output;
    }

    function paginationEvidenceWeight(option: PageOption): number {
      const reasons = option.reasons.join(' ');
      return (/pager arrow after numeric pages/i.test(reasons) ? 0.06 : 0)
        + (/numeric pager sequence/i.test(reasons) ? 0.04 : 0)
        + (/pager section context/i.test(reasons) ? 0.02 : 0);
    }

    const output: PageOption[] = [];
    for (const item of items) {
      const rect = listRectFor(item);
      output.push(...scan(item, rect, 'near_list'));
      const listContainer = commonListContainer(item);
      for (const section of [...findNearPageSections(listContainer, rect), ...findBottomPagerSections(item, rect)]) {
        const sectionElements = Array.from(section.querySelectorAll('a,button,input[type="button"],input[type="submit"],span,div,li'))
          .filter(visible)
          .filter((element) => pageButtonLike(element) || pageButtonLike(firstClickable(element)));
        output.push(...pagerArrowOptions(sectionElements, rect, 'near_list', item));
        const lastButton = sectionElements
          .map((element) => ({ element, box: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => numericValue(item.element) === null)
          .filter((item) => !prevTextPattern.test(item.value) && !prevAttrPattern.test(item.attrs))
          .filter((item) => item.value !== '...' && item.value !== '…')
          .sort((a, b) => b.box.left - a.box.left)[0];
        if (lastButton) {
          const option = optionFor(lastButton.element, 'next_page', rect, 'near_list', 'last button in near pager section', item);
          if (option) output.push({ ...option, confidence: Math.max(option.confidence, 0.78) });
        }
      }
    }
    const globalOptions = scan(undefined, undefined, 'global');
    output.push(...globalOptions.filter((option) => option.type === 'load_more' || /pager|numeric/i.test(option.reasons.join(' '))));
    if (!output.length) output.push(...globalOptions);
    return output
      .sort((a, b) => (b.confidence + paginationEvidenceWeight(b)) - (a.confidence + paginationEvidenceWeight(a)))
      .filter((option, index, array) => array.findIndex((item) => item.xpath === option.xpath) === index)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 8);
  }, selected) as DetectedPagination[];

  const existing = selected
    .map((item) => item.pagination && !scrollProbeRulesOutScroll(item, scrollProbe) ? item.pagination : undefined)
    .filter((pagination): pagination is DetectedPagination => Boolean(pagination));
  const probeDetected = Object.values(scrollProbePaginationForCandidates(candidates, scrollProbe));
  return [...detected, ...existing, ...probeDetected]
    .filter(isPlausiblePaginationOption)
    .filter((pagination, index, array) => {
      const key = paginationKey(pagination);
      return pagination.type === 'scroll' || array.findIndex((item) => paginationKey(item) === key) === index;
    })
    .sort(comparePaginationOptions);
}

function isPlausiblePaginationOption(pagination: DetectedPagination): boolean {
  if (pagination.type === 'load_more') return reliableLoadMorePagination(pagination);
  if (pagination.type !== 'next_page') return true;
  const text = (pagination.text || '').trim();
  const xpath = pagination.xpath || '';
  const reasons = pagination.reasons.join(' ');
  const pagerLike = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)
    || /numeric pager|pager sequence|pager section|pager arrow/i.test(reasons);
  if (/^(下一页|下页|后一页|后页|next)$/i.test(text)) return true;
  if (/^(>|›|»|→)$/i.test(text)) return pagerLike;
  if (/(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)) return true;
  if (/(pager-next|page-next|pagination-next|nextpage|btn-next)/i.test(xpath)) return true;
  if (/(^|[^a-z])next([^a-z]|$)/i.test(xpath) && !/(arrow-right|right)/i.test(xpath)) return true;
  if (/numeric pager|pager sequence|pager section/i.test(reasons) && /^\d{1,5}$/.test(text)) return true;
  return false;
}

function reliableLoadMorePagination(pagination: DetectedPagination): boolean {
  if (pagination.type !== 'load_more') return false;
  const text = (pagination.text || '').replace(/\s+/g, ' ').trim();
  const evidence = `${pagination.xpath || ''} ${pagination.reasons.join(' ')}`;
  if (loadMoreRecordExpanderText(text)) return false;
  if (/(?:loadmore|load-more|load_more)/i.test(evidence)) return true;
  if (!text || text.length > 72) return false;
  return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(text);
}

function loadMoreRecordExpanderText(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
    || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
    || /^(?:view|show)\s+details?\b/i.test(normalized)
    || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
}

function comparePaginationOptions(a: DetectedPagination, b: DetectedPagination): number {
  const typeWeight = (pagination: DetectedPagination) => {
    if (pagination.type === 'load_more') return 0.26;
    if (pagination.type === 'next_page') return reliableNextPagination(pagination) ? 0.28 : -0.16;
    if (pagination.type === 'scroll') return 0.04;
    return 0;
  };
  const sourceWeight = (pagination: DetectedPagination) => {
    const reasons = pagination.reasons.join(' ');
    return /protected SmartProxy|SmartProxy/i.test(reasons) ? 0.08 : 0;
  };
  return (b.confidence + typeWeight(b) + sourceWeight(b)) - (a.confidence + typeWeight(a) + sourceWeight(a));
}

async function installCandidateOverlay(page: Page, candidates: DetectedCandidate[], paginations: DetectedPagination[] = []): Promise<void> {
  const overlayCandidates = candidates
    .filter((candidate) => candidate.type === 'table' || candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection')
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      itemXPath: candidate.itemXPath || candidate.xpath,
      xpath: candidate.xpath,
      itemCount: candidate.itemCount,
      layoutRole: candidate.layout?.role ?? 'unknown',
      layoutScore: candidate.layout?.score ?? 0,
      mainScore: candidate.layout?.mainScore ?? 0,
      sidebarPenalty: candidate.layout?.sidebarPenalty ?? 0,
      navigationLike: candidate.reasons.some((reason) => /navigation|header/i.test(reason)),
      fields: candidate.fields
        .filter((field) => field.kind === 'text' || field.kind === 'href' || field.kind === 'src')
        .map((field) => ({
          name: field.name,
          kind: field.kind,
          xpath: field.xpath,
          relativeXPath: field.relativeXPath || ''
        }))
    }));
  const overlayPaginations = paginations.map((pagination) => ({
    key: paginationKey(pagination),
    type: pagination.type,
    xpath: pagination.xpath,
    text: pagination.text,
    confidence: pagination.confidence
  }));
  await page.evaluate(({ items, paginationItems }) => {
    const w = window as typeof window & {
      __octopusDetectionSelection?: string;
      __octopusDetectionSelections?: string[];
      __octopusDetectionClearSelection?: () => void;
      __octopusDetectionCleanup?: () => void;
    };
    w.__octopusDetectionCleanup?.();
    document.getElementById('octopus-detection-overlay-root')?.remove();
    w.__octopusDetectionSelection = undefined;
    w.__octopusDetectionSelections = [];

    const palette = [
      '#009f4d',
      '#2563eb',
      '#d97706',
      '#dc2626',
      '#7c3aed',
      '#0891b2',
      '#db2777',
      '#4b5563'
    ];
    const root = document.createElement('div');
    root.id = 'octopus-detection-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'visible';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483600';
    document.documentElement.appendChild(root);

    const labels: HTMLElement[] = [];
    const highlighted: HTMLElement[] = [];
    const fieldHighlighted: HTMLElement[] = [];
    const paginationPreviewElements: HTMLElement[] = [];
    const byElement = new WeakMap<Element, string>();
    const previewByElement = new WeakSet<Element>();
    const selectedIds = new Set<string>();
    const labelEntries: Array<{ element: Element; label: HTMLElement }> = [];

    function evaluateXPath(xpath: string): Element[] {
      if (!xpath) return [];
      const normalized = xpath.includes('[*]') ? xpath.replace(/\[\*\]/g, '') : xpath;
      const result = document.evaluate(normalized, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function drawBox(element: Element, candidateId: string, labelText: string, color: string, emphasis: 'primary' | 'secondary'): void {
      const html = element as HTMLElement;
      const originalOutline = html.style.outline;
      const originalOutlineOffset = html.style.outlineOffset;
      const originalBackground = html.style.backgroundColor;
      html.dataset.octopusDetectionOutline = originalOutline;
      html.dataset.octopusDetectionOutlineOffset = originalOutlineOffset;
      html.dataset.octopusDetectionBackground = originalBackground;
      html.dataset.octopusDetectionColor = color;
      html.dataset.octopusDetectionEmphasis = emphasis;
      html.style.outline = `${emphasis === 'primary' ? 3 : 2}px ${emphasis === 'primary' ? 'solid' : 'dashed'} ${color}`;
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = emphasis === 'primary' ? `${color}16` : `${color}08`;
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      byElement.set(element, candidateId);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 22)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '3px 6px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.opacity = emphasis === 'primary' ? '1' : '.72';
      label.style.boxShadow = emphasis === 'primary' ? '0 2px 8px rgba(0,0,0,.18)' : '0 1px 5px rgba(0,0,0,.14)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function elementText(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function ownText(element: Element | null): string {
      if (!element) return '';
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        html.className || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('rel') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('data-testid') || '',
        html.getAttribute('data-test') || '',
        html.getAttribute('data-qa') || '',
        html.getAttribute('data-role') || ''
      ].join(' ');
    }

    function hasVisibleImage(element: Element): boolean {
      return Array.from(element.querySelectorAll('img')).some(visible);
    }

    function textFieldValue(element: Element): string {
      const own = ownText(element);
      if (own) return own;
      const tag = element.tagName.toLowerCase();
      const value = elementText(element);
      if (/^(a|h1|h2|h3|h4|p|span|time|em|i|strong|b)$/i.test(tag)) return value;
      if (element.children.length <= 1 && !hasVisibleImage(element)) return value;
      return '';
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function isEngagementCount(value: string): boolean {
      const compact = value.replace(/\s+/g, '');
      if (!compact || compact.length > 24 || !/\d/.test(compact)) return false;
      if (dateMatch(compact)) return false;
      return /^(赞|喜欢|收藏|评论|转发|like|likes|save|saves|comment|comments|share|shares)?[:：]?[♡♥❤👍]?\d+(?:[.,]\d+)?(?:万|千|亿|w|k|m)?\+?(赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?$/i.test(compact);
    }

    type EngagementKind = 'comments' | 'favorites' | 'shares' | 'likes' | 'metric';

    function engagementCountValue(element: Element): string {
      const values = [ownText(element), textFieldValue(element), elementText(element)];
      return values.find((value) => isEngagementCount(value)) || '';
    }

    function engagementCountLeaves(root: Element): Element[] {
      return Array.from(root.querySelectorAll('span,em,i,b,strong,a,button,div'))
        .filter(visible)
        .filter((element) => Boolean(engagementCountValue(element)))
        .filter((element) => !Array.from(element.querySelectorAll('span,em,i,b,strong,a,button,div'))
          .some((child) => child !== element && visible(child) && Boolean(engagementCountValue(child))));
    }

    function nearestSiblings(element: Element, direction: 'previous' | 'next', limit = 3): Element[] {
      const output: Element[] = [];
      let current = direction === 'previous' ? element.previousElementSibling : element.nextElementSibling;
      while (current && output.length < limit) {
        output.push(current);
        current = direction === 'previous' ? current.previousElementSibling : current.nextElementSibling;
      }
      return output;
    }

    function visualArea(element: Element): number {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function localEngagementWrapper(element: Element, row: Element): Element | null {
      let current = element.parentElement;
      const rowArea = Math.max(1, visualArea(row));
      while (current && current !== row) {
        const countLeaves = engagementCountLeaves(current);
        if (countLeaves.length > 1) return null;
        if (countLeaves.length === 1 && countLeaves[0] === element) {
          const areaRatio = visualArea(current) / rowArea;
          if (areaRatio <= 0.25 || current.children.length <= 5 || /comment|reply|discuss|like|heart|collect|favorite|fav|star|share|forward|repost|retweet|interact|action|metric|count/i.test(elementIdentity(current))) return current;
        }
        current = current.parentElement;
      }
      return null;
    }

    function engagementSemanticText(element: Element, row: Element): string {
      const parent = element.parentElement;
      const wrapper = localEngagementWrapper(element, row);
      const localElements = [
        ...nearestSiblings(element, 'previous'),
        ...nearestSiblings(element, 'next', 1),
        ...(wrapper ? [wrapper] : []),
        ...(parent && engagementCountLeaves(parent).length <= 1 ? [parent] : [])
      ].filter((item): item is Element => Boolean(item && item !== row));
      const attr = (target: Element | null | undefined): string => {
        if (!target) return '';
        const item = target as HTMLElement;
        return [
          target.localName,
          item.id || '',
          typeof item.className === 'string' ? item.className : '',
          item.getAttribute('role') || '',
          item.getAttribute('aria-label') || '',
          item.getAttribute('title') || '',
          item.getAttribute('alt') || '',
          item.getAttribute('href') || '',
          item.getAttribute('xlink:href') || '',
          item.getAttribute('data-testid') || '',
          item.getAttribute('data-test') || '',
          item.getAttribute('data-qa') || '',
          item.getAttribute('data-role') || '',
          item.getAttribute('use') || '',
          target.textContent || ''
        ].join(' ');
      };
      return [
        attr(element),
        wrapper ? attr(wrapper) : '',
        parent && engagementCountLeaves(parent).length <= 1 ? attr(parent) : '',
        ...localElements.map(attr),
        ...localElements.flatMap((item) => Array.from(item.querySelectorAll('svg,use,i,span[class],em[class]')).map(attr))
      ].join(' ');
    }

    function engagementKind(element: Element, row: Element): EngagementKind {
      const value = `${engagementSemanticText(element, row)} ${engagementCountValue(element)}`.toLowerCase();
      if (/(comment|comments|reply|replies|discuss|discussion|bubble|message|chat|评论|评|留言|回复)/i.test(value)) return 'comments';
      if (/(share|shares|forward|repost|retweet|transmit|arrow|send|转发|分享|转|转推|↗|↪|➜|➤|⤴|⤵)/i.test(value)) return 'shares';
      if (/(collect|collection|favorite|favourite|favorites|favourites|fav|star|bookmark|save|saves|收藏|星标|书签|☆|★)/i.test(value)) return 'favorites';
      if (/(like|likes|heart|thumb|vote|upvote|赞|喜欢|点赞|♥|❤|♡|👍)/i.test(value)) return 'likes';
      return 'metric';
    }

    function findEngagementElement(row: Element, fieldName: string): Element | null {
      const wanted = fieldName === 'comments' || fieldName === 'favorites' || fieldName === 'shares' || fieldName === 'likes' ? fieldName : '';
      const candidates = Array.from(row.querySelectorAll('[class*="comment" i],[class*="reply" i],[class*="discuss" i],[class*="like" i],[class*="heart" i],[class*="collect" i],[class*="favorite" i],[class*="count" i],[class*="interact" i],[class*="engage" i],[class*="share" i],[class*="forward" i],[class*="repost" i],span,em,i,b,strong,div'))
        .filter(visible)
        .map((element) => {
          const value = engagementCountValue(element);
          const rect = element.getBoundingClientRect();
          const kind = engagementKind(element, row);
          const descendantCountLeaves = engagementCountLeaves(element).filter((child) => child !== element);
          const directCount = isEngagementCount(ownText(element));
          return { element, value, rect, kind, directCount, descendantCountLeaves };
        })
        .filter((item) => item.value && (item.directCount || item.descendantCountLeaves.length === 0))
        .filter((item) => !wanted || item.kind === wanted || item.kind === 'metric')
        .sort((a, b) => {
          const aExact = wanted && a.kind === wanted ? 1 : 0;
          const bExact = wanted && b.kind === wanted ? 1 : 0;
          if (aExact !== bExact) return bExact - aExact;
          return a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.value.length - b.value.length || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
      return candidates[0]?.element || null;
    }

    function findAuthorElement(row: Element): Element | null {
      const rowRect = row.getBoundingClientRect();
      const candidates = Array.from(row.querySelectorAll('[class*="author" i],[class*="byline" i],[class*="user" i],[class*="nick" i],[class*="name" i],[class*="creator" i],[class*="owner" i],[class*="profile" i],[class*="avatar" i],[rel="author"],[itemprop*="author" i],a,span,p,div'))
        .filter(visible)
        .map((element) => {
          const value = textFieldValue(element);
          const rect = element.getBoundingClientRect();
          const identity = elementIdentity(element);
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar/i.test(identity);
          const nearBottom = rect.top > rowRect.top + rowRect.height * 0.35;
          const hasProfileLink = Boolean(element.closest('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]') || element.querySelector('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]'));
          return { element, value, rect, semantic, nearBottom, hasProfileLink };
        })
        .filter((item) => item.value.length >= 2 && item.value.length <= 60 && !isEngagementCount(item.value) && !dateMatch(item.value))
        .sort((a, b) => {
          const aScore = (a.semantic ? 1 : 0) + (a.hasProfileLink ? 0.45 : 0) + (a.nearBottom ? 0.25 : 0) - Math.max(0, a.value.length - 24) / 100;
          const bScore = (b.semantic ? 1 : 0) + (b.hasProfileLink ? 0.45 : 0) + (b.nearBottom ? 0.25 : 0) - Math.max(0, b.value.length - 24) / 100;
          return bScore - aScore || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        });
      return candidates[0]?.element || null;
    }

    function findDateElement(row: Element): Element | null {
      return [row, ...Array.from(row.querySelectorAll('time,[datetime],[class*="date" i],[class*="time" i],span,p,div,em,i,b,strong'))]
        .filter(visible)
        .map((element) => ({ element, value: elementText(element), rect: element.getBoundingClientRect() }))
        .filter((item) => item.value.length > 0 && item.value.length <= 90 && Boolean(dateMatch(item.value)))
        .sort((a, b) => {
          const aSemantic = /time|date/i.test(`${a.element.id} ${(a.element as HTMLElement).className} ${(a.element as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
          const bSemantic = /time|date/i.test(`${b.element.id} ${(b.element as HTMLElement).className} ${(b.element as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
          if (aSemantic !== bSemantic) return aSemantic - bSemantic;
          return a.value.length - b.value.length || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
        })[0]?.element || null;
    }

    function normalizedFieldName(name: string): string {
      return name.toLowerCase().replace(/\s+/g, '');
    }

    function relativeXPathForRow(xpath: string): string {
      if (!xpath) return '';
      if (xpath === '.') return '.';
      if (xpath.startsWith('./') || xpath.startsWith('.//')) return xpath;
      if (xpath.startsWith('/descendant-or-self::')) return xpath.slice(1);
      if (xpath.startsWith('//')) return `.//${xpath.slice(2)}`;
      if (xpath.startsWith('/')) return `.${xpath}`;
      return xpath;
    }

    function fallbackFieldElement(row: Element, field: { name: string; kind: string }): Element | null {
      const name = normalizedFieldName(field.name);
      if (name === 'image' || name === '图片' || field.kind === 'src') {
        return Array.from(row.querySelectorAll('img'))
          .filter(visible)
          .sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            const aArea = aRect.width * aRect.height;
            const bArea = bRect.width * bRect.height;
            return bArea - aArea;
          })[0] || null;
      }
      if (name === 'date' || name === '日期' || name === '时间') return findDateElement(row);
      if (/^(comments|favorites|shares|likes|metric_\d+|like_count|engagement)$/.test(field.name)) return findEngagementElement(row, field.name);
      if (name === 'author' || name === 'user' || name === 'nickname' || name === '作者' || name === '用户' || name === '昵称') return findAuthorElement(row);
      if (name === 'url' || name === 'link' || name.includes('链接') || field.kind === 'href') {
        return Array.from(row.querySelectorAll('a')).filter(visible).find((element) => (element as HTMLAnchorElement).href) || null;
      }
      if (name === 'title' || name === '标题' || name.includes('标题')) {
        return Array.from(row.querySelectorAll('h1,h2,h3,h4,a,[class*="title" i],p,span,div'))
          .filter(visible)
          .map((element) => ({ element, value: elementText(element), rect: element.getBoundingClientRect() }))
          .filter((item) => item.value.length >= 2 && item.value.length <= 220 && !dateMatch(item.value))
          .sort((a, b) => {
            const tagWeight = (element: Element) => /^(h1|h2|h3|h4|a)$/i.test(element.tagName) ? 0 : 1;
            if (tagWeight(a.element) !== tagWeight(b.element)) return tagWeight(a.element) - tagWeight(b.element);
            return b.rect.width - a.rect.width;
          })[0]?.element || null;
      }
      if (name === 'summary' || name === '摘要' || name.includes('摘要') || name === '简介' || name === '描述') {
        return Array.from(row.querySelectorAll('p,span,div'))
          .filter(visible)
          .map((element) => ({ element, value: textFieldValue(element), rect: element.getBoundingClientRect() }))
          .filter((item) => {
            if (hasVisibleImage(item.element)) return false;
            return item.value.length > 20 && item.value.length < 300 && !isEngagementCount(item.value);
          })
          .sort((a, b) => {
            const aOwn = ownText(a.element) ? 0 : 1;
            const bOwn = ownText(b.element) ? 0 : 1;
            if (aOwn !== bOwn) return aOwn - bOwn;
            return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
          })[0]?.element || null;
      }
      return null;
    }

    function fieldElement(row: Element, field: { name: string; kind: string; xpath: string; relativeXPath: string }): Element | null {
      let element: Element | null = null;
      if (field.relativeXPath) {
        try {
          const result = document.evaluate(relativeXPathForRow(field.relativeXPath), row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (result.singleNodeValue instanceof Element) element = result.singleNodeValue;
        } catch {
          element = null;
        }
      }
      if (!element && field.xpath) {
        element = evaluateXPath(field.xpath).find(visible) || null;
      }
      if (!element || element === row || !row.contains(element) || !visible(element)) {
        element = fallbackFieldElement(row, field);
      }
      if (!element || element === row || !row.contains(element) || !visible(element)) return null;
      return element;
    }

    function drawFieldBox(element: Element, labelText: string, color: string): void {
      const html = element as HTMLElement;
      if (!html.dataset.octopusDetectionFieldOutline) {
        html.dataset.octopusDetectionFieldOutline = html.style.outline;
        html.dataset.octopusDetectionFieldOutlineOffset = html.style.outlineOffset;
        html.dataset.octopusDetectionFieldBackground = html.style.backgroundColor;
      }
      html.style.outline = `2px solid ${color}`;
      html.style.outlineOffset = '-1px';
      html.style.backgroundColor = `${color}12`;
      fieldHighlighted.push(html);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 18)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 11px/1.1 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '2px 5px';
      label.style.borderRadius = '3px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 1px 6px rgba(0,0,0,.18)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function drawPaginationPreview(element: Element, labelText: string): void {
      const html = element as HTMLElement;
      const originalOutline = html.style.outline;
      const originalOutlineOffset = html.style.outlineOffset;
      const originalBackground = html.style.backgroundColor;
      const originalBoxShadow = html.style.boxShadow;
      html.dataset.octopusDetectionOutline = originalOutline;
      html.dataset.octopusDetectionOutlineOffset = originalOutlineOffset;
      html.dataset.octopusDetectionBackground = originalBackground;
      html.dataset.octopusDetectionBoxShadow = originalBoxShadow;
      html.style.outline = '3px solid #f97316';
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = 'rgba(249,115,22,.14)';
      html.style.boxShadow = '0 0 0 1px rgba(249,115,22,.35)';
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      paginationPreviewElements.push(html);
      previewByElement.add(element);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 24)}px`;
      label.style.background = '#f97316';
      label.style.color = '#fff';
      label.style.font = '700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '4px 7px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,.2)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        label.style.display = offscreen ? 'none' : '';
        label.style.left = `${Math.max(0, Math.min(window.innerWidth - 40, rect.left))}px`;
        label.style.top = `${Math.max(0, Math.min(window.innerHeight - 20, rect.top - 22))}px`;
      });
    }

    function syncSelectionStyles(): void {
      highlighted.forEach((element) => {
        const candidateId = byElement.get(element);
        const selected = candidateId ? selectedIds.has(candidateId) : false;
        const color = element.dataset.octopusDetectionColor || '#2563eb';
        const emphasis = element.dataset.octopusDetectionEmphasis === 'secondary' ? 'secondary' : 'primary';
        element.style.outline = `${selected ? 5 : emphasis === 'primary' ? 3 : 2}px ${selected || emphasis === 'primary' ? 'solid' : 'dashed'} ${color}`;
        element.style.outlineOffset = '-2px';
        element.style.backgroundColor = selected ? `${color}33` : emphasis === 'primary' ? `${color}16` : `${color}08`;
        element.style.boxShadow = selected ? `0 0 0 2px ${color}55` : '';
        element.style.opacity = '';
      });
      labels.forEach((label) => {
        const related = labelEntries.find((entry) => entry.label === label);
        const candidateId = related ? byElement.get(related.element) : undefined;
        const selected = candidateId ? selectedIds.has(candidateId) : false;
        label.style.transform = selected ? 'scale(1.08)' : '';
        label.style.filter = selected ? 'saturate(1.35)' : '';
      });
      w.__octopusDetectionSelection = Array.from(selectedIds)[0];
      w.__octopusDetectionSelections = Array.from(selectedIds);
    }

    const prepared = items
      .map((candidate) => {
        const elements = evaluateXPath(candidate.itemXPath || candidate.xpath)
          .filter(visible)
          .slice(0, 80);
        if (!elements.length) return null;
        const rects = elements.map((element) => element.getBoundingClientRect());
        const top = Math.min(...rects.map((rect) => rect.top));
        const height = Math.max(...rects.map((rect) => rect.bottom)) - top;
        const width = Math.max(...rects.map((rect) => rect.right)) - Math.min(...rects.map((rect) => rect.left));
        const sampleText = elements.slice(0, 8).map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const shortTextRate = sampleText.filter((value) => value.length <= 8).length / Math.max(1, sampleText.length);
        const navPenalty = candidate.navigationLike || (top < 180 && height < 160 && shortTextRate > 0.75) ? 1 : 0;
        const primaryLike = candidate.layoutRole === 'main' || candidate.mainScore >= 0.62 || (candidate.layoutScore >= 0.52 && candidate.sidebarPenalty < 0.35);
        return { candidate, elements, top, area: Math.max(1, width * height), navPenalty, primaryLike };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const primarySource = prepared.filter((item) => item.primaryLike && item.navPenalty === 0);
    const secondarySource = prepared.filter((item) => !primarySource.includes(item));
    const orderedPrimary = (primarySource.length ? primarySource : prepared.filter((item) => item.navPenalty === 0))
      .sort((a, b) => {
        if (a.navPenalty !== b.navPenalty) return a.navPenalty - b.navPenalty;
        if (Math.abs(b.candidate.mainScore - a.candidate.mainScore) > 0.08) return b.candidate.mainScore - a.candidate.mainScore;
        if (Math.abs(a.top - b.top) > 80) return a.top - b.top;
        return b.area - a.area;
      })
      .slice(0, 10);
    const orderedSecondary = secondarySource
      .sort((a, b) => {
        if (a.navPenalty !== b.navPenalty) return a.navPenalty - b.navPenalty;
        return b.candidate.layoutScore - a.candidate.layoutScore || b.area - a.area;
      })
      .slice(0, 6);
    const drawable = [
      ...orderedPrimary.map((item) => ({ ...item, emphasis: 'primary' as const })),
      ...orderedSecondary.map((item) => ({ ...item, emphasis: 'secondary' as const }))
    ];

    let visibleGroupIndex = 0;
    drawable.forEach(({ candidate, elements, emphasis }, candidateIndex) => {
      const color = palette[candidateIndex % palette.length];
      visibleGroupIndex += 1;
      const label = `G${visibleGroupIndex}`;
      elements.slice(0, emphasis === 'primary' ? 80 : 24).forEach((element) => drawBox(element, candidate.id, label, color, emphasis));
      if (emphasis === 'secondary') return;
      const fieldColor = '#0f766e';
      elements.forEach((element) => {
        const groupedFields = new Map<Element, string[]>();
        candidate.fields.slice(0, 8).forEach((field) => {
          const fieldTarget = fieldElement(element, field);
          if (!fieldTarget) return;
          groupedFields.set(fieldTarget, [...(groupedFields.get(fieldTarget) ?? []), field.name]);
        });
        groupedFields.forEach((names, fieldTarget) => {
          drawFieldBox(fieldTarget, Array.from(new Set(names)).join('+'), fieldColor);
        });
      });
    });
    paginationItems.forEach((item, index) => {
      if (!item.xpath) return;
      const element = evaluateXPath(item.xpath).find(visible);
      if (!element) return;
      drawPaginationPreview(element, item.type === 'load_more' ? `MORE ${index + 1}` : `PAGE ${index + 1}`);
    });
    positionLabels();

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const previewTarget = path.find((item): item is Element => item instanceof Element && previewByElement.has(item));
      if (previewTarget) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }
      const target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const selectedId = byElement.get(target);
      if (!selectedId) return;
      if (selectedIds.has(selectedId)) selectedIds.delete(selectedId);
      else selectedIds.add(selectedId);
      syncSelectionStyles();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusDetectionClearSelection = () => {
      selectedIds.clear();
      syncSelectionStyles();
    };
    w.__octopusDetectionCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetectionOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetectionOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetectionBackground || '';
        element.style.boxShadow = element.dataset.octopusDetectionBoxShadow || '';
        element.style.cursor = '';
        element.style.opacity = '';
        delete element.dataset.octopusDetectionOutline;
        delete element.dataset.octopusDetectionOutlineOffset;
        delete element.dataset.octopusDetectionBackground;
        delete element.dataset.octopusDetectionBoxShadow;
        delete element.dataset.octopusDetectionColor;
        delete element.dataset.octopusDetectionEmphasis;
      });
      fieldHighlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetectionFieldOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetectionFieldOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetectionFieldBackground || '';
        delete element.dataset.octopusDetectionFieldOutline;
        delete element.dataset.octopusDetectionFieldOutlineOffset;
        delete element.dataset.octopusDetectionFieldBackground;
      });
      root.remove();
      delete w.__octopusDetectionClearSelection;
      delete w.__octopusDetectionCleanup;
      delete w.__octopusDetectionSelections;
    };
  }, { items: overlayCandidates, paginationItems: overlayPaginations });
}

async function installPaginationOverlay(page: Page, paginations: DetectedPagination[]): Promise<void> {
  const overlayPaginations = paginations.map((pagination) => ({
    key: paginationKey(pagination),
    type: pagination.type,
    xpath: pagination.xpath,
    text: pagination.text,
    confidence: pagination.confidence
  }));
  await page.evaluate((items) => {
    const w = window as typeof window & {
      __octopusPaginationSelection?: string;
      __octopusPaginationClearSelection?: () => void;
      __octopusPaginationCleanup?: () => void;
    };
    w.__octopusPaginationCleanup?.();
    document.getElementById('octopus-pagination-overlay-root')?.remove();
    w.__octopusPaginationSelection = undefined;

    const root = document.createElement('div');
    root.id = 'octopus-pagination-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'visible';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483600';
    document.documentElement.appendChild(root);

    const highlighted: HTMLElement[] = [];
    const labelEntries: Array<{ element: Element; label: HTMLElement; key: string }> = [];
    const byElement = new WeakMap<Element, string>();
    let selectedKey = items[0]?.key || '';

    function evaluateXPath(xpath: string): Element[] {
      if (!xpath) return [];
      try {
        const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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

    function labelFor(type: string): string {
      if (type === 'next_page') return 'PAGE';
      if (type === 'load_more') return 'MORE';
      if (type === 'scroll') return 'SCROLL';
      return 'PAGE';
    }

    function syncStyles(): void {
      highlighted.forEach((element) => {
        const key = byElement.get(element);
        const selected = key === selectedKey;
        element.style.outline = `${selected ? 5 : 3}px solid #f97316`;
        element.style.outlineOffset = '-2px';
        element.style.backgroundColor = selected ? 'rgba(249,115,22,.28)' : 'rgba(249,115,22,.14)';
        element.style.boxShadow = selected ? '0 0 0 2px rgba(249,115,22,.45)' : '';
      });
      labelEntries.forEach(({ label, key }) => {
        const selected = key === selectedKey;
        label.style.transform = selected ? 'scale(1.08)' : '';
        label.style.filter = selected ? 'saturate(1.35)' : '';
      });
      w.__octopusPaginationSelection = selectedKey || undefined;
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        label.style.display = offscreen ? 'none' : '';
        label.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, rect.left))}px`;
        label.style.top = `${Math.max(0, Math.min(window.innerHeight - 22, rect.top - 24))}px`;
      });
    }

    function drawBox(element: Element, key: string, labelText: string): void {
      const html = element as HTMLElement;
      html.dataset.octopusPaginationOutline = html.style.outline;
      html.dataset.octopusPaginationOutlineOffset = html.style.outlineOffset;
      html.dataset.octopusPaginationBackground = html.style.backgroundColor;
      html.dataset.octopusPaginationBoxShadow = html.style.boxShadow;
      html.style.cursor = 'crosshair';
      highlighted.push(html);
      byElement.set(element, key);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = labelText;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 24)}px`;
      label.style.background = '#f97316';
      label.style.color = '#fff';
      label.style.font = '700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '4px 7px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,.2)';
      root.appendChild(label);
      labelEntries.push({ element, label, key });
    }

    items.forEach((item, index) => {
      if (item.type === 'scroll') {
        const scrollTarget = document.scrollingElement || document.documentElement;
        drawBox(scrollTarget, item.key, `${labelFor(item.type)} ${index + 1}`);
        return;
      }
      const element = evaluateXPath(item.xpath).find(visible);
      if (!element) return;
      drawBox(element, item.key, `${labelFor(item.type)} ${index + 1}`);
    });
    syncStyles();
    positionLabels();

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const key = byElement.get(target);
      if (!key) return;
      selectedKey = key;
      syncStyles();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusPaginationClearSelection = () => {
      selectedKey = '';
      syncStyles();
    };
    w.__octopusPaginationCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusPaginationOutline || '';
        element.style.outlineOffset = element.dataset.octopusPaginationOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusPaginationBackground || '';
        element.style.boxShadow = element.dataset.octopusPaginationBoxShadow || '';
        element.style.cursor = '';
        delete element.dataset.octopusPaginationOutline;
        delete element.dataset.octopusPaginationOutlineOffset;
        delete element.dataset.octopusPaginationBackground;
        delete element.dataset.octopusPaginationBoxShadow;
      });
      root.remove();
      delete w.__octopusPaginationSelection;
      delete w.__octopusPaginationClearSelection;
      delete w.__octopusPaginationCleanup;
    };
  }, overlayPaginations);
}

async function readOverlaySelection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusDetectionSelections?: string[]; __octopusDetectionSelection?: string };
    if (Array.isArray(w.__octopusDetectionSelections)) return w.__octopusDetectionSelections;
    return w.__octopusDetectionSelection ? [w.__octopusDetectionSelection] : [];
  });
}

async function installDetailFieldOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    type SelectedField = {
      id: string;
      suggestedName: string;
      kind: 'text' | 'href' | 'src';
      xpath: string;
      selector: string;
      sample: string;
      diagnostics?: {
        matchCount: number;
        textLength: number;
        paragraphCount: number;
        hasStyleNoise: boolean;
        warnings: string[];
      };
    };
    const w = window as typeof window & {
      __octopusDetailFieldSelections?: string[];
      __octopusDetailFieldObjects?: SelectedField[];
      __octopusDetailFieldClearSelection?: () => void;
      __octopusDetailFieldCleanup?: () => void;
    };
    w.__octopusDetailFieldCleanup?.();
    document.getElementById('octopus-detail-field-overlay-root')?.remove();
    w.__octopusDetailFieldSelections = [];
    w.__octopusDetailFieldObjects = [];

    const root = document.createElement('div');
    root.id = 'octopus-detail-field-overlay-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.overflow = 'visible';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '2147483600';
    document.documentElement.appendChild(root);

    const highlighted: HTMLElement[] = [];
    const labels: HTMLElement[] = [];
    const labelEntries: Array<{ element: Element; label: HTMLElement }> = [];
    const byElement = new WeakMap<Element, SelectedField>();
    const selected = new Map<string, SelectedField>();
    const palette: Record<string, string> = {
      title: '#2563eb',
      time: '#7c3aed',
      author: '#0f766e',
      content: '#dc2626',
      image: '#d97706',
      link: '#0891b2',
      field: '#4b5563'
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
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
      const style = window.getComputedStyle(element);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function elementIdentity(element: Element | null): string {
      if (!element) return '';
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('rel') || '',
        element.getAttribute('itemprop') || '',
        element.getAttribute('data-testid') || '',
        element.getAttribute('data-test') || '',
        element.getAttribute('data-qa') || ''
      ].join(' ');
    }

    function nearestIdentity(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      let depth = 0;
      while (current && depth < 4) {
        parts.push(elementIdentity(current));
        current = current.parentElement;
        depth += 1;
      }
      return parts.join(' ');
    }

    function boilerplateLike(element: Element): boolean {
      const tag = element.tagName.toLowerCase();
      if (/^(script|style|noscript|svg|button|input|select|textarea|nav|footer|header|aside)$/i.test(tag)) return true;
      const identity = nearestIdentity(element);
      if (/(^|\b)(ad|ads|advert|advertise|banner|sponsor|推广|广告)(\b|$)/i.test(identity)) return true;
      if (/(sidebar|side-bar|rightbar|recommend|related|hot|rank|popular|精选|推荐|热门|排行|应用|下载|客户端)/i.test(identity)) return true;
      if (/(toolbar|tool-bar|share|forward|comment|reply|collect|favorite|like|interaction|operate|action|qrcode|qr-code|登录|关注)/i.test(identity)) return true;
      const style = window.getComputedStyle(element);
      if (style.position === 'fixed' || style.position === 'sticky') return true;
      return false;
    }

    function contentScore(element: Element): number {
      if (!visible(element) || boilerplateLike(element)) return -Infinity;
      const rect = element.getBoundingClientRect();
      const value = text(element);
      if (styleTextLike(value)) return -Infinity;
      if (value.length < 80) return -Infinity;
      const paragraphCount = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20).length;
      const titleCount = element.querySelectorAll('h1,h2,[class*="title" i],[class*="headline" i]').length;
      const linkText = Array.from(element.querySelectorAll('a')).map((item) => text(item)).join(' ');
      const linkDensity = linkText.length / Math.max(1, value.length);
      const centerX = rect.left + rect.width / 2;
      const centerDistance = Math.abs(centerX - window.innerWidth / 2) / Math.max(1, window.innerWidth);
      const widthRatio = rect.width / Math.max(1, window.innerWidth);
      let score = 0;
      score += Math.min(3, value.length / 700);
      score += Math.min(2, paragraphCount * 0.55);
      score += Math.min(1.2, titleCount * 0.45);
      score += Math.max(0, 1 - centerDistance * 2);
      if (widthRatio >= 0.32 && widthRatio <= 0.78) score += 0.8;
      if (rect.left < 80 || rect.right > window.innerWidth - 40) score -= 1.2;
      if (linkDensity > 0.45) score -= 1.4;
      if (paragraphCount === 0) score -= 0.8;
      return score;
    }

    function mainContentRoot(): Element {
      const explicit = Array.from(document.querySelectorAll([
        'article',
        '[role="main"]',
        'main',
        '[class*="article" i]',
        '[class*="content" i]',
        '[class*="detail" i]',
        '[class*="main" i]',
        '[id*="article" i]',
        '[id*="content" i]',
        '[id*="detail" i]'
      ].join(',')));
      const textBlocks = Array.from(document.querySelectorAll('section,div'))
        .filter((element) => text(element).length >= 240 && element.querySelectorAll('p').length >= 1);
      const candidates = [...explicit, ...textBlocks]
        .filter((element, index, array) => array.indexOf(element) === index)
        .filter(visible)
        .map((element) => ({ element, score: contentScore(element) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.element || document.querySelector('article') || document.querySelector('main') || document.body;
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const tag = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        const currentTag = current.tagName;
        const siblings: Element[] = parent ? Array.from(parent.children).filter((item): item is Element => item instanceof Element && item.tagName === currentTag) : [];
        parts.unshift(`${tag}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return `/${parts.join('/')}`;
    }

    function selector(element: Element): string {
      const html = element as HTMLElement;
      if (html.id) return `#${CSS.escape(html.id)}`;
      const cls = typeof html.className === 'string'
        ? html.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => `.${CSS.escape(part)}`).join('')
        : '';
      return `${element.tagName.toLowerCase()}${cls}`;
    }

    function fieldKind(element: Element): 'text' | 'href' | 'src' {
      if (element instanceof HTMLImageElement) return 'src';
      if (element instanceof HTMLAnchorElement) return 'href';
      return 'text';
    }

    function sampleValue(element: Element, kind: 'text' | 'href' | 'src'): string {
      if (kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      if (kind === 'href') return (element as HTMLAnchorElement).href || '';
      return text(element);
    }

    const articleRoot = mainContentRoot();

    function suggestedName(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const identity = [
        tag,
        (element as HTMLElement).id || '',
        typeof (element as HTMLElement).className === 'string' ? (element as HTMLElement).className : '',
        element.getAttribute('rel') || '',
        element.getAttribute('itemprop') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ');
      const value = text(element);
      if (element instanceof HTMLImageElement) return 'image';
      if (/^(h1|h2|h3)$/i.test(tag) || /title|headline/i.test(identity)) return 'title';
      if (value.length > 80 || element.querySelectorAll('p').length >= 2) return 'content';
      if ((/time|date|publish|pubtime|datetime|时间|日期/i.test(identity) || /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(value)) && value.length <= 90) return 'time';
      if (/author|byline|writer|source|media|account|name|user|nick|作者|来源|账号|媒体/i.test(identity) && value.length <= 80) return 'author';
      if (element instanceof HTMLAnchorElement) return 'link';
      if (/article|content|body|main|detail|正文|内容/i.test(identity) || tag === 'article') return 'content';
      return 'field';
    }

    function selectedXPath(element: Element, name: string): string {
      return xpath(element);
    }

    function inMainArticle(element: Element): boolean {
      if (!articleRoot.contains(element) && element !== articleRoot) return false;
      if (boilerplateLike(element)) return false;
      const rect = element.getBoundingClientRect();
      const rootRect = articleRoot.getBoundingClientRect();
      if (rect.right < rootRect.left - 2 || rect.left > rootRect.right + 2) return false;
      if (rect.width < 32 && rect.height > 120) return false;
      return true;
    }

    function makeField(element: Element): SelectedField {
      const initialName = suggestedName(element);
      const normalizedElement = initialName === 'content' ? normalizeContentSelection(element) : element;
      const name = initialName === 'content' ? 'content' : suggestedName(normalizedElement);
      const kind = initialName === 'content' ? 'text' : fieldKind(normalizedElement);
      const itemXpath = selectedXPath(normalizedElement, name);
      return {
        id: itemXpath,
        suggestedName: name,
        kind,
        xpath: itemXpath,
        selector: selector(normalizedElement),
        sample: sampleValue(normalizedElement, kind),
        ...(name === 'content' ? { diagnostics: fieldDiagnostics(normalizedElement) } : {})
      };
    }

    function firstBest(elements: Element[], accept: (element: Element) => boolean, compare?: (a: Element, b: Element) => number): Element | undefined {
      const items = elements.filter(visible).filter(inMainArticle).filter(accept);
      if (compare) items.sort(compare);
      return items[0];
    }

    function metadataBottomFor(scoped: Element[]): number {
      const title = firstBest(scoped, (element) => {
        const value = text(element);
        return suggestedName(element) === 'title' && value.length >= 4 && value.length <= 160;
      });
      const time = firstBest(scoped, (element) => suggestedName(element) === 'time' && text(element).length <= 80);
      const author = firstBest(scoped, (element) => suggestedName(element) === 'author' && text(element).length <= 80);
      return Math.max(
        title?.getBoundingClientRect().bottom ?? 0,
        time?.getBoundingClientRect().bottom ?? 0,
        author?.getBoundingClientRect().bottom ?? 0
      );
    }

    function contentCandidateScore(element: Element, metadataBottom = 0): number {
      const tag = element.tagName.toLowerCase();
      if (/^(h1|h2|h3|time|img|a|span|em|i|strong|b|button)$/i.test(tag)) return -Infinity;
      const value = text(element);
      if (value.length < 80 || value.length > 12000) return -Infinity;
      const rect = element.getBoundingClientRect();
      if (metadataBottom && rect.top < metadataBottom - 24) return -Infinity;
      const own = ownText(element);
      const paragraphs = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20);
      const textChildren = Array.from(element.children).filter((item) => {
        const childTag = item.tagName.toLowerCase();
        return !/^(script|style|noscript|img|svg|button)$/i.test(childTag) && text(item).length >= 20;
      });
      const linkText = Array.from(element.querySelectorAll('a')).map((item) => text(item)).join(' ');
      const linkDensity = linkText.length / Math.max(1, value.length);
      if (linkDensity > 0.35) return -Infinity;
      const sentenceMarks = (value.match(/[。！？!?；;，,]/g) ?? []).length;
      const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / Math.max(1, window.innerWidth);
      let score = 0;
      score += Math.min(4, value.length / 350);
      score += Math.min(3, paragraphs.length * 0.9);
      score += Math.min(2, textChildren.length * 0.35);
      score += Math.min(2, sentenceMarks * 0.18);
      if (own.length >= 80) score += 1.1;
      if (rect.width >= articleRoot.getBoundingClientRect().width * 0.45) score += 0.6;
      score -= centerPenalty;
      score -= Math.max(0, element.querySelectorAll('img').length - 1) * 0.3;
      if (element === articleRoot) score -= 1.5;
      return score;
    }

    function candidateElements(): Element[] {
      const scoped = [articleRoot, ...Array.from(articleRoot.querySelectorAll('*'))].filter((element): element is Element => element instanceof Element);
      const title = firstBest(scoped, (element) => {
        const value = text(element);
        return suggestedName(element) === 'title' && value.length >= 4 && value.length <= 160;
      }, (a, b) => {
        const tagWeight = (element: Element) => /^(h1|h2)$/i.test(element.tagName) ? 0 : 1;
        return tagWeight(a) - tagWeight(b) || a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      });
      const time = firstBest(scoped, (element) => suggestedName(element) === 'time' && text(element).length <= 80);
      const author = firstBest(scoped, (element) => {
        const value = text(element);
        return suggestedName(element) === 'author' && value.length >= 2 && value.length <= 80;
      });
      const metadataBottom = metadataBottomFor(scoped);
      const contentContainers = scoped
        .filter(visible)
        .filter(inMainArticle)
        .map((element) => ({ element, score: contentCandidateScore(element, metadataBottom) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => {
          const aRect = a.element.getBoundingClientRect();
          const bRect = b.element.getBoundingClientRect();
          return b.score - a.score || aRect.top - bRect.top;
        });
      const content = contentContainers[0]?.element ? expandContentContainer(contentContainers[0].element, metadataBottom) : undefined;
      const images = Array.from(articleRoot.querySelectorAll('img'))
        .filter(visible)
        .filter(inMainArticle)
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const source = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
          return Boolean(source) && rect.width >= 80 && rect.height >= 60;
        })
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        })
        .slice(0, 3);
      return [title, time, author, content, ...images]
        .filter((element): element is Element => Boolean(element))
        .filter((element, index, array) => array.indexOf(element) === index);
    }

    function expandContentContainer(element: Element, metadataBottom: number): Element {
      let current = element;
      while (current.parentElement && current.parentElement !== articleRoot && articleRoot.contains(current.parentElement)) {
        const parent = current.parentElement;
        if (!visible(parent) || boilerplateLike(parent)) break;
        const currentText = text(current);
        const parentText = text(parent);
        if (styleTextLike(parentText)) break;
        if (parentText.length < Math.max(120, currentText.length * 1.08)) break;
        if (parentText.length > 20000) break;
        const parentRect = parent.getBoundingClientRect();
        const currentRect = current.getBoundingClientRect();
        if (metadataBottom && parentRect.top < metadataBottom - 32) break;
        const linkText = Array.from(parent.querySelectorAll('a')).map((item) => text(item)).join(' ');
        if (linkText.length / Math.max(1, parentText.length) > 0.35) break;
        if (parent.querySelector('h1,h2,h3')) break;
        if (parentRect.width < currentRect.width * 0.85) break;
        current = parent;
      }
      return current;
    }

    function styleTextLike(value: string): boolean {
      if (!value) return false;
      const cssTokenCount = (value.match(/--weui-|data_color_scheme|rgba?\(|#[0-9a-f]{3,8}\b|ACTIVE-|BG-|FG-/gi) ?? []).length;
      return cssTokenCount >= 8 || /--weui-[\s\S]{80,}/i.test(value) || /\.data_color_scheme_dark\{/i.test(value);
    }

    function articleMetadataBottom(): number {
      const scoped = [articleRoot, ...Array.from(articleRoot.querySelectorAll('*'))].filter((element): element is Element => element instanceof Element);
      return metadataBottomFor(scoped);
    }

    function normalizeContentSelection(element: Element): Element {
      const metadataBottom = articleMetadataBottom();
      const candidates: Element[] = [];
      let current: Element | null = element;
      while (current && articleRoot.contains(current)) {
        candidates.push(current);
        if (current === articleRoot) break;
        current = current.parentElement;
      }
      const ranked = candidates
        .filter(visible)
        .filter(inMainArticle)
        .map((candidate) => ({ element: candidate, score: contentCandidateScore(candidate, metadataBottom) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => {
          const aParagraphs = a.element.querySelectorAll('p').length;
          const bParagraphs = b.element.querySelectorAll('p').length;
          return b.score - a.score || bParagraphs - aParagraphs;
        });
      return ranked[0]?.element ? expandContentContainer(ranked[0].element, metadataBottom) : element;
    }

    function fieldDiagnostics(element: Element): SelectedField['diagnostics'] {
      const value = text(element);
      const paragraphCount = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20).length;
      const warnings: string[] = [];
      if (value.length < 300) warnings.push('content text looks short');
      if (paragraphCount <= 1) warnings.push('content has too few paragraphs');
      if (styleTextLike(value)) warnings.push('text contains CSS/style noise');
      return {
        matchCount: 1,
        textLength: value.length,
        paragraphCount,
        hasStyleNoise: styleTextLike(value),
        warnings
      };
    }

    function draw(element: Element): void {
      const field = makeField(element);
      const html = element as HTMLElement;
      if (byElement.has(element)) return;
      byElement.set(element, field);
      html.dataset.octopusDetailOutline = html.style.outline;
      html.dataset.octopusDetailOutlineOffset = html.style.outlineOffset;
      html.dataset.octopusDetailBackground = html.style.backgroundColor;
      html.dataset.octopusDetailBoxShadow = html.style.boxShadow;
      const color = palette[field.suggestedName] || palette.field;
      html.dataset.octopusDetailColor = color;
      html.style.outline = `2px solid ${color}`;
      html.style.outlineOffset = '-2px';
      html.style.backgroundColor = `${color}12`;
      html.style.cursor = 'crosshair';
      highlighted.push(html);

      const rect = element.getBoundingClientRect();
      const label = document.createElement('div');
      label.textContent = field.suggestedName;
      label.style.position = 'fixed';
      label.style.left = `${Math.max(0, rect.left)}px`;
      label.style.top = `${Math.max(0, rect.top - 22)}px`;
      label.style.background = color;
      label.style.color = '#fff';
      label.style.font = '600 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
      label.style.padding = '3px 6px';
      label.style.borderRadius = '4px';
      label.style.pointerEvents = 'none';
      label.style.boxShadow = '0 2px 8px rgba(0,0,0,.18)';
      root.appendChild(label);
      labels.push(label);
      labelEntries.push({ element, label });
    }

    function positionLabels(): void {
      labelEntries.forEach(({ element, label }) => {
        const rect = element.getBoundingClientRect();
        const offscreen = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
        label.style.display = offscreen ? 'none' : '';
        label.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, rect.left))}px`;
        label.style.top = `${Math.max(0, Math.min(window.innerHeight - 20, rect.top - 22))}px`;
      });
    }

    function sync(): void {
      highlighted.forEach((element) => {
        const field = byElement.get(element);
        const isSelected = field ? selected.has(field.id) : false;
        const color = element.dataset.octopusDetailColor || palette.field;
        element.style.outline = `${isSelected ? 5 : 2}px solid ${color}`;
        element.style.backgroundColor = isSelected ? `${color}33` : `${color}12`;
        element.style.boxShadow = isSelected ? `0 0 0 2px ${color}55` : '';
      });
      w.__octopusDetailFieldSelections = Array.from(selected.values()).map((field) => `detail_${field.suggestedName}`);
      w.__octopusDetailFieldObjects = Array.from(selected.values());
    }

    candidateElements().forEach(draw);
    positionLabels();

    function handleClick(event: MouseEvent): void {
      const path = event.composedPath();
      if (path.some((item) => item instanceof HTMLElement && item.getAttribute('data-octopus-manual-overlay') === 'true')) return;
      const target = path.find((item): item is Element => item instanceof Element && byElement.has(item));
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const field = byElement.get(target);
      if (!field) return;
      if (selected.has(field.id)) selected.delete(field.id);
      else selected.set(field.id, field);
      sync();
    }

    const handleViewportChange = () => positionLabels();
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange, true);
    w.__octopusDetailFieldClearSelection = () => {
      selected.clear();
      sync();
    };
    w.__octopusDetailFieldCleanup = () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.removeEventListener('resize', handleViewportChange, true);
      highlighted.forEach((element) => {
        element.style.outline = element.dataset.octopusDetailOutline || '';
        element.style.outlineOffset = element.dataset.octopusDetailOutlineOffset || '';
        element.style.backgroundColor = element.dataset.octopusDetailBackground || '';
        element.style.boxShadow = element.dataset.octopusDetailBoxShadow || '';
        element.style.cursor = '';
        delete element.dataset.octopusDetailOutline;
        delete element.dataset.octopusDetailOutlineOffset;
        delete element.dataset.octopusDetailBackground;
        delete element.dataset.octopusDetailBoxShadow;
        delete element.dataset.octopusDetailColor;
      });
      labels.forEach((label) => label.remove());
      root.remove();
      w.__octopusDetailFieldSelections = [];
      w.__octopusDetailFieldObjects = [];
      delete w.__octopusDetailFieldClearSelection;
      delete w.__octopusDetailFieldCleanup;
    };
  });
}

async function readDetailFieldSelection(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldSelections?: string[] };
    return Array.isArray(w.__octopusDetailFieldSelections) ? w.__octopusDetailFieldSelections : [];
  });
}

async function readDetailFieldObjects(page: Page): Promise<Array<{
  suggestedName: string;
  kind: 'text' | 'href' | 'src';
  xpath: string;
  selector: string;
  sample: string;
  diagnostics?: DetectedFieldDiagnostics;
}>> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __octopusDetailFieldObjects?: Array<{
        suggestedName: string;
        kind: 'text' | 'href' | 'src';
        xpath: string;
        selector: string;
        sample: string;
        diagnostics?: DetectedFieldDiagnostics;
      }>;
    };
    return Array.isArray(w.__octopusDetailFieldObjects) ? w.__octopusDetailFieldObjects : [];
  });
}

async function clearDetailFieldSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldClearSelection?: () => void };
    w.__octopusDetailFieldClearSelection?.();
  });
}

async function removeDetailFieldOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetailFieldCleanup?: () => void };
    w.__octopusDetailFieldCleanup?.();
  });
}

async function readPaginationOverlaySelection(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationSelection?: string };
    return w.__octopusPaginationSelection;
  });
}

async function clearPaginationOverlaySelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationClearSelection?: () => void };
    w.__octopusPaginationClearSelection?.();
  });
}

async function removeCandidateOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusDetectionCleanup?: () => void };
    w.__octopusDetectionCleanup?.();
  });
}

async function removePaginationOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as typeof window & { __octopusPaginationCleanup?: () => void };
    w.__octopusPaginationCleanup?.();
  });
}

function paginationKey(pagination: DetectedPagination): string {
  return `${pagination.type}:${pagination.xpath || pagination.text}`;
}

async function refineCandidateFields(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      type: candidate.type,
      itemCount: candidate.itemCount
    }));
  if (!input.length) return candidates;

  const refinedById = await page.evaluate((items) => {
    type FieldInfo = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      xpath: string;
      relativeSelector?: string;
      relativeXPath?: string;
      operations?: Array<{ type: 'trim' | 'regex_match' | 'regex_replace'; params: string[] }>;
      samples: string[];
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function directText(element: Element | null): string {
      if (!element) return '';
      const parts = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '');
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function readableText(element: Element | null): string {
      return directText(element) || text(element);
    }

    function hasVisibleImage(element: Element): boolean {
      return Array.from(element.querySelectorAll('img')).some(visible);
    }

    function textFieldValue(element: Element): string {
      const own = directText(element);
      if (own) return own;
      const tag = element.tagName.toLowerCase();
      const value = text(element);
      if (/^(a|h1|h2|h3|h4|p|span|time|em|i|strong|b)$/i.test(tag)) return value;
      if (element.children.length <= 1 && !hasVisibleImage(element)) return value;
      return '';
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
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

    function generalRelativeXPath(row: Element, element: Element): string {
      const absoluteRow = xpath(row);
      const absoluteElement = xpath(element);
      if (absoluteElement.startsWith(absoluteRow)) {
        const relative = absoluteElement.slice(absoluteRow.length).replace(/^\/?/, './');
        return relative === './' ? '.' : relative;
      }
      return '.';
    }

    function absoluteFieldXPath(rowXPath: string, relativeXPath: string): string {
      if (relativeXPath.includes('|')) {
        return relativeXPath
          .split(/\s*\|\s*/)
          .map((part) => absoluteFieldXPath(rowXPath, part.trim()))
          .filter(Boolean)
          .join(' | ');
      }
      if (relativeXPath === '.') return rowXPath;
      return `${rowXPath}${relativeXPath.replace(/^\./, '')}`;
    }

    function compactRelativeXPath(row: Element, element: Element): string {
      if (element === row) return '.';
      const semanticPath = semanticRelativeXPath(row, element);
      if (semanticPath) return semanticPath;
      const exactPath = generalRelativeXPath(row, element);
      if (exactPath !== '.') return exactPath;
      const tag = element.tagName.toLowerCase();
      const sameTag = Array.from(row.querySelectorAll(tag)).filter(visible);
      const index = sameTag.indexOf(element);
      if (index >= 0) return `.//${tag}[${index + 1}]`;
      return '.';
    }

    function semanticRelativeXPath(row: Element, element: Element): string {
      const tag = element.tagName.toLowerCase();
      const attrNames = ['data-testid', 'data-test', 'data-qa', 'data-role', 'aria-label', 'rel', 'itemprop'];
      for (const attr of attrNames) {
        const value = element.getAttribute(attr);
        if (!value || value.length > 80) continue;
        const candidate = `.//${tag}[@${attr}=${xpathLiteral(value)}]`;
        if (uniqueRelativeMatch(row, element, candidate)) return candidate;
      }
      const classAttr = (element as HTMLElement).className || '';
      if (typeof classAttr === 'string') {
        const tokens = classAttr
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => /^[A-Za-z][\w-]{2,}$/.test(token))
          .filter((token) => !/^(active|selected|visible|hidden|show|open|current|disabled|loaded)$/i.test(token))
          .sort((a, b) => semanticTokenScore(b) - semanticTokenScore(a) || a.length - b.length);
        for (const token of tokens.slice(0, 4)) {
          const candidate = `.//${tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathLiteral(` ${token} `)})]`;
          if (uniqueRelativeMatch(row, element, candidate)) return candidate;
        }
      }
      return '';
    }

    function semanticTokenScore(token: string): number {
      if (/title|name|author|byline|user|nick|creator|owner|profile|member|like|count|heart|collect|favorite|image|img|cover|thumb|avatar|date|time|desc|summary|content/i.test(token)) return 2;
      if (/text|info|meta|footer|body|header|caption/i.test(token)) return 1;
      return 0;
    }

    function uniqueRelativeMatch(row: Element, element: Element, relativeXPath: string): boolean {
      try {
        const result = document.evaluate(relativeXPath, row, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === element;
      } catch {
        return false;
      }
    }

    function xpathLiteral(value: string): string {
      if (!value.includes('"')) return `"${value}"`;
      if (!value.includes("'")) return `'${value}'`;
      return `concat(${value.split('"').map((part) => `"${part}"`).join(', \'"\', ')})`;
    }

    function textNodeRelativeXPath(row: Element, value: string): string {
      const matching = Array.from(row.querySelectorAll('*'))
        .filter(visible)
        .find((element) => directText(element) === value || readableText(element) === value);
      if (matching) return compactRelativeXPath(row, matching);
      return `.//*[normalize-space(text())=${xpathLiteral(value)}]`;
    }

    function fieldKey(name: string, kind: string, relativeXPath: string): string {
      return `${name}:${kind}:${relativeXPath}`;
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.className || '',
        html.id || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('rel') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('data-testid') || '',
        html.getAttribute('data-test') || '',
        html.getAttribute('data-qa') || '',
        html.getAttribute('data-role') || ''
      ].join(' ');
    }

    function isButtonText(value: string): boolean {
      return /^(查看|更多|点击|回复|提交|确定|取消|登录|注册|搜索|分享|收藏|加入|上一页|下一页|next|prev|more|view|read more)$/i.test(value.trim());
    }

    function isNumericLike(value: string): boolean {
      const compact = value.replace(/[0-9\s.,:/\-年月日￥¥$元円€()（）]/g, '');
      return compact.length < 3 && /[0-9]/.test(value);
    }

    function isEngagementCount(value: string): boolean {
      const compact = value.replace(/\s+/g, '');
      if (!compact || compact.length > 24 || !/\d/.test(compact)) return false;
      if (dateMatch(compact)) return false;
      return /^(赞|喜欢|收藏|评论|转发|like|likes|save|saves|comment|comments|share|shares)?[:：]?[♡♥❤👍]?\d+(?:[.,]\d+)?(?:万|千|亿|w|k|m)?\+?(赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?$/i.test(compact);
    }

    function stripTrailingEngagement(value: string): string {
      return value.replace(new RegExp(authorEngagementSuffixPatternSource, 'i'), '').replace(/\s+/g, ' ').trim();
    }

    function stripDateFromAuthor(value: string): string {
      const date = dateMatch(value);
      if (!date) return value.replace(/\s+/g, ' ').trim();
      return value.replace(date, '').replace(/[|｜·•,，:：-]+$/g, '').replace(/\s+/g, ' ').trim();
    }

    function isAuthorText(value: string): boolean {
      const compact = value.trim();
      if (compact.length < 2 || compact.length > 60) return false;
      if (isButtonText(compact) || isEngagementCount(compact) || dateMatch(compact)) return false;
      if (/^https?:\/\//i.test(compact)) return false;
      return true;
    }

    function visualArea(element: Element): number {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    }

    function largestImageRect(row: Element): DOMRect | null {
      const images = Array.from(row.querySelectorAll('img'))
        .filter(visible)
        .map((image) => image.getBoundingClientRect())
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      return images[0] || null;
    }

    function overlapRatio(rect: DOMRect, other: DOMRect): number {
      const left = Math.max(rect.left, other.left);
      const right = Math.min(rect.right, other.right);
      const top = Math.max(rect.top, other.top);
      const bottom = Math.min(rect.bottom, other.bottom);
      if (right <= left || bottom <= top) return 0;
      return ((right - left) * (bottom - top)) / Math.max(1, rect.width * rect.height);
    }

    function overlapsMainImage(row: Element, rect: DOMRect, minRatio = 0.35): boolean {
      const imageRect = largestImageRect(row);
      if (!imageRect) return false;
      const rowRect = row.getBoundingClientRect();
      if ((imageRect.width * imageRect.height) / Math.max(1, rowRect.width * rowRect.height) < 0.18) return false;
      return overlapRatio(rect, imageRect) >= minRatio;
    }

    function fieldValue(row: Element, relativeXPath: string, kind: 'text' | 'href' | 'src'): string {
      const target = relativeXPath && relativeXPath !== '.'
        ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      const element = target instanceof Element ? target : null;
      if (!element) return '';
      if (kind === 'href') return (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      if (kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      return textFieldValue(element) || readableText(element);
    }

    function fieldElement(row: Element, relativeXPath: string): Element | null {
      const target = relativeXPath && relativeXPath !== '.'
        ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      return target instanceof Element ? target : null;
    }

    function fieldRect(row: Element, relativeXPath: string): DOMRect | null {
      return fieldElement(row, relativeXPath)?.getBoundingClientRect() || null;
    }

    function applyOperations(value: string, operations?: FieldInfo['operations']): string {
      let output = value;
      for (const operation of operations || []) {
        if (operation.type === 'trim') output = output.trim();
        else if (operation.type === 'regex_match') output = output.match(new RegExp(operation.params[0] || ''))?.[0] || '';
        else if (operation.type === 'regex_replace') output = output.replace(new RegExp(operation.params[0] || '', 'g'), operation.params[1] || '');
      }
      return output;
    }

    function sampleValue(row: Element, field: FieldInfo): string {
      return applyOperations(fieldValue(row, field.relativeXPath || '.', field.kind), field.operations);
    }

    function makeField(
      name: string,
      kind: 'text' | 'href' | 'src',
      selector: string,
      rowXPath: string,
      relativeXPath: string,
      rows: Element[]
    ): FieldInfo | null {
      const values = rows.map((row) => fieldValue(row, relativeXPath, kind)).filter(Boolean);
      const minSamples = rows.length >= 3 ? 2 : 1;
      if (values.length < minSamples) return null;
      return {
        name,
        kind,
        selector,
        xpath: absoluteFieldXPath(rowXPath, relativeXPath),
        relativeSelector: selector,
        relativeXPath,
        samples: values.slice(0, 3)
      };
    }

    function uniqueRate(values: string[]): number {
      const filled = values.filter(Boolean);
      if (!filled.length) return 0;
      return new Set(filled).size / filled.length;
    }

    function normalizedComparableText(value: string): string {
      return value.replace(/\s+/g, '').replace(/[|｜·•,，.。:：;；!?！？'"“”‘’()[\]（）【】]/g, '').toLowerCase();
    }

    function samplesDuplicate(left: string[], right: string[]): boolean {
      const pairs = left
        .map((value, index) => [normalizedComparableText(value), normalizedComparableText(right[index] || '')] as const)
        .filter(([a, b]) => a && b);
      if (!pairs.length) return false;
      const duplicateCount = pairs.filter(([a, b]) => a === b || a.includes(b) && b.length >= 6 || b.includes(a) && a.length >= 6).length;
      return duplicateCount / pairs.length >= 0.8;
    }

    function bestByScore<T>(items: T[], score: (item: T) => number): T | undefined {
      return items.map((item) => ({ item, score: score(item) })).sort((a, b) => b.score - a.score)[0]?.item;
    }

    function textFieldQuality(name: string, values: string[]): boolean {
      const filled = values.filter(Boolean);
      if (!filled.length) return false;
      if (name === 'author') {
        return filled.some((value) => {
          const authorText = stripTrailingEngagement(value);
          const withoutDate = stripDateFromAuthor(authorText || value);
          return authorText !== value && isAuthorText(authorText) || withoutDate !== value && isAuthorText(withoutDate) || isAuthorText(value);
        }) && !filled.every((value) => isEngagementCount(value));
      }
      if (isEngagementFieldName(name)) return filled.every((value) => isEngagementCount(value));
      if (name === 'title') return filled.some((value) => value.length >= 2 && value.length <= 220 && !isEngagementCount(value) && !dateMatch(value));
      if (name === 'summary') return filled.some((value) => value.length > 12 && value.length < 300 && !isEngagementCount(value));
      return true;
    }

    function fieldLayoutQuality(name: string, row: Element, field: FieldInfo): boolean {
      const rect = fieldRect(row, field.relativeXPath || '.');
      if (!rect) return false;
      const rowRect = row.getBoundingClientRect();
      const value = field.samples.find(Boolean) || '';
      const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
      const areaRatio = (rect.width * rect.height) / Math.max(1, rowRect.width * rowRect.height);
      if (name === 'title') {
        if (isEngagementCount(value)) return false;
        if (areaRatio > 0.45 && hasVisibleImage(fieldElement(row, field.relativeXPath || '.') || row)) return false;
        if (overlapsMainImage(row, rect)) return false;
        return y < 1.02;
      }
      if (name === 'author') return y > 0.35 && y < 1.02 && areaRatio < 0.35;
      if (isEngagementFieldName(name)) return y > 0.35 && y < 1.02 && areaRatio < 0.25;
      if (name === 'summary') return areaRatio < 0.45;
      return true;
    }

    function scanColumnFields(first: Element, rows: Element[], rowXPath: string): FieldInfo[] {
      type Column = {
        kind: 'text' | 'href' | 'src';
        element: Element;
        relativeXPath: string;
        selector: string;
        values: string[];
        fillRate: number;
      };
      const allElements = [first, ...Array.from(first.querySelectorAll('*'))].filter(visible);
      const columns: Column[] = [];
      const seen = new Set<string>();
      const addColumn = (element: Element, kind: Column['kind']) => {
        const relativeXPath = element === first ? '.' : compactRelativeXPath(first, element);
        const key = `${kind}:${relativeXPath}`;
        if (seen.has(key)) return;
        seen.add(key);
        const values = rows.map((row) => fieldValue(row, relativeXPath, kind));
        const fillRate = values.filter(Boolean).length / Math.max(1, rows.length);
        if (fillRate < (rows.length >= 3 ? 0.45 : 0.5)) return;
        columns.push({ kind, element, relativeXPath, selector: element.tagName.toLowerCase(), values, fillRate });
      };

      for (const element of allElements) {
        const tag = element.tagName.toLowerCase();
        if (/^(script|style|noscript|svg|button|input|select|textarea)$/.test(tag)) continue;
        if (tag === 'img') {
          const image = element as HTMLImageElement;
          const src = image.currentSrc || image.src;
          if (src && (image.naturalWidth >= 20 || image.width >= 20) && (image.naturalHeight >= 20 || image.height >= 20)) addColumn(element, 'src');
        }
        if (tag === 'a' && (element as HTMLAnchorElement).href && !(element as HTMLAnchorElement).href.includes('#')) {
          addColumn(element, 'href');
        }
        const value = textFieldValue(element);
        if (!value || value.length > 300 || isButtonText(value)) continue;
        addColumn(element, 'text');
      }

      const fields: FieldInfo[] = [];
      const image = bestByScore(
        columns.filter((column) => column.kind === 'src'),
        (column) => {
          const rect = column.element.getBoundingClientRect();
          const identity = elementIdentity(column.element);
          const avatarPenalty = /avatar|head|user|author|profile|logo|icon/i.test(identity) || Math.abs(rect.width - rect.height) < 8 && rect.width <= 80 ? 0.75 : 0;
          return column.fillRate + Math.min(0.7, visualArea(column.element) / Math.max(1, visualArea(first))) - avatarPenalty;
        }
      );
      const dateColumns = columns.filter((column) => column.kind === 'text' && column.values.some((value) => Boolean(dateMatch(value))) && column.values.filter(Boolean).every((value) => value.length <= 90));
      const preferredDateColumns = dateColumns.some((column) => column.relativeXPath !== '.') ? dateColumns.filter((column) => column.relativeXPath !== '.') : dateColumns;
      const date = bestByScore(
        preferredDateColumns,
        (column) => column.fillRate + (/time|date/i.test(elementIdentity(column.element)) ? 0.4 : 0) - Math.max(0, (column.values[0] || '').length - 30) / 100
      );
      const title = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const sampleValue = column.values.find(Boolean) || '';
          if (sampleValue.length < 3 || sampleValue.length > 220) return false;
          if (dateMatch(sampleValue) || isNumericLike(sampleValue) || isEngagementCount(sampleValue) || isButtonText(sampleValue)) return false;
          return uniqueRate(column.values) >= 0.55;
        }),
        (column) => {
          const tag = column.element.tagName.toLowerCase();
          const semantic = /^(h1|h2|h3|h4|a)$/.test(tag) ? 0.55 : /title|tit/i.test(elementIdentity(column.element)) ? 0.45 : 0;
          const rect = column.element.getBoundingClientRect();
          const rowRect = first.getBoundingClientRect();
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          const yScore = y > 0.2 && y < 0.82 ? 0.25 : -0.25;
          const lengthScore = Math.min(0.25, (column.values.find(Boolean) || '').length / 180);
          return column.fillRate + semantic + lengthScore + yScore + Math.min(0.2, rect.width / 900);
        }
      );
      const url = title
        ? bestByScore(
          columns.filter((column) => column.kind === 'href' && (column.relativeXPath === title.relativeXPath || column.element === title.element || column.element.contains(title.element) || title.element.contains(column.element))),
          (column) => column.fillRate + 0.5
        ) || bestByScore(columns.filter((column) => column.kind === 'href'), (column) => column.fillRate)
        : bestByScore(columns.filter((column) => column.kind === 'href'), (column) => column.fillRate);
      const summary = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (title && column.relativeXPath === title.relativeXPath) return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const value = column.values.find(Boolean) || '';
          return value.length > 12 && value.length < 300 && !dateMatch(value) && !isButtonText(value);
        }),
        (column) => column.fillRate + Math.min(0.25, (column.values.find(Boolean) || '').length / 260)
      );
      const author = bestByScore(
        columns.filter((column) => {
          if (column.kind !== 'text') return false;
          if (title && column.relativeXPath === title.relativeXPath) return false;
          if (summary && column.relativeXPath === summary.relativeXPath) return false;
          if (date && column.relativeXPath === date.relativeXPath) return false;
          const value = column.values.find(Boolean) || '';
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(column.element));
          const profileLink = hasProfileLink(column.element);
          const authorValue = stripTrailingEngagement(value);
          const looksLikeAuthor = isAuthorText(value) || (authorValue !== value && isAuthorText(authorValue));
          return looksLikeAuthor && (semantic || profileLink || (authorValue || value).length <= 32 && uniqueRate(column.values) >= 0.55);
        }),
        (column) => {
          const rect = column.element.getBoundingClientRect();
          const rowRect = first.getBoundingClientRect();
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(column.element)) ? 0.75 : 0;
          const profileLink = hasProfileLink(column.element) ? 0.45 : 0;
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          const bottomScore = y > 0.55 ? 0.45 : y > 0.35 ? 0.25 : -0.35;
          return column.fillRate + semantic + profileLink + bottomScore - Math.max(0, stripTrailingEngagement(column.values.find(Boolean) || '').length - 24) / 100;
        }
      );
      const pushColumn = (name: string, column: Column | undefined) => {
        if (!column) return;
        const field = makeField(name, column.kind, column.selector, rowXPath, column.relativeXPath, rows);
        if (!field) return;
        if (field.kind === 'text' && !textFieldQuality(name, field.samples)) return;
        const operation = name === 'date' && column.kind === 'text' && column.values.some((value) => value !== dateMatch(value))
          ? { operations: [{ type: 'regex_match' as const, params: [datePatternSource] }] }
          : name === 'author' && column.kind === 'text' && field.samples.some((value) => {
            const stripped = stripTrailingEngagement(value);
            return stripped !== value && isAuthorText(stripped);
          })
            ? { operations: [{ type: 'regex_replace' as const, params: [authorEngagementSuffixPatternSource, ''] }, { type: 'trim' as const, params: ['0'] }] }
          : {};
        fields.push({ ...field, ...operation });
      };
      pushColumn('title', title);
      pushColumn('url', url);
      pushColumn('image', image);
      pushColumn('date', date);
      pushColumn('summary', summary);
      pushColumn('author', author);
      return fields;
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';
    const authorEngagementSuffixPatternSource = '\\s*(?:[♡♥❤👍]\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?(?:万|千|亿|w|k|m)\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?)?|\\d+(?:[.,]\\d+)?\\+?(?:赞|喜欢|收藏|评论|转发|likes?|saves?|comments?|shares?))\\s*$';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function hasProfileLink(element: Element): boolean {
      return Boolean(
        element.closest('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]')
        || element.querySelector('a[href*="user" i],a[href*="author" i],a[href*="profile" i],a[href*="member" i]')
      );
    }

    function findDateElement(row: Element): Element | null {
      const candidates = Array.from(row.querySelectorAll('time,[datetime],[class*="date" i],[class*="time" i],span,p,div,em,i,b,strong'))
        .filter(visible)
        .filter((element) => {
          const value = readableText(element);
          return value.length <= 90 && Boolean(dateMatch(value));
        });
      return candidates.sort((a, b) => {
        const aSemantic = /time|date/i.test(`${a.id} ${(a as HTMLElement).className} ${(a as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
        const bSemantic = /time|date/i.test(`${b.id} ${(b as HTMLElement).className} ${(b as HTMLElement).getAttribute('datetime') || ''}`) ? 0 : 1;
        if (aSemantic !== bSemantic) return aSemantic - bSemantic;
        return readableText(a).length - readableText(b).length;
      })[0] || null;
    }

    function findDateText(row: Element): string {
      return dateMatch(text(row));
    }

    function findTitleElement(row: Element, dateElement: Element | null): Element | null {
      const rowRect = row.getBoundingClientRect();
      const link = Array.from(row.querySelectorAll('a')).filter(visible).find((element) => {
        const value = textFieldValue(element) || readableText(element);
        const rect = element.getBoundingClientRect();
        const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
        return value.length >= 2 && value.length <= 220 && y < 1.02 && !overlapsMainImage(row, rect) && element !== dateElement && !element.contains(dateElement) && !isEngagementCount(value);
      });
      if (link) return link;
      const candidates = Array.from(row.querySelectorAll('h1,h2,h3,h4,[class*="title" i],a,p,span,div'))
        .filter(visible)
        .filter((element) => element !== dateElement && !element.contains(dateElement))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const y = (rect.top - rowRect.top) / Math.max(1, rowRect.height);
          return { element, value: textFieldValue(element) || readableText(element), rect, y };
        })
        .filter((item) => item.value.length >= 4 && item.value.length <= 220)
        .filter((item) => !/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(item.value))
        .filter((item) => !isEngagementCount(item.value))
        .filter((item) => item.y < 1.02 && !overlapsMainImage(row, item.rect))
        .sort((a, b) => {
          const tagWeight = (element: Element) => /^(h1|h2|h3|h4|a)$/i.test(element.tagName) ? 0 : 1;
          if (tagWeight(a.element) !== tagWeight(b.element)) return tagWeight(a.element) - tagWeight(b.element);
          return b.rect.width - a.rect.width;
        });
      return candidates[0]?.element || null;
    }

    function findMainImageElement(row: Element): HTMLImageElement | null {
      return Array.from(row.querySelectorAll('img'))
        .filter((element): element is HTMLImageElement => element instanceof HTMLImageElement && visible(element))
        .filter((image) => {
          const src = image.currentSrc || image.src;
          return Boolean(src) && (image.naturalWidth >= 20 || image.width >= 20) && (image.naturalHeight >= 20 || image.height >= 20);
        })
        .sort((a, b) => {
          const score = (image: HTMLImageElement) => {
            const rect = image.getBoundingClientRect();
            const identity = elementIdentity(image);
            const avatarPenalty = /avatar|head|user|author|profile|logo|icon/i.test(identity) || Math.abs(rect.width - rect.height) < 8 && rect.width <= 80 ? 0.8 : 0;
            return Math.min(1.2, visualArea(image) / Math.max(1, visualArea(row))) - avatarPenalty;
          };
          return score(b) - score(a);
        })[0] || null;
    }

    function findAuthorElement(row: Element, titleElement: Element | null, dateElement: Element | null): Element | null {
      const rowRect = row.getBoundingClientRect();
      return Array.from(row.querySelectorAll('[class*="author" i],[class*="byline" i],[class*="user" i],[class*="nick" i],[class*="name" i],[class*="creator" i],[class*="owner" i],[class*="profile" i],[class*="avatar" i],[rel="author"],[itemprop*="author" i],a,span,p,div'))
        .filter(visible)
        .filter((element) => element !== titleElement && element !== dateElement && !element.contains(titleElement) && !element.contains(dateElement))
        .map((element) => {
          const value = textFieldValue(element) || readableText(element);
          const rect = element.getBoundingClientRect();
          const semantic = /author|byline|user|nick|name|creator|owner|profile|avatar|member/i.test(elementIdentity(element));
          const profileLink = hasProfileLink(element);
          const nearBottom = rect.top > rowRect.top + rowRect.height * 0.35;
          const authorValue = stripTrailingEngagement(value);
          const scoreText = authorValue || value;
          const score = (semantic ? 1 : 0) + (profileLink ? 0.45 : 0) + (nearBottom ? 0.2 : 0) - Math.max(0, scoreText.length - 24) / 100;
          return { element, value, authorValue, score, area: rect.width * rect.height };
        })
        .filter((item) => isAuthorText(item.value) || item.authorValue !== item.value && isAuthorText(item.authorValue))
        .sort((a, b) => b.score - a.score || a.area - b.area)[0]?.element || null;
    }

    type EngagementKind = 'comments' | 'favorites' | 'shares' | 'likes' | 'metric';

    function isEngagementFieldName(name: string): boolean {
      return /^(comments|favorites|shares|likes|metric_\d+)$/.test(name);
    }

    function engagementCountValue(element: Element): string {
      const values = [directText(element), textFieldValue(element), readableText(element)];
      return values.find((value) => isEngagementCount(value)) || '';
    }

    function engagementCountLeaves(root: Element): Element[] {
      return Array.from(root.querySelectorAll('span,em,i,b,strong,a,button,div'))
        .filter(visible)
        .filter((element) => Boolean(engagementCountValue(element)))
        .filter((element) => !Array.from(element.querySelectorAll('span,em,i,b,strong,a,button,div'))
          .some((child) => child !== element && visible(child) && Boolean(engagementCountValue(child))));
    }

    function nearestSiblings(element: Element, direction: 'previous' | 'next', limit = 3): Element[] {
      const output: Element[] = [];
      let current = direction === 'previous' ? element.previousElementSibling : element.nextElementSibling;
      while (current && output.length < limit) {
        output.push(current);
        current = direction === 'previous' ? current.previousElementSibling : current.nextElementSibling;
      }
      return output;
    }

    function localEngagementWrapper(element: Element, row: Element): Element | null {
      let current = element.parentElement;
      const rowArea = Math.max(1, visualArea(row));
      while (current && current !== row) {
        const countLeaves = engagementCountLeaves(current);
        if (countLeaves.length > 1) return null;
        if (countLeaves.length === 1 && countLeaves[0] === element) {
          const areaRatio = visualArea(current) / rowArea;
          if (areaRatio <= 0.25 || current.children.length <= 5 || /comment|reply|discuss|like|heart|collect|favorite|fav|star|share|forward|repost|retweet|interact|action|metric|count/i.test(elementIdentity(current))) {
            return current;
          }
        }
        current = current.parentElement;
      }
      return null;
    }

    function engagementSemanticText(element: Element, row: Element): string {
      const parent = element.parentElement;
      const wrapper = localEngagementWrapper(element, row);
      const localElements = [
        ...nearestSiblings(element, 'previous'),
        ...nearestSiblings(element, 'next', 1),
        ...(wrapper ? [wrapper] : []),
        ...(parent && engagementCountLeaves(parent).length <= 1 ? [parent] : [])
      ].filter((item): item is Element => Boolean(item && item !== row));
      const iconElements = [
        ...Array.from(element.querySelectorAll('svg,use,i,span[class],em[class]')),
        ...localElements,
        ...localElements.flatMap((item) => Array.from(item.querySelectorAll('svg,use,i,span[class],em[class]')))
      ].filter((item): item is Element => Boolean(item));
      const attr = (target: Element | null | undefined): string => {
        if (!target) return '';
        const item = target as HTMLElement;
        return [
          target.localName,
          item.id || '',
          typeof item.className === 'string' ? item.className : '',
          item.getAttribute('role') || '',
          item.getAttribute('aria-label') || '',
          item.getAttribute('title') || '',
          item.getAttribute('alt') || '',
          item.getAttribute('href') || '',
          item.getAttribute('xlink:href') || '',
          item.getAttribute('data-testid') || '',
          item.getAttribute('data-test') || '',
          item.getAttribute('data-qa') || '',
          item.getAttribute('data-role') || '',
          item.getAttribute('use') || '',
          target.textContent || ''
        ].join(' ');
      };
      return [
        attr(element),
        wrapper ? attr(wrapper) : '',
        parent && engagementCountLeaves(parent).length <= 1 ? attr(parent) : '',
        ...iconElements.map(attr)
      ].join(' ');
    }

    function engagementKind(element: Element, row: Element): EngagementKind {
      const value = `${engagementSemanticText(element, row)} ${textFieldValue(element) || readableText(element)}`.toLowerCase();
      if (/(comment|comments|reply|replies|discuss|discussion|bubble|message|chat|评论|评|留言|回复)/i.test(value)) return 'comments';
      if (/(share|shares|forward|repost|retweet|transmit|arrow|send|转发|分享|转|转推)/i.test(value)) return 'shares';
      if (/(collect|collection|favorite|favourite|favorites|favourites|fav|star|bookmark|save|saves|收藏|星标|书签)/i.test(value)) return 'favorites';
      if (/(like|likes|heart|thumb|vote|upvote|赞|喜欢|点赞|♥|❤|♡|👍)/i.test(value)) return 'likes';
      if (/☆|★/.test(value)) return 'favorites';
      if (/↗|↪|➜|➤|⤴|⤵/.test(value)) return 'shares';
      return 'metric';
    }

    function engagementNameFor(element: Element, row: Element, index: number, total: number): string {
      const kind = engagementKind(element, row);
      if (kind !== 'metric') return kind;
      if (total >= 3) return ['comments', 'favorites', 'shares'][index] || `metric_${index + 1}`;
      return `metric_${index + 1}`;
    }

    function engagementRelativeXPath(row: Element, element: Element): string {
      const structural = generalRelativeXPath(row, element);
      return structural && structural !== '.' ? structural : compactRelativeXPath(row, element);
    }

    function findEngagementElements(row: Element, titleElement: Element | null, dateElement: Element | null): Array<{ element: Element; name: string; relativeXPath: string }> {
      const candidates = Array.from(row.querySelectorAll('[class*="comment" i],[class*="reply" i],[class*="discuss" i],[class*="like" i],[class*="heart" i],[class*="collect" i],[class*="favorite" i],[class*="count" i],[class*="interact" i],[class*="engage" i],[class*="share" i],[class*="forward" i],[class*="repost" i],span,em,i,b,strong,div'))
        .filter(visible)
        .filter((element) => element !== titleElement && element !== dateElement && !element.contains(titleElement) && !element.contains(dateElement))
        .map((element) => {
          const value = engagementCountValue(element);
          const kind = engagementKind(element, row);
          const semantic = kind !== 'metric' || /count|interact|engage|vote|赞|喜欢|收藏|评论|转发|分享/i.test(elementIdentity(element));
          const rect = element.getBoundingClientRect();
          const descendantCountLeaves = engagementCountLeaves(element).filter((child) => child !== element);
          const directCount = isEngagementCount(directText(element));
          return { element, value, kind, semantic, area: visualArea(element), left: rect.left, top: rect.top, descendantCountLeaves, directCount };
        })
        .filter((item) => item.value && (item.directCount || item.descendantCountLeaves.length === 0))
        .sort((a, b) => {
          if (a.semantic !== b.semantic) return a.semantic ? -1 : 1;
          return a.top - b.top || a.left - b.left || a.value.length - b.value.length || a.area - b.area;
        })
        .slice(0, 4)
        .sort((a, b) => a.top - b.top || a.left - b.left);
      return candidates.map((item, index) => ({ element: item.element, name: engagementNameFor(item.element, row, index, candidates.length), relativeXPath: engagementRelativeXPath(row, item.element) }));
    }

    function engagementPathTarget(row: Element, relativeXPath: string): Element | null {
      try {
        const target = document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return target instanceof Element ? target : null;
      } catch {
        return null;
      }
    }

    function engagementPathSupports(name: string, row: Element, relativeXPath: string): boolean {
      const element = engagementPathTarget(row, relativeXPath);
      if (!element || !visible(element)) return false;
      const value = engagementCountValue(element) || textFieldValue(element) || readableText(element);
      if (!isEngagementCount(value)) return false;
      const kind = engagementKind(element, row);
      return kind === name || kind === 'metric';
    }

    function buildEngagementRelativeXPath(name: string, rows: Element[], rawPaths: string[]): string {
      const paths = Array.from(new Set(rawPaths.filter(Boolean)));
      const uncovered = new Set(rows.map((_, index) => index));
      const selected: string[] = [];
      while (uncovered.size && selected.length < 5) {
        const best = paths
          .filter((path) => !selected.includes(path))
          .map((path) => ({
            path,
            covered: Array.from(uncovered).filter((index) => engagementPathSupports(name, rows[index], path))
          }))
          .filter((item) => item.covered.length)
          .sort((a, b) => b.covered.length - a.covered.length || a.path.length - b.path.length)[0];
        if (!best) break;
        selected.push(best.path);
        best.covered.forEach((index) => uncovered.delete(index));
      }
      return selected.length ? selected.join(' | ') : paths[0] || '';
    }

    function findSummaryElement(row: Element, titleElement: Element | null, dateElement: Element | null, authorElement: Element | null, engagementElements: Element[]): Element | null {
      return Array.from(row.querySelectorAll('p,span,div'))
        .filter(visible)
        .filter((element) => ![titleElement, dateElement, authorElement, ...engagementElements].some((used) => used && (element === used || element.contains(used))))
        .map((element) => ({ element, value: textFieldValue(element), area: visualArea(element), own: Boolean(directText(element)) }))
        .filter((item) => item.value.length > 20 && item.value.length < 260 && !dateMatch(item.value) && !isEngagementCount(item.value) && !hasVisibleImage(item.element))
        .sort((a, b) => {
          if (a.own !== b.own) return a.own ? -1 : 1;
          return a.area - b.area;
        })[0]?.element || null;
    }

    function sample(row: Element, field: FieldInfo): string {
      const target = field.relativeXPath && field.relativeXPath !== '.'
        ? document.evaluate(field.relativeXPath.replace(/^\.\//, './'), row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : row;
      const element = target instanceof Element ? target : null;
      if (!element) return '';
      if (field.kind === 'href') return (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      if (field.kind === 'src') return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      return textFieldValue(element) || readableText(element);
    }

    const output: Record<string, { fields: FieldInfo[]; sampleRows: Record<string, string>[] }> = {};
    for (const item of items) {
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 6);
      if (!rows.length) continue;
      const rowXPath = item.itemXPath;
      const first = rows[0];
      const fields: FieldInfo[] = [];
      const seen = new Set<string>();
      const push = (field: FieldInfo) => {
        if (fields.some((item) => item.name === field.name && item.kind === field.kind)) return;
        const key = fieldKey(field.name, field.kind, field.relativeXPath || '.');
        if (seen.has(key)) return;
        if (!field.samples.some(Boolean)) return;
        seen.add(key);
        fields.push(field);
      };

      scanColumnFields(first, rows, rowXPath).forEach(push);

      const image = findMainImageElement(first);
      if (image) {
        const relativeXPath = compactRelativeXPath(first, image);
        push({
          name: 'image',
          kind: 'src',
          selector: 'img',
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: 'img',
          relativeXPath,
          samples: rows.map((row) => {
            const img = document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            return img instanceof HTMLImageElement ? img.currentSrc || img.src : '';
          }).filter(Boolean).slice(0, 3)
        });
      }

      const dateElement = findDateElement(first);
      const titleElement = findTitleElement(first, dateElement);
      if (titleElement) {
        const relativeXPath = compactRelativeXPath(first, titleElement);
        push({
          name: 'title',
          kind: 'text',
          selector: titleElement.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: titleElement.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: 'title', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality('title', [value])).slice(0, 3)
        });
        const linkElement = titleElement.matches('a') ? titleElement : titleElement.closest('a') || titleElement.querySelector('a');
        if (linkElement instanceof HTMLAnchorElement) {
          const linkRelativeXPath = compactRelativeXPath(first, linkElement);
          push({
            name: 'url',
            kind: 'href',
            selector: 'a',
            xpath: absoluteFieldXPath(rowXPath, linkRelativeXPath),
            relativeSelector: 'a',
            relativeXPath: linkRelativeXPath,
            samples: rows.map((row) => sample(row, { name: 'url', kind: 'href', selector: '', xpath: '', relativeXPath: linkRelativeXPath, samples: [] })).filter(Boolean).slice(0, 3)
          });
        }
      }

      const authorElement = findAuthorElement(first, titleElement, dateElement);
      if (authorElement) {
        const relativeXPath = compactRelativeXPath(first, authorElement);
        const authorSamples = rows
          .map((row) => sample(row, { name: 'author', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] }))
          .filter((value) => textFieldQuality('author', [value]))
          .slice(0, 3);
        push({
          name: 'author',
          kind: 'text',
          selector: authorElement.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: authorElement.tagName.toLowerCase(),
          relativeXPath,
          operations: authorSamples.some((value) => {
            const stripped = stripDateFromAuthor(stripTrailingEngagement(value));
            return stripped !== value && isAuthorText(stripped);
          })
            ? [{ type: 'regex_replace', params: [authorEngagementSuffixPatternSource, ''] }, { type: 'regex_replace', params: [datePatternSource, ''] }, { type: 'trim', params: ['0'] }]
            : undefined,
          samples: authorSamples
        });
      }

      const engagementByName = new Map<string, Array<{ element: Element; relativeXPath: string }>>();
      rows.forEach((row, rowIndex) => {
        const rowTitleElement = rowIndex === 0 ? titleElement : fieldElement(row, compactRelativeXPath(first, titleElement || first));
        const rowDateElement = rowIndex === 0 ? dateElement : dateElement ? fieldElement(row, compactRelativeXPath(first, dateElement)) : null;
        for (const engagement of findEngagementElements(row, rowTitleElement, rowDateElement)) {
          engagementByName.set(engagement.name, [...(engagementByName.get(engagement.name) ?? []), { element: engagement.element, relativeXPath: engagement.relativeXPath }]);
        }
      });
      const engagementFields = Array.from(engagementByName.entries())
        .filter(([name]) => name === 'comments' || name === 'favorites' || name === 'shares' || name === 'likes' || /^metric_\d+$/.test(name))
        .map(([name, entries]) => {
          const firstEntry = entries.find((entry) => first.contains(entry.element)) || entries[0];
          const relativeXPath = buildEngagementRelativeXPath(name, rows, entries.map((entry) => entry.relativeXPath));
          return firstEntry && relativeXPath ? { element: firstEntry.element, name, relativeXPath } : null;
        })
        .filter((item): item is { element: Element; name: string; relativeXPath: string } => Boolean(item))
        .sort((a, b) => {
          const order = (name: string) => ['comments', 'favorites', 'shares', 'likes'].indexOf(name);
          const aOrder = order(a.name);
          const bOrder = order(b.name);
          return (aOrder === -1 ? 99 : aOrder) - (bOrder === -1 ? 99 : bOrder);
        });
      for (const engagement of engagementFields) {
        const relativeXPath = engagement.relativeXPath;
        push({
          name: engagement.name,
          kind: 'text',
          selector: engagement.element.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: engagement.element.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: engagement.name, kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality(engagement.name, [value])).slice(0, 3)
        });
      }

      const dateText = findDateText(first);
      if (dateElement || dateText) {
        const relativeXPath = dateElement ? compactRelativeXPath(first, dateElement) : textNodeRelativeXPath(first, dateText);
        push({
          name: 'date',
          kind: 'text',
          selector: dateElement ? dateElement.tagName.toLowerCase() : 'text',
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: dateElement ? dateElement.tagName.toLowerCase() : 'text',
          relativeXPath,
          operations: rows.some((row) => sample(row, { name: 'date', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] }) !== findDateText(row))
            ? [{ type: 'regex_match', params: [datePatternSource] }]
            : undefined,
          samples: rows.map((row) => {
            const extracted = sample(row, { name: 'date', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] });
            return findDateText({ textContent: extracted } as Element) || findDateText(row);
          }).filter(Boolean).slice(0, 3)
        });
      }

      const summary = findSummaryElement(first, titleElement, dateElement, authorElement, engagementFields.map((item) => item.element));
      if (summary) {
        const relativeXPath = compactRelativeXPath(first, summary);
        push({
          name: 'summary',
          kind: 'text',
          selector: summary.tagName.toLowerCase(),
          xpath: absoluteFieldXPath(rowXPath, relativeXPath),
          relativeSelector: summary.tagName.toLowerCase(),
          relativeXPath,
          samples: rows.map((row) => sample(row, { name: 'summary', kind: 'text', selector: '', xpath: '', relativeXPath, samples: [] })).filter((value) => textFieldQuality('summary', [value])).slice(0, 3)
        });
      }

      if (fields.length < 2) continue;
      const usefulRefinedFields = fields.filter((field) => {
        if (field.kind !== 'text') return true;
        if (!textFieldQuality(field.name, field.samples)) return false;
        if (!fieldLayoutQuality(field.name, first, field)) return false;
        if ((field.name === 'title' || field.name === 'summary') && (field.relativeXPath || '.') === '.') return false;
        return true;
      });
      const titleField = usefulRefinedFields.find((field) => field.name === 'title' && field.kind === 'text');
      const nonDuplicateFields = usefulRefinedFields.filter((field) => {
        if (field.name !== 'summary' || !titleField) return true;
        return !samplesDuplicate(field.samples, titleField.samples);
      });
      const usedEngagementSamples = new Set<string>();
      const usedTextPaths = new Map<string, FieldInfo>();
      const cleanFields = nonDuplicateFields.filter((field) => {
        if (field.kind !== 'text') return true;
        if (isEngagementFieldName(field.name)) {
          const sampleKey = field.samples.map((value) => normalizedComparableText(value)).join('|');
          if (usedEngagementSamples.has(sampleKey)) return false;
          usedEngagementSamples.add(sampleKey);
        }
        const path = field.relativeXPath || '.';
        const existing = usedTextPaths.get(path);
        if (!existing) {
          usedTextPaths.set(path, field);
          return true;
        }
        if (isEngagementFieldName(existing.name)) return false;
        if (isEngagementFieldName(field.name)) {
          usedTextPaths.set(path, field);
          return true;
        }
        return false;
      }).filter((field) => usedTextPaths.get(field.relativeXPath || '.') === field || field.kind !== 'text');
      if (cleanFields.length < 2) continue;
      const sampleRows = rows.slice(0, 3).map((row) => {
        const record: Record<string, string> = {};
        for (const field of cleanFields) record[field.name] = sampleValue(row, field);
        return record;
      });
      output[item.id] = { fields: cleanFields, sampleRows };
    }
    return output;
  }, input) as Record<string, { fields: DetectedField[]; sampleRows: Record<string, string>[] }>;

  return candidates.map((candidate) => {
    const refined = refinedById[candidate.id];
    if (!refined || refined.fields.length < 2) return candidate;
    const originalByName = new Map(candidate.fields.map((field) => [`${field.name}:${field.kind}`, field]));
    const refinedHasPreciseTextFields = refined.fields.some((field) => field.kind === 'text' && (field.relativeXPath || '.') !== '.');
    const mergedFields = [
      ...refined.fields,
      ...candidate.fields.filter((field) => {
        if (refined.fields.some((item) => item.name === field.name && item.kind === field.kind)) return false;
        if (refinedHasPreciseTextFields && field.kind === 'text' && (field.relativeXPath || '.') === '.') return false;
        return true;
      })
    ];
    const originalSemanticCount = ['title:text', 'url:href', 'image:src', 'date:text', 'author:text', 'likes:text']
      .filter((key) => originalByName.has(key)).length;
    const refinedSemanticCount = ['title:text', 'url:href', 'image:src', 'date:text', 'author:text', 'likes:text']
      .filter((key) => refined.fields.some((field) => `${field.name}:${field.kind}` === key)).length;
    const shouldUseRefined = refinedSemanticCount >= originalSemanticCount
      || refined.fields.some((field) => !originalByName.has(`${field.name}:${field.kind}`));
    if (!shouldUseRefined) return candidate;
    return {
      ...candidate,
      fields: mergedFields,
      sampleRows: refined.sampleRows,
      reasons: [...candidate.reasons, 'Fields refined from repeated item structure']
    };
  });
}

async function augmentAdjacentMetadataFields(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      sampleRowCount: Math.max(3, Math.min(8, candidate.sampleRows.length || 3)),
      fields: candidate.fields.map((field) => ({ name: field.name, kind: field.kind }))
    }));
  if (!input.length) return candidates;

  const augmentedById = await page.evaluate((items) => {
    type FieldInfo = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      xpath: string;
      relativeSelector?: string;
      relativeXPath?: string;
      operations?: Array<{ type: 'trim' | 'regex_match' | 'regex_replace'; params: string[] }>;
      samples: string[];
    };

    type CandidateInput = {
      id: string;
      xpath: string;
      itemXPath: string;
      sampleRowCount: number;
      fields: Array<{ name: string; kind: string }>;
    };

    type MetadataEntry = {
      name: string;
      kind: 'text' | 'href' | 'src';
      selector: string;
      relativeSelector?: string;
      relativeXPath: string;
      operations?: FieldInfo['operations'];
    };

    type MetadataPair = {
      row: Element;
      metadata: Element;
    };

    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function directText(element: Element | null): string {
      if (!element) return '';
      const parts = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || '');
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function readableText(element: Element | null): string {
      return directText(element) || text(element);
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      try {
        const result = document.evaluate(path.replace(/\[\*\]/g, ''), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
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

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }

    function absoluteFieldXPath(rowXPath: string, relativeXPath: string): string {
      if (relativeXPath.includes('|')) {
        return relativeXPath
          .split(/\s*\|\s*/)
          .map((part) => absoluteFieldXPath(rowXPath, part.trim()))
          .filter(Boolean)
          .join(' | ');
      }
      if (relativeXPath === '.') return rowXPath;
      return `${rowXPath}${relativeXPath.replace(/^\./, '')}`;
    }

    function applyOperations(value: string, operations?: FieldInfo['operations']): string {
      let output = value;
      for (const operation of operations || []) {
        try {
          if (operation.type === 'trim') output = output.trim();
          else if (operation.type === 'regex_match') output = output.match(new RegExp(operation.params[0] || '', 'i'))?.[0] || '';
          else if (operation.type === 'regex_replace') output = output.replace(new RegExp(operation.params[0] || '', 'gi'), operation.params[1] || '');
        } catch {
          return output;
        }
      }
      return output;
    }

    function fieldValue(row: Element, relativeXPath: string, kind: 'text' | 'href' | 'src', operations?: FieldInfo['operations']): string {
      let element: Element | null = null;
      try {
        const target = relativeXPath && relativeXPath !== '.'
          ? document.evaluate(relativeXPath, row, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
          : row;
        element = target instanceof Element ? target : null;
      } catch {
        element = null;
      }
      if (!element) return '';
      let value = '';
      if (kind === 'href') value = (element as HTMLAnchorElement).href || (element.closest('a') as HTMLAnchorElement | null)?.href || '';
      else if (kind === 'src') value = (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || '';
      else value = readableText(element);
      return applyOperations(value, operations).replace(/\s+/g, ' ').trim();
    }

    function elementIdentity(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.tagName.toLowerCase(),
        html.id || '',
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || '',
        html.getAttribute('title') || '',
        html.getAttribute('rel') || '',
        html.getAttribute('itemprop') || '',
        html.getAttribute('href') || '',
        html.getAttribute('data-testid') || '',
        html.getAttribute('data-test') || '',
        html.getAttribute('data-qa') || '',
        html.getAttribute('data-role') || ''
      ].join(' ');
    }

    function relativePathWithin(root: Element, target: Element): string {
      if (root === target) return '';
      const parts: string[] = [];
      let current: Element | null = target;
      while (current && current !== root) {
        const parent: Element | null = current.parentElement;
        if (!parent) return '';
        const tag = current.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((item): item is Element => item instanceof Element && item.tagName === current?.tagName);
        parts.unshift(`${tag}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parent;
      }
      return current === root && parts.length ? `/${parts.join('/')}` : '';
    }

    function relativePathFromRowToMetadataTarget(row: Element, metadata: Element, target: Element): string {
      const parent = row.parentElement;
      if (!parent || metadata.parentElement !== parent) return '';
      const siblings = Array.from(parent.children);
      const rowIndex = siblings.indexOf(row);
      const metadataIndex = siblings.indexOf(metadata);
      if (rowIndex < 0 || metadataIndex <= rowIndex) return '';
      const offset = metadataIndex - rowIndex;
      const suffix = relativePathWithin(metadata, target);
      return `./following-sibling::*[${offset}]${suffix}`;
    }

    const datePatternSource = '(\\d{4}|\\d{2})([-/.年])\\d{1,2}([-/.月])\\d{1,2}(?:日)?(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|\\d{1,2}\\s*(?:分钟前|小时前|天前|周前|月前|年前|minutes?\\s*ago|hours?\\s*ago|days?\\s*ago|weeks?\\s*ago|months?\\s*ago|years?\\s*ago)|[今昨前]天(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{2,4}';
    const scorePatternSource = '\\b\\d[\\d,.]*(?:\\s*[kKmM])?\\s*(?:points?|votes?|upvotes?|likes?|score|票|赞)\\b';
    const commentPatternSource = '\\b(?:\\d[\\d,.]*(?:\\s*[kKmM])?\\s*(?:comments?|replies?|answers?|讨论|评论|回复)|discuss)\\b';

    function dateMatch(value: string): string {
      return value.match(new RegExp(datePatternSource, 'i'))?.[0] || '';
    }

    function scoreMatch(value: string): string {
      return value.match(new RegExp(scorePatternSource, 'i'))?.[0] || '';
    }

    function commentMatch(value: string): string {
      return value.match(new RegExp(commentPatternSource, 'i'))?.[0] || '';
    }

    function isScoreValue(value: string): boolean {
      return Boolean(scoreMatch(value));
    }

    function isCommentValue(value: string): boolean {
      return Boolean(commentMatch(value));
    }

    function cleanAuthorText(value: string): string {
      const normalized = value.replace(/\s+/g, ' ').trim();
      const byMatch = normalized.match(/\bby\s+([^\s|·•,，]+(?:\s+[^\s|·•,，]+){0,2})/i);
      if (byMatch?.[1]) return byMatch[1].trim();
      return normalized
        .replace(/^(?:by|author|user|作者|用户)[:：]?\s*/i, '')
        .replace(new RegExp(scorePatternSource, 'gi'), '')
        .replace(new RegExp(commentPatternSource, 'gi'), '')
        .replace(new RegExp(datePatternSource, 'gi'), '')
        .replace(/\b(?:hide|reply|share|save|举报)\b/gi, '')
        .replace(/[|｜·•,，:：-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function isAuthorText(value: string): boolean {
      const clean = cleanAuthorText(value);
      if (clean.length < 2 || clean.length > 60) return false;
      if (dateMatch(clean) || scoreMatch(clean) || commentMatch(clean)) return false;
      if (/^(?:hide|reply|share|save|more|next|previous|login|submit|discuss)$/i.test(clean)) return false;
      if (/^https?:\/\//i.test(clean)) return false;
      return /[\p{L}\p{N}_-]/u.test(clean);
    }

    function candidateValue(element: Element): string {
      return readableText(element).replace(/\s+/g, ' ').trim();
    }

    function allVisibleElements(root: Element): Element[] {
      return [root, ...Array.from(root.querySelectorAll('*'))].filter(visible);
    }

    function bestTextElement(root: Element, accept: (value: string, element: Element) => boolean, score: (value: string, element: Element) => number): Element | null {
      return allVisibleElements(root)
        .map((element) => ({ element, value: candidateValue(element) }))
        .filter((item) => item.value && item.value.length <= 260 && accept(item.value, item.element))
        .sort((a, b) => score(b.value, b.element) - score(a.value, a.element) || a.value.length - b.value.length)[0]?.element || null;
    }

    function findScoreElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(scoreMatch(value)),
        (value, element) => {
          const exact = scoreMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /score|point|vote|like|upvote|票|赞/i.test(elementIdentity(element)) ? 0.5 : 0;
          return exact + semantic - Math.max(0, value.length - 40) / 100;
        }
      );
    }

    function findCommentElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(commentMatch(value)),
        (value, element) => {
          const exact = commentMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /comment|reply|discuss|answer|bubble|message|chat|评论|回复|讨论/i.test(elementIdentity(element)) ? 0.7 : 0;
          return exact + semantic - Math.max(0, value.length - 50) / 120;
        }
      );
    }

    function findDateElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value) => Boolean(dateMatch(value)),
        (value, element) => {
          const exact = dateMatch(value) === value.trim() ? 0.7 : 0;
          const semantic = /date|time|age|posted|publish|created|updated|时间|日期/i.test(elementIdentity(element)) ? 0.6 : 0;
          return exact + semantic - Math.max(0, value.length - 40) / 100;
        }
      );
    }

    function findAuthorElement(metadata: Element): Element | null {
      return bestTextElement(
        metadata,
        (value, element) => {
          if (!isAuthorText(value)) return false;
          const identity = elementIdentity(element);
          return /author|byline|user|nick|profile|member|hnuser|作者|用户/i.test(identity)
            || /(?:^|\s)by\s+\S/i.test(text(metadata))
            || /^a$/i.test(element.tagName) && /user|author|profile|member/i.test((element as HTMLAnchorElement).href || identity);
        },
        (value, element) => {
          const identity = elementIdentity(element);
          const semantic = /author|byline|user|nick|profile|member|hnuser|作者|用户/i.test(identity) ? 0.9 : 0;
          const link = /^a$/i.test(element.tagName) ? 0.3 : 0;
          const clean = cleanAuthorText(value);
          return semantic + link - Math.max(0, clean.length - 24) / 80;
        }
      );
    }

    function metadataScore(row: Element, metadata: Element): number {
      const value = text(metadata);
      if (!value || value.length > 320) return -Infinity;
      const rowRect = row.getBoundingClientRect();
      const rect = metadata.getBoundingClientRect();
      if (rect.top < rowRect.top - 4) return -Infinity;
      if (rect.top > rowRect.bottom + Math.max(180, rowRect.height * 2.5)) return -Infinity;
      let score = 0;
      if (/(^|\s)by\s+\S|author|byline|user|profile|member|作者|用户/i.test(`${value} ${elementIdentity(metadata)}`)) score += 0.35;
      if (dateMatch(value)) score += 0.25;
      if (scoreMatch(value)) score += 0.22;
      if (commentMatch(value)) score += 0.22;
      if (/meta|subtext|byline|footer|details|stats|score|comment|reply|info|secondary/i.test(elementIdentity(metadata))) score += 0.2;
      if (rect.height <= Math.max(80, rowRect.height * 2.5)) score += 0.1;
      return score;
    }

    function findAdjacentMetadataRow(row: Element, selectedRows: Set<Element>): Element | null {
      const parent = row.parentElement;
      if (!parent) return null;
      const siblings = Array.from(parent.children);
      const rowIndex = siblings.indexOf(row);
      if (rowIndex < 0) return null;
      for (let index = rowIndex + 1; index < siblings.length && index <= rowIndex + 3; index += 1) {
        const sibling = siblings[index];
        if (!(sibling instanceof Element) || !visible(sibling)) continue;
        if (selectedRows.has(sibling)) return null;
        if (!text(sibling)) continue;
        const score = metadataScore(row, sibling);
        if (score >= 0.55) return sibling;
      }
      return null;
    }

    function entryFor(row: Element, metadata: Element, name: string, element: Element | null, operations?: FieldInfo['operations']): MetadataEntry | null {
      if (!element) return null;
      const relativeXPath = relativePathFromRowToMetadataTarget(row, metadata, element);
      if (!relativeXPath) return null;
      return {
        name,
        kind: 'text',
        selector: element.tagName.toLowerCase(),
        relativeSelector: element.tagName.toLowerCase(),
        relativeXPath,
        operations
      };
    }

    function metadataEntriesForPair(pair: MetadataPair): MetadataEntry[] {
      const entries = [
        entryFor(pair.row, pair.metadata, 'score', findScoreElement(pair.metadata), [{ type: 'regex_match', params: [scorePatternSource] }]),
        entryFor(pair.row, pair.metadata, 'author', findAuthorElement(pair.metadata)),
        entryFor(pair.row, pair.metadata, 'date', findDateElement(pair.metadata), [{ type: 'regex_match', params: [datePatternSource] }]),
        entryFor(pair.row, pair.metadata, 'comments', findCommentElement(pair.metadata), [{ type: 'regex_match', params: [commentPatternSource] }])
      ];
      return entries.filter((entry): entry is MetadataEntry => Boolean(entry));
    }

    function supportsField(name: string, value: string): boolean {
      if (!value) return false;
      if (name === 'score') return isScoreValue(value);
      if (name === 'comments') return isCommentValue(value);
      if (name === 'date') return Boolean(dateMatch(value));
      if (name === 'author') return isAuthorText(value);
      return Boolean(value);
    }

    function pathSupportsField(name: string, pair: MetadataPair, path: string, operations?: FieldInfo['operations']): boolean {
      return supportsField(name, fieldValue(pair.row, path, 'text', operations));
    }

    function buildRelativeXPath(name: string, pairs: MetadataPair[], entries: MetadataEntry[]): string {
      const paths = Array.from(new Set(entries.map((entry) => entry.relativeXPath).filter(Boolean)));
      const uncovered = new Set(pairs.map((_, index) => index));
      const selected: string[] = [];
      while (uncovered.size && selected.length < 4) {
        const best = paths
          .filter((path) => !selected.includes(path))
          .map((path) => {
            const operations = entries.find((entry) => entry.relativeXPath === path)?.operations;
            return {
              path,
              covered: Array.from(uncovered).filter((index) => pathSupportsField(name, pairs[index], path, operations))
            };
          })
          .filter((item) => item.covered.length)
          .sort((a, b) => b.covered.length - a.covered.length || a.path.length - b.path.length)[0];
        if (!best) break;
        selected.push(best.path);
        best.covered.forEach((index) => uncovered.delete(index));
      }
      return selected.length ? selected.join(' | ') : paths[0] || '';
    }

    function existingFieldHasName(item: CandidateInput, names: string[]): boolean {
      return item.fields.some((field) => names.some((name) => field.name.toLowerCase() === name.toLowerCase()));
    }

    function shouldSkipName(item: CandidateInput, name: string): boolean {
      if (name === 'author') return existingFieldHasName(item, ['author', '作者', 'user', '用户']);
      if (name === 'date') return existingFieldHasName(item, ['date', 'time', '时间', '日期']);
      if (name === 'comments') return existingFieldHasName(item, ['comments', 'comment', '评论', '回复', '讨论']);
      if (name === 'score') return existingFieldHasName(item, ['score', 'points', 'votes', 'likes', '票数', '评分', '赞']);
      return existingFieldHasName(item, [name]);
    }

    const result: Record<string, { fields: FieldInfo[]; sampleRows: Record<string, string>[] }> = {};
    for (const item of items as CandidateInput[]) {
      const rows = evaluateXPath(item.itemXPath).filter(visible).slice(0, 8);
      if (rows.length < 3) continue;
      const selectedRows = new Set<Element>(rows);
      const pairs = rows
        .map((row) => ({ row, metadata: findAdjacentMetadataRow(row, selectedRows) }))
        .filter((pair): pair is MetadataPair => Boolean(pair.metadata));
      if (pairs.length < Math.max(2, Math.ceil(rows.length * 0.5))) continue;

      const entries = pairs.flatMap(metadataEntriesForPair);
      const outputFields: FieldInfo[] = [];
      for (const name of ['score', 'author', 'date', 'comments']) {
        if (shouldSkipName(item, name)) continue;
        const nameEntries = entries.filter((entry) => entry.name === name);
        if (!nameEntries.length) continue;
        const relativeXPath = buildRelativeXPath(name, pairs, nameEntries);
        if (!relativeXPath) continue;
        const template = nameEntries.find((entry) => relativeXPath.includes(entry.relativeXPath)) || nameEntries[0];
        const samples = pairs
          .map((pair) => fieldValue(pair.row, relativeXPath, 'text', template.operations))
          .filter((value) => supportsField(name, value))
          .slice(0, 3);
        const minSamples = pairs.length >= 3 ? 2 : 1;
        if (samples.length < minSamples) continue;
        outputFields.push({
          name,
          kind: 'text',
          selector: template.selector,
          xpath: absoluteFieldXPath(item.itemXPath, relativeXPath),
          relativeSelector: template.relativeSelector,
          relativeXPath,
          ...(template.operations ? { operations: template.operations } : {}),
          samples
        });
      }
      if (!outputFields.length) continue;
      const pairByRow = new Map<Element, MetadataPair>(pairs.map((pair) => [pair.row, pair]));
      const sampleLimit = Math.max(1, Math.min(rows.length, item.sampleRowCount || 3));
      const sampleRows = rows.slice(0, sampleLimit).map((rowElement) => {
        const pair = pairByRow.get(rowElement);
        const row: Record<string, string> = {};
        if (!pair) return row;
        for (const field of outputFields) {
          const value = fieldValue(pair.row, field.relativeXPath || '.', field.kind, field.operations);
          if (supportsField(field.name, value)) row[field.name] = value;
        }
        return row;
      });
      result[item.id] = { fields: outputFields, sampleRows };
    }
    return result;
  }, input) as Record<string, { fields: DetectedField[]; sampleRows: Record<string, string>[] }>;

  return candidates.map((candidate) => {
    const augmented = augmentedById[candidate.id];
    if (!augmented?.fields.length) return candidate;
    const existing = new Set(candidate.fields.map((field) => `${field.name.toLowerCase()}:${field.kind}`));
    const fields = [
      ...candidate.fields,
      ...augmented.fields.filter((field) => !existing.has(`${field.name.toLowerCase()}:${field.kind}`))
    ];
    const sampleRows = candidate.sampleRows.length
      ? candidate.sampleRows.map((row, index) => ({ ...row, ...(augmented.sampleRows[index] ?? {}) }))
      : augmented.sampleRows;
    return {
      ...candidate,
      fields,
      sampleRows,
      reasons: candidate.reasons.some((reason) => /adjacent metadata/i.test(reason))
        ? candidate.reasons
        : [...candidate.reasons, 'Fields augmented from adjacent metadata rows']
    };
  });
}

async function detectDetails(page: Page): Promise<RawCandidate[]> {
  const detail = await page.evaluate(() => {
    function text(element: Element | null): string {
      return ((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function selector(element: Element): string {
      if ((element as HTMLElement).id) return `#${CSS.escape((element as HTMLElement).id)}`;
      return element.tagName.toLowerCase();
    }
    function styleTextLike(value: string): boolean {
      const cssTokenCount = (value.match(/--weui-|data_color_scheme|rgba?\(|#[0-9a-f]{3,8}\b|ACTIVE-|BG-|FG-/gi) ?? []).length;
      return cssTokenCount >= 8 || /--weui-[\s\S]{80,}/i.test(value) || /\.data_color_scheme_dark\{/i.test(value);
    }
    function fieldDiagnostics(element: Element) {
      const value = text(element);
      const paragraphCount = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20).length;
      const warnings: string[] = [];
      if (value.length < 300) warnings.push('content text looks short');
      if (paragraphCount <= 1) warnings.push('content has too few paragraphs');
      if (styleTextLike(value)) warnings.push('text contains CSS/style noise');
      return {
        matchCount: 1,
        textLength: value.length,
        paragraphCount,
        hasStyleNoise: styleTextLike(value),
        warnings
      };
    }
    function contentScore(element: Element): number {
      const tag = element.tagName.toLowerCase();
      if (/^(script|style|noscript|nav|footer|header|aside|button|input|select|textarea)$/i.test(tag)) return -Infinity;
      const value = text(element);
      if (value.length < 120 || value.length > 20000 || styleTextLike(value)) return -Infinity;
      const rect = element.getBoundingClientRect();
      const paragraphs = Array.from(element.querySelectorAll('p')).filter((item) => text(item).length >= 20);
      const linkText = Array.from(element.querySelectorAll('a')).map((item) => text(item)).join(' ');
      const linkDensity = linkText.length / Math.max(1, value.length);
      if (linkDensity > 0.35) return -Infinity;
      const sentenceMarks = (value.match(/[。！？!?；;，,]/g) ?? []).length;
      const centerPenalty = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) / Math.max(1, window.innerWidth);
      let score = 0;
      score += Math.min(5, value.length / 500);
      score += Math.min(4, paragraphs.length);
      score += Math.min(2, sentenceMarks * 0.12);
      score -= centerPenalty;
      if (element.querySelector('h1,h2,h3')) score -= 0.9;
      return score;
    }
    function contentRoot(base: Element): Element | null {
      const candidates = [base, ...Array.from(base.querySelectorAll('article,main,section,div,[class*="article" i],[class*="content" i],[id*="article" i],[id*="content" i]'))]
        .filter((element, index, array) => array.indexOf(element) === index)
        .map((element) => ({ element, score: contentScore(element) }))
        .filter((item) => Number.isFinite(item.score))
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.element ?? null;
    }
    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    const bodyRoot = contentRoot(root) || root;
    const title = document.querySelector('h1') || root.querySelector('h1,h2');
    const time = root.querySelector('time,[datetime],[class*="date" i],[class*="time" i]');
    const author = root.querySelector('[class*="author" i],[rel="author"]');
    const paragraphs = Array.from(bodyRoot.querySelectorAll('p')).map((p) => text(p)).filter((value) => value.length > 20);
    const contentValue = text(bodyRoot) || paragraphs.join(' ');
    const price = root.querySelector('[class*="price" i],[data-price]');
    const image = root.querySelector('img') as HTMLImageElement | null;
    return {
      rootSelector: selector(root),
      rootXPath: xpath(root),
      fields: {
        title: title ? { value: text(title), xpath: xpath(title), selector: selector(title) } : null,
        time: time ? { value: text(time) || (time as HTMLElement).getAttribute('datetime') || '', xpath: xpath(time), selector: selector(time) } : null,
        author: author ? { value: text(author), xpath: xpath(author), selector: selector(author) } : null,
        price: price ? { value: text(price) || (price as HTMLElement).getAttribute('data-price') || '', xpath: xpath(price), selector: selector(price) } : null,
        content: contentValue ? { value: contentValue, xpath: xpath(bodyRoot), selector: selector(bodyRoot), diagnostics: fieldDiagnostics(bodyRoot) } : null,
        image: image?.src ? { value: image.src, xpath: xpath(image), selector: selector(image) } : null
      }
    };
  });
  const fields: DetectedField[] = [];
  for (const [name, value] of Object.entries(detail.fields)) {
    if (!value?.value) continue;
    fields.push({
      name,
      kind: name === 'image' ? 'src' : 'text',
      selector: value.selector,
      xpath: value.xpath,
      relativeSelector: value.selector,
      relativeXPath: value.xpath,
      ...(name === 'content' && 'diagnostics' in value && value.diagnostics ? { diagnostics: value.diagnostics as DetectedFieldDiagnostics } : {}),
      ...(name === 'content' ? { operations: contentCleanupOperations() } : {}),
      samples: [value.value].filter(Boolean)
    });
  }
  const meaningful = fields.filter((field) => field.name !== 'image');
  if (meaningful.length < 2) return [];
  return [{
    type: 'detail',
    selector: detail.rootSelector,
    xpath: detail.rootXPath,
    itemSelector: detail.rootSelector,
    itemXPath: detail.rootXPath,
    itemCount: 1,
    fields,
    sampleRows: [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))],
    reasons: ['Single detail page with semantic fields'],
    confidence: scoreCandidate({ itemCount: 1, fieldCount: fields.length, semantic: fields.some((field) => field.name === 'title') ? 1 : 0, penalty: 0.05 })
  }];
}

async function submitInputs(host: ExtensionDetectorHost, options: DetectOptions, inputOverrides?: Map<string, SearchInputCandidate>): Promise<DetectedSearchPlan | undefined> {
  const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
  await debugSearchTabs('before-submit', host, options, beforePages).catch(() => undefined);
  const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
  const entries = Object.entries(options.input ?? {});
  debugSearchSubmitDecision('submit-inputs-start', undefined, { entries: entries.map(([name, value]) => ({ name, value })) });
  const resolvedInputOverrides = await resolveSearchInputOverrides(host.page, entries.map(([name]) => name), inputOverrides);
  const inputOnlyPlan = await inputSearchFieldsOnly(host, options, resolvedInputOverrides);
  const inputs = inputOnlyPlan?.inputs ?? [];
  const lastInputXPath = inputs[inputs.length - 1]?.xpath || '';
  const preferredSubmitButtons: SearchSubmitButton[] = [];
  for (const [name] of entries) {
    const override = resolvedInputOverrides.get(name);
    debugSearchSubmitDecision('input-resolved', undefined, {
      name,
      inputXPath: inputs.find((input) => input.name === name)?.xpath,
      override: override ? {
        xpath: override.xpath,
        score: override.score,
        buttonXPath: override.buttonXPath,
        reasons: override.reasons
      } : undefined
    });
    if (override?.buttonXPath) preferredSubmitButtons.push({ xpath: override.buttonXPath, ...(override.buttonText ? { text: override.buttonText } : {}) });
  }

  debugSearchSubmitDecision('before-click-submit', undefined, { inputs, preferredSubmitButtons });
  let effectiveSubmit = await clickSubmit(host, options.submit, options.timeoutMs, inputs, preferredSubmitButtons).catch((_error) => {
    debugSearchSubmitDecision('click-submit-error', undefined, { error: String(_error?.message || _error) });
    return undefined;
  });
  let submit: DetectedSearchPlan['submit'] | undefined = effectiveSubmit
    ? { mode: 'click', xpath: effectiveSubmit.xpath, ...(effectiveSubmit.text ? { text: effectiveSubmit.text } : {}) }
    : undefined;
  if (!effectiveSubmit && lastInputXPath) {
    debugSearchSubmitDecision('geometry-fallback-start', undefined, { lastInputXPath });
    effectiveSubmit = await clickSearchSubmitByGeometry(host, lastInputXPath, options.timeoutMs).catch(() => undefined);
    if (effectiveSubmit) submit = { mode: 'click', xpath: effectiveSubmit.xpath, ...(effectiveSubmit.text ? { text: effectiveSubmit.text } : {}) };
  }
  if (!effectiveSubmit && lastInputXPath) {
    debugSearchSubmitDecision('enter-fallback-start', undefined, { lastInputXPath });
    const value = entries[entries.length - 1]?.[1] ?? '';
    await host.command({
      action: 'input',
      frame: { isIframe: false },
      target: { type: 'xpath', xpath: lastInputXPath },
      timeoutMs: options.timeoutMs,
      payload: {
        text: value,
        mode: 'native-setter',
        clearBeforeInput: false,
        submit: 'enter',
        dispatchEvents: ['input', 'change']
      }
    }).catch((error) => {
      if (!options.manual) throw error;
    });
    submit = { mode: 'enter' };
  }
  await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
  await debugSearchTabs('after-submit-wait', host, options, beforePages).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    if (!inputs.length) return undefined;
    return {
      startUrl: options.url,
      finalUrl: host.page.url(),
      inputs,
      ...(submit ? { submit } : {})
    };
  }
  await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
  await debugSearchTabs('after-new-page-adopt', host, options, beforePages).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    if (!inputs.length) return undefined;
    return {
      startUrl: options.url,
      finalUrl: host.page.url(),
      inputs,
      ...(submit ? { submit } : {})
    };
  }
  await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
  await debugSearchTabs('after-best-page-adopt', host, options, beforePages).catch(() => undefined);
  await host.refreshTabId().catch(() => undefined);
  if (!inputs.length) return undefined;
  return {
    startUrl: options.url,
    finalUrl: host.page.url(),
    inputs,
    ...(submit ? { submit } : {})
  };
}

async function resolveSearchInputOverrides(page: Page, names: string[], existing?: Map<string, SearchInputCandidate>): Promise<Map<string, SearchInputCandidate>> {
  const resolved = new Map(existing ?? []);
  for (const name of names) {
    if (resolved.has(name)) continue;
    const candidate = (await findSearchInputCandidates(page, name).catch(() => []))[0];
    if (candidate) resolved.set(name, candidate);
  }
  return resolved;
}

async function retrySearchWithEnter(host: ExtensionDetectorHost, options: DetectOptions, existingPlan: DetectedSearchPlan | undefined): Promise<DetectedSearchPlan | undefined> {
  const entries = Object.entries(options.input ?? {});
  const last = entries[entries.length - 1];
  const lastInput = existingPlan?.inputs[existingPlan.inputs.length - 1];
  if (!last || !lastInput?.xpath) return existingPlan;
  const beforePages = new Set<Page>((await host.browser()?.pages().catch(() => []) ?? []).filter((page) => !page.isClosed()));
  const newPageWatcher = watchNewPage(host.browser(), beforePages, Math.min(options.timeoutMs, 12_000));
  await host.command({
    action: 'input',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: lastInput.xpath },
    timeoutMs: options.timeoutMs,
    payload: {
      text: last[1],
      mode: 'native-setter',
      clearBeforeInput: false,
      submit: 'enter',
      dispatchEvents: ['input', 'change']
    }
  }).catch((error) => {
    if (!options.manual) throw error;
  });
  await waitAfterSearchSubmitOrLogin(host.page, Math.min(options.timeoutMs, 12_000));
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    return existingPlan
      ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
      : undefined;
  }
  await adoptNewSearchPage(host, options, newPageWatcher).catch(() => undefined);
  if (await pageHasSearchLoginGate(host.page).catch(() => false)) {
    await host.refreshTabId().catch(() => undefined);
    return existingPlan
      ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
      : undefined;
  }
  await adoptBestPageAfterSearch(host, options, beforePages).catch(() => undefined);
  await host.refreshTabId().catch(() => undefined);
  return existingPlan
    ? { ...existingPlan, finalUrl: host.page.url(), submit: { mode: 'enter' } }
    : undefined;
}

async function debugSearchTabs(label: string, host: ExtensionDetectorHost, options: DetectOptions, beforePages: Set<Page>): Promise<void> {
  if (process.env.OCTOPARSE_TRACKING_DEBUG !== '1') return;
  const browser = host.browser();
  if (!browser) return;
  const pages = (await browser.pages()).filter((page) => !page.isClosed());
  const tabs = await Promise.all(pages.map(async (page, index) => ({
    index,
    current: page === host.page,
    isNew: !beforePages.has(page),
    url: page.url(),
    title: await page.title().catch(() => ''),
    score: await scoreSearchResultPage(page, options, !beforePages.has(page), index, pages.length).catch(() => null)
  })));
  process.stderr.write(`[detect-debug] search tabs ${label}: ${JSON.stringify(tabs, null, 2)}\n`);
}

async function waitAfterSearchSubmitOrLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(1200, timeoutMs);
  const pollMs = 300;
  const stableMs = 1200;
  let lastUrl = '';
  let lastTextLength = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const snapshot = await searchSubmitSnapshot(page).catch(() => undefined);
    if (!snapshot) {
      await delay(pollMs);
      continue;
    }
    if (snapshot.hasLoginGate || snapshot.hasResultContent) return;

    const textDelta = Math.abs(snapshot.textLength - lastTextLength);
    const stable = snapshot.url === lastUrl && textDelta < 80 && snapshot.readyState !== 'loading';
    if (!stable) {
      lastUrl = snapshot.url;
      lastTextLength = snapshot.textLength;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
    await delay(pollMs);
  }
}

async function pageHasSearchLoginGate(page: Page): Promise<boolean> {
  const snapshot = await searchSubmitSnapshot(page).catch(() => undefined);
  return Boolean(snapshot?.hasLoginGate);
}

async function searchSubmitSnapshot(page: Page): Promise<{
  url: string;
  readyState: string;
  textLength: number;
  hasLoginGate: boolean;
  hasResultContent: boolean;
}> {
  return page.evaluate(() => {
    const visible = (element: Element | null): boolean => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 40 && rect.height > 30 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const text = (document.body?.textContent || '').replace(/\s+/g, ' ');
    const modal = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="login" i],[class*="passport" i],[class*="mask" i]')).some(visible);
    const loginInput = Array.from(document.querySelectorAll('input[type="password"],input[type="tel"],input[name*="phone" i],input[name*="mobile" i],input[name*="code" i],input[placeholder*="验证码"],input[placeholder*="手机"],input[placeholder*="密码"]')).some(visible);
    const hasLoginGate = Boolean((modal || loginInput) && /登录|登陆|注册|验证|验证码|手机号|手机号码|微信登录|扫码|人机|login|sign in|register|verification|verify|captcha/i.test(text));
    const resultBlocks = Array.from(document.querySelectorAll('article,main section,main div,li,tr,[class*="result" i],[class*="list" i],[class*="item" i],[class*="article" i],[class*="content" i]'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 40)
      .slice(0, 8);
    const links = Array.from(document.querySelectorAll('main a,article a,section a,li a,[class*="result" i] a,[class*="item" i] a'))
      .filter(visible)
      .filter((element) => (element.textContent || '').replace(/\s+/g, ' ').trim().length >= 4)
      .slice(0, 8);
    return {
      url: location.href,
      readyState: document.readyState,
      textLength: text.length,
      hasLoginGate,
      hasResultContent: text.length >= 600 && resultBlocks.length >= 2 && links.length >= 2
    };
  });
}

async function confirmSearchInputsInteractively(host: ExtensionDetectorHost, options: DetectOptions, runtimeConsole: SuppressedRuntimeConsole): Promise<Map<string, SearchInputCandidate> | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const entries = Object.entries(options.input ?? {});
  if (!entries.length) return undefined;
  const selected = new Map<string, SearchInputCandidate>();
  runtimeConsole.restore();
  try {
    for (const [name, value] of entries) {
      await adoptBestPageForSearchInput(host, options).catch(() => undefined);
      let candidates = await findSearchInputCandidates(host.page, name);
      while (!candidates.length) {
        const action = await chooseSearchInputRetryInBrowser(host.page, name, value, runtimeConsole)
          .catch(() => chooseSearchInputRetryInCli(name, value));
        if (action === 'retry') {
          await adoptBestPageForSearchInput(host, options).catch(() => undefined);
          candidates = await findSearchInputCandidates(host.page, name);
          continue;
        }
        throw new Error('User canceled search input confirmation');
      }
      if (candidates.length <= 1 && (candidates[0]?.score ?? 0) >= 1.5) {
        selected.set(name, candidates[0]);
        continue;
      }
      const action = await chooseSearchInputCandidateInBrowser(host.page, name, value, candidates, runtimeConsole)
        .catch(() => chooseSearchInputCandidateInCli(name, value, candidates));
      if (action === 'cancel' || !action) throw new Error('User canceled search input confirmation');
      const index = Number(String(action).replace('candidate:', ''));
      if (Number.isFinite(index) && candidates[index]) selected.set(name, candidates[index]);
    }
  } finally {
    await removeManualOverlay(host.page).catch(() => undefined);
    runtimeConsole.suppress();
  }
  return selected.size ? selected : undefined;
}

async function chooseSearchInputRetryInBrowser(
  page: Page,
  name: string,
  value: string,
  runtimeConsole: SuppressedRuntimeConsole
): Promise<'retry' | 'cancel'> {
  writeManualOverlayHintOnce(runtimeConsole, page, `search-input-retry:${name}`, `\nUse the browser overlay to continue: no search input was detected for ${name} = ${value}\n`);
  await showManualOverlay(page, {
    title: 'No search input detected',
    message: `Open or focus the search box on the page, then detect again.\nKeyword: ${name} = ${value}`,
    choices: [
      { title: 'Detect again', value: 'retry', primary: true },
      { title: 'Cancel search detection', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  return selection?.action === 'retry' ? 'retry' : 'cancel';
}

async function chooseSearchInputRetryInCli(name: string, value: string): Promise<'retry' | 'cancel'> {
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: `No usable search input was detected: ${name} = ${value}`,
    choices: [
      { title: 'I opened/focused the search box in the browser; detect again', description: 'Use this when the site hides search behind a popup, button, or login state.', value: 'retry' },
      { title: 'Cancel search detection', description: 'Stop this detect run to avoid choosing the wrong input.', value: 'cancel' }
    ],
    initial: 0
  });
  return response.action === 'retry' ? 'retry' : 'cancel';
}

async function chooseSearchInputCandidateInBrowser(
  page: Page,
  name: string,
  value: string,
  candidates: SearchInputCandidate[],
  runtimeConsole: SuppressedRuntimeConsole
): Promise<ManualOverlayAction> {
  const visibleCandidates = candidates.slice(0, 5);
  writeManualOverlayHintOnce(runtimeConsole, page, `search-input-candidate:${name}`, `\nUse the browser overlay to confirm the search input: ${name} = ${value}\n`);
  await showManualOverlay(page, {
    title: 'Confirm search input',
    message: `Keyword: ${name} = ${value}`,
    status: `Recommended: ${searchInputCandidateLabel(visibleCandidates[0])}`,
    highlightXPaths: visibleCandidates.map((candidate) => candidate.xpath),
    choices: [
      ...visibleCandidates.map((candidate, index): ManualOverlayChoice => ({
        title: `${index === 0 ? 'Use recommended input' : `Use candidate ${index + 1}`}`,
        value: `candidate:${index}`,
        description: `${searchInputCandidateLabel(candidate)} | ${candidate.xpath}`,
        primary: index === 0
      })),
      { title: 'Cancel search detection', value: 'cancel' }
    ]
  });
  const selection = await waitForManualOverlayAction(page);
  await clearManualOverlayAction(page);
  return selection?.action || 'cancel';
}

async function chooseSearchInputCandidateInCli(name: string, value: string, candidates: SearchInputCandidate[]): Promise<ManualOverlayAction> {
  const choices = candidates.slice(0, 5).map((candidate, index) => ({
    title: `${index === 0 ? 'Recommended: ' : ''}${searchInputCandidateLabel(candidate)}`,
    description: `XPath: ${candidate.xpath}${candidate.buttonXPath ? ` | submit: ${candidate.buttonText || candidate.buttonXPath}` : ' | submit: Enter fallback'}`,
    value: `candidate:${index}`
  }));
  choices.push({ title: 'Cancel search detection', description: 'Stop this detect run to avoid choosing the wrong input.', value: 'cancel' });
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: `Confirm search input: ${name} = ${value}`,
    choices,
    initial: 0
  });
  return response.action || 'cancel';
}

function searchInputCandidateLabel(candidate: SearchInputCandidate): string {
  const parts = [
    `score=${candidate.score}`,
    candidate.name ? `name=${candidate.name}` : '',
    candidate.type ? `type=${candidate.type}` : '',
    candidate.placeholder ? `placeholder=${truncateText(candidate.placeholder, 30)}` : '',
    candidate.buttonText ? `button=${truncateText(candidate.buttonText, 20)}` : ''
  ].filter(Boolean);
  return parts.join('  ');
}

async function findInputXPath(page: Page, name: string): Promise<string> {
  const candidates = await findSearchInputCandidates(page, name);
  return candidates[0]?.xpath ?? '';
}

async function searchInputNeedsDomEntry(page: Page, xpath: string): Promise<boolean> {
  return page.evaluate((path) => {
    const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue;
    if (!(element instanceof HTMLElement)) return false;
    return !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement);
  }, xpath);
}

async function setSearchInputValueByDom(page: Page, xpath: string, value: string): Promise<boolean> {
  return page.evaluate((input) => {
    const result = document.evaluate(input.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const element = result.singleNodeValue;
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = input.value;
    } else {
      element.textContent = input.value;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    return true;
  }, { xpath, value });
}

async function findSearchInputCandidates(page: Page, name: string): Promise<SearchInputCandidate[]> {
  return page.evaluate((inputName) => {
    type Candidate = {
      xpath: string;
      name: string;
      type: string;
      placeholder: string;
      value: string;
      formAction: string;
      buttonXPath?: string;
      buttonText?: string;
      score: number;
      reasons: string[];
    };
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function stringAttr(value: unknown): string {
      return String(value || '');
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 20 && rect.height >= 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element | null | undefined): string {
      if (!element) return '';
      return ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent) || '').trim();
    }
    function attrsOf(element: Element): string {
      return [
        element.tagName,
        stringAttr((element as HTMLElement).id),
        stringAttr((element as HTMLElement).className),
        element.getAttribute('name') || '',
        element.getAttribute('data-name') || '',
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || '',
        element.getAttribute('href') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('data-placeholder') || '',
        element.getAttribute('contenteditable') || ''
      ].join(' ');
    }
    function childAttrsOf(element: Element): string {
      return Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
        .map((child) => attrsOf(child))
        .join(' ');
    }
    function ancestorAttrsOf(element: Element, maxDepth = 5): string {
      const parts: string[] = [];
      let current = element.parentElement;
      for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
        parts.push(attrsOf(current));
      }
      return parts.join(' ');
    }
    function inputNameOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.name || ''
        : element.getAttribute('name') || element.getAttribute('data-name') || '';
    }
    function inputTypeOf(element: Element): string {
      if (element instanceof HTMLTextAreaElement) return 'textarea';
      if (element instanceof HTMLInputElement) return element.type || 'text';
      const role = element.getAttribute('role') || '';
      if (/^(textbox|searchbox)$/i.test(role)) return role.toLowerCase();
      if (/^(true|plaintext-only)$/i.test(element.getAttribute('contenteditable') || '')) return 'contenteditable';
      return element.tagName.toLowerCase();
    }
    function placeholderOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.placeholder || ''
        : element.getAttribute('placeholder') || element.getAttribute('data-placeholder') || element.getAttribute('aria-label') || element.getAttribute('title') || '';
    }
    function valueOf(element: Element): string {
      return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value || '' : textOf(element);
    }
    function editableLike(element: Element): boolean {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return true;
      const role = element.getAttribute('role') || '';
      return /^(textbox|searchbox)$/i.test(role) || /^(true|plaintext-only)$/i.test(element.getAttribute('contenteditable') || '');
    }
    function allowedEditable(element: Element): boolean {
      if (element instanceof HTMLTextAreaElement) return true;
      if (element instanceof HTMLInputElement) {
        const type = (element.type || 'text').toLowerCase();
        return /^(search|text|url|email|tel|number)$/i.test(type);
      }
      return editableLike(element);
    }
    function searchSemantic(text: string): boolean {
      return /搜索|搜一搜|搜一下|查询|检索|关键词|关键字|找内容|Search|search|query|keyword|searchbox/i.test(text);
    }
    function weakSearchSemantic(text: string): boolean {
      return searchSemantic(text) || /探索|发现|输入.*问题|ask|find/i.test(text);
    }
    function badInputSemantic(text: string): boolean {
      return /登录|登陆|注册|手机号|手机号码|验证码|密码|邮箱|评论|留言|回复|发布|正文|描述|手机号|phone|mobile|password|captcha|verify|verification|comment|reply|message|editor|compose|subscribe|email/i.test(text);
    }
    function insideLoginOrVerificationOverlay(element: Element): boolean {
      let current: Element | null = element.parentElement;
      for (let depth = 0; current && current !== document.body && depth < 8; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        const value = `${attrs} ${textOf(current)}`.replace(/\s+/g, ' ').slice(0, 1000);
        const modalLike = /dialog|modal|popup|pop|mask|overlay|login|signin|passport|auth|登录|登陆|注册/i.test(attrs)
          || current.getAttribute('aria-modal') === 'true'
          || current.getAttribute('role') === 'dialog';
        const style = window.getComputedStyle(current as HTMLElement);
        const rect = current.getBoundingClientRect();
        const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
        const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
        const centered = rect.left < viewportWidth * 0.76 && rect.right > viewportWidth * 0.24 && rect.top < viewportHeight * 0.78 && rect.bottom > viewportHeight * 0.14;
        const bodyStyle = (document.body as HTMLElement | null)?.style;
        const documentStyle = (document.documentElement as HTMLElement | null)?.style;
        const scrollLocked = bodyStyle?.overflow === 'hidden' || documentStyle?.overflow === 'hidden';
        const overlayEvidence = modalLike
          || style.position === 'fixed'
          || style.position === 'sticky'
          || Number.parseInt(style.zIndex || '0', 10) >= 10
          || scrollLocked;
        const loginLike = /登录|登陆|注册|手机号|手机号码|验证码|密码|微信|扫码|phone|mobile|captcha|verify|verification|password|login|sign in|register/i.test(value);
        if (overlayEvidence && centered && modalLike && loginLike) return true;
      }
      return false;
    }
    function searchInputLike(element: Element): boolean {
      if (!allowedEditable(element)) return false;
      if (insideLoginOrVerificationOverlay(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 10) return false;
      const attrs = `${attrsOf(element)} ${ancestorAttrsOf(element, 4)}`;
      const hasSearchSemantic = weakSearchSemantic(attrs);
      if (rect.height > 260 && !hasSearchSemantic) return false;
      if (rect.width < 90 && !hasSearchSemantic) return false;
      const placeholder = placeholderOf(element);
      const ownText = textOf(element);
      const semantic = weakSearchSemantic(`${attrs} ${placeholder} ${ownText}`);
      return editableLike(element) || semantic;
    }
    function isContentLink(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      if (contentDetailUrlLike(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="suggest" i],[class*="recommend" i]');
      if (!container) return false;
      const attrs = attrsOf(container);
      return !/search|toolbar|header|form|submit|button/i.test(attrs);
    }
    function contentDetailUrlLike(value: string): boolean {
      if (!value) return false;
      try {
        const path = new URL(value, location.href).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function searchScope(input: Element): ParentNode {
      const form = input.closest('form');
      if (form) return form;
      let fallback: Element | null = null;
      let current: Element | null = input.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|so-box|search-box|searchbar/i.test(attrs)) return current;
        if (!fallback && /input|textbox|textarea|输入/i.test(attrs)) fallback = current;
      }
      return fallback || input.parentElement || document;
    }
    function distance(left: Element, right: Element): number {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      return Math.hypot(ax - bx, ay - by);
    }
    function rightSideControl(input: Element, button: Element): boolean {
      const inputRect = input.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 120 && rect.height <= 120;
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function negativeSubmitControl(element: Element): boolean {
      const value = `${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`;
      return /(清除|清空|关闭|取消|删除|移除|重置|close|clear|cancel|remove|delete|reset|times|cross)/i.test(value)
        && !searchSemantic(value);
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      const attrs = attrsOf(element);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search-(?:button|btn|submit)|search_button|icon|suffix|append/i.test(attrs);
    }
    function submitTarget(input: Element, element: Element): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        if (!visible(current) || isContentLink(current)) continue;
        const rect = current.getBoundingClientRect();
        const explicitClickable = /^(button|input|a)$/i.test(current.tagName)
          || current.getAttribute('role') === 'button'
          || Boolean((current as HTMLElement).onclick)
          || Boolean(current.getAttribute('tabindex'))
          || window.getComputedStyle(current as HTMLElement).cursor === 'pointer';
        const ownsSearchInput = current !== element && Boolean(current.querySelector('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'));
        if (ownsSearchInput && (rect.width > 220 || rect.height > 180) && !explicitClickable) continue;
        if (negativeSubmitControl(current)) continue;
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(current.tagName);
        const nativeButton = /^(button|input)$/i.test(current.tagName) || current.getAttribute('role') === 'button';
        const semantic = searchSemantic(`${attrsOf(current)} ${textOf(current)} ${childAttrsOf(current)}`);
        const nearInput = rightSideControl(input, current);
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(current)) score += 2;
        if (semantic) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(current)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: current, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function scoreButton(input: Element, button: Element | null): { score: number; reasons: string[] } {
      if (!button || !visible(button)) return { score: 0, reasons: [] };
      if (isContentLink(button)) return { score: 0, reasons: [] };
      if (negativeSubmitControl(button)) return { score: 0, reasons: [] };
      const value = textOf(button);
      const attrs = `${attrsOf(button)} ${childAttrsOf(button)}`;
      const searchLike = /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(`${value} ${attrs}`);
      const nativeButton = /^(button|input)$/i.test(button.tagName) || button.getAttribute('role') === 'button';
      const nearInputIcon = rightSideControl(input, button) && compactControl(button) && (iconLike(button) || clickableLike(button));
      if (!nativeButton && !searchLike && !nearInputIcon) return { score: 0, reasons: [] };
      const reasons: string[] = ['visible submit control nearby'];
      let score = nativeButton ? 0.2 : 0.1;
      if (searchLike) {
        score += 0.55;
        reasons.push('submit text is search-like');
      }
      const dist = distance(input, button);
      if (dist < 260) {
        score += 0.25;
        reasons.push('submit control is near input');
      } else if (dist > 800) {
        score -= 0.25;
        reasons.push('submit control is far from input');
      }
      if (nearInputIcon) {
        score += 0.55;
        reasons.push('icon-like control is aligned with input');
      }
      return { score, reasons };
    }
    const escapedName = CSS.escape(inputName);
    const targetNameSelectors = [
      `input[name="${escapedName}"]`,
      `textarea[name="${escapedName}"]`,
      `[role="textbox"][name="${escapedName}"]`,
      `[role="searchbox"][name="${escapedName}"]`,
      `[contenteditable="true"][name="${escapedName}"]`,
      `[contenteditable="plaintext-only"][name="${escapedName}"]`,
      `[data-name="${escapedName}"]`
    ];
    const broadSelectors = [
      'input',
      'textarea',
      '[role="textbox"]',
      '[role="searchbox"]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]'
    ];
    const seen = new Set<Element>();
    const elements = [...targetNameSelectors, ...broadSelectors]
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => {
        if (seen.has(element) || !visible(element)) return false;
        seen.add(element);
        return searchInputLike(element);
      });
    return elements.map((input): Candidate => {
      const form = input.closest('form');
      const buttonSelector = 'button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span';
      const buttonSeen = new Set<Element>();
      const scopedButtons = [
        ...Array.from(searchScope(input).querySelectorAll(buttonSelector)),
        ...Array.from(document.querySelectorAll(buttonSelector)).filter((element) => distance(input, element) < 560 || rightSideControl(input, element))
      ]
        .map((button) => submitTarget(input, button))
        .filter((element) => {
          if (buttonSeen.has(element) || element === input || !visible(element)) return false;
          buttonSeen.add(element);
          return true;
        });
      const nearestButton = scopedButtons
        .map((button) => ({ button, distance: distance(input, button), buttonScore: scoreButton(input, button) }))
        .filter((item) => item.buttonScore.score > 0)
        .sort((a, b) => (b.buttonScore.score - a.buttonScore.score) || (a.distance - b.distance))[0];
      const inputNameValue = inputNameOf(input);
      const inputTypeValue = inputTypeOf(input);
      const placeholder = placeholderOf(input);
      const attrText = `${inputNameValue} ${stringAttr((input as HTMLElement).id)} ${inputTypeValue} ${placeholder} ${input.getAttribute('aria-label') || ''} ${input.getAttribute('title') || ''} ${stringAttr((input as HTMLElement).className)} ${input.getAttribute('data-placeholder') || ''}`;
      const ancestorText = ancestorAttrsOf(input, 5);
      const reasons: string[] = [];
      let score = 0;
      if (inputNameValue === inputName) {
        score += 1.2;
        reasons.push('exact input name match');
      }
      if (inputTypeValue === 'search' || inputTypeValue === 'searchbox') {
        score += 0.95;
        reasons.push('input type/role is search');
      }
      if (input instanceof HTMLTextAreaElement) {
        score += 0.25;
        reasons.push('textarea can accept search text');
      }
      if (editableLike(input) && !(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
        score += 0.55;
        reasons.push('custom editable textbox');
      }
      if (searchSemantic(attrText)) {
        score += 0.8;
        reasons.push('input attributes are search-like');
      }
      if (!searchSemantic(attrText) && weakSearchSemantic(attrText)) {
        score += 0.35;
        reasons.push('input attributes weakly suggest search');
      }
      if (/^(q|wd|s|query|keyword|keywords|key|search|search_text)$/i.test(inputNameValue)) {
        score += 0.55;
        reasons.push('input name is common search parameter');
      }
      if (/search|query|keyword|搜索|查询/i.test(inputNameValue)) {
        score += 0.55;
        reasons.push('input name contains search terms');
      }
      if (searchSemantic(ancestorText)) {
        score += 0.45;
        reasons.push('ancestor container is search-like');
      }
      if (form?.action && /search|query|s\?|wd=|keyword/i.test(form.action)) {
        score += 0.35;
        reasons.push('form action is search-like');
      }
      if (nearestButton) {
        score += nearestButton.buttonScore.score;
        reasons.push(...nearestButton.buttonScore.reasons);
      }
      const rect = input.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.75) {
        score += 0.15;
        reasons.push('input is in first viewport');
      }
      if (rect.width >= 120 && rect.height >= 16 && rect.height <= 180) {
        score += 0.2;
        reasons.push('input has search-box-like dimensions');
      }
      const negativeText = `${attrText} ${ancestorText}`;
      const hasStrongSearchSignal = searchSemantic(`${attrText} ${ancestorText}`);
      if (badInputSemantic(negativeText) && !hasStrongSearchSignal) {
        score -= 1.1;
        reasons.push('input looks like login/comment/composer field');
      }
      if (input instanceof HTMLTextAreaElement && rect.height > 180 && !hasStrongSearchSignal) {
        score -= 0.5;
        reasons.push('large textarea without search semantics');
      }
      return {
        xpath: xpath(input),
        name: inputNameValue,
        type: inputTypeValue,
        placeholder,
        value: valueOf(input),
        formAction: form instanceof HTMLFormElement ? form.action : '',
        ...(nearestButton?.button ? { buttonXPath: xpath(nearestButton.button), buttonText: textOf(nearestButton.button) || undefined } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }).filter((candidate) => candidate.score >= 1.05)
      .sort((a, b) => b.score - a.score);
  }, name);
}

async function clickSubmit(
  host: ExtensionDetectorHost,
  submitText: string | undefined,
  timeoutMs: number,
  inputs: SearchSubmitInputRef[] = [],
  preferredButtons: SearchSubmitButton[] = []
): Promise<SearchSubmitButton | undefined> {
  const button = await resolveSearchSubmitButton(host.page, {
    submitText,
    inputs,
    preferredButtons
  });
  debugSearchSubmitDecision('resolved', button);
  if (!button?.xpath) return undefined;

  const domEffectBaseline = await captureSearchSubmitEffectBaseline(host).catch(() => undefined);
  const domSubmitted = await submitSearchByDom(host.page, button.xpath, inputs.map((input) => input.xpath)).catch(() => false);
  const domHadEffect = domSubmitted && await waitForSearchSubmitEffect(host, domEffectBaseline, 900).catch(() => false);
  debugSearchSubmitDecision('dom-click', button, { domSubmitted, domHadEffect });
  if (domHadEffect) return button;

  debugSearchSubmitDecision('real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

async function clickRecordedSearchSubmit(
  host: ExtensionDetectorHost,
  button: SearchSubmitButton,
  timeoutMs: number,
  inputs: SearchSubmitInputRef[] = []
): Promise<SearchSubmitButton | undefined> {
  if (!button.xpath) return undefined;
  debugSearchSubmitDecision('manual-recorded-click', button);
  const domEffectBaseline = await captureSearchSubmitEffectBaseline(host).catch(() => undefined);
  const domSubmitted = await submitSearchByDom(host.page, button.xpath, inputs.map((input) => input.xpath), { allowRecorded: true }).catch(() => false);
  const domHadEffect = domSubmitted && await waitForSearchSubmitEffect(host, domEffectBaseline, 900).catch(() => false);
  debugSearchSubmitDecision('manual-recorded-dom-click', button, { domSubmitted, domHadEffect });
  if (domHadEffect) return button;
  debugSearchSubmitDecision('manual-recorded-real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

function debugSearchSubmitDecision(label: string, button: SearchSubmitButton | undefined, extra: Record<string, unknown> = {}): void {
  if (process.env.OCTOPARSE_TRACKING_DEBUG !== '1') return;
  process.stderr.write(`[detect-debug] search submit ${label}: ${JSON.stringify({ button, ...extra })}\n`);
}

async function captureSearchSubmitEffectBaseline(host: ExtensionDetectorHost): Promise<{
  url: string;
  textLength: number;
  pageCount: number;
  hasLoginGate: boolean;
  hasResultContent: boolean;
}> {
  const snapshot = await searchSubmitSnapshot(host.page).catch(() => undefined);
  const pages = await host.browser()?.pages().catch(() => []) ?? [];
  return {
    url: snapshot?.url || host.page.url(),
    textLength: snapshot?.textLength ?? -1,
    pageCount: pages.filter((page) => !page.isClosed()).length,
    hasLoginGate: snapshot?.hasLoginGate ?? false,
    hasResultContent: snapshot?.hasResultContent ?? false
  };
}

async function waitForSearchSubmitEffect(
  host: ExtensionDetectorHost,
  baseline: { url: string; textLength: number; pageCount: number; hasLoginGate: boolean; hasResultContent: boolean } | undefined,
  timeoutMs: number
): Promise<boolean> {
  if (!baseline) return false;
  const deadline = Date.now() + Math.max(200, timeoutMs);
  while (Date.now() < deadline) {
    const pages = await host.browser()?.pages().catch(() => []) ?? [];
    if (pages.filter((page) => !page.isClosed()).length > baseline.pageCount) return true;
    const snapshot = await searchSubmitSnapshot(host.page).catch(() => undefined);
    if (snapshot) {
      if (snapshot.url !== baseline.url) return true;
      if (!baseline.hasLoginGate && snapshot.hasLoginGate) return true;
      if (!baseline.hasResultContent && snapshot.hasResultContent) return true;
      if (baseline.textLength >= 0 && Math.abs(snapshot.textLength - baseline.textLength) > 180) return true;
    }
    await delay(100);
  }
  return false;
}

async function clickSearchSubmitByGeometry(host: ExtensionDetectorHost, inputXPath: string, timeoutMs: number): Promise<SearchSubmitButton | undefined> {
  const button = await resolveSearchSubmitButtonByGeometry(host.page, inputXPath).catch(() => undefined);
  debugSearchSubmitDecision('geometry-resolved', button);
  if (!button?.xpath) return undefined;
  debugSearchSubmitDecision('geometry-real-mouse-click', button);
  await host.command({
    action: 'click',
    frame: { isIframe: false },
    target: { type: 'xpath', xpath: button.xpath },
    timeoutMs,
    payload: {
      mode: 'real-mouse',
      ensureInView: true,
      scrollBlock: 'center',
      requireVisible: true
    }
  });
  return button;
}

async function resolveSearchSubmitButtonByGeometry(page: Page, inputXPath: string): Promise<SearchSubmitButton | undefined> {
  return page.evaluate((path) => {
    type Candidate = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
    function byXPath(xpathValue: string): Element | null {
      const result = document.evaluate(xpathValue, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element): string {
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }
    function attrsOf(element: Element): string {
      return [
        element.localName,
        String((element as HTMLElement).id || ''),
        String((element as HTMLElement).className || ''),
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || ''
      ].join(' ');
    }
    function contentLike(element: Element): boolean {
      if (/^(textarea|input)$/i.test(element.tagName)) return true;
      const href = element.getAttribute('href') || '';
      if (/\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="recommend" i]');
      return Boolean(container && !/search|query|keyword|toolbar|header|form|input|submit|button|icon/i.test(attrsOf(container)));
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search|icon|suffix|append/i.test(attrsOf(element));
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${Array.from(element.querySelectorAll('svg,path,use,i,span')).map(attrsOf).join(' ')}`);
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function submitTarget(inputElement: Element, element: Element): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const candidate = current;
        if (!visible(candidate) || contentLike(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const nativeButton = /^(button|input)$/i.test(candidate.tagName) || candidate.getAttribute('role') === 'button';
        const semantic = /搜索|查询|搜一下|搜一搜|Search|search|query|submit/i.test(`${textOf(candidate)} ${attrsOf(candidate)}`);
        const nearInput = rightSideControl(inputElement, candidate);
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(candidate)) score += 2;
        if (semantic) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(candidate)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function searchScope(inputElement: Element): Element {
      let current: Element | null = inputElement.parentElement;
      let fallback: Element = inputElement.parentElement || document.body || document.documentElement;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const attrs = attrsOf(current);
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|input|textarea/i.test(attrs)) return current;
        fallback = current;
      }
      return fallback;
    }
    function scoreCandidate(inputElement: Element, candidate: Element): Candidate | undefined {
      if (candidate === inputElement || !visible(candidate) || contentLike(candidate)) return undefined;
      const inputRect = inputElement.getBoundingClientRect();
      const rect = candidate.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2));
      const aligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.75);
      const rightEdgeAligned = rect.left >= inputRect.right - 160 && rect.left <= inputRect.right + 220;
      const insideInputRight = rect.right <= inputRect.right + 60 && rect.left >= inputRect.left + inputRect.width * 0.45;
      const compact = rect.width >= 10 && rect.height >= 10 && rect.width <= 150 && rect.height <= 150;
      if (!aligned || !compact || (!rightEdgeAligned && !insideInputRight)) return undefined;
      const attrs = attrsOf(candidate);
      const searchLike = /搜索|查询|搜一下|搜一搜|Search|search|query|submit/i.test(`${textOf(candidate)} ${attrs}`);
      const clickable = clickableLike(candidate);
      const icon = iconLike(candidate);
      if (!searchLike && !clickable && !icon) return undefined;
      let score = 0.8;
      const reasons = ['geometry fallback near search input'];
      if (searchLike) {
        score += 0.5;
        reasons.push('candidate has search semantics');
      }
      if (clickable) {
        score += 0.35;
        reasons.push('candidate looks clickable');
      }
      if (icon) {
        score += 0.35;
        reasons.push('candidate looks icon-like');
      }
      score -= Math.min(0.4, verticalCenterDistance / 200);
      return {
        xpath: xpath(candidate),
        ...(textOf(candidate) ? { text: textOf(candidate) } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }
    const inputElement = byXPath(path);
    if (!inputElement) return undefined;
    const scope = searchScope(inputElement);
    const rawCandidates = Array.from(scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],svg,path,use,i,div,span,[class*="icon" i],[class*="button" i],[class*="btn" i],[class*="search" i],[class*="submit" i]'));
    const scored = rawCandidates
      .map((candidate) => scoreCandidate(inputElement, submitTarget(inputElement, candidate)))
      .filter((candidate): candidate is Candidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score);
    return scored[0];
  }, inputXPath);
}

async function resolveSearchSubmitButton(page: Page, options: {
  submitText?: string;
  inputs: SearchSubmitInputRef[];
  preferredButtons: SearchSubmitButton[];
}): Promise<SearchSubmitButton | undefined> {
  return page.evaluate((input) => {
    type Button = {
      xpath: string;
      text?: string;
      score: number;
      reasons: string[];
    };
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function byXPath(path: string): Element | null {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
    }
    function visible(element: Element | null): element is Element {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function textOf(element: Element | null | undefined): string {
      if (!element) return '';
      return (element instanceof HTMLInputElement
        ? element.value || element.getAttribute('aria-label') || element.getAttribute('title') || ''
        : element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }
    function stringAttr(value: unknown): string {
      return String(value || '');
    }
    function attrsOf(element: Element): string {
      return [
        element.localName,
        stringAttr((element as HTMLElement).id),
        stringAttr((element as HTMLElement).className),
        element.getAttribute('role') || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('type') || '',
        element.getAttribute('href') || '',
        element.getAttribute('name') || '',
        element.getAttribute('data-name') || ''
      ].join(' ');
    }
    function childAttrsOf(element: Element): string {
      return Array.from(element.querySelectorAll('svg,path,use,i,img,span,[class*="icon" i],[class*="search" i]')).slice(0, 8)
        .map((child) => attrsOf(child))
        .join(' ');
    }
    function distance(left: Element, right: Element): number {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ay = a.top + a.height / 2;
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      return Math.hypot(ax - bx, ay - by);
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 120 && rect.height <= 120;
    }
    function iconLike(element: Element): boolean {
      return /svg|path|use|icon|magnif|glass|lens|search/i.test(`${element.localName} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function negativeSubmitControl(element: Element): boolean {
      const value = `${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`;
      return /(清除|清空|关闭|取消|删除|移除|重置|close|clear|cancel|remove|delete|reset|times|cross)/i.test(value)
        && !isSearchLike(element);
    }
    function clickableLike(element: Element): boolean {
      const style = window.getComputedStyle(element as HTMLElement);
      const attrs = attrsOf(element);
      return /^(button|input|a)$/i.test(element.tagName)
        || element.getAttribute('role') === 'button'
        || Boolean(element.getAttribute('onclick'))
        || Boolean(element.getAttribute('tabindex'))
        || style.cursor === 'pointer'
        || /btn|button|submit|search-(?:button|btn|submit)|search_button|icon|suffix|append/i.test(attrs);
    }
    function submitTarget(element: Element, inputs: Element[]): Element {
      let current: Element | null = element;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const candidate = current;
        if (!visible(candidate) || isContentLink(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        const explicitClickable = /^(button|input|a)$/i.test(candidate.tagName)
          || candidate.getAttribute('role') === 'button'
          || Boolean((candidate as HTMLElement).onclick)
          || Boolean(candidate.getAttribute('tabindex'))
          || window.getComputedStyle(candidate as HTMLElement).cursor === 'pointer';
        const ownsSearchInput = Boolean(candidate.querySelector('input,textarea,[role="textbox"],[role="searchbox"],[contenteditable="true"],[contenteditable="plaintext-only"]'));
        if (ownsSearchInput && (rect.width > 220 || rect.height > 180) && !explicitClickable) continue;
        if (negativeSubmitControl(candidate)) continue;
        const tapTarget = rect.width >= 18 && rect.height >= 18 && rect.width <= 180 && rect.height <= 180;
        const tinyGlyph = rect.width < 20 || rect.height < 20 || /^(svg|path|use|i)$/i.test(candidate.tagName);
        const nativeButton = isNativeButton(candidate);
        const searchLike = isSearchLike(candidate);
        const nearInput = inputs.some((inputElement) => rightSideControl(inputElement, candidate));
        let score = 0;
        if (nativeButton) score += 3;
        if (clickableLike(candidate)) score += 2;
        if (searchLike) score += 1.6;
        if (nearInput) score += 1.2;
        if (tapTarget) score += 0.9;
        if (iconLike(candidate)) score += 0.4;
        if (tinyGlyph) score -= 1.8;
        score -= depth * 0.04;
        if (score >= 1.2) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => {
        const aRect = a.element.getBoundingClientRect();
        const bRect = b.element.getBoundingClientRect();
        return (b.score - a.score) || ((bRect.width * bRect.height) - (aRect.width * aRect.height));
      });
      return candidates[0]?.element || element;
    }
    function isSearchLike(element: Element): boolean {
      return /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(`${textOf(element)} ${attrsOf(element)} ${childAttrsOf(element)}`);
    }
    function isNativeButton(element: Element): boolean {
      return /^(button|input)$/i.test(element.tagName) || element.getAttribute('role') === 'button';
    }
    function isContentLink(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      if (contentDetailUrlLike(href)) return true;
      const container = element.closest('article,[class*="article" i],[class*="card" i],[class*="feed" i],[class*="result" i],[class*="item" i],[class*="suggest" i],[class*="recommend" i]');
      if (!container) return false;
      return !/search|toolbar|header|form|submit|button/i.test(attrsOf(container));
    }
    function contentDetailUrlLike(value: string): boolean {
      if (!value) return false;
      try {
        const path = new URL(value, location.href).pathname;
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(path)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(path);
      } catch {
        return /\/(?:article|articles|blog|blogs|post|posts|detail|details|content|news)(?:\/|$)/i.test(value)
          && !/\/(?:search|query|result|results)(?:\/|$)/i.test(value);
      }
    }
    function searchScope(inputElement: Element | null): ParentNode {
      if (!inputElement) return document;
      const form = inputElement.closest('form');
      if (form) return form;
      let current: Element | null = inputElement.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        if (/search|query|keyword|搜索|查询|toolbar|header|nav|form|input|so-box|search-box|searchbar/i.test(attrsOf(current))) return current;
      }
      return inputElement.parentElement || document;
    }
    function inputByName(name: string): Element | null {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(name) : name.replace(/"/g, '\\"');
      return document.querySelector(`input[name="${escaped}"],textarea[name="${escaped}"]`);
    }
    function inputRefs(): Element[] {
      const seen = new Set<Element>();
      const refs: Element[] = [];
      for (const item of input.inputs) {
        const element = byXPath(item.xpath) || inputByName(item.name);
        if (!element || seen.has(element)) continue;
        seen.add(element);
        refs.push(element);
      }
      return refs;
    }
    function scoreButton(button: Element, inputs: Element[]): Button | undefined {
      if (!visible(button) || isContentLink(button)) return undefined;
      if (negativeSubmitControl(button)) return undefined;
      const nativeButton = isNativeButton(button);
      const searchLike = isSearchLike(button);
      const nearInputIcon = inputs.some((inputElement) => rightSideControl(inputElement, button) && compactControl(button) && (iconLike(button) || clickableLike(button)));
      if (!nativeButton && !searchLike && !nearInputIcon) return undefined;
      const reasons: string[] = ['visible submit control'];
      let score = nativeButton ? 0.35 : 0;
      if (searchLike) {
        score += 0.65;
        reasons.push('search-like submit label');
      }
      if (input.submitText && textOf(button).includes(input.submitText)) {
        score += 0.9;
        reasons.push('matches requested submit text');
      }
      for (const inputElement of inputs) {
        const dist = distance(inputElement, button);
        if (dist < 220) {
          score += 0.45;
          reasons.push('near search input');
          break;
        }
        if (dist < 420) {
          score += 0.22;
          reasons.push('same search area as input');
          break;
        }
      }
      if (nearInputIcon) {
        score += 0.7;
        reasons.push('icon-like control is aligned with input');
      }
      if (button.closest('form')) {
        score += 0.2;
        reasons.push('inside form');
      }
      return {
        xpath: xpath(button),
        ...(textOf(button) ? { text: textOf(button) } : {}),
        score: Number(score.toFixed(3)),
        reasons
      };
    }

    const inputs = inputRefs();
    const candidates: Button[] = [];
    const preferred = input.preferredButtons
      .map((button) => byXPath(button.xpath))
      .filter((element): element is Element => Boolean(element));
    for (const button of preferred) {
      const scored = scoreButton(submitTarget(button, inputs), inputs);
      if (scored) candidates.push({ ...scored, score: scored.score + 0.8, reasons: [...scored.reasons, 'manual/preferred submit'] });
    }
    const scopes = inputs.length ? inputs.map(searchScope) : [document];
    for (const scope of scopes) {
      const buttons = Array.from(scope.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span'))
        .map((button) => submitTarget(button, inputs));
      for (const button of buttons) {
        const scored = scoreButton(button, inputs);
        if (scored) candidates.push(scored);
      }
    }
    if (inputs.length) {
      const globalButtons = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a,[onclick],[tabindex],[class*="search" i],[class*="submit" i],[class*="button" i],[class*="btn" i],[class*="icon" i],[class*="suffix" i],[class*="append" i],[aria-label*="搜索"],[title*="搜索"],[aria-label*="Search" i],[title*="Search" i],svg,path,use,i,div,span'))
        .filter((button) => inputs.some((inputElement) => distance(inputElement, button) < 560 || rightSideControl(inputElement, button)))
        .map((button) => submitTarget(button, inputs));
      for (const button of globalButtons) {
        const scored = scoreButton(button, inputs);
        if (scored) candidates.push({ ...scored, score: scored.score + 0.12, reasons: [...scored.reasons, 'global nearby submit candidate'] });
      }
    }
    if (!candidates.length && input.submitText) {
      const fallback = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],[role="button"],a'))
        .map((button) => scoreButton(button, inputs))
        .filter((button): button is Button => Boolean(button))
        .filter((button) => (button.text || '').includes(input.submitText || ''));
      candidates.push(...fallback);
    }
    const unique = new Map<string, Button>();
    for (const candidate of candidates) {
      const existing = unique.get(candidate.xpath);
      if (!existing || candidate.score > existing.score) unique.set(candidate.xpath, candidate);
    }
    return Array.from(unique.values()).sort((a, b) => b.score - a.score)[0];
  }, options).catch(() => undefined);
}

async function submitSearchByDom(page: Page, buttonXPath: string, inputXPaths: string[] = [], options: { allowRecorded?: boolean } = {}): Promise<boolean> {
  return page.evaluate((payload) => {
    function byXPath(path: string): Element | null {
      const result = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const element = result.singleNodeValue;
      return element instanceof Element ? element : null;
    }
    const rawElement = byXPath(payload.buttonXPath);
    if (!rawElement) return false;
    const inputElements = payload.inputXPaths.map(byXPath).filter((item): item is Element => Boolean(item));
    const element = clickTargetForSearchSubmit(rawElement, inputElements);
    if (!(element instanceof HTMLElement)) return false;
    const attrs = [
      element.localName,
      element.id,
      element.className,
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('type') || '',
      element.getAttribute('href') || '',
      element.textContent || ''
    ].join(' ');
    const searchLike = /搜索|查询|搜一下|搜一搜|百度一下|Search|search|query|submit/i.test(attrs);
    const nearInputIcon = inputElements.some((inputElement) => rightSideControl(inputElement, element) && compactControl(element));
    if (!payload.options.allowRecorded && !searchLike && !nearInputIcon) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    const form = element.closest('form');
    if (form instanceof HTMLFormElement && typeof form.requestSubmit === 'function' && !/^(button)$/i.test(element.getAttribute('type') || '')) {
      form.requestSubmit(element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : undefined);
    }
    return true;
    function clickTargetForSearchSubmit(target: Element, inputs: Element[]): Element {
      let current: Element | null = target;
      const candidates: Array<{ element: Element; score: number }> = [];
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const candidate = current;
        const rect = candidate.getBoundingClientRect();
        const attrs = [
          candidate.localName,
          (candidate as HTMLElement).id || '',
          (candidate as HTMLElement).className || '',
          candidate.getAttribute('role') || '',
          candidate.getAttribute('aria-label') || '',
          candidate.getAttribute('title') || ''
        ].join(' ');
        const compact = rect.width >= 12 && rect.height >= 12 && rect.width <= 180 && rect.height <= 180;
        const clickable = /^(button|a|input)$/i.test(candidate.tagName)
          || candidate.getAttribute('role') === 'button'
          || Boolean((candidate as HTMLElement).onclick)
          || Boolean(candidate.getAttribute('tabindex'))
          || /btn|button|submit|search|icon|suffix|append/i.test(attrs);
        const nearInput = inputs.some((inputElement) => rightSideControl(inputElement, candidate));
        let score = 0;
        if (candidate instanceof HTMLElement) score += 0.4;
        if (clickable) score += 1.2;
        if (compact) score += 0.6;
        if (nearInput) score += 0.5;
        score -= depth * 0.05;
        if (score >= 0.7) candidates.push({ element: candidate, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0]?.element || target;
    }
    function rightSideControl(inputElement: Element, button: Element): boolean {
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const verticalCenterDistance = Math.abs((buttonRect.top + buttonRect.height / 2) - (inputRect.top + inputRect.height / 2));
      const verticallyAligned = verticalCenterDistance <= Math.max(48, inputRect.height * 0.65);
      const rightEdgeAligned = buttonRect.left >= inputRect.right - 140 && buttonRect.left <= inputRect.right + 180;
      const insideInputRight = buttonRect.right <= inputRect.right + 48 && buttonRect.left >= inputRect.left + inputRect.width * 0.45;
      return verticallyAligned && (rightEdgeAligned || insideInputRight);
    }
    function compactControl(control: Element): boolean {
      const rect = control.getBoundingClientRect();
      return rect.width >= 12 && rect.height >= 12 && rect.width <= 140 && rect.height <= 140;
    }
  }, { buttonXPath, inputXPaths, options });
}

async function detectTables(page: Page): Promise<RawCandidate[]> {
  const tableInfos = await page.evaluate(() => {
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
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
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    return Array.from(document.querySelectorAll('table')).slice(0, 10).filter(visible).map((element) => {
      const rows = Array.from(element.querySelectorAll('tr'));
      const headerCells = Array.from(rows[0]?.querySelectorAll('th,td') ?? []);
      const headers = headerCells.map((cell, i) => (cell.textContent || '').trim() || `column_${i + 1}`);
      const dataRows = rows.slice(headerCells.length ? 1 : 0).map((row) => Array.from(row.querySelectorAll('td,th')).map((cell) => (cell.textContent || '').trim()));
      return { headers, dataRows: dataRows.filter((row) => row.some(Boolean)).slice(0, 5), xpath: xpath(element), selector: selector(element) };
    });
  });
  const candidates: RawCandidate[] = [];
  for (const info of tableInfos) {
    if (info.dataRows.length < 2 || info.headers.length < 2) continue;
    const fields: DetectedField[] = info.headers.slice(0, 12).map((header, fieldIndex) => ({
      name: normalizeFieldName(header, `column_${fieldIndex + 1}`),
      kind: 'text',
      selector: `tr td:nth-child(${fieldIndex + 1})`,
      xpath: `${info.xpath}//tr/td[${fieldIndex + 1}]`,
      relativeSelector: `td:nth-child(${fieldIndex + 1})`,
      relativeXPath: `./td[${fieldIndex + 1}]`,
      samples: info.dataRows.map((row) => row[fieldIndex] ?? '').filter(Boolean).slice(0, 3)
    }));
    candidates.push({
      type: 'table',
      selector: info.selector,
      xpath: info.xpath,
      itemSelector: `${info.selector} tr`,
      itemXPath: `${info.xpath}//tr[td]`,
      itemCount: info.dataRows.length,
      fields,
      sampleRows: info.dataRows.slice(0, 3).map((row) => rowToSample(fields, row)),
      reasons: ['HTML table with repeated rows'],
      confidence: scoreCandidate({ itemCount: info.dataRows.length, fieldCount: fields.length, semantic: 1, penalty: 0 })
    });
  }
  return candidates;
}

async function detectRepeatedCards(page: Page): Promise<RawCandidate[]> {
  const raw = await page.evaluate(() => {
    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS']);
    const elements = Array.from(document.querySelectorAll('body, main, article, section, div, ul, ol'));
    function visible(element: Element): boolean {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = window.getComputedStyle(html);
      return rect.width > 40 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${current.tagName.toLowerCase()}[${index || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function selector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const html = current as HTMLElement;
        const id = html.id && !/[^\w-]/.test(html.id) ? `#${html.id}` : '';
        if (id) {
          parts.unshift(id);
          break;
        }
        const cls = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${cls}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    function signature(element: Element): string {
      return Array.from(element.children)
        .filter((child) => !ignored.has(child.tagName))
        .slice(0, 8)
        .map((child) => {
          const hasLink = child.querySelector('a') || child.tagName === 'A' ? 'a' : '';
          const hasImg = child.querySelector('img') || child.tagName === 'IMG' ? 'img' : '';
          return `${child.tagName.toLowerCase()}${hasLink}${hasImg}`;
        })
        .join('|');
    }
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return elements
      .filter((parent) => visible(parent))
      .flatMap((parent) => {
        const groups = new Map<string, Element[]>();
        for (const child of Array.from(parent.children)) {
          if (ignored.has(child.tagName) || !visible(child)) continue;
          const childText = text(child);
          if (childText.length < 8) continue;
          const sig = signature(child);
          if (!sig) continue;
          const key = `${child.tagName}:${sig}`;
          groups.set(key, [...(groups.get(key) ?? []), child]);
        }
        return Array.from(groups.values())
          .filter((items) => items.length >= 3)
          .map((items) => ({
            parentSelector: selector(parent),
            parentXPath: xpath(parent),
            itemSelector: selector(items[0]),
            itemXPath: xpath(items[0]).replace(/\[\d+\]$/, ''),
            itemCount: items.length,
            rows: items.slice(0, 5).map((item) => {
              const links = Array.from(item.querySelectorAll('a')).map((link) => ({
                text: text(link).slice(0, 160),
                href: (link as HTMLAnchorElement).href
              })).filter((link) => link.text || link.href).slice(0, 4);
              const images = Array.from(item.querySelectorAll('img')).map((img) => (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src).filter(Boolean).slice(0, 2);
              const chunks = Array.from(item.querySelectorAll('h1,h2,h3,h4,p,span,div')).map((node) => text(node)).filter((value, index, arr) => value.length >= 3 && arr.indexOf(value) === index).slice(0, 6);
              return { text: text(item).slice(0, 500), links, images, chunks };
            })
          }));
      });
  });

  return raw
    .map((item) => repeatedCardCandidate(item))
    .filter((candidate): candidate is RawCandidate => Boolean(candidate));
}

async function detectSearchResultBlocks(page: Page): Promise<RawCandidate[]> {
  const groups = await page.evaluate(() => {
    type ResultRow = {
      element: Element;
      title: string;
      href: string;
      summary: string;
      category: string;
      text: string;
      titlePath: string;
      summaryPath: string;
      categoryPath: string;
    };
    type ResultGroup = {
      parentSelector: string;
      parentXPath: string;
      itemSelector: string;
      itemXPath: string;
      itemCount: number;
      titlePath: string;
      summaryPath: string;
      categoryPath: string;
      rows: Array<{
        title: string;
        href: string;
        summary: string;
        category: string;
        text: string;
      }>;
      boilerplateLike: boolean;
      shadowHost: boolean;
      reasons: string[];
    };
    type SearchRoot = { root: Element | ShadowRoot; host: Element | null };

    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE']);
    const mainRoots = Array.from(document.querySelectorAll('main,[role="main"],#main,#content,[class*="content" i],[class*="results" i],[class*="search" i]'));
    const rootElements = mainRoots.length ? mainRoots : Array.from(document.querySelectorAll('body'));
    const roots: SearchRoot[] = rootElements.map((root) => ({ root, host: null }));
    const seenShadowRoots = new Set<ShadowRoot>();
    function addShadowRoots(root: Element | ShadowRoot): void {
      const elements = [
        ...(root instanceof Element ? [root] : []),
        ...Array.from(root.querySelectorAll('*'))
      ];
      for (const element of elements) {
        const shadow = (element as HTMLElement).shadowRoot;
        if (!shadow || seenShadowRoots.has(shadow)) continue;
        seenShadowRoots.add(shadow);
        roots.push({ root: shadow, host: element });
        addShadowRoots(shadow);
      }
    }
    for (const root of rootElements) addShadowRoots(root);

    function text(element: Element): string {
      return ((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function directText(element: Element): string {
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
      return rect.width > 24 && rect.height > 12 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function shadowHostFor(element: Element): Element | null {
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
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
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    }
    function attrs(element: Element): string {
      const html = element as HTMLElement;
      return [
        element.localName,
        html.id,
        typeof html.className === 'string' ? html.className : '',
        html.getAttribute('role') || '',
        html.getAttribute('aria-label') || ''
      ].join(' ');
    }
    function candidateAttrs(element: Element): string {
      const values: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 3; depth += 1) {
        values.push(attrs(current));
        current = current.parentElement;
      }
      const shadowHost = shadowHostFor(element);
      if (shadowHost) {
        values.push(attrs(shadowHost));
        if (shadowHost.parentElement) values.push(attrs(shadowHost.parentElement));
      }
      return values.join(' ');
    }
    function boilerplateLike(element: Element): boolean {
      const value = `${candidateAttrs(element)} ${text(element).slice(0, 500)}`;
      return Boolean(element.closest('header,footer,nav,aside,[role="banner"],[role="contentinfo"],[role="navigation"],[role="complementary"]'))
        || Boolean(shadowHostFor(element)?.closest('header,footer,nav,aside,[role="banner"],[role="contentinfo"],[role="navigation"],[role="complementary"]'))
        || /(header|footer|contentinfo|copyright|privacy|terms|login|signin|signup|nav|menu|sidebar|aside|advert|banner|sponsor|cookie|newsletter|备案|隐私|条款|登录|注册)/i.test(value);
    }
    function similarKey(element: Element): string {
      const html = element as HTMLElement;
      const classes = Array.from(html.classList)
        .filter((item) => !/\d{2,}/.test(item))
        .slice(0, 3)
        .sort()
        .join('.');
      const role = html.getAttribute('role') || '';
      const marked = /(result|search|item|entry|card|list|document|record|hit|article)/i.test(`${element.localName} ${classes} ${role}`) ? 'marked' : '';
      return [element.tagName.toLowerCase(), classes, role, marked].join('|');
    }
    function relativePath(from: Element, to: Element): string {
      if (from === to) return '.';
      const parts: string[] = [];
      let current: Element | null = to;
      while (current && current !== from) {
        const parentElement: Element | null = current.parentElement;
        if (!parentElement) return '.';
        const same = Array.from(parentElement.children).filter((item: Element) => item.tagName === current!.tagName);
        parts.unshift(`${current.tagName.toLowerCase()}[${same.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return current === from ? `./${parts.join('/')}` : '.';
    }
    function firstTextElement(row: Element, selectors: string[]): Element | null {
      for (const selectorValue of selectors) {
        const match = Array.from(row.querySelectorAll(selectorValue))
          .filter((element) => visible(element))
          .find((element) => {
            const value = text(element);
            return value.length >= 24 && value.length <= 500;
          });
        if (match) return match;
      }
      return null;
    }
    function summaryFor(row: Element, title: string): { value: string; path: string } {
      const summaryElement = firstTextElement(row, [
        '[class*="description" i]',
        '[class*="summary" i]',
        '[class*="snippet" i]',
        '[class*="excerpt" i]',
        '[class*="intro" i]',
        'p',
        'dd'
      ]);
      if (summaryElement) {
        const value = text(summaryElement);
        if (value && value !== title) return { value: value.slice(0, 500), path: relativePath(row, summaryElement) };
      }
      const chunks = Array.from(row.querySelectorAll('p,dd,span,div'))
        .filter((element) => visible(element))
        .map((element) => ({ element, value: text(element) }))
        .filter((item, index, arr) => item.value.length >= 24 && item.value !== title && arr.findIndex((other) => other.value === item.value) === index)
        .sort((a, b) => Math.abs(a.value.length - 160) - Math.abs(b.value.length - 160));
      if (chunks[0]) return { value: chunks[0].value.slice(0, 500), path: relativePath(row, chunks[0].element) };
      const value = text(row).replace(title, '').trim();
      return { value: value.slice(0, 500), path: '.' };
    }
    function categoryFor(row: Element, title: string, summary: string): { value: string; path: string } {
      const categoryElement = Array.from(row.querySelectorAll('[class*="breadcrumb" i],[class*="category" i],[class*="type" i],[class*="section" i],small'))
        .filter((element) => visible(element))
        .find((element) => {
          const value = text(element);
          return value.length >= 2 && value.length <= 120 && value !== title && value !== summary;
        });
      if (categoryElement) return { value: text(categoryElement).slice(0, 160), path: relativePath(row, categoryElement) };
      const shortChunk = Array.from(row.querySelectorAll('span,small,div'))
        .filter((element) => visible(element))
        .map((element) => ({ element, value: directText(element) || text(element) }))
        .find((item) => item.value.length >= 2 && item.value.length <= 80 && item.value !== title && item.value !== summary && /[>/|·•-]/.test(item.value));
      return shortChunk ? { value: shortChunk.value.slice(0, 160), path: relativePath(row, shortChunk.element) } : { value: '', path: '' };
    }
    function titleLinkFor(row: Element): HTMLAnchorElement | null {
      const links = Array.from(row.querySelectorAll('a')).filter(visible) as HTMLAnchorElement[];
      const scored = links
        .map((link, index) => {
          const value = text(link);
          const href = link.href || link.getAttribute('href') || '';
          if (!href || value.length < 3 || value.length > 220) return null;
          const html = link as HTMLElement;
          const attrValue = attrs(link);
          let score = 0;
          if (/^(?:H1|H2|H3|H4)$/i.test(link.parentElement?.tagName || '')) score += 0.35;
          if (link.querySelector('h1,h2,h3,h4')) score += 0.35;
          if (/(title|heading|result|entry|document|article|name)/i.test(attrValue)) score += 0.28;
          if (value.length >= 8 && value.length <= 120) score += 0.22;
          if (/\/(docs?|articles?|posts?|questions?|crates?|packages?|plugins?|title|jobs?|wiki|api)\b/i.test(href)) score += 0.18;
          if (html.closest('nav,header,footer')) score -= 0.55;
          score -= index * 0.03;
          return { link, score };
        })
        .filter((item): item is { link: HTMLAnchorElement; score: number } => Boolean(item))
        .sort((a, b) => b.score - a.score);
      return scored[0]?.link ?? null;
    }
    function asRow(element: Element): ResultRow | null {
      if (ignored.has(element.tagName) || !visible(element) || boilerplateLike(element)) return null;
      const value = text(element);
      if (value.length < 36 || value.length > 1800) return null;
      const directResultChildren = Array.from(element.children)
        .filter((child) => !ignored.has(child.tagName) && visible(child) && Boolean(child.querySelector('a')) && text(child).length >= 36)
        .length;
      if (directResultChildren >= 2) return null;
      const titleLink = titleLinkFor(element);
      if (!titleLink) return null;
      const title = text(titleLink).slice(0, 220);
      const href = titleLink.href || titleLink.getAttribute('href') || '';
      if (!title || !href) return null;
      const summary = summaryFor(element, title);
      if (summary.value.length < 24 && value.replace(title, '').trim().length < 24) return null;
      const category = categoryFor(element, title, summary.value);
      return {
        element,
        title,
        href,
        summary: summary.value,
        category: category.value,
        text: value.slice(0, 800),
        titlePath: relativePath(element, titleLink),
        summaryPath: summary.path,
        categoryPath: category.path
      };
    }
    function commonItemXPath(rows: ResultRow[]): string {
      if (!rows.length) return '';
      const shadowHost = shadowHostFor(rows[0].element);
      if (shadowHost && rows.every((row) => shadowHostFor(row.element) === shadowHost)) return xpath(shadowHost);
      const parent = rows[0].element.parentElement;
      if (!parent || !rows.every((row) => row.element.parentElement === parent)) return xpath(rows[0].element);
      const tag = rows[0].element.tagName.toLowerCase();
      if (rows.every((row) => row.element.tagName.toLowerCase() === tag)) return `${xpath(parent)}/${tag}`;
      return xpath(rows[0].element).replace(/\[\d+\]$/, '');
    }
    function buildGroup(parent: Element, rows: ResultRow[], reasons: string[]): ResultGroup | null {
      const uniqueTitles = new Set(rows.map((row) => row.title.toLowerCase()));
      const uniqueHrefs = new Set(rows.map((row) => row.href.replace(/[?#].*$/g, '').toLowerCase()));
      if (rows.length < 2 || uniqueTitles.size < Math.min(2, rows.length) || uniqueHrefs.size < Math.min(2, rows.length)) return null;
      const withSummary = rows.filter((row) => row.summary.length >= 24).length;
      if (withSummary < Math.min(2, rows.length)) return null;
      const sample = rows.slice(0, 5);
      const first = sample[0];
      const shadowHost = shadowHostFor(first.element);
      const allSameShadowHost = shadowHost && rows.every((row) => shadowHostFor(row.element) === shadowHost);
      const anchor = allSameShadowHost ? shadowHost : parent;
      return {
        parentSelector: selector(anchor),
        parentXPath: xpath(anchor),
        itemSelector: allSameShadowHost ? selector(shadowHost) : selector(first.element),
        itemXPath: commonItemXPath(rows),
        itemCount: rows.length,
        titlePath: allSameShadowHost ? '.' : first.titlePath || './/a[1]',
        summaryPath: allSameShadowHost ? '.' : first.summaryPath || '.',
        categoryPath: allSameShadowHost ? '' : first.categoryPath || '',
        rows: sample.map((row) => ({
          title: row.title,
          href: row.href,
          summary: row.summary,
          category: row.category,
          text: row.text
        })),
        boilerplateLike: boilerplateLike(parent) || (allSameShadowHost ? boilerplateLike(shadowHost) : false) || rows.some((row) => boilerplateLike(row.element)),
        shadowHost: Boolean(allSameShadowHost),
        reasons: [...reasons, ...(allSameShadowHost ? ['Open Shadow DOM search-result blocks'] : [])]
      };
    }

    const rowCandidates = new Map<Element, ResultRow>();
    for (const scope of roots) {
      if (scope.host && !visible(scope.host)) continue;
      if (!scope.host && scope.root instanceof Element && !visible(scope.root)) continue;
      const descendants = Array.from(scope.root.querySelectorAll('article,li,dd,[role="article"],[role="listitem"],[class*="result" i],[class*="search-result" i],[class*="document" i],[class*="entry" i],[class*="item" i]'));
      for (const element of descendants) {
        const row = asRow(element);
        if (!row) continue;
        const nested = Array.from(rowCandidates.values()).some((existing) => row.element.contains(existing.element));
        if (nested) {
          for (const [key, existing] of Array.from(rowCandidates.entries())) {
            if (row.element.contains(existing.element) && text(row.element).length <= text(existing.element).length + 80) {
              rowCandidates.delete(key);
            }
          }
        }
        if (!Array.from(rowCandidates.values()).some((existing) => existing.element.contains(row.element))) {
          rowCandidates.set(element, row);
        }
      }
    }

    const byParent = new Map<Element, ResultRow[]>();
    for (const row of rowCandidates.values()) {
      const parent = row.element.parentElement || shadowHostFor(row.element);
      if (!parent) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
    }

    const output: ResultGroup[] = [];
    for (const [parent, rows] of byParent.entries()) {
      const buckets = new Map<string, ResultRow[]>();
      for (const row of rows) {
        const key = similarKey(row.element);
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      for (const bucketRows of buckets.values()) {
        const group = buildGroup(parent, bucketRows, ['Repeated search-result blocks with title links and summaries']);
        if (group) output.push(group);
      }
    }

    return output
      .sort((a, b) => b.itemCount - a.itemCount)
      .slice(0, 12);
  });

  return groups.map((group) => searchResultBlockCandidate(group));
}

async function detectInteractiveElementGroups(page: Page): Promise<RawCandidate[]> {
  const groups = await page.evaluate(() => {
    const ignored = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'PATH']);
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 12 && rect.height > 10 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
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
        const classes = Array.from(html.classList).filter((item) => !/^\d/.test(item)).slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const same = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(current) + 1})` : '';
        parts.unshift(`${current.tagName.toLowerCase()}${classes}${nth}`);
        current = parentElement;
      }
      return parts.join(' > ');
    }
    function shape(element: Element): string {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect();
      const classes = Array.from(html.classList).filter((item) => !/\d{2,}/.test(item)).slice(0, 3).sort().join('.');
      const role = html.getAttribute('role') || '';
      const hasLink = element.querySelector('a') || element.tagName === 'A' ? 'a' : '';
      const hasImg = element.querySelector('img') || element.tagName === 'IMG' ? 'img' : '';
      const childTags = Array.from(element.children).filter((child) => !ignored.has(child.tagName)).slice(0, 5).map((child) => child.tagName.toLowerCase()).join(',');
      const widthBucket = Math.round(rect.width / 40);
      const heightBucket = Math.round(rect.height / 12);
      return [element.tagName, classes, role, hasLink, hasImg, childTags, widthBucket, heightBucket].join('|');
    }
    function itemXPath(first: Element): string {
      return xpath(first).replace(/\[\d+\]$/, '');
    }

    const containers = Array.from(document.querySelectorAll('body, main, article, section, div, ul, ol, nav'));
    const output: Array<{
      parentSelector: string;
      parentXPath: string;
      itemSelector: string;
      itemXPath: string;
      itemCount: number;
      samples: string[];
      hrefSamples: string[];
    }> = [];
    for (const parent of containers) {
      if (!visible(parent)) continue;
      const buckets = new Map<string, Element[]>();
      for (const child of Array.from(parent.children)) {
        if (ignored.has(child.tagName) || !visible(child)) continue;
        const value = text(child);
        if (value.length < 2 || value.length > 220) continue;
        const key = shape(child);
        buckets.set(key, [...(buckets.get(key) ?? []), child]);
      }
      for (const items of buckets.values()) {
        if (items.length < 3) continue;
        const samples = items.map((item) => text(item)).filter(Boolean).slice(0, 5);
        const uniqueSamples = new Set(samples);
        if (uniqueSamples.size < Math.min(3, samples.length)) continue;
        const hrefSamples = items
          .map((item) => {
            const link = item.matches('a') ? item as HTMLAnchorElement : item.querySelector('a') as HTMLAnchorElement | null;
            return link?.href || '';
          })
          .filter(Boolean)
          .slice(0, 5);
        output.push({
          parentSelector: selector(parent),
          parentXPath: xpath(parent),
          itemSelector: selector(items[0]),
          itemXPath: itemXPath(items[0]),
          itemCount: items.length,
          samples,
          hrefSamples
        });
      }
    }
    return output;
  });

  return groups.map((group) => {
    const fields: DetectedField[] = [{
      name: 'text',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: group.samples.slice(0, 3)
    }];
    if (group.hrefSamples.length >= 2) {
      fields.push({
        name: 'url',
        kind: 'href',
        selector: `${group.itemSelector} a`,
        xpath: `${group.itemXPath}//a[1]`,
        relativeSelector: 'a',
        relativeXPath: './a[1]',
        samples: group.hrefSamples.slice(0, 3)
      });
    }
    return {
      type: fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
      selector: group.parentSelector,
      xpath: group.parentXPath,
      itemSelector: group.itemSelector,
      itemXPath: group.itemXPath,
      itemCount: group.itemCount,
      fields,
      sampleRows: group.samples.slice(0, 3).map((sample, index) => ({
        text: sample,
        ...(group.hrefSamples[index] ? { url: group.hrefSamples[index] } : {})
      })),
      reasons: ['Interactive similar element group'],
      confidence: scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic: fields.some((field) => field.name === 'url') ? 1 : 0, penalty: 0.08 })
    } satisfies RawCandidate;
  });
}

async function detectDeptaCandidates(page: Page): Promise<RawCandidate[]> {
  const groups = await detectDeptaListGroups(page);
  return groups
    .map((group) => deptaCandidate(group))
    .filter((candidate): candidate is RawCandidate => Boolean(candidate));
}

export async function detectPaginationForCandidatesForTesting(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  return detectPaginationForCandidates(page, candidates, scrollProbe);
}

export function sanitizeCandidatePaginationByLayoutForTesting(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return sanitizeCandidatePaginationByLayout(candidates);
}

export async function detectInteractivePaginationOptionsForTesting(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedPagination[]> {
  return detectInteractivePaginationOptions(page, candidates, scrollProbe);
}

export async function detectSearchResultBlocksForTesting(page: Page): Promise<RawCandidate[]> {
  return detectSearchResultBlocks(page);
}

export async function detectPageObstructionsForTesting(page: Page): Promise<Array<{
  popupXPath: string;
  popupText: string;
  type: DetectedPopupDismissal['type'];
  confidence: number;
  closeXPath?: string;
  closeText?: string;
  reasons: string[];
  canHide: boolean;
}>> {
  return detectPageObstructions(page);
}

export function shouldPromptForLoginInterventionForTesting(options: DetectOptions): boolean {
  return shouldPromptForLoginIntervention(options);
}

export async function dismissPageObstructionsForTesting(page: Page, options: { includeLogin?: boolean } = {}): Promise<DetectedPopupDismissal[]> {
  return dismissPageObstructions(page, options);
}

export async function confirmManualPopupDismissalForTesting(page: Page, runtimeConsole: SuppressedRuntimeConsole, promptedKeys?: Set<string>): Promise<DetectedPopupDismissal[]> {
  return confirmManualPopupDismissal(page, runtimeConsole, promptedKeys);
}

export async function refineCandidateFieldsForTesting(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  return refineCandidateFields(page, candidates);
}

export async function augmentAdjacentMetadataFieldsForTesting(page: Page, candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  return augmentAdjacentMetadataFields(page, candidates);
}

export async function findSearchInputCandidatesForTesting(page: Page, name: string): Promise<SearchInputCandidate[]> {
  return findSearchInputCandidates(page, name);
}

export async function resolveSearchSubmitButtonForTesting(page: Page, options: {
  submitText?: string;
  inputs: SearchSubmitInputRef[];
  preferredButtons?: SearchSubmitButton[];
}): Promise<SearchSubmitButton | undefined> {
  return resolveSearchSubmitButton(page, {
    submitText: options.submitText,
    inputs: options.inputs,
    preferredButtons: options.preferredButtons ?? []
  });
}

export async function resolveSearchSubmitButtonByGeometryForTesting(page: Page, inputXPath: string): Promise<SearchSubmitButton | undefined> {
  return resolveSearchSubmitButtonByGeometry(page, inputXPath);
}

export async function scoreSearchResultPageForTesting(page: Page, options: DetectOptions, isNewPage = false, index = 0, total = 1): Promise<number> {
  return scoreSearchResultPage(page, options, isNewPage, index, total);
}

export async function pageLooksLikeSearchResultForTesting(page: Page, options: DetectOptions): Promise<boolean> {
  return pageLooksLikeSearchResult(page, options);
}

export function isPlausiblePaginationOptionForTesting(pagination: DetectedPagination): boolean {
  return isPlausiblePaginationOption(pagination);
}

export function preferredPaginationForTesting(existing: DetectedPagination | undefined, detected: DetectedPagination | undefined): DetectedPagination | undefined {
  return preferredPagination(existing, detected);
}

export function selectDetailUrlFieldForTesting(candidate: DetectedCandidate): DetectedField | undefined {
  return selectDetailUrlField(candidate);
}

async function detectPaginationForCandidates(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<DetectedCandidate[]> {
  const input = candidates
    .filter((candidate) => candidate.type !== 'detail' && candidate.type !== 'form')
    .map((candidate) => ({
      id: candidate.id,
      xpath: candidate.xpath,
      itemXPath: candidate.itemXPath || candidate.xpath,
      type: candidate.type,
      itemCount: candidate.itemCount
    }));
  if (!input.length) return candidates;
  const paginationById = await page.evaluate((items) => {
    type PageCandidate = {
      type: 'next_page' | 'load_more' | 'scroll';
      xpath: string;
      text: string;
      confidence: number;
      isAjax: boolean;
      scope: 'near_list' | 'global';
      revealByScroll?: boolean;
      reasons: string[];
    };
    type ItemInfo = {
      id: string;
      xpath: string;
      itemXPath: string;
      type: string;
      itemCount: number;
    };
    const nextTexts = ['下一页', '下页', '后一页', '后页', 'Next', 'next', '>', '›', '»', '→'];
    const prevTextPattern = /^(上一页|上页|前一页|前页|prev|previous|<|‹|«|←)$/i;
    const loadMoreTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'Load more', 'Show more', 'See more'];
    const loadMoreEndPattern = /(没有更多|无更多|没有了|已到底|到底了|暂无更多|没有更多内容|已加载全部|加载完毕|no more|nothing more|end of|all loaded)/i;
    const nextClassPattern = /(next|pager-next|page-next|pagination-next|nextpage|btn-next|arrow-right)/i;
    const pagerClassPattern = /(pager|pagination|page-nav|pagebar|pages|paginator|el-pagination|ant-pagination|ivu-page)/i;
    const activeClassPattern = /(active|current|selected|on|cur|is-active|disabled)/i;
    const excludedClassPattern = /(prev|previous|disabled|ellipsis|more-prev|jump-prev)/i;
    const scanSelector = [
      'a',
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      '[onclick]',
      '[class*="load" i]',
      '[class*="more" i]',
      '[aria-label*="more" i]',
      '[aria-label*="更多" i]',
      '[title*="more" i]',
      '[title*="更多" i]',
      'span',
      'div',
      'li'
    ].join(',');

    function text(element: Element | null): string {
      if (!element) return '';
      if (element instanceof HTMLInputElement) return (element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return (element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    }

    function attrText(element: Element): string {
      const html = element as HTMLElement;
      return [
        html.id,
        html.className,
        html.getAttribute('rel'),
        html.getAttribute('aria-label'),
        html.getAttribute('title'),
        ...html.getAttributeNames().filter((name) => /^data-/i.test(name)).map((name) => html.getAttribute(name) || '')
      ].join(' ');
    }

    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function documentRect(element: Element): DOMRect {
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
      const scrollY = window.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
      return new DOMRect(rect.left + scrollX, rect.top + scrollY, rect.width, rect.height);
    }

    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }

    function evaluateXPath(path: string): Element[] {
      if (!path) return [];
      const normalized = path.includes('[*]') ? path.replace(/\[\*\]/g, '') : path;
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

    function isAjax(element: Element): boolean {
      const href = element.getAttribute('href') || '';
      const onclick = element.getAttribute('onclick') || element.getAttribute('onClick') || '';
      const combined = `${attrText(element)} ${onclick}`;
      return Boolean(onclick)
        || !href
        || href === '#'
        || href === '/'
        || /^javascript:/i.test(href)
        || /ajax|load-more|loadmore|fetch|api/i.test(combined)
        || !/^(a)$/i.test(element.localName);
    }

    function firstClickable(element: Element): Element {
      if (/^(a|button|input)$/i.test(element.localName)) return element;
      const child = element.querySelector('a,button,input[type="button"],input[type="submit"]');
      return child || element;
    }

    function numericValue(element: Element): number | null {
      const value = text(element).match(/^\d{1,5}$/)?.[0];
      return value ? Number(value) : null;
    }

    function numericDescendants(element: Element): Element[] {
      return Array.from(element.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((item) => numericValue(item) !== null);
    }

    function explicitPagerContext(element: Element): boolean {
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        if (pagerClassPattern.test(attrText(current))) return true;
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) return true;
      }
      return false;
    }

    function horizontalFilterOrCarousel(element: Element, listRect?: DOMRect): boolean {
      if (explicitPagerContext(element)) return false;
      const value = text(element);
      const rect = documentRect(element);
      const arrowOnly = value === '' || /^[›»>→]$/.test(value);
      let current: Element | null = element;
      for (let level = 0; current && current !== document.body && level < 5; level += 1, current = current.parentElement) {
        const html = current as HTMLElement;
        const attrsAndText = `${attrText(current)} ${(html.innerText || current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260)}`;
        const horizontalScrollable = Number(html.scrollWidth || 0) > Number(html.clientWidth || rect.width || 0) + 24;
        const filterLike = /(filter|filters|筛选|过滤|排序|sort|分类|category|categories|tag|tags|标签|tab|tabs|chip|chips|carousel|swiper|slider|频道|导航|menu|dropdown|select|selector|员工人数|盈利情况|学生|行业|地区|公司|融资|规模|综合|最新|最热|推荐)/i.test(attrsAndText);
        if ((horizontalScrollable || filterLike) && arrowOnly) return true;
      }
      if (!listRect) return false;
      const aboveListEnd = rect.bottom < listRect.bottom - Math.max(160, listRect.height * 0.18);
      return arrowOnly && aboveListEnd && /(arrow-right|right|next)/i.test(attrText(element));
    }

    function xpathLiteral(value: string): string {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat('${value.split("'").join(`',"'",'`)}')`;
    }

    function lowerXPath(expression: string): string {
      return `translate(${expression}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    }

    function safeNextPredicate(): string {
      const classExpr = lowerXPath('concat(" ", normalize-space(@class), " ")');
      const ariaExpr = lowerXPath('@aria-disabled');
      const textExpr = lowerXPath('normalize-space(.)');
      return [
        `not(contains(${classExpr}, " disabled "))`,
        `not(contains(${classExpr}, " prev "))`,
        `not(contains(${classExpr}, " previous "))`,
        `not(${ariaExpr}="true")`,
        `not(contains(${textExpr}, "没有更多"))`,
        `not(contains(${textExpr}, "暂无更多"))`,
        `not(contains(${textExpr}, "已到底"))`,
        `not(contains(${textExpr}, "到底了"))`,
        `not(contains(${textExpr}, "加载完毕"))`,
        `not(contains(${textExpr}, "no more"))`,
        `not(contains(${textExpr}, "all loaded"))`,
        `not(contains(${textExpr}, "end of"))`
      ].join(' and ');
    }

    function activeLoadMoreTextPredicate(): string {
      const textExpr = lowerXPath('normalize-space(.)');
      const positive = [
        `contains(${textExpr}, "加载更多")`,
        `contains(${textExpr}, "查看更多")`,
        `contains(${textExpr}, "显示更多")`,
        `contains(${textExpr}, "点击加载")`,
        `contains(${textExpr}, "load more")`,
        `contains(${textExpr}, "show more")`,
        `contains(${textExpr}, "see more")`
      ].join(' or ');
      const negative = [
        `not(contains(${textExpr}, "see more information"))`,
        `not(contains(${textExpr}, "more information about"))`,
        `not(contains(${textExpr}, "details about"))`,
        `not(contains(${textExpr}, "view details"))`,
        `not(contains(${textExpr}, "查看详情"))`,
        `not(contains(${textExpr}, "详细信息"))`
      ].join(' and ');
      return `(${positive}) and ${negative}`;
    }

    function loadMoreRecordExpanderText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalized) return false;
      return /^(?:see|show|view)\s+more\s+(?:information|info|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:more\s+information|details?)\s+(?:about|for|on)\b/i.test(normalized)
        || /^(?:view|show)\s+details?\b/i.test(normalized)
        || /^(?:查看|显示|展开|查看更多).{0,8}(?:详情|详细信息)(?:\s|$)/i.test(normalized);
    }

    function reliableLoadMoreText(value: string): boolean {
      const normalized = value.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 72 || loadMoreRecordExpanderText(normalized)) return false;
      return /^(加载更多|查看更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|显示更多(?:内容|结果|数据|文章|商品|评论|列表|记录|帖子|问题|回答|图片|视频|新闻|项目|仓库|包)?|点击加载(?:更多)?|load more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|show more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?|see more(?:\s+(?:results?|items?|posts?|articles?|stories?|products?|comments?|reviews?|questions?|answers?|rows?|data|content|listings?|jobs?|books?|movies?|news|repositories|packages|issues|photos|videos))?)$/i.test(normalized);
    }

    function loadMoreState(element: Element): { active: boolean; hasText: boolean; end: boolean } {
      const value = text(element);
      const attrs = attrText(element);
      const combined = `${value} ${attrs}`;
      const hasText = reliableLoadMoreText(value);
      const hasAttr = /loadmore|load-more/i.test(attrs);
      const end = loadMoreEndPattern.test(combined);
      return { active: !end && !loadMoreRecordExpanderText(value) && (hasText || hasAttr), hasText, end };
    }

    function pagerGroupForStableXPath(element: Element): Element | undefined {
      let current: Element | null = element.parentElement;
      let best: Element | undefined;
      for (let level = 0; current && current !== document.body && level < 5; level += 1) {
        const numbers = numericDescendants(current);
        const label = (current.textContent || '').replace(/\s+/g, ' ').trim();
        if (numbers.length >= 2 && label.length < 220) best = current;
        if (pagerClassPattern.test(attrText(current))) {
          best = current;
          break;
        }
        current = current.parentElement;
      }
      return best || element.parentElement || undefined;
    }

    function stablePaginationXPath(element: Element, type: 'next_page' | 'load_more', fallback: string): string {
      const tag = element.localName.toLowerCase();
      const value = text(element);
      const html = element as HTMLElement;
      const predicates: string[] = [];
      const safe = safeNextPredicate();
      const attrMatches = type === 'load_more'
        ? (raw: string) => /loadmore|load-more|more/i.test(raw)
        : (raw: string) => nextClassPattern.test(raw) && !excludedClassPattern.test(raw);
      const textMatches = type === 'load_more'
        ? (raw: string) => reliableLoadMoreText(raw) || /loadmore|load-more/i.test(raw)
        : (raw: string) => nextTexts.some((item) => raw === item || raw.toLowerCase() === item.toLowerCase()) && !prevTextPattern.test(raw);
      const push = (predicate: string) => {
        const full = type === 'load_more'
          ? `${predicate} and (${activeLoadMoreTextPredicate()}) and ${safe}`
          : `${predicate} and ${safe}`;
        if (!predicates.includes(full)) predicates.push(full);
      };

      if (html.id && attrMatches(html.id)) push(`@id=${xpathLiteral(html.id)}`);
      for (const name of ['rel', 'aria-label', 'title', 'alt', 'value']) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      for (const token of Array.from(html.classList || [])) {
        if (attrMatches(token)) push(`contains(concat(" ", normalize-space(@class), " "), ${xpathLiteral(` ${token} `)})`);
      }
      for (const name of html.getAttributeNames().filter((item) => /^data-/i.test(item))) {
        const attr = element.getAttribute(name) || '';
        if (attr && (attrMatches(attr) || textMatches(attr))) push(`@${name}=${xpathLiteral(attr)}`);
      }
      if (type === 'load_more' && reliableLoadMoreText(value)) {
        const textExpr = lowerXPath('normalize-space(.)');
        const positiveTexts = ['加载更多', '查看更多', '显示更多', '点击加载', 'load more', 'show more', 'see more'];
        push(`(${positiveTexts.map((item) => `contains(${textExpr}, ${xpathLiteral(item.toLowerCase())})`).join(' or ')})`);
      } else if (value && textMatches(value)) {
        push(`normalize-space(.)=${xpathLiteral(value)}`);
      }

      const section = element.closest('[class*="pagination" i],[class*="pager" i],nav,ul,ol') || pagerGroupForStableXPath(element);
      const candidates: string[] = [];
      if (section) {
        const sectionXPath = xpath(section);
        candidates.push(...predicates.map((predicate) => `${sectionXPath}//${tag}[${predicate}]`));
      }
      candidates.push(...predicates.map((predicate) => `//${tag}[${predicate}]`));

      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.length === 1 && matches[0] === element) return candidate;
      }
      for (const candidate of candidates) {
        const matches = evaluateXPath(candidate);
        if (matches.includes(element)) return candidate;
      }
      return fallback;
    }

    function samePagerGroup(elements: Element[]): Element[][] {
      const map = new Map<Element, Element[]>();
      for (const element of elements) {
        const parent = element.parentElement || element;
        const section = element.closest('[class*="pagination" i],[class*="pager" i],nav,ul,ol') || parent;
        map.set(section, [...(map.get(section) ?? []), element]);
      }
      return Array.from(map.values());
    }

    function scoreButton(element: Element, kind: 'next_page' | 'load_more', listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): number {
      const rect = documentRect(element);
      const viewportRect = element.getBoundingClientRect();
      const value = text(element);
      const attrs = attrText(element);
      if (kind === 'next_page' && horizontalFilterOrCarousel(element, listRect)) return 0;
      let score = scope === 'near_list' ? 0.42 : 0.32;
      if (kind === 'next_page') {
        if (nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase())) score += 0.34;
        if (nextClassPattern.test(attrs)) score += 0.2;
        if (!nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase()) && nextClassPattern.test(attrs) && !explicitPagerContext(element)) score -= 0.24;
        if (element.closest('[class*="pagination" i],[class*="pager" i],nav[aria-label*="pagination" i]')) score += 0.12;
        else if (explicitPagerContext(element)) score += 0.1;
      } else {
        const state = loadMoreState(element);
        if (!state.active) return 0;
        if (state.hasText) score += 0.34;
        else score += 0.08;
        if (/(load-more|loadmore)/i.test(attrs)) score += 0.16;
      }
      if (listRect) {
        const below = rect.top >= listRect.top + Math.min(80, listRect.height * 0.25);
        const close = rect.top <= listRect.bottom + Math.max(260, window.innerHeight * 0.7);
        const overlap = rect.right >= listRect.left && rect.left <= listRect.right;
        if (below && close) score += 0.18;
        if (overlap) score += 0.08;
      } else if (viewportRect.top > window.innerHeight * 0.5 || viewportRect.top > 320) {
        score += 0.08;
      }
      if (prevTextPattern.test(value) || excludedClassPattern.test(attrs)) score -= 0.45;
      if (value.length > 40) score -= 0.2;
      if (element.closest('header,footer')) score -= 0.16;
      return Math.max(0, Math.min(0.98, score));
    }

    function findNumericNext(elements: Element[], listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): PageCandidate | null {
      for (const group of samePagerGroup(elements)) {
        const nums = group
          .map((element) => ({ element, num: numericValue(element), cls: attrText(element), rect: documentRect(element) }))
          .filter((item): item is { element: Element; num: number; cls: string; rect: DOMRect } => item.num !== null)
          .sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top || a.num - b.num);
        if (nums.length < 2) continue;
        let activeIndex = nums.findIndex((item) => activeClassPattern.test(item.cls) || item.element.getAttribute('aria-current') === 'page');
        if (activeIndex === -1 && nums[0]?.num === 1) activeIndex = 0;
        if (activeIndex < 0 || activeIndex >= nums.length - 1) continue;
        const lastNumRect = nums[nums.length - 1].rect;
        const centerY = lastNumRect.top + lastNumRect.height / 2;
        const arrow = group
          .map((element) => ({ element, clickable: firstClickable(element), rect: documentRect(element), value: text(element), attrs: attrText(element) }))
          .filter((item) => numericValue(item.element) === null)
          .filter((item) => !prevTextPattern.test(item.value) && !excludedClassPattern.test(item.attrs))
          .filter((item) => item.value !== '...' && item.value !== '…')
          .filter((item) => Math.abs((item.rect.top + item.rect.height / 2) - centerY) < Math.max(24, lastNumRect.height))
          .filter((item) => item.rect.left >= lastNumRect.right - 4)
          .sort((a, b) => a.rect.left - b.rect.left)
          .find((item) => nextTexts.some((value) => item.value === value || item.value.toLowerCase() === value.toLowerCase()) || nextClassPattern.test(`${item.attrs} ${attrText(item.clickable)}`));
        const target = arrow ? firstClickable(arrow.clickable) : firstClickable(nums[activeIndex + 1].element);
        const confidence = scoreButton(target, 'next_page', listRect, scope) + 0.08;
        if (confidence < 0.5) continue;
        return {
          type: 'next_page',
          xpath: stablePaginationXPath(target, 'next_page', xpath(target)),
          text: text(target),
          confidence: Math.min(0.98, arrow ? Math.max(confidence, 0.84) : confidence),
          isAjax: isAjax(target),
          scope,
          reasons: arrow ? ['pager arrow after numeric pages', 'numeric pager sequence'] : ['numeric pager sequence']
        };
      }
      return null;
    }

    function insideListItem(element: Element, item: ItemInfo): boolean {
      if (!item.itemXPath) return false;
      return evaluateXPath(item.itemXPath).slice(0, 160).some((row) => row === element || row.contains(element));
    }

    function findButtons(item?: ItemInfo, listRect?: DOMRect, scope: 'near_list' | 'global' = 'global'): PageCandidate[] {
      const elements = Array.from(document.querySelectorAll(scanSelector))
        .filter(visible)
        .filter((element) => item ? !insideListItem(element, item) : true)
        .filter((element) => {
          if (!listRect) return true;
          const rect = documentRect(element);
          const belowListStart = rect.top >= listRect.top + Math.min(80, listRect.height * 0.2);
          const notTooFar = rect.top <= listRect.bottom + Math.max(360, window.innerHeight);
          const horizontalNear = rect.right >= listRect.left - 80 && rect.left <= listRect.right + 80;
          return belowListStart && notTooFar && horizontalNear;
        });
      const output: PageCandidate[] = [];
      for (const element of elements) {
        const value = text(element);
        const attrs = attrText(element);
        const clickable = firstClickable(element);
        if (loadMoreState(element).active) {
          const confidence = scoreButton(clickable, 'load_more', listRect, scope);
          if (confidence >= 0.52) {
            output.push({
              type: 'load_more',
              xpath: stablePaginationXPath(clickable, 'load_more', xpath(clickable)),
              text: value,
              confidence,
              isAjax: true,
              scope,
              reasons: ['load-more text or attributes']
            });
          }
          continue;
        }
        if ((nextTexts.some((item) => value === item || value.toLowerCase() === item.toLowerCase()) || nextClassPattern.test(attrs)) && !horizontalFilterOrCarousel(clickable, listRect)) {
          const confidence = scoreButton(clickable, 'next_page', listRect, scope);
          if (confidence >= 0.5) {
            output.push({
              type: 'next_page',
              xpath: stablePaginationXPath(clickable, 'next_page', xpath(clickable)),
              text: value || clickable.getAttribute('aria-label') || clickable.getAttribute('title') || '',
              confidence,
              isAjax: isAjax(clickable),
              scope,
              reasons: ['next-page text or attributes']
            });
          }
        }
      }
      const numeric = findNumericNext(elements, listRect, scope);
      if (numeric) output.push(numeric);
      return output;
    }

    function listRectFor(item: { xpath: string; itemXPath: string }): DOMRect | undefined {
      const elements = evaluateXPath(item.itemXPath).filter(visible).slice(0, 80);
      if (!elements.length) {
        const root = evaluateXPath(item.xpath).find(visible);
        return root?.getBoundingClientRect();
      }
      const rects = elements.map((element) => documentRect(element));
      const left = Math.min(...rects.map((rect) => rect.left));
      const top = Math.min(...rects.map((rect) => rect.top));
      const right = Math.max(...rects.map((rect) => rect.right));
      const bottom = Math.max(...rects.map((rect) => rect.bottom));
      return new DOMRect(left, top, right - left, bottom - top);
    }

    function choose(candidates: PageCandidate[]): PageCandidate | undefined {
      const evidenceWeight = (value: PageCandidate) => {
        const reasons = value.reasons.join(' ');
        return (/pager arrow after numeric pages/i.test(reasons) ? 0.06 : 0)
          + (/numeric pager sequence/i.test(reasons) ? 0.04 : 0)
          + (/pager section context/i.test(reasons) ? 0.02 : 0);
      };
      return candidates
        .sort((a, b) => (b.confidence + evidenceWeight(b)) - (a.confidence + evidenceWeight(a)))
        .filter((candidate, index, array) => array.findIndex((item) => item.xpath === candidate.xpath) === index)
        .sort((a, b) => {
          const typeWeight = (value: PageCandidate) => value.type === 'load_more' ? 0.03 : 0;
          return (b.confidence + typeWeight(b) + evidenceWeight(b)) - (a.confidence + typeWeight(a) + evidenceWeight(a));
        })[0];
    }

    const globalButtons = (item?: ItemInfo) => findButtons(item, undefined, 'global')
      .filter((candidate) => candidate.confidence >= 0.58 || pagerClassPattern.test(candidate.xpath));
    const result: Record<string, PageCandidate> = {};
    for (const item of items) {
      const rect = listRectFor(item);
      const local = rect ? findButtons(item, rect, 'near_list') : [];
      const selected = choose([...local, ...globalButtons(item)]);
      if (selected) result[item.id] = selected;
    }
    return result;
  }, input) as Record<string, DetectedPagination>;

  const fallbackPaginationById = await detectCandidateScopedPaginationFallbacks(
    page,
    candidates.filter((candidate) => !paginationById[candidate.id] || !isPlausiblePaginationOption(paginationById[candidate.id])),
    scrollProbe
  );
  const probePaginationById = scrollProbePaginationForCandidates(candidates, scrollProbe);
  return candidates.map((candidate) => {
    const existingPagination = candidate.pagination && !scrollProbeRulesOutScroll(candidate, scrollProbe)
      ? candidate.pagination
      : undefined;
    const paginationSources: Array<DetectedPagination | undefined> = [
      existingPagination,
      paginationAllowedForCandidate(candidate, paginationById[candidate.id]) ? paginationById[candidate.id] : undefined,
      fallbackPaginationById[candidate.id],
      probePaginationById[candidate.id]
    ];
    const pagination = paginationSources
      .filter((item): item is DetectedPagination => item ? isPlausiblePaginationOption(item) : false)
      .reduce<DetectedPagination | undefined>((selected, item) => preferredPagination(selected, item), undefined);
    const { pagination: _discardedPagination, ...candidateWithoutPagination } = candidate;
    return {
      ...candidateWithoutPagination,
      ...(pagination ? { pagination } : {})
    };
  });
}

function paginationAllowedForCandidate(candidate: DetectedCandidate, pagination: DetectedPagination | undefined): boolean {
  if (!pagination) return false;
  if (pagination.scope !== 'global') return true;
  if (pagination.type === 'scroll') return candidateEligibleForGlobalScrollPagination(candidate);
  return candidateEligibleForGlobalControlPagination(candidate);
}

function sanitizeCandidatePaginationByLayout(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates.map((candidate) => {
    if (!candidate.pagination || paginationAllowedForCandidate(candidate, candidate.pagination)) return candidate;
    const { pagination: _discardedPagination, ...withoutPagination } = candidate;
    return withoutPagination;
  });
}

async function detectCandidateScopedPaginationFallbacks(page: Page, candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Promise<Record<string, DetectedPagination>> {
  const result: Record<string, DetectedPagination> = {};
  for (const candidate of candidates) {
    if (candidate.type === 'detail' || candidate.type === 'form') continue;
    const options = await detectInteractivePaginationOptions(page, [candidate], scrollProbe).catch(() => []);
    const selected = options.find(isCandidateScopedPaginationFallback);
    if (selected) {
      result[candidate.id] = {
        ...selected,
        reasons: selected.reasons.some((reason) => /candidate-scoped fallback/i.test(reason))
          ? selected.reasons
          : [...selected.reasons, 'candidate-scoped fallback pagination scan']
      };
    }
  }
  return result;
}

function isCandidateScopedPaginationFallback(pagination: DetectedPagination): boolean {
  return pagination.scope === 'near_list'
    && pagination.type !== 'scroll'
    && pagination.confidence >= 0.72
    && isPlausiblePaginationOption(pagination);
}

function candidateEligibleForGlobalControlPagination(candidate: DetectedCandidate): boolean {
  if (candidate.itemCount < 8) return false;
  const role = candidate.layout?.role;
  if (role && role !== 'main' && role !== 'unknown') return false;
  if (candidate.layout) {
    if (candidate.layout.sidebarPenalty >= 0.28 || candidate.layout.boilerplatePenalty >= 0.34) return false;
    if (candidate.layout.visualCoverage < 0.12 && candidate.itemCount < 20) return false;
  }
  return candidateHasRecordSignal(candidate) || candidate.itemCount >= 20;
}

function scrollProbeRulesOutScroll(candidate: Pick<DetectedCandidate, 'itemCount' | 'pagination'>, scrollProbe?: ScrollProbeSummary): boolean {
  if (candidate.pagination?.type !== 'scroll' || !scrollProbe) return false;
  if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) return false;
  if (scrollProbeLooksLikeStaticLargeList(candidate, scrollProbe)) return true;
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  if (grewArticleLikeCount >= 2) return false;
  if (!scrollProbe.reachedBottom) return false;
  return !scrollProbe.sawGrowth || (grewArticleLikeCount === 0 && candidate.itemCount <= 20);
}

function scrollProbePaginationForCandidates(candidates: DetectedCandidate[], scrollProbe?: ScrollProbeSummary): Record<string, DetectedPagination> {
  if (!scrollProbe) return {};
  const result: Record<string, DetectedPagination> = {};
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  const grewContentHeight = scrollProbe.grewContentHeight ?? 0;
  const grewPageHeight = scrollProbe.grewPageHeight ?? 0;
  const sawListItemGrowth = grewArticleLikeCount >= 2;
  for (const candidate of candidates) {
    if (candidate.type === 'detail' || candidate.type === 'form') continue;
    if (!candidateEligibleForGlobalScrollPagination(candidate)) continue;
    const listLike = candidate.type === 'repeated_card' || candidate.type === 'search_results' || candidate.type === 'link_collection';
    const enoughItems = candidate.itemCount >= 8 || scrollProbe.maxArticleLikeCount >= 8;
    if (!listLike || !enoughItems) continue;
    if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) {
      const text = scrollProbe.bestActiveLoadMoreText || 'Load more';
      const confidence = Math.min(
        0.9,
        0.62
          + (scrollProbe.sawGrowth ? 0.1 : 0)
          + Math.min(0.08, grewArticleLikeCount / 100)
          + (scrollProbe.bestActiveLoadMoreXPath ? 0.04 : 0)
      );
      result[candidate.id] = {
        type: 'load_more',
        xpath: scrollProbeLoadMoreXPath(scrollProbe),
        text,
        confidence,
        isAjax: true,
        scope: 'global',
        revealByScroll: true,
        reasons: [
          'load-more observed during detection scroll probe',
          ...(scrollProbe.sawGrowth ? ['content grew during detection scroll probe'] : [])
        ]
      };
      continue;
    }
    if (scrollProbeLooksLikeStaticLargeList(candidate, scrollProbe)) continue;
    if (!sawListItemGrowth) continue;
    const confidence = Math.min(
      0.86,
      0.56
        + Math.min(0.18, grewArticleLikeCount / 40)
        + Math.min(0.08, grewPageHeight / 3000)
        + Math.min(0.06, grewContentHeight / 9000)
        + (scrollProbe.reachedBottom ? 0.02 : 0)
    );
    result[candidate.id] = {
      type: 'scroll',
      xpath: '',
      text: 'Scroll page',
      confidence,
      isAjax: true,
      scope: 'global',
      reasons: [
        'list-like item count grew during detection scroll probe',
        `scroll probe added ${grewArticleLikeCount} list-like items`,
        ...(grewContentHeight ? [`scroll probe increased content text by ${grewContentHeight} chars`] : []),
        ...(grewPageHeight ? [`scroll probe increased page height by ${grewPageHeight}px`] : [])
      ]
    };
  }
  return result;
}

function candidateEligibleForGlobalScrollPagination(candidate: DetectedCandidate): boolean {
  if (candidate.itemCount < 8) return false;
  const role = candidate.layout?.role;
  if (role && role !== 'main' && role !== 'unknown') return false;
  if (candidate.layout) {
    if (candidate.layout.sidebarPenalty >= 0.28 || candidate.layout.boilerplatePenalty >= 0.34) return false;
    if (candidate.layout.visualCoverage < 0.12 && candidate.itemCount < 20) return false;
  }
  return candidateHasRecordSignal(candidate) || candidate.itemCount >= 20;
}

function candidateHasRecordSignal(candidate: DetectedCandidate): boolean {
  const fieldNames = candidate.fields.map((field) => field.name).join(' ');
  return /title|标题|url|链接|image|图片|date|time|时间|summary|description|描述|价格|price|company|公司|位置|location|author|作者|标签|tag/i.test(fieldNames);
}

function scrollProbeLooksLikeStaticLargeList(candidate: Pick<DetectedCandidate, 'itemCount'>, scrollProbe: ScrollProbeSummary): boolean {
  if (scrollProbeHasReliableActiveLoadMore(scrollProbe)) return false;
  const grewArticleLikeCount = scrollProbe.grewArticleLikeCount ?? 0;
  if (candidate.itemCount < 180 || grewArticleLikeCount < 2) return false;
  if (grewArticleLikeCount > candidate.itemCount && scrollProbe.maxArticleLikeCount > candidate.itemCount * 2.5) return true;
  const largestObservedCount = Math.max(candidate.itemCount, scrollProbe.maxArticleLikeCount || 0);
  const growthRatio = grewArticleLikeCount / Math.max(1, largestObservedCount);
  const likelyReachedCompleteList = scrollProbe.reachedBottom === true || candidate.itemCount >= 200;
  return likelyReachedCompleteList && growthRatio < 0.5;
}

function scrollProbeHasReliableActiveLoadMore(scrollProbe: ScrollProbeSummary): boolean {
  if (!scrollProbe.sawActiveLoadMore) return false;
  const text = scrollProbe.bestActiveLoadMoreText?.replace(/\s+/g, ' ').trim() || '';
  if (!text) return Boolean(scrollProbe.bestActiveLoadMoreXPath);
  if (text.length > 48) return false;
  return /^(加载更多|查看更多|查看更多内容|查看更多结果|显示更多|显示更多内容|显示更多结果|点击加载|点击加载更多|load more|load more results|show more|show more results|see more)$/i.test(text);
}

function scrollProbeLoadMoreXPath(scrollProbe: ScrollProbeSummary): string {
  const text = scrollProbe.bestActiveLoadMoreText?.replace(/\s+/g, ' ').trim();
  const matchedText = text?.match(/加载更多|查看更多|显示更多|点击加载|load more|show more|see more/i)?.[0];
  if (matchedText) {
    const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
    return `//*[(${loadMoreTagOrRoleXPath()}) and contains(${lowerText}, ${xpathStringLiteral(matchedText.toLowerCase())}) and ${loadMoreEndTextExclusionForDetectorXPath()}]`;
  }
  return scrollProbe.bestActiveLoadMoreXPath || genericLoadMoreDetectorXPath();
}

function genericLoadMoreDetectorXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const classExpr = `translate(concat(" ", normalize-space(@class), " "), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const roleExpr = `translate(@role, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const positive = [
    `contains(${lowerText}, "加载更多")`,
    `contains(${lowerText}, "查看更多")`,
    `contains(${lowerText}, "显示更多")`,
    `contains(${lowerText}, "点击加载")`,
    `contains(${lowerText}, "load more")`,
    `contains(${lowerText}, "show more")`,
    `contains(${lowerText}, "see more")`,
    `contains(${classExpr}, " load-more ")`,
    `contains(${classExpr}, " loadmore ")`,
    `${roleExpr}="button" and (contains(${lowerText}, "more") or contains(${lowerText}, "更多"))`
  ].join(' or ');
  return `//*[(${loadMoreTagOrRoleXPath()}) and (${positive}) and ${loadMoreEndTextExclusionForDetectorXPath()}]`;
}

function loadMoreTagOrRoleXPath(): string {
  return 'self::a or self::button or self::div or self::span or self::li or @onclick or @role';
}

function loadMoreEndTextExclusionForDetectorXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  return [
    `not(contains(${lowerText}, "没有更多"))`,
    `not(contains(${lowerText}, "暂无更多"))`,
    `not(contains(${lowerText}, "已到底"))`,
    `not(contains(${lowerText}, "到底了"))`,
    `not(contains(${lowerText}, "加载完毕"))`,
    `not(contains(${lowerText}, "no more"))`,
    `not(contains(${lowerText}, "all loaded"))`,
    `not(contains(${lowerText}, "end of"))`,
    `not(contains(${lowerText}, "see more information"))`,
    `not(contains(${lowerText}, "more information about"))`,
    `not(contains(${lowerText}, "details about"))`,
    `not(contains(${lowerText}, "view details"))`,
    `not(contains(${lowerText}, "查看详情"))`,
    `not(contains(${lowerText}, "详细信息"))`
  ].join(' and ');
}

function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.split("'").join(`',"'",'`)}')`;
}

function preferredPagination(existing: DetectedPagination | undefined, detected: DetectedPagination | undefined): DetectedPagination | undefined {
  if (!existing) return detected;
  if (!detected) return existing;
  const merged = mergePaginationSignals(existing, detected);
  let selected: DetectedPagination;
  if (existing.type === 'next_page' && detected.type === 'scroll' && !reliableNextPagination(existing)) selected = detected;
  else if (existing.type === 'scroll' && detected.type === 'next_page' && !reliableNextPagination(detected)) selected = existing;
  else if (existing.type !== 'scroll' && detected.type === 'scroll') selected = existing;
  else if (existing.type === 'load_more' && detected.type !== 'load_more') selected = existing;
  else if (detected.type !== 'scroll' && existing.type === 'scroll') selected = detected;
  else selected = comparePaginationOptions(existing, detected) <= 0 ? existing : detected;
  return merged(selected);
}

function reliableNextPagination(pagination: DetectedPagination): boolean {
  if (pagination.type !== 'next_page') return false;
  const text = (pagination.text || '').trim();
  const xpath = pagination.xpath || '';
  const reasons = pagination.reasons.join(' ');
  const pagerLike = /(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)
    || /numeric pager|pager sequence|pager section|pager arrow/i.test(reasons);
  if (/^(下一页|下页|后一页|后页|next)$/i.test(text)) return true;
  if (/^(>|›|»|→)$/i.test(text)) return pagerLike;
  if (/(pagination|pager|paginator|pagebar|page-nav|pages|el-pagination|ant-pagination|ivu-page)/i.test(xpath)) return true;
  if (/(pager-next|page-next|pagination-next|nextpage|btn-next)/i.test(xpath)) return true;
  if (/numeric pager|pager sequence|pager section/i.test(reasons) && /^\d{1,5}$/.test(text)) return true;
  return pagination.confidence >= 0.86 && !/(arrow-right|right|carousel|filter|筛选|分类|category|tag|tab|chip|swiper|slider)/i.test(`${xpath} ${reasons}`);
}

function mergePaginationSignals(a: DetectedPagination, b: DetectedPagination): (selected: DetectedPagination) => DetectedPagination {
  const revealByScroll = a.revealByScroll || b.revealByScroll || a.type === 'scroll' && b.type === 'load_more' || b.type === 'scroll' && a.type === 'load_more';
  return (selected) => revealByScroll && selected.type === 'load_more'
    ? {
      ...selected,
      revealByScroll: true,
      reasons: selected.reasons.some((reason) => /scroll/i.test(reason))
        ? selected.reasons
        : [...selected.reasons, 'load-more may be revealed after scrolling']
    }
    : selected;
}

function deptaCandidate(group: DeptaListGroup): RawCandidate | null {
  const fields: DetectedField[] = [];
  const titleSamples = group.rowSamples
    .map((row) => row.chunks.find((chunk) => chunk.length >= 2 && chunk !== row.text) || row.text)
    .filter(Boolean)
    .slice(0, 3);
  if (titleSamples.length) {
    fields.push({
      name: group.rowSamples.some((row) => row.href) ? 'title' : 'text',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: titleSamples
    });
  }
  const hrefSamples = group.rowSamples.map((row) => row.href).filter(Boolean).slice(0, 3);
  if (hrefSamples.length >= 2) {
    fields.push({
      name: 'url',
      kind: 'href',
      selector: `${group.itemSelector} a`,
      xpath: `${group.itemXPath}//a[1]`,
      relativeSelector: 'a',
      relativeXPath: './a[1]',
      samples: hrefSamples
    });
  }
  const imageSamples = group.rowSamples.map((row) => row.image).filter(Boolean).slice(0, 3);
  if (imageSamples.length >= 2) {
    fields.push({
      name: 'image',
      kind: 'src',
      selector: `${group.itemSelector} img`,
      xpath: `${group.itemXPath}//img[1]`,
      relativeSelector: 'img',
      relativeXPath: './img[1]',
      samples: imageSamples
    });
  }
  const summarySamples = group.rowSamples
    .map((row) => row.chunks.find((chunk) => chunk.length > 12 && !titleSamples.includes(chunk)) || '')
    .filter(Boolean)
    .slice(0, 3);
  if (summarySamples.length >= 2) {
    fields.push({
      name: 'summary',
      kind: 'text',
      selector: group.itemSelector,
      xpath: group.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: summarySamples
    });
  }
  if (!fields.length) return null;
  const legalBoilerplate = group.rowSamples.some((row) => isLegalBoilerplateText([row.text, ...row.chunks].join(' ')));
  if (legalBoilerplate) return null;
  const semantic = (fields.some((field) => field.name === 'title') ? 1 : 0)
    + (fields.some((field) => field.name === 'url') ? 1 : 0)
    + (fields.some((field) => field.name === 'image') ? 0.5 : 0);
  const weakBoilerplate = group.navigationLike
    || isFooterLikeSelector(group.parentSelector)
    || group.rowSamples.some((row) => isWeakBoilerplateText([row.text, ...row.chunks].join(' ')));
  const penalty = (group.navigationLike ? 0.22 : 0) + (weakBoilerplate ? 0.34 : 0);
  return {
    type: fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
    selector: group.parentSelector,
    xpath: group.parentXPath,
    itemSelector: group.itemSelector,
    itemXPath: group.itemXPath,
    itemCount: group.itemCount,
    fields,
    sampleRows: group.rowSamples.slice(0, 3).map((row) => {
      const record: Record<string, string> = {};
      for (const field of fields) {
        if (field.name === 'title' || field.name === 'text') record[field.name] = row.chunks[0] || row.text;
        else if (field.name === 'url') record[field.name] = row.href;
        else if (field.name === 'image') record[field.name] = row.image;
        else record[field.name] = row.chunks.find((chunk) => chunk.length > 12) || row.text;
      }
      return record;
    }),
    reasons: [
      ...group.reasons,
      `${group.itemCount} repeated records found by visual DOM tree`,
      ...(group.navigationLike ? ['Likely navigation/header group'] : []),
      ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: Math.max(
      0.1,
      Math.min(0.98, scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic, penalty }) + group.score * 0.08)
    )
  };
}

function repeatedCardCandidate(item: {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  rows: Array<{ text: string; links: Array<{ text: string; href: string }>; images: string[]; chunks: string[] }>;
}): RawCandidate | null {
  const fields: DetectedField[] = [];
  const firstLinkSamples = item.rows.map((row) => row.links[0]?.text).filter(Boolean);
  if (firstLinkSamples.length) {
    fields.push({
      name: 'title',
      kind: 'text',
      selector: `${item.itemSelector} a`,
      xpath: `${item.itemXPath}//a[1]`,
      relativeSelector: 'a',
      relativeXPath: './a[1]',
      samples: firstLinkSamples.slice(0, 3)
    });
    const hrefSamples = item.rows.map((row) => row.links[0]?.href).filter(Boolean);
    if (hrefSamples.length) {
      fields.push({
        name: 'url',
        kind: 'href',
        selector: `${item.itemSelector} a`,
        xpath: `${item.itemXPath}//a[1]`,
        relativeSelector: 'a',
        relativeXPath: './a[1]',
        samples: hrefSamples.slice(0, 3)
      });
    }
  }
  const imageSamples = item.rows.map((row) => row.images[0]).filter(Boolean);
  if (imageSamples.length) {
    fields.push({
      name: 'image',
      kind: 'src',
      selector: `${item.itemSelector} img`,
      xpath: `${item.itemXPath}//img[1]`,
      relativeSelector: 'img',
      relativeXPath: './img[1]',
      samples: imageSamples.slice(0, 3)
    });
  }
  const chunkSamples = item.rows.map((row) => row.chunks.find((chunk) => chunk !== row.links[0]?.text && chunk.length > 12)).filter(Boolean) as string[];
  if (chunkSamples.length) {
    fields.push({
      name: 'summary',
      kind: 'text',
      selector: item.itemSelector,
      xpath: item.itemXPath,
      relativeSelector: '',
      relativeXPath: '.',
      samples: chunkSamples.slice(0, 3)
    });
  }
  if (fields.length < 2) return null;
  const semantic = (fields.some((field) => field.name === 'title') ? 1 : 0) + (fields.some((field) => field.name === 'url') ? 1 : 0);
  const textLooksSearch = item.rows.some((row) => row.links.length > 0 && row.text.length > 30);
  const legalBoilerplate = item.rows.some((row) => isLegalBoilerplateText(row.text));
  if (legalBoilerplate) return null;
  const weakBoilerplate = item.rows.some((row) => isWeakBoilerplateText(row.text)) || isFooterLikeSelector(item.parentSelector);
  const boilerplatePenalty = weakBoilerplate ? 0.46 : 0;
  return {
    type: textLooksSearch && fields.some((field) => field.name === 'url') ? 'search_results' : 'repeated_card',
    selector: item.parentSelector,
    xpath: item.parentXPath,
    itemSelector: item.itemSelector,
    itemXPath: item.itemXPath,
    itemCount: item.itemCount,
    fields,
    sampleRows: item.rows.slice(0, 3).map((row) => {
      const record: Record<string, string> = {};
      for (const field of fields) {
        if (field.name === 'title') record[field.name] = row.links[0]?.text ?? '';
        else if (field.name === 'url') record[field.name] = row.links[0]?.href ?? '';
        else if (field.name === 'image') record[field.name] = row.images[0] ?? '';
        else record[field.name] = row.chunks.find((chunk) => chunk !== row.links[0]?.text && chunk.length > 12) ?? row.text;
      }
      return record;
    }),
    reasons: [
      'Sibling elements share the same DOM shape',
      `${item.itemCount} repeated items found`,
      ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: scoreCandidate({ itemCount: item.itemCount, fieldCount: fields.length, semantic, penalty: boilerplatePenalty })
  };
}

function searchResultBlockCandidate(group: {
  parentSelector: string;
  parentXPath: string;
  itemSelector: string;
  itemXPath: string;
  itemCount: number;
  titlePath: string;
  summaryPath: string;
  categoryPath: string;
  rows: Array<{ title: string; href: string; summary: string; category: string; text: string }>;
  boilerplateLike: boolean;
  shadowHost?: boolean;
  reasons: string[];
}): RawCandidate {
  const titleRelativeXPath = group.shadowHost ? '.' : group.titlePath || './/a[1]';
  const summaryRelativeXPath = group.shadowHost ? '.' : group.summaryPath || '.';
  const titleXPath = appendRelativeXPath(group.itemXPath, titleRelativeXPath);
  const summaryXPath = appendRelativeXPath(group.itemXPath, summaryRelativeXPath);
  const categoryXPath = !group.shadowHost && group.categoryPath ? appendRelativeXPath(group.itemXPath, group.categoryPath) : '';
  const fields: DetectedField[] = [
    {
      name: 'title',
      kind: 'text',
      selector: `${group.itemSelector} a`,
      xpath: titleXPath,
      relativeSelector: 'a',
      relativeXPath: titleRelativeXPath,
      samples: group.rows.map((row) => row.title).filter(Boolean).slice(0, 3)
    },
    {
      name: 'url',
      kind: 'href',
      selector: `${group.itemSelector} a`,
      xpath: titleXPath,
      relativeSelector: 'a',
      relativeXPath: titleRelativeXPath,
      samples: group.rows.map((row) => row.href).filter(Boolean).slice(0, 3)
    },
    {
      name: 'summary',
      kind: 'text',
      selector: group.itemSelector,
      xpath: summaryXPath,
      relativeSelector: '',
      relativeXPath: summaryRelativeXPath,
      samples: group.rows.map((row) => row.summary).filter(Boolean).slice(0, 3)
    }
  ];
  const categorySamples = group.rows.map((row) => row.category).filter(Boolean);
  if (categoryXPath && categorySamples.length >= 2) {
    fields.push({
      name: 'category',
      kind: 'text',
      selector: group.itemSelector,
      xpath: categoryXPath,
      relativeSelector: '',
      relativeXPath: group.categoryPath,
      samples: categorySamples.slice(0, 3)
    });
  }
  const semantic = 2.4 + (categorySamples.length >= 2 ? 0.3 : 0);
  const penalty = group.boilerplateLike ? 0.5 : 0;
  return {
    type: 'search_results',
    selector: group.parentSelector,
    xpath: group.parentXPath,
    itemSelector: group.itemSelector,
    itemXPath: group.itemXPath,
    itemCount: group.itemCount,
    fields,
    sampleRows: group.rows.slice(0, 3).map((row) => ({
      title: row.title,
      url: row.href,
      summary: row.summary,
      ...(row.category ? { category: row.category } : {})
    })),
    reasons: [
      ...group.reasons,
      `${group.itemCount} repeated search-result records found`,
      ...(group.boilerplateLike ? ['Likely weak footer/navigation boilerplate group'] : [])
    ],
    confidence: scoreCandidate({ itemCount: group.itemCount, fieldCount: fields.length, semantic, penalty })
  };
}

function appendRelativeXPath(itemXPath: string, relativeXPath: string): string {
  if (!relativeXPath || relativeXPath === '.') return itemXPath;
  if (relativeXPath.startsWith('.//')) return `${itemXPath}//${relativeXPath.slice(3)}`;
  if (relativeXPath.startsWith('./')) return `${itemXPath}/${relativeXPath.slice(2)}`;
  return `${itemXPath}/${relativeXPath.replace(/^\/+/, '')}`;
}

async function detectForms(page: Page): Promise<RawCandidate[]> {
  const forms = await findSearchInputCandidates(page, 'query');
  return forms
    .filter((form) => form.name || form.placeholder || form.buttonText || form.formAction)
    .slice(0, 8)
    .map((form, index) => ({
      type: 'form',
      selector: `input[name="${form.name || 'query'}"]`,
      xpath: form.xpath,
      itemCount: 1,
      fields: [{
        name: 'query',
        kind: 'value',
        selector: 'input',
        xpath: form.xpath,
        samples: [form.placeholder || form.name || form.buttonText || form.formAction].filter(Boolean)
      }],
      sampleRows: [{ input: form.placeholder || form.name, action: form.formAction, submit: form.buttonText || '' }],
      reasons: ['Search or input form detected; provide input before extracting results', ...form.reasons],
      confidence: Math.max(0.45, Math.min(0.92, 0.35 + form.score * 0.18 - index * 0.02))
    } satisfies RawCandidate));
}

async function detectLinkCollections(page: Page): Promise<RawCandidate[]> {
  const collections = await page.evaluate(() => {
    function text(element: Element): string {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function xpath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        const currentTag = current.tagName;
        const parentElement: Element | null = current.parentElement;
        const siblings = parentElement ? Array.from(parentElement.children).filter((item: Element) => item.tagName === currentTag) : [];
        parts.unshift(`${current.tagName.toLowerCase()}[${siblings.indexOf(current) + 1 || 1}]`);
        current = parentElement;
      }
      return `/${parts.join('/')}`;
    }
    function visible(element: Element): boolean {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element as HTMLElement);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' && style.visibility !== 'hidden';
    }
    function commonXPath(paths: string[]): string {
      if (!paths.length) return '';
      const split = paths.map((path) => path.split('/').filter(Boolean));
      const output: string[] = [];
      for (let index = 0; index < Math.min(...split.map((parts) => parts.length)); index += 1) {
        const tag = split[0][index].replace(/\[\d+\]$/, '');
        if (!split.every((parts) => parts[index].replace(/\[\d+\]$/, '') === tag)) break;
        output.push(split.every((parts) => parts[index] === split[0][index]) ? split[0][index] : tag);
      }
      return output.length ? `/${output.join('/')}` : '';
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
    function navigationLike(element: Element, links: Array<{ text: string; href: string }>): boolean {
      if (element.closest('nav,header')) return true;
      const rect = element.getBoundingClientRect();
      const shortTextRate = links.filter((link) => link.text.length <= 8).length / Math.max(1, links.length);
      const navTextRate = links.filter((link) => /^(新闻|网页|贴吧|知道|图片|视频|地图|文库|更多|设置|登录|注册|首页|分类|导航|about|home|login|news|images|video|more)$/i.test(link.text)).length / Math.max(1, links.length);
      return (rect.top < 180 && rect.height < 180 && shortTextRate > 0.7) || navTextRate > 0.45;
    }
    function footerLike(element: Element): boolean {
      if (element.closest('footer,[role="contentinfo"]')) return true;
      const value = `${attrText(element)} ${text(element).slice(0, 500)}`;
      return /(footer|contentinfo|copyright|beian|icp|备案|公网安备|营业执照|增值电信|隐私政策|用户协议)/i.test(value);
    }
    return Array.from(document.querySelectorAll('main,article,section,ul,ol,div,footer'))
      .map((element, index) => {
        const linkElements = Array.from(element.querySelectorAll(':scope > a, :scope > li > a')).filter(visible) as HTMLAnchorElement[];
        const links = linkElements.map((link) => ({
          text: text(link).slice(0, 120),
          href: (link as HTMLAnchorElement).href
        })).filter((link) => link.text && link.href).slice(0, 20);
        const itemXPath = commonXPath(linkElements.map(xpath));
        return { index, links, parentXPath: xpath(element), itemXPath, navigationLike: navigationLike(element, links), footerLike: footerLike(element) };
      })
      .filter((item) => item.links.length >= 5)
      .sort((a, b) => Number(a.navigationLike) - Number(b.navigationLike))
      .slice(0, 8);
  });
  const output: RawCandidate[] = [];
  for (const [index, item] of collections.entries()) {
    const type = item.navigationLike ? 'link_collection' : 'search_results';
    const legalLinks = item.links.filter((link) => isLegalBoilerplateText(link.text));
    const strongLegalBoilerplate = legalLinks.some((link) => isStrongLegalBoilerplateText(link.text));
    const legalRate = legalLinks.length / Math.max(1, item.links.length);
    if (strongLegalBoilerplate || (item.footerLike && legalLinks.length) || legalRate >= 0.35) continue;
    const links = item.links.filter((link) => !isLegalBoilerplateText(link.text));
    if (links.length < 5) continue;
    const weakBoilerplate = item.footerLike || item.navigationLike || item.links.some((link) => isWeakBoilerplateText(link.text));
    const penalty = (item.navigationLike ? 0.28 : 0) + (weakBoilerplate ? 0.46 : 0) + index * 0.02;
    output.push({
      type,
      selector: `link-collection-${item.index}`,
      xpath: item.parentXPath,
      itemSelector: 'a',
      itemXPath: item.itemXPath || `${item.parentXPath}//a`,
      itemCount: links.length,
      fields: [
        { name: 'text', kind: 'text', selector: 'a', xpath: item.itemXPath || `${item.parentXPath}//a`, relativeSelector: '', relativeXPath: '.', samples: links.map((link) => link.text).slice(0, 3) },
        { name: 'url', kind: 'href', selector: 'a', xpath: item.itemXPath || `${item.parentXPath}//a`, relativeSelector: '', relativeXPath: '.', samples: links.map((link) => link.href).slice(0, 3) }
      ],
      sampleRows: links.slice(0, 3).map((link) => ({ text: link.text, url: link.href })),
      reasons: [
        'Several adjacent links detected',
        ...(item.navigationLike ? ['Likely navigation/header group'] : []),
        ...(weakBoilerplate ? ['Likely weak footer/navigation boilerplate group'] : [])
      ],
      confidence: scoreCandidate({ itemCount: links.length, fieldCount: 2, semantic: item.navigationLike ? 0.3 : 1.2, penalty })
    });
  }
  return output;
}

function candidateTitle(candidate: RawCandidate): string {
  if (candidate.type === 'table') return `Table (${candidate.itemCount} rows)`;
  if (candidate.type === 'search_results') return `Search/list results (${candidate.itemCount} items)`;
  if (candidate.type === 'repeated_card') return `Repeated cards (${candidate.itemCount} items)`;
  if (candidate.type === 'form') return 'Search/input form';
  if (candidate.type === 'link_collection') return `Link collection (${candidate.itemCount} links)`;
  return 'Detail content';
}

function applyLlmRankPreparation(candidates: DetectedCandidate[], goal?: string): DetectedCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    goalReasons: [
      ...(candidate.goalReasons ?? []),
      `LLM rank input prepared${goal ? ` for goal "${goal}"` : ''}; external ranker can use layout, fields, samples, and scores`
    ]
  }));
}

function buildLlmRankInput(candidates: DetectedCandidate[], goal?: string): DetectedLlmRankInput {
  return {
    ...(goal ? { goal } : {}),
    instruction: 'Choose the candidate that best represents the primary user-intended data list. Prefer main content regions with rich repeated records. Penalize navigation, ads, sidebars, and boilerplate unless the goal explicitly asks for them. Return a candidate id and a short reason.',
    candidates: candidates
      .filter((candidate) => candidate.type !== 'form')
      .slice(0, 10)
      .map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        score: Number((candidate.goalScore ?? candidate.confidence).toFixed(2)),
        ...(candidate.layout ? { layout: candidate.layout } : {}),
        fields: candidate.fields.map((field) => field.name),
        sampleRows: candidate.sampleRows.slice(0, 2),
        reasons: candidate.reasons.slice(-8)
      }))
  };
}

function scoreCandidate(input: { itemCount: number; fieldCount: number; semantic: number; penalty: number }): number {
  const itemScore = Math.min(0.35, input.itemCount * 0.04);
  const fieldScore = Math.min(0.25, input.fieldCount * 0.06);
  const semanticScore = Math.min(0.25, input.semantic * 0.1);
  return Number(Math.max(0.1, Math.min(0.98, 0.25 + itemScore + fieldScore + semanticScore - input.penalty)).toFixed(2));
}

function rowToSample(fields: DetectedField[], row: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  fields.forEach((field, index) => {
    record[field.name] = row[index] ?? '';
  });
  return record;
}

function normalizeFieldName(value: string, fallback: string): string {
  const ascii = value.trim().toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return ascii || fallback;
}

const DETECTOR_PARKING_URL = [
  'data:text/html,',
  encodeURIComponent([
    '<!doctype html>',
    '<html><head><title>Octoparse Detector</title></head>',
    '<body style="margin:0">',
    '<div style="height:200000px"></div>',
    '</body></html>'
  ].join(''))
].join('');

function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
