import type { TaskDefinition } from '../types.js';
import {
  ApiRequestError,
  fetchAccountBalance,
  fetchCaptchaRemain,
  fetchProxyBalance,
  fetchTemplateBillingInfo
} from './api-client.js';
import { resolveAuth } from './auth.js';

const PROXY_BALANCE_WARNING_THRESHOLD = 10;
const CAPTCHA_BALANCE_WARNING_THRESHOLD = 5;
const PROXY_TYPE_STRONG = 1;
const WORKFLOW_TYPE_TEMPLATE = 10;

export interface BillingWarning {
  code: 'TEMPLATE_BALANCE_LOW' | 'PROXY_BALANCE_LOW' | 'CAPTCHA_BALANCE_LOW';
  severity: 'warning';
  message: string;
  balance?: number;
  balanceLowThreshold?: number;
  chargingGranularity?: number;
  captchaRemain?: number;
}

export class BillingPreflightError extends Error {
  constructor(
    readonly code: 'TEMPLATE_BALANCE_NOT_ENOUGH' | 'TEMPLATE_NOT_ALLOWED' | 'PROXY_BALANCE_NOT_ENOUGH',
    message: string,
    readonly data: {
      balance?: number;
      balanceLowThreshold?: number;
      chargingGranularity?: number;
      canUse?: boolean;
    }
  ) {
    super(message);
    this.name = 'BillingPreflightError';
  }
}

export async function checkTemplateBillingPreflight(task: TaskDefinition): Promise<BillingWarning[]> {
  if (!taskUsesPaidTemplate(task)) return [];

  const auth = await resolveAuth();
  if (!auth.credential) return [];

  let result: Awaited<ReturnType<typeof fetchTemplateBillingInfo>>;
  try {
    result = await fetchTemplateBillingInfo({ auth: auth.credential, taskId: task.taskId });
  } catch (error) {
    if (isOptionalTemplateBillingFailure(error)) return [];
    throw error;
  }

  const info = result.data;
  const data = {
    balance: info.balance,
    balanceLowThreshold: info.balanceLowThreshold,
    chargingGranularity: info.chargingGranularity,
    canUse: info.canUse
  };

  if (!info.canUse) {
    throw new BillingPreflightError(
      'TEMPLATE_NOT_ALLOWED',
      'This account is not allowed to run this paid template. Check template permissions or account entitlements.',
      data
    );
  }

  if (info.chargingGranularity > 0 && info.balance < info.chargingGranularity) {
    throw new BillingPreflightError(
      'TEMPLATE_BALANCE_NOT_ENOUGH',
      `Paid template balance is too low. Current balance ${info.balance}; minimum start balance ${info.chargingGranularity}. Please top up and try again.`,
      data
    );
  }

  if (info.balanceLowThreshold > 0 && info.balance < info.balanceLowThreshold) {
    return [{
      code: 'TEMPLATE_BALANCE_LOW',
      severity: 'warning',
      message: `Paid template balance is low. Current balance ${info.balance}; low-balance threshold ${info.balanceLowThreshold}. The run may stop if balance is insufficient during extraction.`,
      balance: info.balance,
      balanceLowThreshold: info.balanceLowThreshold,
      chargingGranularity: info.chargingGranularity
    }];
  }

  return [];
}

export async function checkPaidCapabilityPreflight(task: TaskDefinition): Promise<BillingWarning[]> {
  const auth = await resolveAuth();
  if (!auth.credential) return [];

  const warnings: BillingWarning[] = [];

  if (taskUsesStrongProxy(task)) {
    const proxyBalanceResult = await fetchProxyBalance({ auth: auth.credential }).catch(() => undefined);
    const balance = proxyBalanceResult?.totalBalance ?? proxyBalanceResult?.balance;

    if (balance !== undefined && balance < PROXY_BALANCE_WARNING_THRESHOLD) {
      warnings.push({
        code: 'PROXY_BALANCE_LOW',
        severity: 'warning',
        message: `Premium proxy balance is low. Current balance ${balance}; low-balance threshold ${PROXY_BALANCE_WARNING_THRESHOLD}. Proxy requests may fail during extraction.`,
        balance,
        balanceLowThreshold: PROXY_BALANCE_WARNING_THRESHOLD
      });
    }
  }

  if (taskUsesCaptcha(task)) {
    const [accountBalanceResult, captchaRemainResult] = await Promise.allSettled([
      fetchAccountBalance({ auth: auth.credential }),
      fetchCaptchaRemain({ auth: auth.credential })
    ]);
    const balance = accountBalanceResult.status === 'fulfilled'
      ? accountBalanceResult.value.totalBalance ?? accountBalanceResult.value.balance
      : undefined;
    const captchaRemain = captchaRemainResult.status === 'fulfilled'
      ? captchaRemainResult.value.remain
      : undefined;

    if (
      balance !== undefined &&
      captchaRemain !== undefined &&
      balance < CAPTCHA_BALANCE_WARNING_THRESHOLD &&
      captchaRemain <= 0
    ) {
      warnings.push({
        code: 'CAPTCHA_BALANCE_LOW',
        severity: 'warning',
        message: `CAPTCHA balance may be insufficient. Current account balance ${balance}; CAPTCHA remaining quota ${captchaRemain}. Automatic CAPTCHA solving may fail during extraction.`,
        balance,
        balanceLowThreshold: CAPTCHA_BALANCE_WARNING_THRESHOLD,
        captchaRemain
      });
    }
  }

  return warnings;
}

function isOptionalTemplateBillingFailure(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.status === 404 || error.code === 'TASK_NOT_FOUND' || error.code === 'API_ERROR';
}

function taskUsesPaidTemplate(task: TaskDefinition): boolean {
  if (!taskUsesTemplate(task)) return false;
  const template = getRecord(task.template);
  const permission = getRecord(template?.permission);
  const allowCrossAccountLevelPricing = booleanValue(permission?.allowCrossAccountLevelPricing ?? template?.allowCrossAccountLevelPricing);
  const pricePerData = numberValue(template?.pricePerData);
  const prices = getRecord(template?.prices);
  return allowCrossAccountLevelPricing || (pricePerData !== undefined && pricePerData > 0) || hasPositivePrice(prices);
}

function taskUsesTemplate(task: TaskDefinition): boolean {
  return task.isTemplate === true ||
    numberValue(task.workFlowType) === WORKFLOW_TYPE_TEMPLATE ||
    Boolean(task.templateVersionId) ||
    Boolean(task.template);
}

function taskUsesStrongProxy(task: TaskDefinition): boolean {
  const settings = getRecord(getRecord(task.brokerSettings)?.ipProxySettings);
  return numberValue(settings?.ipProxyFromType) === PROXY_TYPE_STRONG &&
    (taskHasSwitchIpAction(task.xml) || taskHasSwitchIpAction(task.xoml));
}

function taskUsesCaptcha(task: TaskDefinition): boolean {
  const captchaSettings = getRecord(getRecord(task.brokerSettings)?.captchaSettings);
  if (captchaSettings?.isAutoCloudflare === true) return true;
  return /EnterCapachaAction|CapachaType|CaptchaType|Cloudflare|Turnstile|reCAPTCHA|HCaptcha/i.test(`${task.xml}\n${task.xoml}`);
}

function taskHasSwitchIpAction(xml: string): boolean {
  return /EnableSwitchIp=(["'])true\1/i.test(xml);
}

function hasPositivePrice(prices: Record<string, unknown> | undefined): boolean {
  if (!prices) return false;
  return Object.values(prices).some((value) => {
    const price = numberValue(value);
    return price !== undefined && price > 0;
  });
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}
