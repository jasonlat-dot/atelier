import type { components } from '../../lib/generated/api';
import { request, SessionError } from '../auth/sessionApi';
export type AdminSchema = components['schemas'];
export type User = AdminSchema['AdminUser'];
export type Job = AdminSchema['AdminJob'];
export type Rule = AdminSchema['AdminRule'];
export type Invite = AdminSchema['AdminInvite'];
export type Settings = AdminSchema['AdminSettings'];
export const integer = (v: number) => v.toLocaleString('zh-CN');
export const when = (v?: string | null) =>
  v ? new Date(v).toLocaleString('zh-CN') : '—';
export const roles: Record<string, string> = {
  USER: '普通用户',
  ADMIN: '管理员',
  SUPER_ADMIN: '超级管理员',
};
export const statuses: Record<string, string> = {
  ACTIVE: '正常',
  DISABLED: '已禁用',
  QUEUED: '排队中',
  ROUTING: '正在分配',
  RUNNING: '生成中',
  STORING: '正在保存',
  SUCCEEDED: '已完成',
  PARTIAL: '部分完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  COOLDOWN: '冷却中',
  QUOTA_EXHAUSTED: '额度耗尽',
  INVALID: '凭据失效',
};
function params(value: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(value))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return `?${p}`;
}
const userPath = (id: string) => `/admin/users/${encodeURIComponent(id)}`;
export const adminApi = {
  dashboard: (days: number, signal?: AbortSignal) =>
    request<AdminSchema['AdminDashboard']>(
      `/admin/dashboard?days=${days}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  usage: (days: number, signal?: AbortSignal) =>
    request<AdminSchema['UsageView']>(
      `/me/usage?days=${days}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  users: (
    q: string,
    status: string,
    role: string,
    before?: string,
    signal?: AbortSignal,
  ) =>
    request<AdminSchema['AdminUserPage']>(
      `/admin/users${params({ q, status, role, before })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  user: (id: string, signal?: AbortSignal) =>
    request<AdminSchema['AdminUserDetail']>(
      userPath(id),
      'GET',
      undefined,
      undefined,
      signal,
    ),
  ledger: (id: string, before: number) =>
    request<AdminSchema['LedgerPage']>(
      `${userPath(id)}/ledger?before=${before}`,
    ),
  userAction: (
    id: string,
    action: string,
    body: AdminSchema['AdminUserAction'],
    csrf: string,
  ) => request<User>(`${userPath(id)}/${action}`, 'POST', csrf, body),
  credits: (
    id: string,
    amount: number,
    reason: string,
    csrf: string,
    key: string,
  ) =>
    request<AdminSchema['CreditReceipt']>(
      `${userPath(id)}/credits`,
      'POST',
      csrf,
      { amount, reason },
      undefined,
      key,
    ),
  jobs: (
    q: string,
    status: string,
    owner?: string,
    before?: string,
    signal?: AbortSignal,
  ) =>
    request<AdminSchema['AdminJobPage']>(
      `/admin/jobs${params({ q, status, user_id: owner, before })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  jobAction: (
    id: string,
    action: string,
    body: AdminSchema['AdminJobAction'],
    csrf: string,
    key: string,
  ) =>
    request<Job>(
      `/admin/jobs/${encodeURIComponent(id)}/${action}`,
      'POST',
      csrf,
      body,
      undefined,
      key,
    ),
  settings: (signal?: AbortSignal) =>
    request<Settings>('/admin/settings', 'GET', undefined, undefined, signal),
  saveSettings: (body: AdminSchema['AdminSettingsUpdate'], csrf: string) =>
    request<Settings>('/admin/settings', 'PUT', csrf, body),
  rules: (q: string, before?: number, signal?: AbortSignal) =>
    request<AdminSchema['AdminRulePage']>(
      `/admin/moderation-rules${params({ q, before })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  saveRule: (body: AdminSchema['AdminRuleInput'], csrf: string, id?: number) =>
    request<Rule>(
      `/admin/moderation-rules${id ? `/${id}` : ''}`,
      id ? 'PATCH' : 'POST',
      csrf,
      body,
    ),
  deleteRule: (
    id: number,
    body: AdminSchema['AdminRevisionReason'],
    csrf: string,
  ) => request<void>(`/admin/moderation-rules/${id}`, 'DELETE', csrf, body),
  invites: (q: string, before?: string, signal?: AbortSignal) =>
    request<AdminSchema['AdminInvitePage']>(
      `/admin/invite-codes${params({ q, before })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  createInvite: (body: AdminSchema['AdminInviteInput'], csrf: string) =>
    request<AdminSchema['AdminInviteCreated']>(
      '/admin/invite-codes',
      'POST',
      csrf,
      body,
    ),
  updateInvite: (
    id: string,
    body: AdminSchema['AdminInviteUpdate'],
    csrf: string,
  ) =>
    request<Invite>(
      `/admin/invite-codes/${encodeURIComponent(id)}`,
      'PATCH',
      csrf,
      body,
    ),
  revokeInvite: (
    id: string,
    body: AdminSchema['AdminRevisionReason'],
    csrf: string,
  ) =>
    request<Invite>(
      `/admin/invite-codes/${encodeURIComponent(id)}`,
      'DELETE',
      csrf,
      body,
    ),
  audit: (q: string, before?: number, signal?: AbortSignal) =>
    request<AdminSchema['AdminAuditPage']>(
      `/admin/audit${params({ q, before })}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
};
export function adminError(e: unknown): string {
  if (e instanceof SessionError) {
    const messages: Record<string, string> = {
      ADMIN_CONFLICT: '记录已变化，请关闭弹窗并刷新，再核对后操作。',
      LAST_SUPER_ADMIN:
        '必须保留至少一个有效的超级管理员，不能禁用或降权最后一个账号。',
      FORBIDDEN: '没有操作权限，或安全验证已失效。请刷新后核对。',
      VALIDATION: '请检查必填项、数值范围、正则表达式和有效期。',
      INSUFFICIENT_CREDITS: '可用积分不足，不能扣减任务正在预占的部分。',
      IDEMPOTENCY_CONFLICT: '请求内容已变化，请刷新并核对记录后重新操作。',
      NOT_FOUND: '记录不存在或已移除。',
      TOO_MANY_REQUESTS: '操作过于频繁，请稍后再试。',
    };
    if (messages[e.code]) return messages[e.code];
  }
  return '服务暂时不可用，操作结果尚未确认。请刷新核对后再重试。';
}
