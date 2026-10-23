import type { components } from '../../lib/generated/api';
import { request } from '../auth/sessionApi';
export type Summary = components['schemas']['WalletSummary'];
export type Entry = components['schemas']['LedgerEntry'];
export const walletApi = {
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
