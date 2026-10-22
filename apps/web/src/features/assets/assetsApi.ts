import type { components } from '../../lib/generated/api';
import { request } from '../auth/sessionApi';
export type Asset = components['schemas']['AssetView'];
export type AssetPage = components['schemas']['AssetPage'];
export type AssetLimits = components['schemas']['AssetLimits'];
export type Filters = { kind: string; source: string; search: string };
export const assetsApi = {
  limits: (signal?: AbortSignal) =>
    request<AssetLimits>('/assets/limits', 'GET', undefined, undefined, signal),
  list: (filters: Filters, before?: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ limit: '24' });
    for (const [key, value] of Object.entries(filters))
      if (value) query.set(key, value);
    if (before) query.set('before', before);
    return request<AssetPage>(
      `/assets?${query}`,
      'GET',
      undefined,
      undefined,
      signal,
    );
  },
  get: (id: string, signal?: AbortSignal) =>
    request<Asset>(
      `/assets/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  upload: (file: File, csrf: string, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', file);
    return request<Asset>('/assets/uploads', 'POST', csrf, form, signal);
  },
  delete: (ids: string[], csrf: string) =>
    request<void>('/assets', 'DELETE', csrf, { ids }),
};
