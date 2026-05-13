import type { AccountInfo, QuantityLimitSettings } from './api-client.js';

export enum OPAccountType {
  None = 0,
  Free = 1,
  Standard = 2,
  Professional = 3,
  PrivateCloud = 4,
  Basic = 9,
  UltimatePlus = 31,
  BusinessMember = 140
}

export interface LocalRunPolicy {
  accountLevel: number;
  maxActiveLocalRuns?: number | null;
}

export function resolveOPLocalRunPolicy(account: AccountInfo, limits: QuantityLimitSettings): LocalRunPolicy {
  const accountLevel = effectiveOPAccountLevel(account);
  return {
    accountLevel,
    maxActiveLocalRuns: maxActiveLocalRunsForOPLevel(accountLevel, limits)
  };
}

function effectiveOPAccountLevel(account: AccountInfo): number {
  if (account.isFreeAccount || isExpired(account.effectiveDate)) return OPAccountType.Free;
  return account.type ?? account.currentAccountLevel ?? OPAccountType.None;
}

function maxActiveLocalRunsForOPLevel(accountLevel: number, limits: QuantityLimitSettings): number | null | undefined {
  const localRunLimit = limits.localRunLimit;
  if (!localRunLimit || typeof localRunLimit !== 'object') return undefined;

  if (accountLevel === OPAccountType.Free || accountLevel === OPAccountType.None) {
    return normalizeLimit(localRunLimit.freeCount);
  }
  if (accountLevel === OPAccountType.Standard) {
    return normalizeLimit(localRunLimit.professionCount);
  }
  if (accountLevel === OPAccountType.Professional) {
    return normalizeLimit(localRunLimit.ultimateCount);
  }
  if (accountLevel === OPAccountType.Basic) {
    return normalizeLimit(localRunLimit.basicCount);
  }
  if (accountLevel === OPAccountType.UltimatePlus) {
    return normalizeLimit(localRunLimit.ultimatePlusCount);
  }
  if (accountLevel === OPAccountType.PrivateCloud) {
    return normalizeLimit(localRunLimit.maxCount);
  }
  if (accountLevel === OPAccountType.BusinessMember) {
    return normalizeLimit(localRunLimit.businessMember ?? localRunLimit.maxCount);
  }

  return undefined;
}

function normalizeLimit(value: unknown): number | null | undefined {
  const limit = numberValue(value);
  if (limit === undefined) return undefined;
  return limit < 0 ? null : limit;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isExpired(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const effectiveDate = new Date(value);
  return effectiveDate.getFullYear() > 2000 && effectiveDate.getTime() < Date.now();
}
