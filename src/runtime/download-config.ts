import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false
});

export function extractFieldNamesWithDownloadOutputs(taskXml: string): string[] {
  const root = toRecord(xmlParser.parse(taskXml));
  const rootElement = firstRecordValue(root);
  const names = new Set<string>();
  for (const field of extractExtractItemsFromNode(rootElement)) {
    const header = stringValue(field.Header);
    if (header && header.toLowerCase() !== 'root') names.add(header);
  }
  return [...names];
}

function extractExtractItemsFromNode(value: unknown): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = toRecord(node);
    if (!record || !Object.keys(record).length) return;

    const extractTemplateXml = stringValue(record.ExtractTemplate);
    if (extractTemplateXml) {
      items.push(...parseExtractTemplate(extractTemplateXml));
    }

    for (const [key, child] of Object.entries(record)) {
      if (key === 'ExtractTemplate') continue;
      visit(child);
    }
  };
  visit(value);
  return items;
}

function parseExtractTemplate(xml: string): Record<string, unknown>[] {
  try {
    const parsed = toRecord(xmlParser.parse(xml));
    const root = toRecord(parsed.ExtractTemplate);
    const itemsNode = toRecord(root.Items).ExtractItem;
    const items = Array.isArray(itemsNode) ? itemsNode : itemsNode ? [itemsNode] : [];
    return items.map(toRecord).filter((item) => Object.keys(item).length > 0);
  } catch {
    return [];
  }
}

function firstRecordValue(record: Record<string, unknown>): Record<string, unknown> {
  for (const value of Object.values(record)) {
    const child = toRecord(value);
    if (Object.keys(child).length) return child;
  }
  return {};
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}
