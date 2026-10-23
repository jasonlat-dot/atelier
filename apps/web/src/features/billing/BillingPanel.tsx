import Feedback from '../../components/Feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Package, RefreshCw } from 'lucide-react';
import AdminDialog from '../upstream/AdminDialog';
import type { AdminProps } from '../upstream/upstreamApi';
import {
  billingApi as api,
  billingError,
  dateTime,
  money,
  orderStatus,
  type Entitlements,
  type Order,
  type Plan,
} from './billingApi';
import '../upstream/AdminUpstream.css';
import './Billing.css';

export default function BillingPanel(
  props: AdminProps & {
    mode: 'plans' | 'orders';
    onWalletChanged: () => void;
    onOrders: () => void;
  },
) {
  const { me, onExpired, onReload, mode } = props;
  const [plans, setPlans] = useState<Plan[]>([]);
  const [tier, setTier] = useState<Entitlements>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [buy, setBuy] = useState<Plan>();
  const [cancel, setCancel] = useState<Order>();
  const pending = useRef<{ id: string; key: string }>();
  const lock = useRef(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const t = await api.subscription(signal);
        const [p, o] = await Promise.all([
          api.plans(false, signal),
          api.orders(false, undefined, signal),
        ]);
        if (!signal?.aborted) {
          setTier(t);
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
  async function act(work: () => Promise<string>, refresh = true) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setMessage(await work());
      setBuy(undefined);
      setCancel(undefined);
      pending.current = undefined;
      if (refresh) {
        await load();
        props.onWalletChanged();
      }
    } catch (e) {
      setError(billingError(e, props));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="billing-panel"
      aria-label={mode === 'plans' ? '套餐与订阅' : '我的订单'}
    >
      <div className="billing-heading">
        <div>
          <h2>{mode === 'plans' ? '选择适合你的创作额度' : '我的订单'}</h2>
          <p>人工确认到账后生效。订阅按已付款周期使用，不会自动扣费。</p>
        </div>
        <button
          className="btn btn-light"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          刷新订单与权益
        </button>
      </div>
      {tier && (
        <section className="billing-entitlements" aria-label="当前订阅权益">
          <div>
            <small>当前方案</small>
            <h3>{tier.plan_name || '免费账户'}</h3>
            <p>
              {tier.current_period_end
                ? `本周期至 ${dateTime(tier.current_period_end)}`
                : '可随时购买积分包或订阅套餐'}
            </p>
          </div>
          <ul>
            <li>最高 {tier.max_resolution} 分辨率</li>
            <li>最多 {tier.max_active_jobs} 个生成任务同时进行</li>
            <li>新上传素材保留 {tier.retention_days} 天</li>
            {tier.scheduled_periods > 0 && (
              <li>已有 {tier.scheduled_periods} 个已付款周期等待开始</li>
            )}
          </ul>
        </section>
      )}
      {loading && !tier && <p role="status">正在读取套餐和订单…</p>}
      {message && (
        <Feedback
          onDismiss={() => setMessage('')}
          className="billing-success"
          variant="success"
        >
          {message}
          {mode === 'plans' && message.startsWith('订单已创建') && (
            <button className="text-action" onClick={props.onOrders}>
              查看新订单 →
            </button>
          )}
        </Feedback>
      )}
      {error && !buy && !cancel && (
        <Feedback
          onDismiss={() => setError('')}
          className="up-alert"
          variant="error"
        >
          {error}
        </Feedback>
      )}
      {mode === 'plans' ? (
        <>
          {!loading && !error && plans.length === 0 && (
            <div className="billing-empty">
              <Package size={28} />
              <h3>套餐暂未上架</h3>
              <p>管理员发布后会显示在这里。已有兑换码仍可在积分账本中使用。</p>
            </div>
          )}
          <div className="billing-plans">
            {plans.map((p) => (
              <article className="billing-plan" key={p.id}>
                <div className="billing-plan-type">
                  {p.details.kind === 'PACK' ? '积分包' : '订阅套餐'}
                </div>
                <h3>{p.details.name}</h3>
                <p className="billing-description">{p.details.description}</p>
                <div className="billing-price">
                  {money(p.details.price_cents, p.details.currency)}
                  <small>
                    {' '}
                    /{' '}
                    {p.details.kind === 'PACK'
                      ? '一次'
                      : `${p.details.period_days} 天`}
                  </small>
                </div>
                <ul>
                  <li>
                    <Check size={15} />
                    {p.details.credits.toLocaleString('zh-CN')} 积分
                    {p.details.kind === 'MONTHLY' ? ' / 周期' : ''}
                  </li>
                  {p.details.kind === 'MONTHLY' ? (
                    <>
                      <li>
                        <Check size={15} />
                        最高 {p.details.max_resolution} ·{' '}
                        {p.details.concurrency_limit} 个并发任务
                      </li>
                      <li>
                        <Check size={15} />
                        新素材保留 {p.details.retention_days} 天
                      </li>
                      <li>
                        <Check size={15} />
                        {p.details.rollover
                          ? '未用周期积分可结转'
                          : '未用周期积分到期回收'}
                      </li>
                    </>
                  ) : (
                    <li>仅增加积分，账户权益不变</li>
                  )}
                </ul>
                <button
                  className="btn btn-dark"
                  disabled={busy || loading}
                  onClick={() => {
                    setError('');
                    setBuy(p);
                  }}
                >
                  选择套餐
                  <ArrowRight size={16} />
                </button>
              </article>
            ))}
          </div>
          <p className="billing-note">
            重复购买订阅会顺延排队，在对应周期开始时发放积分。分辨率还需所选模型支持。保留时间适用于新素材，历史素材到期时间不变。
          </p>
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
                  <span
                    className={`billing-status status-${o.status.toLowerCase()}`}
                  >
                    {orderStatus[o.status] || o.status}
                  </span>
                </div>
                <p className="billing-order-id">订单号：{o.id}</p>
                <div className="billing-order-bottom">
                  <strong>{money(o.amount_cents, o.currency)}</strong>
                  <span>{o.plan_snapshot.credits} 积分</span>
                  {o.status === 'PENDING' && (
                    <button
                      className="btn btn-light"
                      disabled={busy}
                      onClick={() => {
                        setError('');
                        setCancel(o);
                      }}
                    >
                      取消订单
                    </button>
                  )}
                </div>
                {o.status === 'PENDING' && (
                  <p className="billing-instructions">
                    请联系管理员线下付款，提供上方订单号。请先确认收款方式，再付款；管理员核对到账后发放权益。
                  </p>
                )}
                {o.status === 'REFUNDED' && (
                  <p>
                    已登记退款 {money(o.refund_cents, o.currency)}，回收{' '}
                    {o.recovered_credits} 积分。到账情况请联系管理员核对。
                  </p>
                )}
              </article>
            ))}
          </div>
          {!loading && !error && orders.length === 0 && (
            <div className="billing-empty">
              <Package size={28} />
              <h3>还没有订单</h3>
              <p>在「套餐与订阅」选择套餐，确认后即可创建订单。</p>
            </div>
          )}
          {cursor && (
            <button
              className="btn btn-light"
              disabled={busy || loading}
              onClick={() =>
                void act(async () => {
                  const next = await api.orders(false, cursor);
                  setOrders((a) => [...a, ...next.items]);
                  setCursor(next.next_cursor);
                  return '';
                }, false)
              }
            >
              加载更多订单
            </button>
          )}
        </>
      )}
      {buy && (
        <AdminDialog
          title="确认创建订单"
          busy={busy}
          onClose={() => {
            setBuy(undefined);
            setError('');
          }}
        >
          <form
            className="billing-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const fingerprint = `${buy.id}:${buy.revision}`;
                if (pending.current?.id !== fingerprint)
                  pending.current = {
                    id: fingerprint,
                    key: crypto.randomUUID(),
                  };
                const result = await api.create(
                  buy,
                  me.csrf_token,
                  pending.current.key,
                );
                return `订单已创建。${result.instructions}`;
              });
            }}
          >
            <h3>{buy.details.name}</h3>
            <p className="billing-price">
              {money(buy.details.price_cents, buy.details.currency)}
            </p>
            <p>
              {buy.details.credits} 积分 ·{' '}
              {buy.details.kind === 'PACK'
                ? '一次性积分包，不改变账户权益'
                : `${buy.details.period_days} 天已付款周期，不自动续费`}
            </p>
            <p>
              创建订单后，请联系管理员确认收款方式并完成线下付款。此按钮只创建订单，不会扣款。
            </p>
            {error && (
              <Feedback
                onDismiss={() => setError('')}
                className="up-alert"
                variant="error"
              >
                {error}
              </Feedback>
            )}
            <div className="billing-actions">
              <button
                className="btn btn-light"
                type="button"
                disabled={busy}
                onClick={() => setBuy(undefined)}
              >
                返回
              </button>
              <button
                className="btn btn-dark"
                data-initial-focus
                disabled={busy}
              >
                {busy ? '正在创建…' : '确认创建订单'}
              </button>
            </div>
          </form>
        </AdminDialog>
      )}
      {cancel && (
        <AdminDialog
          title="取消这笔订单？"
          busy={busy}
          onClose={() => {
            setCancel(undefined);
            setError('');
          }}
        >
          <div className="billing-form">
            <p>
              订单 {cancel.id}{' '}
              取消后将无法确认到账。如果已经付款，请先联系管理员核对。
            </p>
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
                className="btn btn-light"
                disabled={busy}
                onClick={() => setCancel(undefined)}
              >
                保留订单
              </button>
              <button
                className="btn btn-dark"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.cancel(cancel.id, me.csrf_token);
                    return '订单已取消';
                  })
                }
              >
                {busy ? '正在取消…' : '确认取消订单'}
              </button>
            </div>
          </div>
        </AdminDialog>
      )}
    </section>
  );
}
