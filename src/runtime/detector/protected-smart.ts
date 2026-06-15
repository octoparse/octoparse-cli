import type { Page } from 'puppeteer-core';
import type { DetectedCandidate } from './types.js';
import { runProtectedSmartDetection, type SmartRawResult } from './protected-smart-provider.js';
import { protectedSmartResultToCandidates } from './protected-smart-normalizer.js';

export function protectedSmartRequested(): boolean {
  return process.env.OCTOPARSE_LEGACY_DETECTOR !== '1';
}

export async function detectProtectedSmartCandidates(page: Page, options: { maxCandidates: number; baseUrl?: string }): Promise<DetectedCandidate[]> {
  const result = await runProtectedSmartDetection(page, { baseUrl: options.baseUrl });
  return protectedSmartResultToCandidates(result, options.maxCandidates);
}

export function protectedSmartResultToCandidatesForTesting(result: SmartRawResult, maxCandidates: number): DetectedCandidate[] {
  return protectedSmartResultToCandidates(result, maxCandidates);
}
