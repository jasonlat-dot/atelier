import Feedback from '../../components/Feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import AdminDialog from '../upstream/AdminDialog';
import type { AdminProps } from '../upstream/upstreamApi';
import {
  billingApi as api,
  billingError,
  dateTime,
  money,
  orderStatus,
  type Order,
  type Plan,
  type PlanInput,
  type RefundQuote,
} from './billingApi';
import '../upstream/AdminUpstream.css';
import './Billing.css';
type Panel =
  { kind: 'plan'; plan?: Plan } | { kind: 'paid' | 'refund'; order: Order };
export default function AdminBillingPage(props: AdminProps) {
  return props.me.user.role === 'USER' ? (
    <main className="page-padding">
      <h1>无权访问</h1>
      <p>此页面需要管理员权限。</p>
    </main>
  ) : (
    <BillingAdmin {...props} />
  );
}
function BillingAdmin(props: AdminProps) {
  const { me, onExpired, onReload } = props;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [tab, setTab] = useState('plans');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState<Panel>();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const [p, o] = await Promise.all([
          api.plans(true, signal),
          api.orders(true, undefined, signal),
        ]);
        if (!signal?.aborted) {
          setPlans(p);
          setOrders(o.items);
          setCursor(o.next_cursor);
          setError('');
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(billingError(e, { me, onExpired, onReload }));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [me, onExpired, onReload],
  );
  useEffect(() => {
    const a = new AbortController();
    void load(a.signal);
    return () => a.abort();
  }, [load]);
  const done = async (text: string) => {
    setPanel(undefined);
    setMessage(text);
    await load();
  };
  return (
    <main className="page-padding up-page billing-admin">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">ATELIER / BILLING</div>
          <h1>套餐与订单</h1>
          <p>先核对真实收付款，再登记到账或退款。每次变更保留审计记录。</p>
        </div>
        <button
          className="btn btn-light"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      <nav className="billing-tabs" aria-label="账务管理">
        <button aria-pressed={tab === 'plans'} onClick={() => setTab('plans')}>
          套餐管理
        </button>
        <button
          aria-pressed={tab === 'orders'}
          onClick={() => setTab('orders')}
        >
          订单管理
        </button>
        <Link to="/admin/credits">兑换码与积分调整</Link>
      </nav>
      {error && (
        <Feedback
          onDismiss={() => setError('')}
          className="up-alert"
          variant="error"
        >
          {error}
        </Feedback>
      )}
      {message && (
        <Feedback
          onDismiss={() => setMessage('')}
          className="billing-success"
          variant="success"
        >
          {message}
        </Feedback>
      )}
      {loading && <p role="status">正在读取账务记录…</p>}
      {tab === 'plans' ? (
        <>
          <div className="billing-heading">
            <p>套餐调整只影响新订单。下架后，历史订单仍按原价格和权益处理。</p>
            <button
              className="btn btn-dark"
              onClick={() => setPanel({ kind: 'plan' })}
            >
              <Plus size={16} />
              新增套餐
            </button>
          </div>
          <div className="billing-plans">
            {plans.map((p) => (
              <article className="billing-plan" key={p.id}>
                <div className="billing-plan-type">
                  {p.details.active ? '已上架' : '已下架'} ·{' '}
                  {p.details.kind === 'PACK' ? '积分包' : '订阅'}
                </div>
                <h3>{p.details.name}</h3>
                <p className="billing-price">
                  {money(p.details.price_cents, p.details.currency)}
                </p>
                <p>
                  {p.details.credits} 积分
                  {p.details.kind === 'MONTHLY'
                    ? ` / ${p.details.period_days} 天`
                    : ''}
                </p>
                {p.details.kind === 'MONTHLY' && (
                  <p>
                    {p.details.max_resolution} · {p.details.concurrency_limit}{' '}
                    并发 · 新素材 {p.details.retention_days} 天<br />
                    {p.details.rollover ? '积分可结转' : '周期积分到期回收'}
                  </p>
                )}
                <button
                  className="btn btn-light"
                  onClick={() => setPanel({ kind: 'plan', plan: p })}
                >
                  编辑套餐
                </button>
              </article>
            ))}
          </div>
          {!loading && plans.length === 0 && (
            <div className="billing-empty">
              <h3>还没有套餐</h3>
              <p>创建并上架后，用户可在「积分与订阅」下单。</p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="billing-orders">
            {orders.map((o) => (
              <article className="billing-order" key={o.id}>
                <div className="billing-order-top">
                  <div>
                    <h3>{o.plan_snapshot.name}</h3>
                    <small>{dateTime(o.created_at)}</small>
                  </div>
                  <span className="billing-status">
                    {orderStatus[o.status] || o.status}
                  </span>
                </div>
                <p className="billing-order-id">
                  订单号：{o.id}
                  <br />
                  用户：{o.user_id}
                </p>
                <div className="billing-order-bottom">
                  <strong>{money(o.amount_cents, o.currency)}</strong>
                  <span>{o.plan_snapshot.credits} 积分</span>
                  {o.status === 'PENDING' && (
                    <button
                      className="btn btn-dark"
                      onClick={() => setPanel({ kind: 'paid', order: o })}
                    >
                      确认到账
                    </button>
                  )}
                  {o.status === 'FULFILLED' && (
                    <button
                      className="btn btn-light"
                      onClick={() => setPanel({ kind: 'refund', order: o })}
                    >
                      办理退款
                    </button>
                  )}
                </div>
                {o.provider_trade_no && (
                  <p className="billing-order-id">
                    收款凭证：{o.provider_trade_no}
                  </p>
                )}
                {o.status === 'REFUNDED' && (
                  <p>
                    登记退款 {money(o.refund_cents, o.currency)} · 回收{' '}
                    {o.recovered_credits} 积分
                  </p>
                )}
              </article>
            ))}
          </div>
          {!loading && orders.length === 0 && (
            <p className="billing-empty">暂无订单</p>
          )}
          {cursor && (
            <button
              className="btn btn-light"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const next = await api.orders(true, cursor);
                  setOrders((a) => [...a, ...next.items]);
                  setCursor(next.next_cursor);
                } catch (e) {
                  setError(billingError(e, props));
                } finally {
                  setLoading(false);
                }
              }}
            >
              加载更多订单
            </button>
          )}
        </>
      )}
      {panel?.kind === 'plan' && (
        <PlanEditor
          {...props}
          plan={panel.plan}
          onClose={() => setPanel(undefined)}
          onDone={done}
        />
      )}
      {panel && panel.kind !== 'plan' && (
        <PaymentDialog
          {...props}
          mode={panel.kind}
          order={panel.order}
          onClose={() => setPanel(undefined)}
          onDone={done}
        />
      )}
    </main>
  );
}
const initial: PlanInput = {
  name: '',
  kind: 'PACK',
  description: '',
  price_cents: 100,
  currency: 'CNY',
  credits: 100,
  period_days: null,
  rollover: true,
  concurrency_limit: 3,
  max_resolution: '4K',
  retention_days: 180,
  active: false,
};
function PlanEditor(
  props: AdminProps & {
    plan?: Plan;
    onClose: () => void;
    onDone: (text: string) => Promise<void>;
  },
) {
  const [p, setP] = useState<PlanInput>(props.plan?.details || initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const patch = (next: Partial<PlanInput>) => setP((a) => ({ ...a, ...next }));
  return (
    <AdminDialog
      title={props.plan ? '编辑套餐' : '新增套餐'}
      busy={busy}
      onClose={props.onClose}
    >
      <form
        className="billing-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (lock.current) return;
          lock.current = true;
          setBusy(true);
          setError('');
          try {
            await api.savePlan(p, props.me.csrf_token, props.plan);
            await props.onDone('套餐已保存');
          } catch (e) {
            setError(billingError(e, props));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <label>
            套餐名称
            <input
              data-initial-focus
              className="input"
              required
              maxLength={80}
              value={p.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <div className="billing-form-grid">
            <label>
              类型
              <select
                aria-label="类型"
                className="input"
                value={p.kind}
                onChange={(e) =>
                  patch({
                    kind: e.target.value,
                    period_days: e.target.value === 'MONTHLY' ? 30 : null,
                  })
                }
              >
                <option value="PACK">一次性积分包</option>
                <option value="MONTHLY">订阅套餐</option>
              </select>
            </label>
            <label>
              币种
              <select
                aria-label="币种"
                className="input"
                value={p.currency}
                onChange={(e) => patch({ currency: e.target.value })}
              >
                <option>CNY</option>
                <option>USD</option>
              </select>
            </label>
            <label>
              价格（分）
              <input
                aria-label="价格（分）"
                className="input"
                type="number"
                min={1}
                max={100000000}
                step={1}
                required
                value={p.price_cents}
                onChange={(e) => patch({ price_cents: Number(e.target.value) })}
              />
              <small>{money(p.price_cents, p.currency)}</small>
            </label>
            <label>
              发放积分
              <input
                className="input"
                type="number"
                min={1}
                max={100000000}
                step={1}
                required
                value={p.credits}
                onChange={(e) => patch({ credits: Number(e.target.value) })}
              />
            </label>
          </div>
          <label>
            套餐说明
            <textarea
              className="input"
              maxLength={2000}
              value={p.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
          {p.kind === 'MONTHLY' && (
            <>
              <div className="billing-form-grid">
                <label>
                  周期天数
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={366}
                    step={1}
                    required
                    value={p.period_days ?? 30}
                    onChange={(e) =>
                      patch({ period_days: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  并发任务数
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={64}
                    step={1}
                    required
                    value={p.concurrency_limit}
                    onChange={(e) =>
                      patch({ concurrency_limit: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  最高分辨率
                  <select
                    className="input"
                    value={p.max_resolution}
                    onChange={(e) => patch({ max_resolution: e.target.value })}
                  >
                    <option>1K</option>
                    <option>2K</option>
                    <option>4K</option>
                  </select>
                </label>
                <label>
                  新素材保留天数
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={3650}
                    step={1}
                    required
                    value={p.retention_days}
                    onChange={(e) =>
                      patch({ retention_days: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <label className="billing-check">
                <input
                  type="checkbox"
                  checked={p.rollover}
                  onChange={(e) => patch({ rollover: e.target.checked })}
                />
                周期未用积分可结转至到期后
              </label>
              <p className="billing-note">
                关闭结转时，仅回收本周期未用积分；任务已预占的部分在释放后回收。订阅每次付款购买一个周期，不会自动扣费。
              </p>
            </>
          )}
          <label className="billing-check">
            <input
              type="checkbox"
              checked={p.active}
              onChange={(e) => patch({ active: e.target.checked })}
            />
            上架，允许用户创建新订单
          </label>
        </fieldset>
        {error && (
          <Feedback
            onDismiss={() => setError('')}
            variant="error"
            className="up-alert"
          >
            {error}
          </Feedback>
        )}
        <div className="billing-actions">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy}
            onClick={props.onClose}
          >
            取消
          </button>
          <button className="btn btn-dark" disabled={busy}>
            {busy ? '正在保存…' : '保存套餐'}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}
function PaymentDialog(
  props: AdminProps & {
    mode: 'paid' | 'refund';
    order: Order;
    onClose: () => void;
    onDone: (text: string) => Promise<void>;
  },
) {
  const { order: o, mode } = props;
  const [quote, setQuote] = useState<RefundQuote>();
  const [reason, setReason] = useState('');
  const [trade, setTrade] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(mode === 'refund');
  const [version, setVersion] = useState(0);
  const pending = useRef<{ body: string; key: string }>();
  const lock = useRef(false);
  const { me, onExpired, onReload } = props;
  useEffect(() => {
    if (mode !== 'refund') return;
    let live = true;
    setLoading(true);
    setQuote(undefined);
    void api
      .refundQuote(o.id)
      .then((q) => {
        if (live) {
          setQuote(q);
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(billingError(e, { me, onExpired, onReload }));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [mode, o.id, version, me, onExpired, onReload]);
  return (
    <AdminDialog
      title={mode === 'paid' ? '确认订单到账' : '登记订单退款'}
      busy={busy}
      onClose={props.onClose}
    >
      <form
        className="billing-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            lock.current ||
            !checked ||
            (mode === 'refund' && (!quote || quote.held_credits > 0))
          )
            return;
          lock.current = true;
          setBusy(true);
          setError('');
          const body =
            mode === 'paid'
              ? {
                  amount_cents: o.amount_cents,
                  currency: o.currency,
                  trade_no: trade.trim(),
                  reason: reason.trim(),
                }
              : {
                  expected_credits: quote!.refundable_credits,
                  confirm_external_refund: true,
                  reason: reason.trim(),
                };
          const fingerprint = JSON.stringify(body);
          if (pending.current?.body !== fingerprint)
            pending.current = { body: fingerprint, key: crypto.randomUUID() };
          try {
            if (mode === 'paid')
              await api.paid(
                o.id,
                body as Parameters<typeof api.paid>[1],
                props.me.csrf_token,
                pending.current.key,
              );
            else
              await api.refund(
                o.id,
                body as Parameters<typeof api.refund>[1],
                props.me.csrf_token,
                pending.current.key,
              );
            await props.onDone(
              mode === 'paid'
                ? '到账已确认，权益已按订单发放或排期'
                : '退款已登记，未用积分与对应订阅权益已回收',
            );
          } catch (e) {
            setError(billingError(e, props));
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <h3>{o.plan_snapshot.name}</h3>
        <p className="billing-order-id">
          订单 {o.id}
          <br />
          用户 {o.user_id}
        </p>
        <p>
          订单金额：<strong>{money(o.amount_cents, o.currency)}</strong> ·{' '}
          {o.plan_snapshot.credits} 积分
        </p>
        {mode === 'paid' ? (
          <>
            <p>
              请核对实际收到的金额、币种和收款凭证。确认后发放订单原始套餐权益，无法取消订单。
            </p>
            <label>
              收款凭证号
              <input
                className="input"
                data-initial-focus
                required
                maxLength={120}
                value={trade}
                disabled={busy}
                onChange={(e) => setTrade(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            {loading && <p role="status">正在核对未用积分…</p>}
            {quote && (
              <div className="billing-refund-quote">
                <p>
                  可退款金额{' '}
                  <strong>{money(quote.refund_cents, o.currency)}</strong>
                </p>
                <p>
                  可退款积分 {quote.refundable_credits} · 任务预占{' '}
                  {quote.held_credits}
                </p>
                <small>
                  按订单未消费积分比例计算，金额向下取整至分。已消费积分不退款；退订后对应周期的权益结束。
                </small>
              </div>
            )}
            {quote && quote.held_credits > 0 && (
              <Feedback variant="error" className="up-alert">
                请等待该用户的生成任务结束或取消任务，解除预占后再退款。
              </Feedback>
            )}
            <button
              className="text-action"
              type="button"
              disabled={busy || loading}
              onClick={() => {
                setChecked(false);
                setVersion((v) => v + 1);
              }}
            >
              重新核对可退金额
            </button>
            <p>此操作登记已完成的线下退款，不会自动向银行卡或支付账户转账。</p>
          </>
        )}
        <label>
          处理说明
          <textarea
            className="input"
            required
            maxLength={1500}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="billing-check">
          <input
            type="checkbox"
            checked={checked}
            disabled={busy || loading}
            onChange={(e) => setChecked(e.target.checked)}
          />
          {mode === 'paid'
            ? `我已核实收到 ${money(o.amount_cents, o.currency)}，币种和凭证与订单一致`
            : `我已完成上方金额的线下退款，同意回收未用积分并结束对应周期权益`}
        </label>
        {error && (
          <Feedback
            onDismiss={() => setError('')}
            variant="error"
            className="up-alert"
          >
            {error}
          </Feedback>
        )}
        <div className="billing-actions">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy}
            onClick={props.onClose}
          >
            返回
          </button>
          <button
            className="btn btn-dark"
            disabled={
              busy ||
              loading ||
              !checked ||
              !reason.trim() ||
              (mode === 'paid'
                ? !trade.trim()
                : !quote || quote.held_credits > 0)
            }
          >
            {busy
              ? '正在处理…'
              : mode === 'paid'
                ? '确认到账并发放权益'
                : '登记退款并回收权益'}
          </button>
        </div>
      </form>
    </AdminDialog>
  );
}
