import type { components } from '../../lib/generated/api';
import { request, SessionError } from '../auth/sessionApi';
import type { AdminProps } from '../upstream/upstreamApi';
type S = components['schemas'];
export type Plan = S['PlanView'];
export type PlanInput = S['PlanInput'];
export type Order = S['OrderView'];
export type Entitlements = S['Entitlements'];
export type RefundQuote = S['RefundQuote'];
const orderPath = (id: string) => `/admin/orders/${encodeURIComponent(id)}`;
export const billingApi = {
  plans: (admin = false, signal?: AbortSignal) =>
    request<Plan[]>(
      `${admin ? '/admin' : ''}/plans`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  subscription: (signal?: AbortSignal) =>
    request<Entitlements>('/subscription', 'GET', undefined, undefined, signal),
  orders: (admin = false, before?: string, signal?: AbortSignal) =>
    request<S['OrderPage']>(
      `${admin ? '/admin' : ''}/orders${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  create: (p: Plan, csrf: string, key: string) =>
    request<S['Checkout']>(
      '/orders',
      'POST',
      csrf,
      { plan_id: p.id, plan_revision: p.revision },
      undefined,
      key,
    ),
  cancel: (id: string, csrf: string) =>
    request<Order>(`/orders/${encodeURIComponent(id)}/cancel`, 'POST', csrf),
  savePlan: (details: PlanInput, csrf: string, old?: Plan) =>
    request<Plan>(
      old ? `/admin/plans/${encodeURIComponent(old.id)}` : '/admin/plans',
      old ? 'PATCH' : 'POST',
      csrf,
      old ? { revision: old.revision, details } : details,
    ),
  paid: (id: string, body: S['PaidInput'], csrf: string, key: string) =>
    request<Order>(
      `${orderPath(id)}/mark-paid`,
      'POST',
      csrf,
      body,
      undefined,
      key,
    ),
  refundQuote: (id: string) =>
    request<RefundQuote>(`${orderPath(id)}/refund-quote`),
  refund: (id: string, body: S['RefundInput'], csrf: string, key: string) =>
    request<Order>(
      `${orderPath(id)}/refund`,
      'POST',
      csrf,
      body,
      undefined,
      key,
    ),
};
export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(
    cents / 100,
  );
export const orderStatus: Record<string, string> = {
  PENDING: '待付款',
  PAID: '已到账',
  FULFILLED: '已发放',
  CANCELLED: '已取消',
  REFUNDED: '已退款',
};
export const dateTime = (v: string) => new Date(v).toLocaleString('zh-CN');
export function billingError(e: unknown, props: AdminProps) {
  if (e instanceof SessionError) {
    if (e.status === 401 || e.code === 'ACCOUNT_DISABLED') props.onExpired();
    if (e.code === 'MFA_REQUIRED') props.onReload();
    const errors: Record<string, string> = {
      BILLING_CONFLICT: '套餐、订单或可退款积分已变化，请刷新后重试。',
      PAYMENT_MISMATCH: '到账金额或币种与订单不一致，请重新核对。',
      DUPLICATE_TRADE: '这个收款凭证已用于其他订单，请核对凭证。',
      ORDER_CREDITS_HELD:
        '该用户还有任务预占积分，请等待任务结束或取消后再退款。',
      IDEMPOTENCY_CONFLICT: '请求内容已变化，请关闭后刷新订单再操作。',
      VALIDATION: '请检查必填项和数值范围。',
      FORBIDDEN: '安全验证已失效，请刷新后重新验证。',
      NOT_FOUND: '记录不存在或不属于当前账号。',
    };
    if (errors[e.code]) return errors[e.code];
  }
  return '暂时无法确认操作结果，请刷新订单核对；重试会沿用同一请求，避免重复处理。';
}
