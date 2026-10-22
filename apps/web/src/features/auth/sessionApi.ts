import type { components } from '../../lib/generated/api';
export type Me = components['schemas']['MeResponse'];
export type Device = components['schemas']['DeviceSession'];

export class SessionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  method = 'GET',
  csrf?: string,
  body?: unknown,
  signal?: AbortSignal,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new SessionError(
      response.status,
      data?.error?.code || 'UNKNOWN',
      data?.error?.message || '请求未成功，请稍后重试',
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export const sessionApi = {
  publicConfig: (signal?: AbortSignal) =>
    request<components['schemas']['PublicConfig']>(
      '/public/config',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  mfaSetup: (csrf: string) =>
    request<components['schemas']['MfaSetup']>(
      '/admin/mfa/setup',
      'POST',
      csrf,
    ),
  mfaVerify: (code: string, csrf: string) =>
    request<void>('/admin/mfa/verify', 'POST', csrf, { code }),
  me: (signal?: AbortSignal) =>
    request<Me>('/me', 'GET', undefined, undefined, signal),
  rename: (name: string, csrf: string) =>
    request<Me>('/me', 'PATCH', csrf, { display_name: name }),
  devices: (signal?: AbortSignal) =>
    request<components['schemas']['DeviceList']>(
      '/me/sessions',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  revoke: (id: string, csrf: string) =>
    request<void>(`/me/sessions/${encodeURIComponent(id)}`, 'DELETE', csrf),
  logout: (csrf: string) => request<void>('/auth/logout', 'POST', csrf),
};
