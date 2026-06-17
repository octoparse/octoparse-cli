#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, 'docs', 'i18n');
const srcDir = path.join(repoRoot, 'src');

const SKIP_PROPERTY_NAMES = new Set([
  'action',
  'apiBaseUrl',
  'code',
  'content',
  'cwd',
  'encoding',
  'env',
  'event',
  'extension',
  'format',
  'id',
  'kind',
  'language',
  'method',
  'mimeType',
  'mode',
  'name',
  'outputDir',
  'path',
  'platform',
  'role',
  'schemaVersion',
  'selector',
  'source',
  'status',
  'type',
  'url',
  'value',
  'xpath'
]);

const USER_FACING_PROPERTY_NAMES = new Set([
  'afterRepairBudgetRule',
  'description',
  'doNotRecreateTaskWhen',
  'failureMode',
  'help',
  'instruction',
  'label',
  'message',
  'notes',
  'output',
  'purpose',
  'rankingRule',
  'reason',
  'recreateTaskOnlyWhen',
  'recommendedCandidateRule',
  'repairInstruction',
  'rule',
  'searchRule',
  'summary',
  'title',
  'usage'
]);

const USER_FACING_CALL_NAMES = [
  'console.error',
  'console.log',
  'process.stderr.write',
  'process.stdout.write',
  'printEnvelope',
  'printMissingRun',
  'printUsageError',
  'reject',
  'rejectSecret',
  'rejectValue',
  'resolveSecret',
  'runtimeConsole.writeStderr',
  'showManualOverlayChoice',
  'showManualOverlayStatus',
  'writeManualOverlayHintOnce'
];

const FILES_TO_SKIP = new Set([
  'src/runtime/detector/agent-visual-artifacts.ts'
]);

const MARKDOWN_FILES = [
  'README.md',
  'docs/AGENT_USAGE.md',
  'docs/ARCHITECTURE.md',
  'SECURITY.md',
  'RUNTIME_SECURITY_NOTICE.txt'
];

const rows = [];

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const tsFiles = (await listFiles(srcDir))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => !FILES_TO_SKIP.has(relativePath(file)));

  for (const file of tsFiles) {
    await extractTypeScriptFile(file);
  }

  for (const file of MARKDOWN_FILES) {
    await extractTextFile(path.join(repoRoot, file));
  }

  rows.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column);

  await mkdir(outDir, { recursive: true });
  const reviewRows = rows.filter((row) => !row.locked);
  const runtimeReviewRows = reviewRows.filter((row) => row.file.startsWith('src/'));
  const payload = {
    schemaVersion: 'octoparse-cli-copy-export.v1',
    generatedAt: new Date().toISOString(),
    sourceRoot: repoRoot,
    counts: {
      total: rows.length,
      unlocked: rows.filter((row) => !row.locked).length,
      locked: rows.filter((row) => row.locked).length,
      runtimeReview: runtimeReviewRows.length
    }
  };

  await writeFile(path.join(outDir, 'cli-copy-to-translate.json'), `${JSON.stringify(toTranslatorJson(reviewRows), null, 2)}\n`);
  await writeFile(path.join(outDir, 'cli-runtime-copy-to-translate.json'), `${JSON.stringify(toTranslatorJson(runtimeReviewRows), null, 2)}\n`);
  await writeFile(path.join(outDir, 'README.md'), renderReadme(payload));

  console.log(`Exported ${payload.counts.runtimeReview} runtime copy rows and ${payload.counts.unlocked} full review rows to ${relativePath(outDir)}`);
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  }));
  return files.flat();
}

async function extractTypeScriptFile(file) {
  const sourceText = await readFile(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  visit(sourceFile);

  function visit(node) {
    if (isExtractableStringNode(node)) {
      const extracted = extractNodeText(node, sourceFile);
      if (extracted && shouldIncludeNode(node, sourceFile, extracted.text)) {
        addTypeScriptRow(file, sourceFile, node, extracted);
      }
    }
    ts.forEachChild(node, visit);
  }
}

function isExtractableStringNode(node) {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateExpression(node);
}

function extractNodeText(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return {
      text: node.text,
      raw: node.getText(sourceFile),
      placeholders: []
    };
  }

  if (ts.isTemplateExpression(node)) {
    const placeholders = [];
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const index = placeholders.length;
      placeholders.push(span.expression.getText(sourceFile));
      text += `{${index}}${span.literal.text}`;
    }
    return {
      text,
      raw: node.getText(sourceFile),
      placeholders
    };
  }

  return undefined;
}

function shouldIncludeNode(node, sourceFile, value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!hasHumanLetters(trimmed)) return false;
  if (isInImportOrTypePosition(node)) return false;
  if (ts.isStringLiteral(node) && isObjectPropertyName(node)) return false;
  if (isDirectivePrologue(node)) return false;

  const file = relativePath(sourceFile.fileName);
  const propertyName = nearestPropertyName(node);
  const callName = nearestCallName(node, sourceFile);
  const variableName = nearestVariableName(node);
  const functionName = nearestFunctionName(node);
  const isHelpFile = file === 'src/cli/help.ts';
  const isSecurityNotice = file === 'src/runtime/security-notice.ts';

  if (isHelpFile || isSecurityNotice) return true;
  if (isClearlyMachineString(trimmed)) return false;
  if (isSelectorLike(trimmed)) return false;
  if (isLikelyMarkupOrStyleBlock(trimmed)) return false;
  if (USER_FACING_CALL_NAMES.includes(callName)) return true;
  if (callName === 'Error' || callName === 'new Error') return true;
  if (propertyName && USER_FACING_PROPERTY_NAMES.has(propertyName)) return true;
  if (variableName && /help|message|notice|prompt|title|description|instruction|summary|warning|label|names/i.test(variableName)) return true;
  if (functionName && /Help|Label|Hint|Message|Notice|Prompt|Summary|Title|Usage|Warning/.test(functionName)) return true;
  if (file.startsWith('src/commands/') && trimmed.includes(' ')) return true;
  if (file.startsWith('src/runtime/') && (trimmed.includes(' ') || trimmed.includes('\n'))) {
    return Boolean(propertyName && !SKIP_PROPERTY_NAMES.has(propertyName));
  }
  return false;
}

function addTypeScriptRow(file, sourceFile, node, extracted) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const context = buildContext(node, sourceFile);
  const category = classify(relativePath(file), context, extracted.text);
  const locked = isLocked(category, extracted.text, context);
  const note = buildNote(locked, extracted.placeholders, context);
  const sourceHash = sha1(extracted.raw);
  const id = makeId(relativePath(file), line + 1, character + 1, sourceHash);

  rows.push({
    id,
    file: relativePath(file),
    line: line + 1,
    column: character + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
    category,
    context,
    nodeKind: ts.SyntaxKind[node.kind],
    locked,
    note,
    placeholders: JSON.stringify(extracted.placeholders),
    sourceHash,
    source_text: extracted.text,
    revised_text: ''
  });
}

async function extractTextFile(file) {
  let sourceText;
  try {
    sourceText = await readFile(file, 'utf8');
  } catch {
    return;
  }
  const rel = relativePath(file);
  const blocks = collectTextBlocks(sourceText);
  for (const block of blocks) {
    if (!hasHumanLetters(block.text) || isClearlyMachineString(block.text.trim())) continue;
    const sourceHash = sha1(block.text);
    rows.push({
      id: makeId(rel, block.line, 1, sourceHash),
      file: rel,
      line: block.line,
      column: 1,
      endLine: block.endLine,
      category: rel === 'RUNTIME_SECURITY_NOTICE.txt' ? 'security-notice' : 'docs',
      context: block.context,
      nodeKind: 'TextBlock',
      locked: false,
      note: 'Documentation copy. Keep command examples, flags, URLs, env vars, JSON field names, and Markdown formatting intact.',
      placeholders: '[]',
      sourceHash,
      source_text: block.text,
      revised_text: ''
    });
  }
}

function collectTextBlocks(sourceText) {
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let current = [];
  let startLine = 1;

  const flush = (endLine) => {
    const text = current.join('\n').trim();
    if (text) {
      blocks.push({
        line: startLine,
        endLine,
        context: text.startsWith('#') ? 'markdown heading' : 'markdown prose',
        text
      });
    }
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lineNo = index + 1;
    const isFence = trimmed.startsWith('```');
    if (isFence) {
      if (current.length) flush(lineNo - 1);
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) index += 1;
      continue;
    }
    if (!trimmed) {
      if (current.length) flush(lineNo - 1);
      continue;
    }
    if (/^\|?[-:| ]+\|?$/.test(trimmed)) continue;
    if (/^(?:[-*]|\d+\.)\s+`[^`]+`$/.test(trimmed)) continue;
    if (!current.length) startLine = lineNo;
    current.push(line);
  }
  if (current.length) flush(lines.length);
  return blocks;
}

function isInImportOrTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isImportTypeNode(current) || ts.isLiteralTypeNode(current)) return true;
    if (ts.isTypeReferenceNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
  }
  return false;
}

function isObjectPropertyName(node) {
  return ts.isPropertyAssignment(node.parent) && node.parent.name === node;
}

function isDirectivePrologue(node) {
  return ts.isExpressionStatement(node.parent)
    && ts.isSourceFile(node.parent.parent)
    && typeof node.text === 'string'
    && /^[a-z ]+$/i.test(node.text);
}

function nearestPropertyName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      return propertyNameText(current.name);
    }
  }
  return '';
}

function nearestVariableName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
  }
  return '';
}

function nearestFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return propertyNameText(current.name);
  }
  return '';
}

function nearestCallName(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isNewExpression(current) && current.expression.getText(sourceFile) === 'Error') return 'new Error';
    if (ts.isCallExpression(current)) return current.expression.getText(sourceFile);
  }
  return '';
}

function buildContext(node, sourceFile) {
  const parts = [];
  const callName = nearestCallName(node, sourceFile);
  const propertyName = nearestPropertyName(node);
  const variableName = nearestVariableName(node);
  const functionName = nearestFunctionName(node);
  if (functionName) parts.push(`function ${functionName}`);
  if (variableName) parts.push(`variable ${variableName}`);
  if (propertyName) parts.push(`property ${propertyName}`);
  if (callName) parts.push(`call ${callName}`);
  return parts.join(' > ') || 'source string';
}

function classify(file, context, text) {
  if (file === 'src/cli/help.ts') return 'help';
  if (file === 'src/runtime/security-notice.ts') return 'security-notice';
  if (file === 'RUNTIME_SECURITY_NOTICE.txt') return 'security-notice';
  if (file.endsWith('.md')) return 'docs';
  if (context.includes('printUsageError')) return 'usage-error';
  if (context.includes('new Error') || context.includes('call Error')) return 'error';
  if (context.includes('prompts') || context.includes('Overlay') || context.includes('prompt')) return 'prompt';
  if (context.includes('console.error') || context.includes('stderr.write')) return 'stderr';
  if (context.includes('console.log') || context.includes('stdout.write')) return 'stdout';
  if (file === 'src/commands/capabilities.ts') return 'agent-contract';
  if (/warning/i.test(context) || /warning/i.test(text)) return 'warning';
  return 'runtime-copy';
}

function isLocked(category, text, context) {
  if (category === 'docs' || category === 'help' || category === 'prompt' || category === 'security-notice') return false;
  if (/\bproperty (?:affectedCommands|cleanupCommands|command|diagnosticCommandsWithoutAuth|event|example|examples|firstCommand|npmExec|packageFirstCommand|setupCommandsWithoutAuth)\b/.test(context)) return true;
  if (context.includes('property command')) return true;
  if (/^(?:octoparse|npx)\s/.test(text.trim())) return true;
  if (/^[A-Z0-9_]{3,}$/.test(text.trim())) return true;
  if (/^[a-z][a-zA-Z0-9_.-]*$/.test(text.trim()) && /\bproperty (?:code|event|message|name|output|path|schema|status|type|value)\b/.test(context)) return true;
  if (/^\s*[\w.-]+:[\w./-]+/.test(text.trim())) return true;
  return false;
}

function buildNote(locked, placeholders, context) {
  const notes = [];
  if (locked) notes.push('Locked context row; normally do not edit.');
  if (placeholders.length) notes.push(`Keep placeholders ${placeholders.map((_, index) => `{${index}}`).join(', ')} in the revised text.`);
  if (context.includes('printUsageError') || context.includes('help')) notes.push('Keep command names, flags, URLs, env vars, JSON field names, and examples intact.');
  if (!notes.length) notes.push('Edit revised_text only.');
  return notes.join(' ');
}

function propertyNameText(name) {
  if (!name) return '';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return '';
}

function hasHumanLetters(value) {
  return /[A-Za-z\u4e00-\u9fff]/.test(value);
}

function isClearlyMachineString(value) {
  if (!value) return true;
  if (/^https?:\/\/\S+$/.test(value)) return true;
  if (/^[@./\w-]+(?:\.[\w-]+)+$/.test(value) && !value.includes(' ')) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return true;
  if (/^--?[a-z0-9-]+$/i.test(value)) return true;
  if (/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/i.test(value)) return true;
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|utf8|json|jsonl|csv|xlsx|html|xml|oauth|apiKey)$/i.test(value)) return true;
  if (/^\.[a-z0-9]+$/i.test(value)) return true;
  return false;
}

function isSelectorLike(value) {
  const trimmed = value.trim();
  if (/^(?:\.|#|\[|\/|\/\/|\*|>|:)/.test(trimmed)) return true;
  if (/\b(?:aria-label|data-|xpath|XPath|selector|querySelector)\b/.test(trimmed) && !trimmed.includes(' ')) return true;
  if (/^\w+(?:\.\w+)+$/.test(trimmed)) return true;
  return false;
}

function isLikelyMarkupOrStyleBlock(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('<!doctype html')) return false;
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<style')) return true;
  if (trimmed.includes('{') && trimmed.includes('}') && /(?:font|color|display|position|padding|margin):/.test(trimmed)) return true;
  return false;
}

function toTranslatorJson(records) {
  const entries = {};
  for (const record of records) {
    entries[record.id] = {
      source: record.source_text,
      target: '',
      note: record.note,
      location: `${record.file}:${record.line}`,
      category: record.category,
      placeholders: JSON.parse(record.placeholders)
    };
  }
  return {
    schemaVersion: 'octoparse-cli-copy-translation.v1',
    instructions: [
      '翻译人员只需要填写 target。',
      '不要修改 id、source、placeholders、location。',
      '保留 {0}、{1} 等占位符；保留命令、参数、URL、环境变量、JSON 字段名。'
    ],
    entries
  };
}

function renderReadme(payload) {
  return `# CLI Copy Export

Generated: ${payload.generatedAt}

Files:

- \`cli-runtime-copy-to-translate.json\`: recommended handoff file for translators. Source CLI copy only; fill \`target\`.
- \`cli-copy-to-translate.json\`: same translator-friendly JSON, but also includes docs/security notice copy.

Translator/editor workflow:

1. Give translators \`cli-runtime-copy-to-translate.json\` unless docs also need review.
2. They only fill each entry's \`target\`.
3. They should not change entry ids, \`source\`, \`location\`, \`category\`, \`placeholders\`, or \`note\`.
4. Keep placeholders such as \`{0}\`, \`{1}\`, command names, flags, URLs, env vars, and JSON field names intact.
5. Return the edited JSON file when translation is done; import will use the entry ids and \`target\` values.

Current counts:

- Total rows: ${payload.counts.total}
- Reviewable rows: ${payload.counts.unlocked}
- Runtime review rows: ${payload.counts.runtimeReview}
- Locked rows: ${payload.counts.locked}
`;
}

function makeId(file, line, column, hash) {
  return `copy_${sha1(`${file}:${line}:${column}:${hash}`).slice(0, 12)}`;
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function relativePath(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}
