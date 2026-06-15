import { resolve } from 'node:path';
import type { Page } from 'puppeteer-core';
import type { DetectedAgentScreenshot, DetectedCandidate, DetectedCandidateDiagnostics } from './types.js';

export async function captureAgentScreenshot(page: Page, path: string, candidates: DetectedCandidate[]): Promise<DetectedAgentScreenshot> {
  const resolved = resolve(path);
  await page.screenshot({ path: resolved, fullPage: true });
  const annotatedPath = annotatedScreenshotPath(resolved);
  const candidateScreenshots = await captureCandidateScreenshots(page, resolved, candidates).catch(() => []);
  const annotated = await captureAnnotatedAgentScreenshot(page, annotatedPath, candidates).catch(() => false);
  return {
    path: resolved,
    fullPage: true,
    ...(annotated ? { annotatedPath } : {}),
    ...(candidateScreenshots.length ? { candidateScreenshots } : {})
  };
}

function annotatedScreenshotPath(path: string): string {
  return path.replace(/(\.[^.\/]+)?$/, (_match, ext: string | undefined) => `.annotated${ext || '.png'}`);
}

function candidateScreenshotPath(path: string, candidateId: string): string {
  return path.replace(/(\.[^.\/]+)?$/, (_match, ext: string | undefined) => `.${candidateId}.crop${ext || '.png'}`);
}

async function captureAnnotatedAgentScreenshot(page: Page, path: string, candidates: DetectedCandidate[]): Promise<boolean> {
  const overlays = candidatesForVisualArtifacts(candidates).map((candidate, index) => ({
    id: candidate.id,
    label: `${index + 1}. ${candidate.id}`,
    box: visualBoxForCandidate(candidate)
  })).filter((item): item is { id: string; label: string; box: NonNullable<ReturnType<typeof visualBoxForCandidate>> } => Boolean(item.box));
  if (!overlays.length) return false;
  await page.evaluate((items) => {
    const previous = document.getElementById('__octopus_agent_visual_overlay__');
    previous?.remove();
    const root = document.createElement('div');
    root.id = '__octopus_agent_visual_overlay__';
    root.setAttribute('aria-hidden', 'true');
    Object.assign(root.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      fontFamily: 'Arial, sans-serif'
    });
    const colors = ['#ff2d55', '#007aff', '#34c759', '#ff9500', '#af52de', '#00c7be'];
    for (const [index, item] of items.entries()) {
      const color = colors[index % colors.length];
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'absolute',
        left: `${item.box.x}px`,
        top: `${item.box.y}px`,
        width: `${item.box.width}px`,
        height: `${item.box.height}px`,
        border: `4px solid ${color}`,
        boxSizing: 'border-box',
        background: 'rgba(255, 255, 255, 0.08)',
        boxShadow: '0 0 0 99999px rgba(0, 0, 0, 0.02)'
      });
      const label = document.createElement('div');
      label.textContent = item.label;
      Object.assign(label.style, {
        position: 'absolute',
        left: `${item.box.x}px`,
        top: `${Math.max(0, item.box.y - 30)}px`,
        maxWidth: `${Math.max(160, item.box.width)}px`,
        padding: '4px 8px',
        color: '#fff',
        background: color,
        fontSize: '16px',
        lineHeight: '20px',
        fontWeight: '700',
        borderRadius: '4px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)'
      });
      root.appendChild(box);
      root.appendChild(label);
    }
    document.documentElement.appendChild(root);
  }, overlays);
  try {
    await page.screenshot({ path, fullPage: true });
    return true;
  } finally {
    await page.evaluate(() => {
      document.getElementById('__octopus_agent_visual_overlay__')?.remove();
    }).catch(() => undefined);
  }
}

async function captureCandidateScreenshots(
  page: Page,
  basePath: string,
  candidates: DetectedCandidate[]
): Promise<NonNullable<DetectedAgentScreenshot['candidateScreenshots']>> {
  const pageSize = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, window.innerWidth),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, window.innerHeight)
  }));
  const screenshots: NonNullable<DetectedAgentScreenshot['candidateScreenshots']> = [];
  for (const [index, candidate] of candidatesForVisualArtifacts(candidates).entries()) {
    const rawBox = visualBoxForCandidate(candidate);
    const box = rawBox ? expandClip(rawBox, pageSize, 32) : undefined;
    if (!box || box.width < 8 || box.height < 8) continue;
    const path = candidateScreenshotPath(basePath, candidate.id);
    await page.screenshot({ path, clip: box });
    screenshots.push({
      candidateId: candidate.id,
      path,
      boundingBox: box,
      rank: index + 1
    });
  }
  return screenshots;
}

function candidatesForVisualArtifacts(candidates: DetectedCandidate[]): DetectedCandidate[] {
  return candidates
    .filter((candidate) => candidate.type !== 'form')
    .slice()
    .sort((a, b) => (b.goalScore ?? b.confidence) - (a.goalScore ?? a.confidence))
    .slice(0, 3);
}

function visualBoxForCandidate(candidate: DetectedCandidate): DetectedCandidateDiagnostics['boundingBox'] {
  return candidate.diagnostics?.boundingBox;
}

function expandClip(
  box: NonNullable<DetectedCandidateDiagnostics['boundingBox']>,
  pageSize: { width: number; height: number },
  padding: number
): NonNullable<DetectedCandidateDiagnostics['boundingBox']> {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const right = Math.min(pageSize.width, box.x + box.width + padding);
  const bottom = Math.min(pageSize.height, box.y + box.height + padding);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}
