import type { BrowserSessionReference } from '../browser-session.js';
import type { DetectedCandidate, DetectedField, DetectedPaginationType, DetectedPopupDismissal, DetectedSearchPlan } from './types.js';

export interface GeneratedDetectedTask {
  taskId: string;
  taskName: string;
  xml: string;
  fieldNames: string[];
  workflowSetting?: Record<string, unknown>;
  detection: {
    url: string;
    candidateId: string;
    candidateType: DetectedCandidate['type'];
    session?: BrowserSessionReference;
    paginationType?: DetectedPaginationType;
    popupDismissals?: DetectedPopupDismissal[];
    detailPlan?: DetectedCandidate['detailPlan'];
    search?: DetectedSearchPlan;
  };
}

export function buildTaskFromCandidate(options: {
  url: string;
  taskId: string;
  taskName: string;
  candidate: DetectedCandidate;
  popupDismissals?: DetectedPopupDismissal[];
  session?: BrowserSessionReference;
  searchPlan?: DetectedSearchPlan;
}): GeneratedDetectedTask {
  const candidate = normalizeCandidateItemXPath(options.candidate);
  const fields = candidate.fields.filter((field) => field.kind === 'text' || field.kind === 'href' || field.kind === 'src');
  const detailPlan = detailRuntimePlan(candidate);
  const detectionDetailPlan = candidate.detailPlan
    ? { ...candidate.detailPlan, ...(detailPlan ? { status: 'planned' as const } : {}) }
    : undefined;
  const detailFields = detailPlan?.fields.filter((field) => field.kind === 'text' || field.kind === 'href' || field.kind === 'src') ?? [];
  const fieldNames = detailPlan
    ? outputFieldsForDetailMode(detailPlan.mode, fields, detailFields).map((field) => field.name)
    : fields.map((field) => field.name);
  const bodyXml = candidate.type === 'detail'
    ? extractActionXml(fields, { useLoopItem: false })
    : extractionWithPaginationXml(candidate, fields);
  const searchActions = options.searchPlan ? searchActionXml(options.searchPlan) : [];
  const xml = [
    `<ns0:RootAction ${rootAttrs()}>`,
    navigateActionXml(options.searchPlan?.startUrl ?? options.url),
    ...searchActions,
    ...popupDismissalActionXml(options.popupDismissals ?? []),
    bodyXml,
    '</ns0:RootAction>'
  ].join('');
  return {
    taskId: options.taskId,
    taskName: options.taskName,
    xml,
    fieldNames,
    ...workflowSettingForCandidate(candidate),
    detection: {
      url: options.url,
      candidateId: candidate.id,
      candidateType: candidate.type,
      ...(options.searchPlan ? { search: options.searchPlan } : {}),
      ...(options.session ? { session: options.session } : {}),
      paginationType: candidate.pagination?.type,
      ...(detectionDetailPlan ? { detailPlan: detectionDetailPlan } : {}),
      ...(options.popupDismissals?.length ? { popupDismissals: options.popupDismissals } : {})
    }
  };
}

function workflowSettingForCandidate(candidate: DetectedCandidate): { workflowSetting: Record<string, unknown> } | Record<string, never> {
  const pagination = candidate.pagination;
  if (pagination?.type !== 'scroll' && !pagination?.revealByScroll) return {};
  return {
    workflowSetting: {
      repeatPageLoopCount: 12,
      continuousJudgeCount: 3
    }
  };
}

function normalizeCandidateItemXPath(candidate: DetectedCandidate): DetectedCandidate {
  if (candidate.type === 'detail' || candidate.type === 'form') return candidate;
  const itemXPath = candidate.itemXPath || candidate.xpath;
  if (normalizeXPath(itemXPath) !== normalizeXPath(candidate.xpath)) return candidate;
  const inferred = inferItemXPathFromFields(candidate);
  if (!inferred || normalizeXPath(inferred) === normalizeXPath(candidate.xpath)) return candidate;
  return {
    ...candidate,
    itemXPath: inferred,
    fields: candidate.fields.map((field) => ({
      ...field,
      relativeXPath: field.relativeXPath || relativeXPathFromBase(inferred, field.xpath)
    }))
  };
}

function inferItemXPathFromFields(candidate: DetectedCandidate): string | undefined {
  const fieldPaths = candidate.fields
    .map((field) => field.xpath)
    .filter((xpath) => xpath && xpath.startsWith(candidate.xpath));
  for (const fieldPath of fieldPaths) {
    const match = fieldPath.match(/^(.*?\/(?:article|li|tr|section|div)(?:\[\d+\])?)(?:\/|\/\/).+$/i);
    if (!match) continue;
    const base = match[1];
    if (normalizeXPath(base) !== normalizeXPath(candidate.xpath)) return stripLastIndex(base);
  }
  return undefined;
}

function relativeXPathFromBase(baseXPath: string, fieldXPath: string): string {
  if (!fieldXPath.startsWith(baseXPath)) return relativeXPathFromItem(fieldXPath);
  const suffix = fieldXPath.slice(baseXPath.length);
  if (!suffix) return '.';
  return suffix.startsWith('//') ? `.${suffix}` : `.${suffix}`;
}

function normalizeXPath(xpath: string): string {
  return xpath.replace(/\[\d+\]/g, '').replace(/\/+$/, '');
}

function stripLastIndex(xpath: string): string {
  return xpath.replace(/\[\d+\]$/, '');
}

function rootAttrs(): string {
  return [
    'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/workflow"',
    'xmlns:ns0="clr-namespace:Octopus.Actions;Assembly=Octopus.Actions, Version=1.1.5585.26568, Culture=neutral, PublicKeyToken=null"',
    'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"',
    'startRunnerShowBrowser="false"',
    'downloadFolderPath=""',
    'startCaptrueErrorLog="false"',
    'globalCookie=""',
    'isSetGlobalCookie="false"',
    'isCloseLocalWindow="false"',
    'useKernelBrowser="false"'
  ].join(' ');
}

function navigateActionXml(url: string, options: {
  name?: string;
  caption?: string;
  scrollDown?: boolean;
  scrollTime?: string;
  maxRetry?: string;
} = {}): string {
  return `<ns0:NavigateAction ${attrs({
    'x:Name': options.name ?? 'Navigate1',
    Name: '',
    WaitSeconds: '0',
    Caption: options.caption ?? 'Open detected URL',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    URL: url,
    TimeOut: '00:02:00',
    ScrollDown: (options.scrollDown ?? true) ? 'true' : 'false',
    ScrollTime: options.scrollTime ?? '3',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    BlockPopup: 'true',
    IfStopScroll: 'true',
    UseCustomizeCookie: 'false',
    MaxRetry: options.maxRetry ?? '3',
    EnableRetry: 'false',
    TimeInterval: '5',
    RetryInterval: '5',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: '1',
    NavigateType: 'OpenWebpage',
    RequestMethod: 'GET',
    RequestBodyContent: '',
    CustomizeCookie: ''
  })}><ns0:NavigateAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:NavigateAction.RetryConditions></ns0:NavigateAction>`;
}

function searchActionXml(plan: DetectedSearchPlan): string[] {
  const lastInputIndex = plan.inputs.length - 1;
  const inputActions = plan.inputs.map((input, index) => enterTextActionXml({
    name: `EnterSearch${index + 1}`,
    xpath: input.xpath,
    value: input.value,
    autoSubmit: plan.submit?.mode === 'enter' && index === lastInputIndex
  }));
  const clickSubmit = plan.submit?.mode === 'click' && plan.submit.xpath
    ? [clickSearchSubmitActionXml(plan.submit.xpath, plan.submit.text)]
    : [];
  return [...inputActions, ...clickSubmit, ...searchResultNavigationXml(plan)];
}

function searchResultNavigationXml(plan: DetectedSearchPlan): string[] {
  if (!shouldNavigateToSearchFinalUrl(plan)) return [];
  return [navigateActionXml(plan.finalUrl, {
    name: 'NavigateSearchResults',
    caption: 'Open confirmed search results',
    scrollDown: false,
    scrollTime: '0',
    maxRetry: '1'
  })];
}

function shouldNavigateToSearchFinalUrl(plan: DetectedSearchPlan): boolean {
  const finalUrl = normalizeComparableUrl(plan.finalUrl);
  const startUrl = normalizeComparableUrl(plan.startUrl);
  if (!finalUrl || !/^https?:\/\//i.test(finalUrl)) return false;
  if (finalUrl === startUrl) return false;
  return true;
}

function normalizeComparableUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return String(value).replace(/[#?].*$/, '').replace(/\/$/, '');
  }
}

function enterTextActionXml(options: { name: string; xpath: string; value: string; autoSubmit: boolean }): string {
  return `<ns0:EnterTextAction ${attrs({
    'x:Name': options.name,
    Name: '',
    WaitSeconds: '1',
    Caption: 'Enter search keyword',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: actionItemXml(options.xpath),
    InputElementXPaths: '',
    InputMode: 'type',
    IsPassword: 'false',
    TextToSet: options.value,
    AutoSubmit: options.autoSubmit ? 'true' : 'false',
    AutoSubmitTimeout: options.autoSubmit ? '2' : '0',
    AjaxLoad: 'true',
    AjaxTimeout: '3',
    ScrollDown: 'false',
    ScrollTime: '0',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: '3',
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: '1'
  })}><ns0:EnterTextAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:EnterTextAction.RetryConditions></ns0:EnterTextAction>`;
}

function clickSearchSubmitActionXml(xpath: string, text?: string): string {
  return `<ns0:ClickAction ${attrs({
    'x:Name': 'ClickSearchSubmit',
    Name: '',
    WaitSeconds: '0',
    Caption: text ? `Click search submit (${text})` : 'Click search submit',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: actionItemXml(xpath),
    AjaxLoad: 'true',
    TimeOut: '00:02:00',
    AjaxTimeout: '3',
    ScrollDown: 'false',
    ScrollTime: '0',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: '3',
    EnableRetry: 'false',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    OpenInNewWindow: 'false',
    OpenByHref: 'false',
    TimeInterval: '5',
    LocateAnchor: 'false',
    AnchorId: '',
    IPType: '1'
  })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`;
}

function extractionWithPaginationXml(candidate: DetectedCandidate, fields: DetectedField[]): string {
  const listLoop = loopActionXml(candidate, fields, 'LoopItems', 'ExtractItems');
  const pagination = candidate.pagination;
  if (!pagination) return listLoop;
  if (pagination.type === 'scroll') {
    return scrollStepLoopActionXml(candidate, listLoop);
  }
  if (!pagination.xpath) return listLoop;
  return fixedPaginationLoopXml(candidate, listLoop);
}

function loopActionXml(candidate: DetectedCandidate, fields: DetectedField[], loopName = 'Loop1', extractName = 'Extract1'): string {
  const bodyXml = detailRuntimeBodyXml(candidate, fields, extractName);
  return `<ns0:LoopAction ${attrs({
    'x:Name': loopName,
    Name: '',
    WaitSeconds: '2',
    Caption: 'Loop detected items',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'true',
    ScrollTime: '3',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: actionItemXml(candidate.itemXPath || candidate.xpath),
    FixedItem: '',
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'VarilableItemList',
    QuitLoopWhenExecutedTimesEqual: 'false',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: '0',
    CheckedJumpLoopClick: 'true'
  })}>${bodyXml}</ns0:LoopAction>`;
}

function detailRuntimePlan(candidate: DetectedCandidate): NonNullable<DetectedCandidate['detailPlan']> | undefined {
  const plan = candidate.detailPlan;
  if (!plan || plan.mode === 'list_only') return undefined;
  if (!plan.fields.length) return undefined;
  const urlField = candidate.fields.find((field) => field.name === plan.urlField && field.kind === 'href')
    ?? candidate.fields.find((field) => field.name === 'url' && field.kind === 'href')
    ?? candidate.fields.find((field) => field.kind === 'href');
  return urlField ? plan : undefined;
}

function outputFieldsForDetailMode(mode: string, listFields: DetectedField[], detailFields: DetectedField[]): DetectedField[] {
  if (mode === 'detail_only') {
    const urlField = listFields.find((field) => field.name === 'url' && field.kind === 'href')
      ?? listFields.find((field) => field.kind === 'href');
    return urlField ? [urlField, ...detailFields] : detailFields;
  }
  return [...listFields, ...detailFields];
}

function detailRuntimeBodyXml(candidate: DetectedCandidate, fields: DetectedField[], extractName: string): string {
  const plan = detailRuntimePlan(candidate);
  if (!plan) return extractActionXml(fields, { useLoopItem: true, name: extractName, pageIndex: '0' });

  const detailFields = plan.fields.filter((field) => field.kind === 'text' || field.kind === 'href' || field.kind === 'src');
  const parts: string[] = [];
  if (plan.mode === 'list_with_detail') {
    parts.push(extractActionXml(fields, {
      useLoopItem: true,
      name: extractName,
      caption: 'Extract detected list data',
      pageIndex: '0'
    }));
  }
  parts.push(clickDetailActionXml(candidate, plan.urlField));
  parts.push(extractActionXml(detailFields, {
    useLoopItem: true,
    name: 'ExtractDetail',
    caption: 'Extract detected detail data',
    pageIndex: '1',
    forceAbsoluteXPath: true
  }));
  return parts.join('');
}

function clickDetailActionXml(candidate: DetectedCandidate, urlFieldName: string): string {
  const urlField = candidate.fields.find((field) => field.name === urlFieldName && field.kind === 'href')
    ?? candidate.fields.find((field) => field.name === 'url' && field.kind === 'href')
    ?? candidate.fields.find((field) => field.kind === 'href');
  const clickXPath = detailClickXPath(urlField);
  return `<ns0:ClickAction ${attrs({
    'x:Name': 'ClickDetail',
    Name: '',
    WaitSeconds: '0',
    Caption: 'Click detail link',
    WaitItem: '',
    UseLoopItem: 'true',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: actionItemXml(clickXPath),
    AjaxLoad: 'false',
    TimeOut: '00:02:00',
    AjaxTimeout: '0',
    ScrollDown: 'false',
    ScrollTime: '100',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: '3',
    EnableRetry: 'false',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    OpenInNewWindow: 'true',
    OpenByHref: 'false',
    TimeInterval: '5',
    LocateAnchor: 'false',
    AnchorId: '',
    IPType: '1'
  })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`;
}

function detailClickXPath(field: DetectedField | undefined): string {
  if (!field) return '';
  const relativeXPath = field.relativeXPath || relativeXPathFromItem(field.xpath);
  return normalizeEngineRelativeXPath(relativeXPath || field.xpath);
}

function fixedPaginationLoopXml(candidate: DetectedCandidate, listLoopXml: string): string {
  const pagination = candidate.pagination;
  if (!pagination || pagination.type === 'scroll') return listLoopXml;
  const isLoadMore = pagination.type === 'load_more';
  if (isLoadMore && pagination.revealByScroll) {
    return scrollRevealedLoadMoreLoopXml(candidate, listLoopXml);
  }
  return `<ns0:LoopAction ${attrs({
    'x:Name': 'LoopPages',
    Name: '',
    WaitSeconds: '3',
    Caption: isLoadMore ? 'Loop load more button' : 'Loop next page button',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'true',
    ScrollTime: '3',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: '',
    FixedItem: actionItemXml(isLoadMore ? loadMoreRuntimeXPath(pagination.xpath) : pagination.xpath),
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'FixedItem',
    QuitLoopWhenExecutedTimesEqual: 'true',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: isLoadMore ? '100' : '50',
    CheckedJumpLoopClick: 'true'
  })}>${listLoopXml}${clickPaginationActionXml(candidate)}</ns0:LoopAction>`;
}

function scrollRevealedLoadMoreLoopXml(candidate: DetectedCandidate, listLoopXml: string): string {
  return `<ns0:LoopAction ${attrs({
    'x:Name': 'LoopScrollAndLoadMore',
    Name: '',
    WaitSeconds: '2',
    Caption: 'Loop scroll then load more',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'true',
    ScrollTime: '1',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: '',
    FixedItem: actionItemXml(candidate.xpath),
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'FixedItem',
    QuitLoopWhenExecutedTimesEqual: 'true',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: '80',
    CheckedJumpLoopClick: 'true'
  })}>${listLoopXml}${scrollStepActionXml()}${optionalLoadMoreLoopXml(candidate)}</ns0:LoopAction>`;
}

function optionalLoadMoreLoopXml(candidate: DetectedCandidate): string {
  const pagination = candidate.pagination;
  if (!pagination || pagination.type !== 'load_more' || !pagination.xpath) return '';
  return `<ns0:LoopAction ${attrs({
    'x:Name': 'TryLoadMore',
    Name: '',
    WaitSeconds: '1',
    Caption: 'Try load more if visible',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'false',
    ScrollTime: '0',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: '',
    FixedItem: actionItemXml(loadMoreRuntimeXPath(pagination.xpath)),
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'FixedItem',
    QuitLoopWhenExecutedTimesEqual: 'true',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: '1',
    CheckedJumpLoopClick: 'true'
  })}>${clickPaginationActionXml(candidate, { optional: true })}</ns0:LoopAction>`;
}

function loadMoreRuntimeXPath(xpath: string): string {
  if (!xpath) return xpath;
  const hasRuntimeTextPredicate = /contains\(translate\(normalize-space\(\.\)/i.test(xpath);
  const hasPositiveText = /加载更多|查看更多|显示更多|点击加载|load more|show more|see more/i.test(xpath);
  const hasEndExclusion = /没有更多|暂无更多|已到底|到底了|加载完毕|no more|all loaded|end of/i.test(xpath);
  if (hasRuntimeTextPredicate && hasPositiveText && hasEndExclusion) return xpath;
  const lastStep = xpath.match(/^(.*\/\/?)([a-zA-Z][\w:-]*)(\[(.*)\])$/);
  if (!lastStep) return xpath;
  const [, prefix, tag, , predicate] = lastStep;
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const positive = [
    `contains(${lowerText}, "加载更多")`,
    `contains(${lowerText}, "查看更多")`,
    `contains(${lowerText}, "显示更多")`,
    `contains(${lowerText}, "点击加载")`,
    `contains(${lowerText}, "load more")`,
    `contains(${lowerText}, "show more")`,
    `contains(${lowerText}, "see more")`
  ].join(' or ');
  return `${prefix}${tag}[${predicate} and (${positive}) and ${loadMoreEndTextExclusionXPath()}]`;
}

function loadMoreEndTextExclusionXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  return [
    `not(contains(${lowerText}, "没有更多"))`,
    `not(contains(${lowerText}, "暂无更多"))`,
    `not(contains(${lowerText}, "已到底"))`,
    `not(contains(${lowerText}, "到底了"))`,
    `not(contains(${lowerText}, "加载完毕"))`,
    `not(contains(${lowerText}, "no more"))`,
    `not(contains(${lowerText}, "all loaded"))`,
    `not(contains(${lowerText}, "end of"))`
  ].join(' and ');
}

function scrollStepLoopActionXml(candidate: DetectedCandidate, listLoopXml: string): string {
  return `<ns0:LoopAction ${attrs({
    'x:Name': 'LoopScroll',
    Name: '',
    WaitSeconds: '2',
    Caption: 'Loop scroll page',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'true',
    ScrollTime: '1',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: '',
    FixedItem: actionItemXml(candidate.xpath),
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'FixedItem',
    QuitLoopWhenExecutedTimesEqual: 'true',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: '80',
    CheckedJumpLoopClick: 'true'
  })}>${listLoopXml}${scrollStepActionXml()}${optionalGenericLoadMoreLoopXml()}</ns0:LoopAction>`;
}

function optionalGenericLoadMoreLoopXml(): string {
  return `<ns0:LoopAction ${attrs({
    'x:Name': 'TryGenericLoadMore',
    Name: '',
    WaitSeconds: '1',
    Caption: 'Try generic load more if visible',
    WaitItem: '',
    UseLoopItem: 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    Url: '',
    ScrollDown: 'false',
    ScrollTime: '0',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    ScrollType: '0',
    UseCustomizeCookie: 'false',
    MaxRetry: '0',
    VariableList: '',
    FixedItem: actionItemXml(genericLoadMoreRuntimeXPath()),
    EnableRetry: 'false',
    RetryInterval: '0',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    ClearCache: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    IPType: 'None',
    LoopType: 'FixedItem',
    QuitLoopWhenExecutedTimesEqual: 'true',
    DisabledScrollAutoRemoveDuplication: 'false',
    ExecutedTimesLimitation: '1',
    CheckedJumpLoopClick: 'true'
  })}>${clickGenericLoadMoreActionXml()}</ns0:LoopAction>`;
}

function genericLoadMoreRuntimeXPath(): string {
  const lowerText = `translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const classExpr = `translate(concat(" ", normalize-space(@class), " "), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const roleExpr = `translate(@role, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const tagOrRole = 'self::a or self::button or self::div or self::span or self::li or @onclick or @role';
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
  return `//*[(${tagOrRole}) and (${positive}) and ${loadMoreEndTextExclusionXPath()}]`;
}

function scrollStepActionXml(): string {
  return `<ns0:ClickAction ${attrs({
    'x:Name': 'ScrollPage',
    Name: '',
    WaitSeconds: '0',
    Caption: 'Scroll page',
    WaitItem: '',
    UseLoopItem: 'true',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: '',
    AjaxLoad: 'true',
    TimeOut: '00:00:20',
    AjaxTimeout: '2',
    ScrollDown: 'true',
    ScrollTime: '1',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: '1',
    EnableRetry: 'false',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    OpenInNewWindow: 'false',
    OpenByHref: 'false',
    TimeInterval: '2',
    LocateAnchor: 'false',
    AnchorId: '',
    IPType: '1'
  })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`;
}

function clickPaginationActionXml(candidate: DetectedCandidate, options: { optional?: boolean } = {}): string {
  const pagination = candidate.pagination;
  if (!pagination || pagination.type === 'scroll') return '';
  const isLoadMore = pagination.type === 'load_more';
  const ajax = pagination.isAjax || isLoadMore;
  return `<ns0:ClickAction ${attrs({
    'x:Name': 'ClickPage',
    Name: '',
    WaitSeconds: '0',
    Caption: isLoadMore ? (options.optional ? 'Click load more if visible' : 'Click load more') : 'Click next page',
    WaitItem: '',
    UseLoopItem: 'true',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: '',
    AjaxLoad: ajax ? 'true' : 'false',
    TimeOut: '00:00:20',
    AjaxTimeout: ajax ? '3' : '0',
    ScrollDown: isLoadMore ? 'true' : 'false',
    ScrollTime: isLoadMore ? '1' : '100',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: options.optional ? '0' : '3',
    EnableRetry: 'false',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    OpenInNewWindow: 'false',
    OpenByHref: 'false',
    TimeInterval: '5',
    LocateAnchor: 'false',
    AnchorId: '',
    IPType: '1'
  })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`;
}

function clickGenericLoadMoreActionXml(): string {
  return `<ns0:ClickAction ${attrs({
    'x:Name': 'ClickGenericLoadMore',
    Name: '',
    WaitSeconds: '0',
    Caption: 'Click generic load more if visible',
    WaitItem: '',
    UseLoopItem: 'true',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: '0',
    ElementXPath: '',
    AjaxLoad: 'true',
    TimeOut: '00:00:20',
    AjaxTimeout: '3',
    ScrollDown: 'true',
    ScrollTime: '1',
    ScrollInterval: '1',
    ScrollIntervalUnit: 'Second',
    ScrollType: '0',
    ScrollScope: '0',
    ScrollXPath: '',
    IfStopScroll: 'true',
    MaxRetry: '0',
    EnableRetry: 'false',
    EnableSwitchIp: 'false',
    EnableSwitchUserAgent: 'false',
    AutoRetry: 'false',
    TextContain: '',
    UrlContain: '',
    TextNotContain: '',
    OpenInNewWindow: 'false',
    OpenByHref: 'false',
    TimeInterval: '5',
    LocateAnchor: 'false',
    AnchorId: '',
    IPType: '1'
  })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`;
}

function popupDismissalActionXml(items: DetectedPopupDismissal[]): string[] {
  return items
    .filter((item) => item.action === 'click' && item.xpath && item.type !== 'captcha' && item.type !== 'paywall')
    .slice(0, 2)
    .map((item, index) => `<ns0:ClickAction ${attrs({
      'x:Name': `DismissPopup${index + 1}`,
      Name: '',
      WaitSeconds: '1',
      Caption: `Dismiss ${item.type} popup`,
      WaitItem: '',
      UseLoopItem: 'false',
      LoopItem: '',
      Description: '',
      IsRandomWait: 'false',
      PageIndex: '-1',
      ElementXPath: actionItemXml(item.xpath || ''),
      AjaxLoad: 'true',
      TimeOut: '00:00:10',
      AjaxTimeout: '2',
      ScrollDown: 'false',
      ScrollTime: '0',
      ScrollInterval: '1',
      ScrollIntervalUnit: 'Second',
      ScrollType: '0',
      ScrollScope: '0',
      ScrollXPath: '',
      IfStopScroll: 'true',
      MaxRetry: '1',
      EnableRetry: 'false',
      EnableSwitchIp: 'false',
      EnableSwitchUserAgent: 'false',
      AutoRetry: 'false',
      TextContain: '',
      UrlContain: '',
      TextNotContain: '',
      OpenInNewWindow: 'false',
      OpenByHref: 'false',
      TimeInterval: '1',
      LocateAnchor: 'false',
      AnchorId: '',
      IPType: '1'
    })}><ns0:ClickAction.RetryConditions><x:Array Type="{x:Type p7:RetryCondition}" xmlns:p7="clr-namespace:Octopus.ActionInterface.WebSiteInterface;Assembly=Octopus.ActionInterface, Version=7.4.2.11231, Culture=neutral, PublicKeyToken=null" /></ns0:ClickAction.RetryConditions></ns0:ClickAction>`);
}

function extractActionXml(fields: DetectedField[], options: {
  useLoopItem: boolean;
  name?: string;
  caption?: string;
  pageIndex?: string;
  forceAbsoluteXPath?: boolean;
}): string {
  const template = extractTemplateXml(fields, options);
  return `<ns0:ExtractDataAction ${attrs({
    'x:Name': options.name ?? 'Extract1',
    Name: '',
    WaitSeconds: '0',
    Caption: options.caption ?? 'Extract detected data',
    WaitItem: '',
    UseLoopItem: options.useLoopItem ? 'true' : 'false',
    LoopItem: '',
    Description: '',
    IsRandomWait: 'false',
    PageIndex: options.pageIndex ?? '-1',
    ElementXPath: '',
    AjaxLoad: 'false',
    AjaxTimeout: '0',
    ScrollDown: 'false',
    ExtractTemplate: template
  })} />`;
}

function extractTemplateXml(fields: DetectedField[], options: {
  useLoopItem: boolean;
  forceAbsoluteXPath?: boolean;
}): string {
  const items = [
    '<ExtractItem xsi:type="ExtractGroupItem"><Id>0</Id><ParentId>-1</ParentId><Name>Root</Name><Header>Root</Header><UseRelativeXPath>false</UseRelativeXPath><AllowNull>false</AllowNull><AllowSkip>false</AllowSkip><AllowDefaultValue>false</AllowDefaultValue><AlertWhenNotFound>false</AlertWhenNotFound><IsIFrame>false</IsIFrame><IsUniqueGroup>false</IsUniqueGroup></ExtractItem>',
    ...fields.map((field, index) => extractItemXml(field, index + 1, options))
  ].join('');
  return `<ExtractTemplate xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><Items>${items}</Items></ExtractTemplate>`;
}

function extractItemXml(field: DetectedField, id: number, options: {
  useLoopItem: boolean;
  forceAbsoluteXPath?: boolean;
}): string {
  const relativeXPath = normalizeEngineRelativeXPath(field.relativeXPath || relativeXPathFromItem(field.xpath));
  const extractType = field.kind === 'href' ? 'ExtractHref' : field.kind === 'src' ? 'ExtractSrc' : 'ExtractText';
  const useRelativeXPath = options.useLoopItem && !options.forceAbsoluteXPath;
  const appendMatches = shouldAppendExtractedText(field);
  return [
    '<ExtractItem xsi:type="ExtractTextItem">',
    tag('Id', String(id)),
    tag('ParentId', '0'),
    tag('Name', field.name),
    tag('Header', field.name),
    tag('UseRelativeXPath', useRelativeXPath ? 'true' : 'false'),
    tag('RelativeXpath', useRelativeXPath ? relativeXPath : ''),
    tag('AllowNull', 'true'),
    tag('AllowSkip', 'false'),
    tag('AllowDefaultValue', 'true'),
    tag('AlertWhenNotFound', 'true'),
    tag('IsIFrame', 'false'),
    tag('IFrameAbsXPath', ''),
    tag('AbsXpath', field.xpath),
    tag('UseBackupPath', 'false'),
    tag('BackUpAbsXPath', ''),
    tag('UseBackupIframePath', 'false'),
    tag('BackUpIframeXPath', ''),
    tag('UseBackupRelativePath', 'false'),
    tag('BackUpRelativeXPath', ''),
    tag('FixedValue', ''),
    tag('NullValue', ''),
    tag('PageSourceReg', ''),
    tag('CustomizeField', ''),
    tag('IsUniqueGroup', 'false'),
    operationsXml(field),
    tag('ExtractType', extractType),
    tag('MatchAll', appendMatches ? 'true' : 'false'),
    tag('IsAppend', appendMatches ? 'true' : 'false'),
    tag('IsDownloadFile', 'false'),
    '</ExtractItem>'
  ].join('');
}

function shouldAppendExtractedText(field: DetectedField): boolean {
  return field.kind === 'text' && /(^|_)content(_|$)|正文|body|article/i.test(field.name);
}

function operationsXml(field: DetectedField): string {
  const operations = field.operations?.length
    ? field.operations
    : field.kind === 'text' ? [{ type: 'trim' as const, params: ['0'] }] : [];
  if (!operations.length) return '<Operations />';
  return `<Operations>${operations.map((operation, index) => operationXml(operation, index)).join('')}</Operations>`;
}

function operationXml(operation: NonNullable<DetectedField['operations']>[number], index: number): string {
  const formatType = operation.type === 'regex_match' ? 'RegMatch' : operation.type === 'regex_replace' ? 'RegReplace' : 'Trim';
  const params = operation.type === 'regex_match' && operation.params.length === 1
    ? [operation.params[0], 'false']
    : operation.params;
  const parameters = params.map((param) => `<anyType xsi:type="xsd:string">${escapeXml(param)}</anyType>`).join('');
  return [
    '<Operation>',
    tag('Index', String(index)),
    tag('Name', ''),
    tag('Output', ''),
    tag('Input', ''),
    tag('FormatType', formatType),
    `<Parameters>${parameters}</Parameters>`,
    '</Operation>'
  ].join('');
}

function actionItemXml(xpath: string): string {
  return `<ActionItem><AbsXpath>${escapeXml(xpath)}</AbsXpath><IsIFrame>false</IsIFrame><IFrameAbsXPath></IFrameAbsXPath><ListXpath></ListXpath><SampleText></SampleText></ActionItem>`;
}

function relativeXPathFromItem(xpath: string): string {
  const trimmed = xpath.trim();
  if (!trimmed) return '';
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) return '';
  const tail = trimmed.slice(lastSlash + 1);
  return tail ? `/${tail}` : '';
}

function normalizeEngineRelativeXPath(xpath: string): string {
  const trimmed = xpath.trim();
  if (!trimmed || trimmed === '.') return '';
  if (trimmed.includes('|')) {
    return trimmed
      .split(/\s*\|\s*/)
      .map((part) => normalizeEngineRelativeXPath(part))
      .filter(Boolean)
      .join(' | ');
  }
  if (trimmed.startsWith('.//')) return `/descendant-or-self::${trimmed.slice(3)}`;
  if (/^\.(?:\/)?(?:following|preceding)-sibling::/i.test(trimmed)) return trimmed.replace(/^\.(?:\/)?/, '');
  if (trimmed.startsWith('./')) return `/${trimmed.slice(2)}`;
  if (trimmed.startsWith('//')) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
}

function attrs(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(' ');
}

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
