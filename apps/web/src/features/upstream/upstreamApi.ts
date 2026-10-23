import type { components } from '../../lib/generated/api';
import { request, SessionError, type Me } from '../auth/sessionApi';
export type Schema = components['schemas'];
export type Account = Schema['AccountView'];
export type Model = Schema['ModelView'];
export type Pricing = Schema['Pricing'];
export type AdminProps = {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
};
const accountPath = (id: string) =>
  `/admin/upstream-accounts/${encodeURIComponent(id)}`;
export const upstreamApi = {
  accounts: (search = '', before?: string, signal?: AbortSignal) =>
    request<Schema['AccountPage']>(
      `/admin/upstream-accounts?${new URLSearchParams({ search, ...(before ? { before } : {}) })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  saveAccount: (body: Schema['AccountInput'], csrf: string, id?: string) =>
    request<Account>(
      id ? accountPath(id) : '/admin/upstream-accounts',
      id ? 'PATCH' : 'POST',
      csrf,
      body,
    ),
  deleteAccount: (a: Account, csrf: string) =>
    request<void>(
      `${accountPath(a.id)}?revision=${a.revision}`,
      'DELETE',
      csrf,
    ),
  importAccounts: (body: Schema['AccountInput'][], csrf: string) =>
    request<Account[]>('/admin/upstream-accounts/import', 'POST', csrf, body),
  probe: (id: string, csrf: string) =>
    request<Schema['ProbeResult']>(`${accountPath(id)}/test`, 'POST', csrf),
  quota: (id: string, body: Schema['QuotaInput'], csrf: string) =>
    request<Account>(`${accountPath(id)}/refresh-quota`, 'POST', csrf, body),
  stats: (id: string, signal?: AbortSignal) =>
    request<Schema['AccountStats']>(
      `${accountPath(id)}/stats`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  models: (signal?: AbortSignal) =>
    request<Model[]>('/admin/models', 'GET', undefined, undefined, signal),
  saveModel: (body: Schema['ModelInput'], csrf: string, edit: boolean) =>
    request<Model>('/admin/models', edit ? 'PATCH' : 'POST', csrf, body),
  bind: (id: string, body: Schema['BindingInput'], csrf: string) =>
    request<Model>(
      `/admin/models/${encodeURIComponent(id)}/accounts`,
      'PUT',
      csrf,
      body,
    ),
  pricing: (signal?: AbortSignal) =>
    request<Pricing>('/admin/pricing', 'GET', undefined, undefined, signal),
  savePricing: (body: Pricing, csrf: string) =>
    request<Pricing>('/admin/pricing', 'PUT', csrf, body),
};
export function errorText(error: unknown, props: AdminProps): string {
  if (error instanceof SessionError) {
    if (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
      props.onExpired();
    if (error.code === 'MFA_REQUIRED') props.onReload();
    if (error.code === 'UPSTREAM_ADDRESS_REJECTED')
      return '接口地址未通过校验，请使用公网 HTTP 或 HTTPS 地址，不要在地址中填写用户名、密码、查询参数或锚点。';
    if (error.status === 409)
      return '配置已变更或账号仍有请求处理中，请关闭后刷新，再重试。';
    if (error.status === 422)
      return '配置未通过校验，请检查必填项、数值范围、账号绑定及价格。';
    if (error.status === 429) return '操作过于频繁，请稍后重试。';
    if (error.status === 403)
      return '权限或安全验证已失效，请刷新页面重新验证。';
  }
  return '服务暂不可用。操作结果可能尚未同步，请刷新确认后重试。';
}
export const failureNames: Record<string, string> = {
  ACCOUNT_INVALID: '凭据无效，请更新密钥后测试',
  RATE_LIMITED: '请求受限或额度耗尽',
  UPSTREAM_ERROR: '上游异常或连接超时',
  CONTENT_POLICY: '内容被拒绝',
  BAD_REQUEST: '请求参数不受支持',
  CANCELLED: '请求已取消',
};
export function accountInput(a: Account): Schema['AccountInput'] {
  return {
    name: a.name,
    group_tag: a.group_tag,
    priority: a.priority,
    weight: a.weight,
    concurrency_limit: a.concurrency_limit,
    quota_total: a.quota_total,
    quota_remaining: a.quota_remaining,
    quota_reset_at: a.quota_reset_at,
    enabled: a.status !== 'DISABLED',
    revision: a.revision,
  };
}
export function modelInput(m: Model): Schema['ModelInput'] {
  return {
    id: m.id,
    kind: m.kind,
    display_name: m.display_name,
    enabled: m.enabled,
    capabilities: m.capabilities,
    sort_order: m.sort_order,
    revision: m.revision,
  };
}
