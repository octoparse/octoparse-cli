import type { AccountInfo } from './api-client.js';

export enum CNAccountType {
  None = 0,
  Free = 1,
  Professional = 2,
  Ultimate = 3,
  PrivateCloud = 4,
  UltimatePlus = 31,
  Personal = 110,
  Group = 120,
  Business = 130,
  BusinessMember = 140
}

export interface LocalRunPolicy {
  accountLevel: number;
  maxActiveLocalRuns?: number | null;
}

export function resolveCNLocalRunPolicy(account: AccountInfo): LocalRunPolicy {
  const accountLevel = account.currentAccountLevel ?? account.type ?? CNAccountType.None;

  return {
    accountLevel,
    maxActiveLocalRuns: maxActiveLocalRunsForCNLevel(accountLevel)
  };
}

function maxActiveLocalRunsForCNLevel(accountLevel: number): number | null | undefined {
  if (accountLevel === CNAccountType.Free) return 2;
  if (accountLevel === CNAccountType.Personal) return 3;
  if ([
    CNAccountType.Group,
    CNAccountType.Business,
    CNAccountType.BusinessMember,
    CNAccountType.PrivateCloud
  ].includes(accountLevel)) {
    return null;
  }

  return undefined;
}
