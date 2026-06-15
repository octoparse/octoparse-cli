import type { DetectedCandidate, DetectedField, DetectedPagination } from './types.js';
import type { SmartExtractItem, SmartListResult, SmartRawResult } from './protected-smart-provider.js';

interface SmartDetectedField extends DetectedField {
  sourceIndex: number;
}

type SmartFieldOperation = NonNullable<DetectedField['operations']>[number];

export function protectedSmartResultToCandidates(result: SmartRawResult, maxCandidates: number): DetectedCandidate[] {
  const lists = (result.List ?? [])
    .filter((item) => item.type === 3 && item.element?.xpath && item.element.scheme?.length)
    .sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0))
    .slice(0, Math.max(1, maxCandidates));
  return lists.map((item, index) => {
    const element = item.element as SmartListResult;
    const rawSmartFields = (element.scheme ?? [])
      .map((field, fieldIndex) => smartFieldToDetectedField(element, field, fieldIndex))
      .filter((field): field is SmartDetectedField => Boolean(field));
    const preliminaryFields = postProcessSmartFields(rawSmartFields);
    const sampleRowIndices = selectSmartSampleRowIndices(preliminaryFields, element.data ?? []);
    const smartFields = postProcessSmartFields(applySmartSampleRows(preliminaryFields, element.data ?? [], sampleRowIndices));
    const fields = smartFields.map(stripSmartFieldMetadata);
    const sampleRows = buildSampleRows(smartFields, element.data ?? [], sampleRowIndices);
    const pagination = smartPaginationToDetected(item.page ?? result.Page);
    return {
      id: `protected_smart_${index + 1}`,
      type: fields.some((field) => field.kind === 'href') ? 'search_results' : 'repeated_card',
      title: `Protected Smart list (${element.data?.[0]?.length ?? 0} items)`,
      confidence: Number(Math.max(0.72, Math.min(0.98, 0.8 + (item.sort ?? 0) * 0.04 + (element.fullColRate ?? 0) * 0.08)).toFixed(2)),
      selector: '',
      xpath: element.xpath || '',
      itemSelector: '',
      itemXPath: element.xpath || '',
      itemCount: element.data?.[0]?.length ?? 0,
      fields,
      sampleRows,
      reasons: [
        'Detected by protected SmartProxy resource',
        `fullColRate=${Number(element.fullColRate ?? 0).toFixed(2)}`
      ],
      ...(pagination ? { pagination } : {})
    } satisfies DetectedCandidate;
  }).filter((candidate) => candidate.fields.length && candidate.itemCount > 0);
}

function smartFieldToDetectedField(list: SmartListResult, field: SmartExtractItem, index: number): SmartDetectedField | undefined {
  const relativeXPath = field.RelativeXPath || '';
  const xpath = field.AbsXPath || `${list.xpath || ''}${relativeXPath}`;
  if (!xpath) return undefined;
  const kind = field.Attribute === 'href' ? 'href' : field.Attribute === 'src' ? 'src' : 'text';
  return {
    name: normalizeFieldName(field.Name, kind, index),
    kind,
    selector: '',
    xpath,
    relativeSelector: '',
    relativeXPath,
    samples: (list.data?.[index] ?? []).filter(Boolean).slice(0, 3),
    sourceIndex: index,
    ...(kind === 'text' ? { operations: [{ type: 'trim', params: ['0'] }] } : {})
  };
}

function postProcessSmartFields(fields: SmartDetectedField[]): SmartDetectedField[] {
  const useful = fields
    .filter((field) => field.kind !== 'href' || field.samples.some(Boolean))
    .filter((field, index, all) => !isNoisySmartField(field, index, all))
    .filter((field, _index, all) => !isNestedRepeatedSubrecordField(field, all));
  const deduped = dedupeSmartFields(useful);
  const renamed = finalizeSmartFields(collapseVacatedSmartFieldSuffixes(compactRepeatedSmartFields(renameSmartFields(deduped))));
  if (renamed.length <= 16) return renamed;
  const selected = new Set(
    renamed
      .map((field, index) => ({ index, score: smartFieldPriority(field, index) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 16)
      .map((item) => item.index)
  );
  return renamed.filter((_, index) => selected.has(index));
}

function stripSmartFieldMetadata(field: SmartDetectedField): DetectedField {
  const { sourceIndex: _sourceIndex, ...detected } = field;
  return detected;
}

function collapseVacatedSmartFieldSuffixes(fields: SmartDetectedField[]): SmartDetectedField[] {
  const existing = new Set(fields.map((field) => field.name));
  const used = new Set<string>();
  return fields.map((field) => {
    const match = field.name.match(/^(.+?)(\d+)$/);
    const preferred = match && !existing.has(match[1]) ? match[1] : field.name;
    const name = uniqueFieldName(preferred, used);
    return name === field.name ? field : { ...field, name };
  });
}

function isNoisySmartField(field: SmartDetectedField, index: number, all: SmartDetectedField[]): boolean {
  if (!field.samples.length) return true;
  if (isSmartFilterOrAdField(field, all)) return true;
  if (field.kind === 'href' && field.samples.every(isActionHref)) return true;
  if (field.kind === 'text' && field.samples.every(isLowValueActionText)) return true;
  if (field.kind === 'text' && field.samples.every(isDecorativeRatingStarText) && all.some((item) => item !== field && item.samples.some(isRatingText))) return true;
  if (field.kind === 'text' && isRedundantTitleFragment(field, all)) return true;
  if (field.kind === 'text' && isWholeRowTextField(field, all)) return true;
  if (field.kind === 'text' && isMisleadingContainerTextField(field, all)) return true;
  if (field.kind === 'text' && isSearchHighlightField(field, all)) return true;
  if (field.kind === 'text' && field.samples.every(isLowValueLabelText)) return true;
  if (field.kind === 'text' && hasPairedHref(field, all) && field.samples.every(isLowValueLinkLabel)) return true;
  if (field.kind === 'src') {
    const firstImageIndex = all.findIndex((item) => item.kind === 'src' && item.samples.length);
    if (firstImageIndex >= 0 && index !== firstImageIndex && /avatar|头像|preview|查看|contributor|built/i.test(`${field.name} ${field.relativeXPath} ${field.samples.join(' ')}`)) return true;
  }
  return false;
}

function isSmartFilterOrAdField(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  if (field.kind !== 'text') return false;
  const identity = `${field.name} ${field.relativeXPath} ${field.samples.join(' ')}`;
  const hasRealTitle = all.some((item) => item !== field && item.kind === 'text' && item.samples.some(isCompactTitleText));
  const normalizedName = field.name.replace(/[_-]+/g, ' ');
  const filterName = normalizedName.length > 64
    && /(salary|benefits|sort by|latest|highest|most viewed|most applied|hottest|clear|results?|筛选|过滤|排序|最新|最热|薪资|福利)/i.test(normalizedName);
  const emojiCount = Array.from(field.name).filter((char) => /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(char)).length;
  const sparseAdSamples = field.samples.some((sample) => /(?:safetywing|sponsor|advert|banner|nomad-health|premium)/i.test(sample));
  return hasRealTitle && (filterName || emojiCount >= 3 && /(sort|clear|results?|salary|benefits)/i.test(identity) || sparseAdSamples && field.kind !== 'text');
}

function dedupeSmartFields(fields: SmartDetectedField[]): SmartDetectedField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const sampleKey = normalizeSamples(field.samples).join('|');
    const key = preservesDistinctSmartStructure(field)
      ? `${field.kind}:${field.relativeXPath}:${sampleKey}`
      : `${field.kind}:${sampleKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renameSmartFields(fields: SmartDetectedField[]): SmartDetectedField[] {
  const hasTitle = fields.some((field) => /^(标题|title)$/i.test(field.name));
  const titlePairs = new Set<string>();
  if (!hasTitle) {
    for (const field of fields) {
      if (field.kind !== 'text' || !looksLikeTitleText(field.samples)) continue;
      const hrefPair = fields.find((item) => item.kind === 'href' && item.relativeXPath === field.relativeXPath);
      if (hrefPair) {
        titlePairs.add(field.relativeXPath || field.xpath);
        break;
      }
    }
  }

  const used = new Set<string>();
  return fields.map((field) => {
    const pairKey = field.relativeXPath || field.xpath;
    const semanticSuggestion = suggestedSmartFieldName(field, fields);
    const suggested = (semanticSuggestion && semanticSuggestion !== '链接' ? semanticSuggestion : undefined) ?? (titlePairs.has(pairKey)
      ? field.kind === 'href' ? '标题链接' : '标题'
      : semanticSuggestion);
    const name = uniqueFieldName(suggested || field.name, used);
    return name === field.name ? field : { ...field, name };
  });
}

function suggestedSmartFieldName(field: SmartDetectedField, fields: SmartDetectedField[]): string | undefined {
  const generatedName = isGeneratedSmartName(field.name);
  const generatedStructure = hasGeneratedSmartStructure(field);
  const structuralRenameSignal = hasKnownSmartStructuralRenameSignal(field);
  const sampleRenameSignal = hasSmartSampleRenameSignal(field);
  const structural = `${field.name} ${field.relativeXPath}`;
  const samples = field.samples.join(' ');
  const haystack = `${structural} ${samples}`;
  const hrefRenameSignal = field.kind === 'href' && (
    /标题_?链接|title_?link/i.test(field.name)
    || /\/(?:stargazers|forks)(?:\?|$|\/)/i.test(samples)
    || samplesMatchPackagePublisherHref(field.samples)
    || smartFieldHasTagSignal(field)
    || /domain|source|site|from\?site/i.test(haystack)
    || /author|user|profile|member/i.test(structural)
    || samplesMatchAuthorProfileHref(field.samples)
    || samplesMatchPrimaryRecordHref(field.samples)
    || isLikelySmartTitleHref(field, fields)
  );
  if (field.kind === 'src' && field.samples.some(Boolean)) return '图片';
  if (!generatedName && !generatedStructure && !structuralRenameSignal && !hasSmartSemanticRenameSignal(field) && !sampleRenameSignal && !hrefRenameSignal) return undefined;
  if (field.kind === 'href') {
    if (samplesMatchPackagePublisherHref(field.samples)) return '发布者链接';
    if (smartFieldHasLocationSignal(field)) return '位置_链接';
    if (smartFieldHasTypeSignal(field)) return '类型_链接';
    if (smartFieldHasTagSignal(field)) return '标签链接';
    if (/标题.*链接|title.*link/i.test(structural)) return '标题链接';
    if (/comment|reply/i.test(structural)) return '评论链接';
    if (/\/stargazers(?:\?|$|\/)/i.test(samples)) return '星标链接';
    if (/\/forks(?:\?|$|\/)/i.test(samples)) return 'Fork链接';
    if (/domain|source|site|from\?site/i.test(haystack)) return '来源链接';
    if (/author|user|profile|member/i.test(structural) || samplesMatchAuthorProfileHref(field.samples)) return '作者链接';
    if (samplesMatchPrimaryRecordHref(field.samples)) return '标题链接';
    if (isLikelySmartTitleHref(field, fields)) return '标题链接';
    const relatedLinkName = smartRelatedLinkName(field);
    if (relatedLinkName) return relatedLinkName;
    return '链接';
  }
  const stackOverflowStatName = stackOverflowStatFieldName(field, fields);
  if (stackOverflowStatName) return stackOverflowStatName;
  if (isStackOverflowReputationField(field, fields)) return '声望';
  if (/s-post-summary--content-excerpt/i.test(structural)) return '摘要';
  if (field.samples.every(isRecordIdentifierText)) return '编号';
  if (!fields.some((item) => /^(标题|title)$/i.test(item.name)) && isFirstUsableTextField(field, fields) && field.samples.some(isCompactTitleText)) return '标题';
  if (field.samples.every(isInstallCountText)) return '安装量';
  if (field.samples.every(isTestedWithText)) return '兼容版本';
  if (/rating|ratings|review/i.test(structural) && field.samples.some((value) => /ratings?|reviews?/i.test(value))) return '评分数';
  if (field.samples.every(isOrdinalText)) return '编号';
  const pairedHref = matchingSmartHref(field, fields) ?? containingSmartHref(field, fields);
  if (pairedHref?.samples.some((value) => /\/stargazers(?:\?|$|\/)/i.test(value))) return '星标数';
  if (pairedHref?.samples.some((value) => /\/forks(?:\?|$|\/)/i.test(value))) return 'Fork数';
  if (/stars?\s+today/i.test(samples)) return '今日星标';
  if (/want to read|收藏|关注/i.test(samples)) return '想读';
  if (field.samples.every(isOpenLibraryVersionText)) return '版本';
  if (field.samples.every(isOpenLibraryEbookText)) return '电子书';
  if (field.samples.every(isOpenLibraryPublicationInfoText)) return '出版信息';
  if (/^version$/i.test(field.name) || field.samples.every(isVersionText)) return '版本';
  if (/stock|availability|instock|库存/i.test(haystack) || field.samples.every(isStockStatusText)) return '库存状态';
  if (field.samples.every(isCountryLocationText)) return '国家';
  if (/rating|ratings|score|stars|评分/i.test(structural) || field.samples.every(isRatingText)) return '评分';
  if (field.samples.every(isProgrammingLanguageText)) return '语言';
  if (samplesMatchPackagePublisherHref(matchingSmartHref(field, fields)?.samples ?? [])) return '发布者';
  if (isLikelySmartTitleText(field, fields, pairedHref)) return '标题';
  if (field.samples.every(isBulletMetadataText)) return '元信息';
  if (/domain|source|site|from\?site/i.test(haystack) || field.samples.every(isSourceText)) return '来源';
  if (field.samples.every(isAllTimeDownloadText)) return '总下载';
  if (field.samples.every(isRecentDownloadText)) return '近期下载';
  if (/download|downloads|下载/i.test(haystack)) return '下载';
  if (/counter|count|数量/i.test(structural)) return '数量';
  if (/price|amount|cost|£|\$|€|¥|价格/i.test(haystack)) return '价格';
  if (/\b(?:salary|pay|compensation)\b|薪资|薪水|工资|报酬/i.test(haystack)) return '薪资';
  if (field.samples.every(isLocationText)) return '位置';
  if (field.samples.every(isRemoteLocationText)) return '位置';
  if (/date|time|updated|created|posted|published|listingposted|时间|日期/i.test(haystack) && !field.samples.every(isDateLikeText) && averageLength(field.samples) >= 36) return '描述';
  if (/date|time|updated|created|ago|时间|日期/i.test(haystack) || field.samples.every(isDateLikeText)) return '时间';
  if (field.samples.every(isEditorAuthorText)) return '作者';
  if (field.samples.every(isAuthorListText)) return '作者';
  if (/author|user|profile|member|作者/i.test(structural) || (pairedHref && samplesMatchAuthorProfileHref(pairedHref.samples)) || isUserCardDisplayNameField(field, fields)) return '作者';
  if (field.samples.every(isLargeNumericText)) return '数量';
  if (/tag|keyword|topic|subject|category|industry|batch|pill|chip|badge|标签|关键词/i.test(structural) || pairedHref?.samples.some((value) => isTagHref(value) || isRemoteOkFacetHref(value)) === true) return '标签';
  if (isLikelyCompanyField(field)) return '公司';
  if (/citation|citationpart|details|journal|publication|publisher|期刊|引用/i.test(haystack) || field.samples.every(isPublicationCitationText)) return '引用';
  if (/comment|note|remark|hastextgreydark|备注|注释/i.test(structural)) return '备注';
  if (/description|summary|snippet|synopsis|abstract|摘要|描述/i.test(haystack) || /\bdesc(?:ription)?\b/i.test(field.name) || averageLength(field.samples) >= 36 || (generatedName && /\/P(?:\[|\/|$)/i.test(field.relativeXPath || '') && averageLength(field.samples) >= 20)) return '描述';
  return undefined;
}

function finalizeSmartFields(fields: SmartDetectedField[]): SmartDetectedField[] {
  return fields.map(finalizeSmartField);
}

function finalizeSmartField(field: SmartDetectedField): SmartDetectedField {
  if (field.kind !== 'text') return field;
  let operations = [...(field.operations ?? [])];
  if (/^作者\d*$/i.test(field.name) && field.samples.some(hasLeadingAuthorPrefix)) {
    operations = appendSmartFieldOperation(operations, { type: 'regex_replace', params: ['^(?:来自|by|authors?|作者)[:：]?\\s*', ''] });
    operations = appendSmartFieldOperation(operations, { type: 'trim', params: ['0'] });
  }
  if (!operations.length) return field;
  const samples = field.samples.map((sample) => applySmartFieldOperations(sample, operations));
  return { ...field, operations, samples };
}

function appendSmartFieldOperation(operations: SmartFieldOperation[], operation: SmartFieldOperation): SmartFieldOperation[] {
  if (operations.some((item) => item.type === operation.type && item.params.join('\u0000') === operation.params.join('\u0000'))) return operations;
  return [...operations, operation];
}

function applySmartFieldOperations(value: string, operations?: SmartFieldOperation[]): string {
  let output = value;
  for (const operation of operations ?? []) {
    try {
      if (operation.type === 'trim') output = output.trim();
      else if (operation.type === 'regex_match') output = output.match(new RegExp(operation.params[0] || ''))?.[0] || '';
      else if (operation.type === 'regex_replace') output = output.replace(new RegExp(operation.params[0] || '', 'g'), operation.params[1] || '');
    } catch {
      return output;
    }
  }
  return output;
}

function compactRepeatedSmartFields(fields: SmartDetectedField[]): SmartDetectedField[] {
  const counts = new Map<string, number>();
  const hasTitleHref = fields.some((field) => field.kind === 'href' && smartFieldFamily(field) === 'title_href');
  return fields.filter((field) => {
    if (field.kind === 'text' && field.samples.every(isLowValueActionText)) return false;
    if (field.kind === 'href' && hasTitleHref && isAuxiliarySmartHref(field)) return false;
    if (field.kind === 'href' && hasTitleHref && isDuplicateTitleHrefVariant(field, fields)) return false;
    const family = smartFieldFamily(field);
    if (family === 'source' && hasCleanerSourceField(field, fields)) return false;
    const count = counts.get(family) ?? 0;
    counts.set(family, count + 1);
    if ((family === 'tag' || family === 'tag_href') && count >= 1) return false;
    if ((family === 'type' || family === 'type_href' || family === 'category_href') && count >= 1) return false;
    if (family === 'author_href' && count >= 1) return false;
    if (family === 'publisher_href' && count >= 1) return false;
    if (family === 'publisher' && count >= 1) return false;
    if (family === 'author' && count >= 1 && hasCleanerAuthorField(field, fields)) return false;
    if ((family === 'source' || family === 'source_href') && count >= 1) return false;
    if (family === 'image' && count >= 1) return false;
    return true;
  });
}

function smartFieldFamily(field: SmartDetectedField): string {
  const name = field.name.replace(/\d+$/g, '').replace(/[_\s-]+/g, '').toLowerCase();
  if (field.kind === 'href' && /^(标题链接|titlelink|url)$/.test(name)) return 'title_href';
  if (/^标题|^title/.test(name)) return 'title';
  if (/发布者.*链接|publisher.*link|maintainer.*link/.test(name)) return 'publisher_href';
  if (/发布者|publisher|maintainer/.test(name)) return 'publisher';
  if (/标签链接|taglink|keywordlink/.test(name)) return 'tag_href';
  if (/标签|关键词|tag|keyword/.test(name)) return 'tag';
  if (/类型.*链接|类别.*链接|category.*link|type.*link/.test(name)) return 'type_href';
  if (/类型|类别|category|type/.test(name)) return 'type';
  if (/作者.*链接|author.*link|user.*link/.test(name)) return 'author_href';
  if (/作者|author|user/.test(name)) return 'author';
  if (/来源.*链接|source.*link|domain.*link|site.*link/.test(name)) return 'source_href';
  if (/来源|source|domain|site/.test(name)) return 'source';
  if (/图片|image|cover/.test(name)) return 'image';
  return `${field.kind}:${name}`;
}

function isAuxiliarySmartHref(field: SmartDetectedField): boolean {
  const identity = `${field.name} ${field.relativeXPath} ${field.samples.join(' ')}`;
  return /\/(?:pdf|ps|format)\//i.test(identity)
    || /[?&]edition=ia:/i.test(identity)
    || /search-result-item__preview-covers|bookpreview|preview-covers/i.test(identity)
    || /web\.archive\.org|ghostarchive\.org|\/caches?\b/i.test(identity);
}

function hasCleanerAuthorField(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  const values = field.samples.map(normalizeAuthorSample).filter(Boolean);
  if (!values.length) return false;
  return fields.some((item) => item !== field && item.kind === 'text' && smartFieldFamily(item) === 'author' && item.samples.some((sample) => {
    const value = normalizeAuthorSample(sample);
    return value && values.some((current) => current === value || current.endsWith(value));
  }));
}

function hasCleanerSourceField(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  const values = field.samples.map(normalizeSourceSample).filter(Boolean);
  if (!values.length || !field.samples.some((sample) => /^\(.+\)$/.test(normalizeSample(sample)))) return false;
  return fields.some((item) => item !== field && item.kind === 'text' && smartFieldFamily(item) === 'source' && item.samples.some((sample) => {
    const value = normalizeSourceSample(sample);
    return value && values.includes(value) && !/^\(.+\)$/.test(normalizeSample(sample));
  }));
}

function hasSmartSemanticRenameSignal(field: SmartDetectedField): boolean {
  return /^(?:title|updatedat|createdat|publishedat|publishdate|postedat|listingposted|date|time|timestamp|desc|details|description|summary|snippet|synopsis|abstract|searchsnippetsynopsis|citation(?:part)?|journal|publication|publisher|maintainer|comments?|notes?|remarks?|hastextgreydark|downloads?|downloadcount|stars?|stars?_?today|rating|ratings?|ratingcount|reviewcount|score|author|username|user|language|source(?:_?链接)?|domain(?:_?链接)?|site(?:_?链接)?|price|salary|stock|instock|availability|version|quicklinks(?:_?链接)?|homepage(?:_?链接)?|repository(?:_?链接)?|documentation(?:_?链接)?|image|img|cover|counter|count|activeinstalls?|testedwith|location|city|region|category|industry|batch|link|link_链接|标题_?链接)$/i.test(field.name.trim());
}

function hasKnownSmartStructuralRenameSignal(field: SmartDetectedField): boolean {
  return /s-post-summary--stats-item|s-post-summary--content-excerpt|s-user-card|flex--item|todo-no-class-here|ratingsbyline|resultdetails|bookauthor|searchresultitemcta/i.test(`${field.name} ${field.relativeXPath}`);
}

function stackOverflowStatFieldName(field: SmartDetectedField, fields: SmartDetectedField[]): string | undefined {
  if (!isStackOverflowStatNumberField(field)) return undefined;
  if (/s-post-summary--stats-item__emphasized/i.test(field.relativeXPath || '')) return '票数';
  const statNumbers = fields
    .filter(isStackOverflowStatNumberField)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
  const position = statNumbers.indexOf(field);
  if (position === 0) return '票数';
  if (position === 1) return '回答数';
  if (position === 2) return '浏览数';
  const relative = field.relativeXPath || '';
  if (/@class=["']s-post-summary--stats-item\s{2,}["']/i.test(relative)) return '回答数';
  if (/@class=["']s-post-summary--stats-item\s["']/i.test(relative)) return '浏览数';
  return '数量';
}

function isStackOverflowStatNumberField(field: SmartDetectedField): boolean {
  const structural = `${field.name} ${field.relativeXPath}`;
  return field.kind === 'text'
    && /s-post-summary--stats-item/i.test(structural)
    && /s-post-summary--stats-item-number/i.test(structural)
    && field.samples.length > 0
    && field.samples.every(isCompactCountText);
}

function preservesDistinctSmartStructure(field: SmartDetectedField): boolean {
  return isStackOverflowStatNumberField(field)
    || /resultdetails|ratingsbyline/i.test(`${field.name} ${field.relativeXPath}`);
}

function isStackOverflowReputationField(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  const structural = `${field.name} ${field.relativeXPath}`;
  return field.kind === 'text'
    && /todo-no-class-here/i.test(structural)
    && field.samples.length > 0
    && field.samples.every(isCompactCountText)
    && fields.some((item) => item.kind === 'href' && (/s-user-card/i.test(item.relativeXPath || '') || samplesMatchAuthorProfileHref(item.samples)));
}

function isUserCardDisplayNameField(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  const structural = `${field.name} ${field.relativeXPath}`;
  if (!/flex--item|s-user-card/i.test(structural)) return false;
  if (field.samples.length === 0 || field.samples.some((sample) => !sample.trim() || sample.length > 80)) return false;
  return fields.some((item) => item.kind === 'href' && (/s-user-card/i.test(item.relativeXPath || '') || samplesMatchAuthorProfileHref(item.samples)));
}

function hasSmartSampleRenameSignal(field: SmartDetectedField): boolean {
  if (field.kind !== 'text') return false;
  return field.samples.every(isLargeNumericText)
    || field.samples.every(isRecordIdentifierText)
    || field.samples.every(isOrdinalText)
    || field.samples.every(isDateLikeText)
    || field.samples.every(isSourceText)
    || field.samples.every(isRatingText)
    || field.samples.every(isAuthorListText)
    || field.samples.every(isVersionText)
    || field.samples.every(isStockStatusText)
    || field.samples.every(isAllTimeDownloadText)
    || field.samples.every(isRecentDownloadText)
    || field.samples.every(isRemoteLocationText)
    || field.samples.every(isCountryLocationText)
    || isLikelyCompanyField(field);
}

function smartFieldHasTagSignal(field: SmartDetectedField): boolean {
  return /tag|keyword|topic|subject|标签|关键词/i.test(`${field.name} ${field.relativeXPath}`)
    || field.samples.some(isTagHref)
    || field.samples.some(isRemoteOkFacetHref);
}

function smartFieldHasTypeSignal(field: SmartDetectedField): boolean {
  return /type|category|industry|batch|类型|类别|行业|批次/i.test(`${field.name} ${field.relativeXPath}`)
    || field.samples.some(isTypeHref);
}

function smartFieldHasLocationSignal(field: SmartDetectedField): boolean {
  return /location|city|region|country|位置|地点|城市|地区|国家/i.test(`${field.name} ${field.relativeXPath}`)
    || field.samples.some(isLocationHref);
}

function smartRelatedLinkName(field: SmartDetectedField): string | undefined {
  if (field.kind !== 'href' || !field.samples.length) return undefined;
  const identity = `${field.name} ${field.relativeXPath}`;
  const quickLinkLike = /quicklinks?|homepage|documentation|repository|repo|related|external/i.test(identity);
  const values = field.samples.map(normalizeSample).filter(Boolean);
  if (!values.length) return undefined;
  const first = values[0] || '';
  if (quickLinkLike && /(?:^https?:\/\/(?:www\.)?docs\.rs\/|doc\.rust-lang\.org|\/docs?(?:\/|$)|documentation)/i.test(first)) return '文档链接';
  if (quickLinkLike && /(?:github\.com|gitlab\.com|bitbucket\.org|\/repository(?:\/|$)|\/repo(?:\/|$))/i.test(first)) return '仓库链接';
  if (quickLinkLike && /^https?:\/\//i.test(first) && !/\/(?:crates|package|packages|remote-jobs|questions|works|abs|plugins|catalogue)\//i.test(first)) return '主页链接';
  if (values.every((value) => /(?:^https?:\/\/(?:www\.)?docs\.rs\/|doc\.rust-lang\.org)/i.test(value) || (quickLinkLike && /\/docs?(?:\/|$)|documentation/i.test(value)))) return '文档链接';
  if (values.every((value) => /(?:github\.com|gitlab\.com|bitbucket\.org)/i.test(value) || (quickLinkLike && /\/repository(?:\/|$)|\/repo(?:\/|$)/i.test(value)))) return '仓库链接';
  if (quickLinkLike && values.every((value) => /^https?:\/\//i.test(value) && !/\/(?:crates|package|packages|remote-jobs|questions|works|abs|plugins|catalogue)\//i.test(value))) return '主页链接';
  return undefined;
}

function matchingSmartHref(field: SmartDetectedField, fields: SmartDetectedField[]): SmartDetectedField | undefined {
  if (field.kind === 'href') return undefined;
  return fields.find((item) => item !== field && item.kind === 'href' && item.relativeXPath === field.relativeXPath);
}

function containingSmartHref(field: SmartDetectedField, fields: SmartDetectedField[]): SmartDetectedField | undefined {
  if (field.kind === 'href') return undefined;
  const relative = normalizeSmartRelativeXPath(field.relativeXPath || '');
  if (!relative) return undefined;
  return fields.find((item) => {
    if (item === field || item.kind !== 'href') return false;
    const hrefRelative = normalizeSmartRelativeXPath(item.relativeXPath || '');
    if (!hrefRelative) return false;
    return relative === hrefRelative
      || relative.startsWith(`${hrefRelative}/`)
      || relative.startsWith(`${hrefRelative}//`)
      || hrefRelative.startsWith(`${relative}/`)
      || hrefRelative.startsWith(`${relative}//`);
  });
}

function normalizeSmartRelativeXPath(value: string): string {
  return value.replace(/\/+$/g, '').trim();
}

function isLikelySmartTitleHref(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  if (field.kind !== 'href' || !field.samples.length) return false;
  const genericHrefName = isGeneratedSmartName(field.name) || /^(?:link|url|href|字段\d*|field_?\d*)$/i.test(field.name.trim());
  if (!genericHrefName) return false;
  if (samplesMatchAuthorProfileHref(field.samples) || smartFieldHasTagSignal(field) || smartFieldHasTypeSignal(field)) return false;
  if (/\/(?:stargazers|forks|sponsors?|login)\b|[?&](?:tag|tags|topic|topics|keyword|keywords|type|category|industry|batch)=/i.test(field.samples.join(' '))) return false;
  const hrefRelative = (field.relativeXPath || '').replace(/\/+$/g, '');
  if (!hrefRelative) return false;
  return fields.some((item) => {
    if (item === field || item.kind !== 'text' || !item.samples.length || !looksLikeTitleText(item.samples)) return false;
    const textRelative = (item.relativeXPath || '').replace(/\/+$/g, '');
    if (!textRelative) return false;
    return textRelative === hrefRelative || textRelative.startsWith(`${hrefRelative}//`) || textRelative.startsWith(`${hrefRelative}/`);
  });
}

function isLikelySmartTitleText(field: SmartDetectedField, fields: SmartDetectedField[], pairedHref?: SmartDetectedField): boolean {
  if (field.kind !== 'text' || !pairedHref) return false;
  if (fields.some((item) => item !== field && item.kind === 'text' && /^(标题|title)$/i.test(item.name))) return false;
  if (samplesMatchPackagePublisherHref(pairedHref.samples) || samplesMatchAuthorProfileHref(pairedHref.samples) || smartFieldHasTagSignal(pairedHref) || smartFieldHasTypeSignal(pairedHref)) return false;
  if (/domain|source|site|from\?site/i.test(`${pairedHref.name} ${pairedHref.relativeXPath} ${pairedHref.samples.join(' ')}`)) return false;
  if (!looksLikeTitleText(field.samples)) return false;
  if (field.samples.every(isSourceText) || field.samples.every(isLocationText) || field.samples.every(isRatingText) || field.samples.every(isDateLikeText)) return false;
  const pairedIdentity = `${pairedHref.name} ${pairedHref.relativeXPath}`;
  return isLikelySmartTitleHref(pairedHref, fields) || /title|storylink|s-link|athing/i.test(pairedIdentity);
}

function isFirstUsableTextField(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  return field.kind === 'text' && fields.find((item) => item.kind === 'text' && item.samples.length) === field;
}

function isNestedRepeatedSubrecordField(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  const group = repeatedSubrecordGroup(field.relativeXPath || '');
  if (!group) return false;
  const sameIndexedGroup = all.filter((item) => repeatedSubrecordGroup(item.relativeXPath || '') === group);
  if (sameIndexedGroup.length < 2) return false;
  const unindexedGroup = group.replace(/\[\d+\]$/, '');
  return all.some((item) => repeatedSubrecordGroup(item.relativeXPath || '') === unindexedGroup || (item.relativeXPath || '').includes(unindexedGroup));
}

function repeatedSubrecordGroup(relativeXPath: string): string | undefined {
  const match = relativeXPath.match(/^(.*?\/(?:descendant-or-self::)?(?:DIV|LI|ARTICLE|SECTION|TR|UL|OL)(?:\[[^\]]+\])*\[(\d+)\])(?:\/\/|\/)/i);
  if (!match || Number(match[2]) <= 1) return undefined;
  return match[1];
}

function smartFieldPriority(field: SmartDetectedField, index: number): number {
  let score = Math.max(0, 80 - index);
  if (/^(标题|title)$/i.test(field.name)) score += 120;
  if (/标题.*链接|title.*link|url|链接$/i.test(field.name) && field.kind === 'href') score += 110;
  if (/图片|image|cover/i.test(field.name) && field.kind === 'src') score += 90;
  if (/描述|摘要|description|summary|snippet/i.test(field.name)) score += 70;
  if (/作者|author|user/i.test(field.name)) score += 55;
  if (/时间|日期|date|time|updated|created/i.test(field.name)) score += 50;
  if (/价格|price|评分|rating|下载|download|views?|votes?|票数|回答数|浏览数|想读|版本|电子书/i.test(field.name)) score += 45;
  if (isGeneratedSmartName(field.name)) score -= 50;
  if (field.samples.every(isLowValueLinkLabel)) score -= 30;
  return score;
}

function uniqueFieldName(name: string, used: Set<string>): string {
  const base = name.trim() || '字段';
  let current = base;
  let suffix = 2;
  while (used.has(current)) {
    current = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(current);
  return current;
}

function isGeneratedSmartName(name: string): boolean {
  const value = name.trim();
  return /^字段\d*$/i.test(value)
    || /^field_?\d+$/i.test(value)
    || /^[a-f0-9]{6,}(?:_\S*)?$/i.test(value)
    || /^(?:_|css|ssrcss|ipc|tmp|col\d|colmd|dinline|dnone|buttonsecondary|tooltipped|textnormal|bookcover|ratingsbyline|resultdetails|btntext|packagesnippet|vr1pye|hvbaad|bwoy4d|srw_|colorfg|fgmuted|valign|textmodule|titlemodule|storycard|counter|link(?:_链接)?$|f\d+$|flexitem|flexshrink|usalist|sustyledtext|sucard|scard|jstilelink|wfull|frame(?:_链接)?$|pill|pillwrapper|chip|badge|gochip|my$|mb$|mt$|mr$|ml$|mx$)/i.test(value);
}

function hasGeneratedSmartStructure(field: SmartDetectedField): boolean {
  const structural = `${field.name} ${field.relativeXPath}`;
  return /\b(?:my|mb|mt|mr|ml|mx)-\d|pill|chip|badge|jstilelink|w-?full|text-(?:xs|sm|base|lg)|font-|leading-|tracking-|shrink|grow|basis-|items-center/i.test(structural);
}

function isWholeRowTextField(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  const relative = (field.relativeXPath || '').trim();
  if (relative !== '.' && relative !== '/self::*' && relative !== 'self::*') return false;
  return field.samples.some((sample) => {
    const normalized = normalizeSample(sample);
    return normalized.length >= 40 && all.some((item) => item !== field && item.samples.some((other) => {
      const value = normalizeSample(other);
      return value.length >= 6 && normalized.includes(value);
    }));
  });
}

function isMisleadingContainerTextField(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  const relative = (field.relativeXPath || '').trim();
  if (!relative || !field.samples.length) return false;
  const childTextFields = all.filter((item) => {
    const childRelative = (item.relativeXPath || '').trim();
    return item !== field
      && item.kind === 'text'
      && childRelative.startsWith(`${relative}//`)
      && item.samples.length;
  });
  const titleChild = childTextFields.find((item) => /^(标题|title)$/i.test(item.name) || item.samples.some(isCompactTitleText));
  if (!titleChild) return false;
  const parentSamples = field.samples.map(normalizeSample);
  const childSamples = titleChild.samples.map(normalizeSample);
  const alignedMatches = parentSamples.filter((sample, index) => {
    const child = childSamples[index] || '';
    return child.length >= 6 && sample.length > child.length && sample.includes(child);
  }).length;
  if (alignedMatches < Math.max(1, Math.ceil(Math.min(parentSamples.length, childSamples.length) * 0.67))) return false;
  return /公司|company|listing|字段|field/i.test(field.name)
    || averageLength(field.samples) > averageLength(titleChild.samples) + 8;
}

function isSearchHighlightField(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  const identity = `${field.name} ${field.relativeXPath}`;
  if (!/highlight|search-hit|高亮/i.test(identity)) return false;
  const values = normalizeSamples(field.samples);
  if (!values.length) return false;
  const distinct = new Set(values);
  if (distinct.size <= Math.max(2, Math.ceil(values.length / 3)) && values.every((value) => value.length <= 40)) return true;
  const matches = field.samples.filter((sample, index) => {
    const value = normalizeSample(sample);
    return value.length >= 2
      && value.length <= 40
      && all.some((item) => item !== field && item.kind === 'text' && item.samples.some((other, otherIndex) => {
        if (index !== otherIndex && item.samples.length === field.samples.length) return false;
        const normalized = normalizeSample(other);
        return normalized.length > value.length + 6 && normalized.includes(value);
      }));
  }).length;
  return matches >= Math.max(1, Math.floor(field.samples.length * 0.67));
}

function hasPairedHref(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  return all.some((item) => item !== field && item.kind === 'href' && item.relativeXPath === field.relativeXPath);
}

function normalizeSamples(samples: string[]): string[] {
  return samples.map(normalizeSample).filter(Boolean);
}

function normalizeSample(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isActionHref(value: string): boolean {
  return /(?:\/login\b|[?&]return_to=|\/sponsors?\b|\/vote\?|#bookpreview|action=locate|\/borrow\/ia\/|watchlistadd|\/myb\/watchlistadd)/i.test(value);
}

function isLowValueActionText(value: string): boolean {
  return /^(?:•|star|rate|mark as watched|add to (?:list|basket|cart)|built by|authored by|via|caches?|downloads?|download|preview|read|read more|view in page|[▽▾▼]?\s*more|see more(?:\s*\([^)]*\))?\.{0,3}|top results in this book|table of contents|imported by|borrow|locate|find (?:in|at) (?:a )?library|check availability|code|issues?|pull requests?|discussions?|sponsor(?:ed)?|updated|buy now|bid now|add to cart|今すぐ買う|\(?about\)?|预览|仅供预览|查找图书馆|借阅|添加到清单|立即购买|加入购物车)$/i.test(normalizeSample(value))
    || /^\[?\s*(?:pdf|ps|html|other)(?:\s*,\s*(?:pdf|ps|html|other))*\s*\]?$/i.test(normalizeSample(value));
}

function isLowValueLinkLabel(value: string): boolean {
  return /^(pdf|html|other|star|rate|homepage|documentation|repository|preview|borrow|locate|read|read more|view in page|more|next|previous)$/i.test(normalizeSample(value));
}

function isLowValueLabelText(value: string): boolean {
  return /^(?:submitted|originally announced|revised|updated|published|authors?|abstract|comments?|votes?|answers?|views?)$/i.test(normalizeSample(value));
}

function isDecorativeRatingStarText(value: string): boolean {
  return /^★+$/.test(value.trim());
}

function isOrdinalText(value: string): boolean {
  return /^#?\d+\.?$/.test(normalizeSample(value));
}

function isRatingText(value: string): boolean {
  return /^★+$/.test(value.trim())
    || /^\d{1,3}(?:\.\d+)?%$/.test(normalizeSample(value))
    || /^\d+(?:\.\d+)?\s*\([^)]*ratings?\)$/i.test(normalizeSample(value));
}

function isSourceText(value: string): boolean {
  return /^\(?[\w.-]+\.[a-z]{2,}(?:\/[\w.-]+)?\)?$/i.test(normalizeSample(value));
}

function isCompactCountText(value: string): boolean {
  return /^-?\d[\d,.]*(?:\s*[km])?$/i.test(normalizeSample(value));
}

function isOpenLibraryPublicationInfoText(value: string): boolean {
  return /^(?:first published(?:\s+in)?|首次出版于)\s*(?:18|19|20)\d{2}$/i.test(normalizeSample(value));
}

function isOpenLibraryVersionText(value: string): boolean {
  return /^\d[\d,.\s]*(?:个版本|种版本|versions?|editions?)$/i.test(normalizeSample(value));
}

function isOpenLibraryEbookText(value: string): boolean {
  return /^\d[\d,.\s]*(?:本电子书|ebooks?|e-books?)$/i.test(normalizeSample(value));
}

function isVersionText(value: string): boolean {
  return /^v?\d+(?:\.\d+){1,4}(?:[-+][\w.-]+)?$/i.test(normalizeSample(value));
}

function isStockStatusText(value: string): boolean {
  return /^(?:in stock|out of stock|available|unavailable|sold out|库存充足|有货|无货|缺货|现货)$/i.test(normalizeSample(value));
}

function isAllTimeDownloadText(value: string): boolean {
  return /^all[-\s]?time downloads?\s*[:：]\s*[\d,.\s]+$/i.test(normalizeSample(value));
}

function isRecentDownloadText(value: string): boolean {
  return /^recent downloads?\s*[:：]\s*[\d,.\s]+$/i.test(normalizeSample(value));
}

function isRemoteLocationText(value: string): boolean {
  const normalized = normalizeSample(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!normalized || normalized.length > 90) return false;
  return /^(?:probably\s+)?(?:worldwide|remote|anywhere|global|europe|emea|apac|americas)$/i.test(normalized)
    || /^(?:remote|probably worldwide|worldwide)\b/i.test(normalized);
}

function isCountryLocationText(value: string): boolean {
  const normalized = normalizeSample(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!normalized || normalized.length > 60) return false;
  return /^(?:united states|canada|united kingdom|germany|france|spain|portugal|netherlands|india|singapore|australia|brazil|mexico|japan|china|hong kong|taiwan|worldwide)$/i.test(normalized);
}

function isLikelyCompanyField(field: SmartDetectedField): boolean {
  if (field.kind !== 'text' || !field.samples.length) return false;
  const identity = `${field.name} ${field.relativeXPath}`;
  if (/type|category|industry|batch|tag|keyword|listing-job-type|job-type|类型|类别|行业|批次|标签|关键词/i.test(identity)) return false;
  if (/company|employer|organization|org|公司|雇主/i.test(identity)) return true;
  if (!/字段|field|span|company|employer/i.test(identity)) return false;
  if (/\/A\[\d+\]/i.test(field.relativeXPath || '')) return false;
  return field.samples.every(isCompanyNameText);
}

function isCompanyNameText(value: string): boolean {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalized = normalizeSample(raw);
  if (!normalized || raw.length > 80) return false;
  if (/^(?:verified|new|featured|premium|remote|worldwide|probably worldwide)$/i.test(raw)) return false;
  if (isLowValueActionText(raw) || isDateLikeText(raw) || isRemoteLocationText(raw) || isCountryLocationText(raw) || isStockStatusText(raw)) return false;
  if (/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/u.test(raw)) return false;
  return /[\p{L}\p{N}]/u.test(raw) && !/[?{}()[\]<>]/.test(raw);
}

function hasLeadingAuthorPrefix(value: string): boolean {
  return /^(?:来自|by|authors?|作者)[:：]?\s*\S/i.test(String(value ?? '').trim());
}

function isTagHref(value: string): boolean {
  const normalized = normalizeSample(value);
  return /(?:^|[/?#])(?:tag|tags|topic|topics|keyword|keywords|subject|subjects|filter)(?::|%3a|[/?#&=]|$)/i.test(normalized)
    || /[?&](?:tag|tags|topic|topics|keyword|keywords|subject|subjects|filter)=/i.test(normalized)
    || /[?&]q=keywords:/i.test(normalized);
}

function isRemoteOkFacetHref(value: string): boolean {
  return /^https?:\/\/(?:www\.)?remoteok\.com\/remote-[\w+-]+-jobs(?:[?#].*)?$/i.test(normalizeSample(value));
}

function isTypeHref(value: string): boolean {
  const normalized = normalizeSample(value);
  return /(?:^|[/?#])(?:type|types|category|categories|industry|industries|batch|batches)(?::|%3a|[/?#&=]|$)/i.test(normalized)
    || /[?&](?:type|types|category|categories|industry|industries|batch|batches)=/i.test(normalized);
}

function isLocationHref(value: string): boolean {
  const normalized = normalizeSample(value);
  return /(?:^|[/?#])(?:location|locations|city|cities|region|regions|country|countries)(?::|%3a|[/?#&=]|$)/i.test(normalized)
    || /[?&](?:location|locations|city|cities|region|regions|country|countries)=/i.test(normalized);
}

function samplesMatchAuthorProfileHref(samples: string[]): boolean {
  return samples.length > 0 && samples.every((value) => {
    const normalized = normalizeSample(value);
    if (!/^https?:\/\//i.test(normalized)) return false;
    return /(?:github\.com\/(?:apps\/)?[^/?#]+$|npmjs\.com\/~[^/?#]+$|openlibrary\.org\/authors\/)/i.test(normalized);
  });
}

function samplesMatchPackagePublisherHref(samples: string[]): boolean {
  return samples.length > 0 && samples.every((value) => /(?:npmjs\.com\/~[^/?#]+|gh\.io\/npm-docs-trusted-publishers)/i.test(normalizeSample(value)));
}

function samplesMatchPrimaryRecordHref(samples: string[]): boolean {
  const values = samples.map(normalizeSample).filter(Boolean);
  if (!values.length) return false;
  const detailMatches = values.filter((value) => {
    if (!/^https?:\/\//i.test(value)) return false;
    if (isTagHref(value) || isTypeHref(value) || isRemoteOkFacetHref(value) || samplesMatchAuthorProfileHref([value]) || smartRelatedLinkName({ name: 'link', kind: 'href', selector: '', xpath: '', relativeSelector: '', relativeXPath: '', samples: [value], sourceIndex: 0 })) return false;
    return /\/(?:remote-jobs|questions|works|abs|plugins|catalogue|crates|package|packages|docs|learn|articles|blog|post|item|product|jobs?)\//i.test(value)
      || /\/(?:remote-jobs|questions|works|abs|plugins|crates|package|packages|docs|learn|articles|blog|post|item|product|jobs?)(?:[/?#]|$)/i.test(value);
  }).length;
  return detailMatches >= Math.max(1, Math.ceil(values.length * 0.67));
}

function isPackagePublisherText(value: string): boolean {
  const normalized = normalizeSample(value);
  if (!normalized || normalized.length > 60) return false;
  return normalized === 'github actions'
    || /^@?[\w.-]{2,40}$/.test(normalized);
}

function isProgrammingLanguageText(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 32) return false;
  return /^(?:TypeScript|JavaScript|Python|Java|C|C\+\+|C#|Go|Rust|Ruby|PHP|Swift|Kotlin|Scala|Dart|Shell|PowerShell|HTML|CSS|Vue|Svelte|Jupyter Notebook|Objective-C|Elixir|Erlang|Haskell|Lua|Perl|R|MATLAB|Julia|Zig|Nim|OCaml|Clojure)$/i.test(normalized);
}

function isBulletMetadataText(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const parts = normalized.split(/[•·]/).map((item) => item.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  const hasVersion = parts.some((part) => /^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/i.test(part));
  const hasTime = parts.some(isDateLikeText);
  const hasLicenseOrDependents = parts.some((part) => /\b(?:dependents?|mit|apache|gpl|bsd|isc|mpl|lgpl|agpl|unlicense)\b/i.test(part));
  return hasVersion && hasTime && hasLicenseOrDependents;
}

function isRecordIdentifierText(value: string): boolean {
  return /^(?:arxiv|doi|pmid|pmcid|isbn|issn)[:：]?\s*[\w./:-]+$/i.test(normalizeSample(value));
}

function isLargeNumericText(value: string): boolean {
  return /^[\d,.\s]+$/.test(value.trim()) && /\d/.test(value) && Number(value.replace(/[,\s]/g, '')) >= 100;
}

function isInstallCountText(value: string): boolean {
  return /\b[\d,.]+\+?\s*(?:million|thousand|k|m)?\s+active installations?\b/i.test(normalizeSample(value));
}

function isTestedWithText(value: string): boolean {
  return /^tested with\s+\d+(?:\.\d+){0,2}$/i.test(normalizeSample(value));
}

function isLocationText(value: string): boolean {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 90 || /\d{3,}/.test(normalized)) return false;
  if (isAuthorListText(normalized)) return false;
  if (!/,/.test(normalized)) return false;
  return /^[\p{L}\p{M} .'-]+,\s*[\p{L}\p{M} .'-]{2,}(?:,\s*[\p{L}\p{M} .'-]{2,})?$/u.test(normalized);
}

function isAuthorListText(value: string): boolean {
  if (isEditorAuthorText(value)) return true;
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const normalized = raw.toLowerCase().replace(/[.;]+$/g, '');
  if (!normalized || normalized.length > 180 || !/[a-z]/i.test(normalized)) return false;
  if (/\b(?:doi|pmcid|journal|medicine|background|objective|abstract|category)\b/i.test(normalized)) return false;
  if (/\b(?:for|with|the|and|a|an|to|of|in|on|from|using|package|helper|pages?|data|extraction)\b/i.test(normalized)) return false;
  const parts = raw.replace(/[.;]+$/g, '').split(/\s*,\s*/).filter(Boolean);
  if (parts.length < 1 || parts.length > 12) return false;
  return parts.every(isAuthorCitationPart);
}

function isEditorAuthorText(value: string): boolean {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 220 || !/\b(?:editors?|eds?)\.?$/i.test(raw)) return false;
  const authorText = raw
    .replace(/\bet\s+al\.?,?\s*(?:editors?|eds?)\.?$/i, '')
    .replace(/,?\s*(?:editors?|eds?)\.?$/i, '')
    .replace(/[.;,\s]+$/g, '');
  const parts = authorText.split(/\s*,\s*/).filter(Boolean);
  if (!parts.length || parts.length > 12) return false;
  return parts.every(isAuthorCitationPart);
}

function isPublicationCitationText(value: string): boolean {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 180) return false;
  if (!/(?:19|20)\d{2}/.test(raw)) return false;
  return /[A-Z][\p{L} .'-]+\s+\([A-Z]{2,}\):/u.test(raw)
    || /\b(?:Publishing|Publisher|Press|University|Centre|Center|Institute|Bookshelf|Database|Decker)\b/i.test(raw)
    || /;\s*(?:19|20)\d{2}/.test(raw);
}

function isAuthorCitationPart(value: string): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 5) return false;
  const initials = tokens[tokens.length - 1].replace(/\./g, '');
  if (!/^[A-Z]{1,5}$/.test(initials)) return false;
  const surnameTokens = tokens.slice(0, -1);
  return surnameTokens.some((token) => /[A-Za-z]{2,}/.test(token))
    && surnameTokens.every((token) => /^(?:[A-Z][A-Za-z'’.-]*(?:-[A-Z][A-Za-z'’.-]*)?|de|da|del|van|von|le|la|du)$/i.test(token));
}

function normalizeAuthorSample(value: string): string {
  return normalizeSample(value)
    .replace(/^(?:authors?|by|来自|作者)[:：]?\s*/i, '')
    .trim();
}

function normalizeSourceSample(value: string): string {
  return normalizeSample(value)
    .replace(/^\((.+)\)$/g, '$1')
    .trim();
}

function isDuplicateTitleHrefVariant(field: SmartDetectedField, fields: SmartDetectedField[]): boolean {
  if (field.kind !== 'href' || smartFieldFamily(field) === 'title_href') return false;
  const titleHref = fields.find((item) => item !== field && item.kind === 'href' && smartFieldFamily(item) === 'title_href');
  if (!titleHref || !field.samples.length) return false;
  const titlePaths = titleHref.samples.map(normalizeHrefIdentity).filter(Boolean);
  const values = field.samples.map(normalizeHrefIdentity).filter(Boolean);
  if (!titlePaths.length || !values.length) return false;
  const matches = values.filter((value, index) => value === titlePaths[index] || titlePaths.includes(value)).length;
  return matches >= Math.max(2, Math.ceil(values.length * 0.67));
}

function normalizeHrefIdentity(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/g, '')}`.toLowerCase();
  } catch {
    return normalizeSample(value).replace(/[?#].*$/g, '').replace(/\/+$/g, '');
  }
}

function isDateLikeText(value: string): boolean {
  const normalized = normalizeSample(value);
  if ((normalized.includes('•') || normalized.length > 48) && !/^(?:published|updated|posted|created)\b/i.test(normalized)) return false;
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(normalized)
    || /\b(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|秒|分钟|小时|天|周|月|年)\s*(?:ago|前)\b/i.test(value)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(value);
}

function isRedundantTitleFragment(field: SmartDetectedField, all: SmartDetectedField[]): boolean {
  const title = all.find((item) => item !== field && item.kind === 'text' && /^(标题|title)$/i.test(item.name));
  if (!title || field.kind !== 'text') return false;
  if (field.samples.length !== title.samples.length && field.samples.length < 2) return false;
  return field.samples.every((sample, index) => {
    const value = normalizeSample(sample);
    const titleValue = normalizeSample(title.samples[index] || '');
    return value.length >= 3 && titleValue.length > value.length && titleValue.includes(value);
  });
}

function looksLikeTitleText(samples: string[]): boolean {
  return samples.some((sample) => {
    const value = normalizeSample(sample);
    return value.length >= 8
      && !isLowValueActionText(value)
      && !isLowValueLinkLabel(value)
      && !isOrdinalText(value)
      && !isDateLikeText(value)
      && !/^https?:\/\//i.test(value);
  });
}

function isCompactTitleText(sample: string): boolean {
  const value = normalizeSample(sample);
  if (value.length < 2 || value.length > 90) return false;
  if (isLowValueActionText(value) || isLowValueLinkLabel(value) || isOrdinalText(value) || isDateLikeText(value) || isSourceText(value) || isRatingText(value) || isLocationText(sample)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (/^(?:[\d,.\s]+|[A-Z]{2,}(?:\s+\d{4})?)$/.test(sample.trim())) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function averageLength(samples: string[]): number {
  if (!samples.length) return 0;
  return samples.reduce((sum, sample) => sum + sample.trim().length, 0) / samples.length;
}

function normalizeFieldName(name: string | undefined, kind: DetectedField['kind'], index: number): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  if (kind === 'href') return index === 0 ? 'url' : `url_${index + 1}`;
  if (kind === 'src') return index === 0 ? 'image' : `image_${index + 1}`;
  return index === 0 ? 'text' : `field_${index + 1}`;
}

function applySmartSampleRows(fields: SmartDetectedField[], data: string[][], rowIndices: number[]): SmartDetectedField[] {
  return fields.map((field) => {
    const samples = rowIndices
      .map((rowIndex) => applySmartFieldOperations(data[field.sourceIndex]?.[rowIndex] ?? '', field.operations))
      .filter(Boolean)
      .slice(0, 3);
    return { ...field, samples };
  });
}

function selectSmartSampleRowIndices(fields: SmartDetectedField[], data: string[][]): number[] {
  const rowCount = Math.max(0, ...data.map((column) => column.length));
  if (!rowCount) return [];
  const scored = Array.from({ length: rowCount }, (_, rowIndex) => {
    const values = fields.map((field) => applySmartFieldOperations(data[field.sourceIndex]?.[rowIndex] ?? '', field.operations));
    const nonEmpty = values.filter((value) => normalizeSample(value)).length;
    const semanticNonEmpty = fields.filter((field, index) => fieldValueLooksUsefulForSampling(field, values[index] || '')).length;
    const filterNoise = values.some((value) => isRowLevelFilterOrAdText(value));
    const fillRate = nonEmpty / Math.max(1, fields.length);
    let score = fillRate + semanticNonEmpty * 0.08;
    if (filterNoise && fillRate < 0.45) score -= 0.55;
    if (nonEmpty <= 2 && fields.length >= 5) score -= 0.35;
    return { rowIndex, score, nonEmpty };
  });
  const bestNonEmpty = Math.max(...scored.map((item) => item.nonEmpty), 0);
  const selected = scored
    .filter((item) => item.nonEmpty >= Math.max(1, Math.ceil(bestNonEmpty * 0.45)))
    .sort((a, b) => b.score - a.score || a.rowIndex - b.rowIndex)
    .slice(0, 3)
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((item) => item.rowIndex);
  return selected.length ? selected : scored.slice(0, 3).map((item) => item.rowIndex);
}

function fieldValueLooksUsefulForSampling(field: SmartDetectedField, value: string): boolean {
  const normalized = normalizeSample(value);
  if (!normalized || isLowValueActionText(normalized) || isLowValueLinkLabel(normalized)) return false;
  if (/^(标题|title|描述|摘要|公司|作者|位置|时间|价格|版本|库存状态|下载|总下载|近期下载)$/i.test(field.name)) return true;
  if (field.kind === 'href' && /^https?:\/\//i.test(normalized)) return true;
  if (field.kind === 'src' && /^https?:\/\//i.test(normalized)) return true;
  return normalized.length >= 4;
}

function isRowLevelFilterOrAdText(value: string): boolean {
  const normalized = normalizeSample(value);
  if (!normalized) return false;
  return normalized.length > 80
    && /(salary|benefits|sort by|latest jobs|highest paid|most viewed|most applied|clear|results?|筛选|排序|最新|最多|清除)/i.test(normalized);
}

function buildSampleRows(fields: SmartDetectedField[], data: string[][], rowIndices: number[]): Record<string, string>[] {
  const selectedRows = rowIndices.length ? rowIndices : Array.from({ length: Math.min(3, data[0]?.length ?? 0) }, (_, index) => index);
  const rows: Record<string, string>[] = [];
  for (const rowIndex of selectedRows.slice(0, 3)) {
    const row: Record<string, string> = {};
    fields.forEach((field) => {
      row[field.name] = applySmartFieldOperations(data[field.sourceIndex]?.[rowIndex] ?? '', field.operations);
    });
    rows.push(row);
  }
  return rows;
}

function smartPaginationToDetected(page: SmartRawResult['Page']): DetectedPagination | undefined {
  if (!page?.XPath) return undefined;
  const type = page.PagingType === 1 ? 'load_more' : page.PagingType === 2 ? 'scroll' : 'next_page';
  return {
    type,
    xpath: page.XPath,
    text: page.Text || (type === 'load_more' ? 'Load more' : type === 'scroll' ? 'Scroll page' : 'Next page'),
    confidence: 0.86,
    isAjax: page.IsAjax === true || type !== 'next_page',
    scope: 'near_list',
    reasons: ['Detected by protected SmartProxy pagination']
  };
}
