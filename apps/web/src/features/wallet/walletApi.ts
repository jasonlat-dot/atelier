import type { components } from '../../lib/generated/api';
import { request } from '../auth/sessionApi';
export type Summary = components['schemas']['WalletSummary'];
export type Entry = components['schemas']['LedgerEntry'];
export type CodeInfo = components['schemas']['CodeInfo'];
export type CreateCodesInput = components['schemas']['CreateCodesRequest'];
export type CreatedCodes = components['schemas']['CreatedCodes'];
export const walletApi = {
  adjustments: (signal?: AbortSignal) =>
    request<components['schemas']['CreditAdjustment'][]>(
      '/admin/credits/adjustments',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  copyCode: (id: string, csrf: string) =>
    request<components['schemas']['CreatedCode']>(
      `/admin/redeem-codes/${encodeURIComponent(id)}/copy`,
      'POST',
      csrf,
    ),
  codes: (before?: string, signal?: AbortSignal) =>
    request<CodeInfo[]>(
      `/admin/redeem-codes${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  createCodes: (body: CreateCodesInput, csrf: string) =>
    request<CreatedCodes>('/admin/redeem-codes', 'POST', csrf, body),
  usage: (signal?: AbortSignal) =>
    request<components['schemas']['UsageView']>(
      '/me/usage?days=7',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  summary: (signal?: AbortSignal) =>
    request<Summary>('/wallet', 'GET', undefined, undefined, signal),
  ledger: (before?: number, signal?: AbortSignal) =>
    request<components['schemas']['LedgerPage']>(
      `/wallet/ledger${before ? `?before=${before}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  checkin: (csrf: string) =>
    request<components['schemas']['CheckinReceipt']>(
      '/wallet/checkin',
      'POST',
      csrf,
    ),
  redeem: (code: string, csrf: string, key: string) =>
    request<components['schemas']['CreditReceipt']>(
      '/wallet/redeem',
      'POST',
      csrf,
      { code },
      undefined,
      key,
    ),
  adjust: (
    owner: string,
    amount: number,
    reason: string,
    csrf: string,
    key: string,
  ) =>
    request<components['schemas']['CreditReceipt']>(
      `/admin/users/${encodeURIComponent(owner)}/credits`,
      'POST',
      csrf,
      { amount, reason },
      undefined,
      key,
    ),
};
