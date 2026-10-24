import Feedback from '../../components/Feedback';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Copy,
  Eye,
  Info,
  Layers3,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  ReceiptText,
} from 'lucide-react';
import Tooltip from '../../components/Tooltip';
import { useToast } from '../../components/Toast';
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
  type RefundQuote,
} from './billingApi';
import '../upstream/AdminUpstream.css';
import './Billing.css';
import './AdminBillingPage.css';
import PlanEditor from './PlanEditor';
type Panel =
  | { kind: 'plan'; plan?: Plan }
  | { kind: 'availability'; plan: Plan }
  | { kind: 'paid' | 'refund' | 'details'; order: Order };
type Tab = 'plans' | 'orders';
const orderFilters = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待付款' },
  { value: 'paid', label: '已到账' },
  { value: 'refunded', label: '已退款' },
  { value: 'cancelled', label: '已取消' },
];
const shortId = (value: string) =>
  value.length > 22 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
const filterStatus = (order: Order) =>
  order.status === 'PENDING'
    ? 'pending'
    : ['PAID', 'FULFILLED'].includes(order.status)
      ? 'paid'
      : order.status === 'REFUNDED'
        ? 'refunded'
        : order.status === 'CANCELLED'
          ? 'cancelled'
          : 'other';
function OrderBadge({ order }: { order: Order }) {
  return (
    <span className="admin-billing-badge" data-tone={filterStatus(order)}>
      {orderStatus[order.status] || order.status}
    </span>
  );
}
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
  const [tab, setTab] = useState<Tab>('plans');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [panel, setPanel] = useState<Panel>();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [manualCopy, setManualCopy] = useState<{
    label: string;
    value: string;
  }>();
  const toast = useToast();
  const readVersion = useRef(0);
  const loadMoreLock = useRef(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++readVersion.current;
      setLoading(true);
      try {
        const [p, o] = await Promise.all([
          api.plans(true, signal),
          api.orders(true, undefined, signal),
        ]);
        if (!signal?.aborted && version === readVersion.current) {
          setPlans(p);
          setOrders(o.items);
          setCursor(o.next_cursor);
          setLoaded(true);
          setError('');
        }
      } catch (failure) {
        if (!signal?.aborted && version === readVersion.current)
          setError(billingError(failure, { me, onExpired, onReload }));
      } finally {
        if (!signal?.aborted && version === readVersion.current)
          setLoading(false);
      }
    },
    [me, onExpired, onReload],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => {
      abort.abort();
      readVersion.current++;
    };
  }, [load]);
  const more = async () => {
    if (loadMoreLock.current || loading || !cursor) return;
    loadMoreLock.current = true;
    const version = readVersion.current;
    setLoadingMore(true);
    try {
      const next = await api.orders(true, cursor);
      if (version === readVersion.current) {
        setOrders((current) =>
          [...current, ...next.items].filter(
            (item, index, all) =>
              all.findIndex((row) => row.id === item.id) === index,
          ),
        );
        setCursor(next.next_cursor);
      }
    } catch (failure) {
      if (version === readVersion.current)
        setError(billingError(failure, props));
    } finally {
      loadMoreLock.current = false;
      setLoadingMore(false);
    }
  };
  const done = async (text: string) => {
    setPanel(undefined);
    setMessage(text);
    await load();
  };
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`${label}已复制`);
    } catch {
      setManualCopy({ label, value });
    }
  };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'plans'
        : event.key === 'End'
          ? 'orders'
          : tab === 'plans'
            ? 'orders'
            : 'plans';
    setTab(next);
    document.getElementById(`billing-tab-${next}`)?.focus();
  };
  const matches = orders.filter(
    (order) =>
      (status === 'all' || filterStatus(order) === status) &&
      `${order.id} ${order.user_id} ${order.plan_snapshot.name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const pendingCount = orders.filter(
    (order) => order.status === 'PENDING',
  ).length;
  const renderId = (label: string, value: string) => (
    <div className="admin-billing-id-row">
      <code data-tip={value} tabIndex={0}>
        {shortId(value)}
      </code>
      <Tooltip content={`复制${label}`}>
        <button
          type="button"
          className="admin-billing-copy"
          aria-label={`复制${label} ${value}`}
          onClick={() => void copy(label, value)}
        >
          <Copy size={13} />
        </button>
      </Tooltip>
    </div>
  );
  return (
    <main className="page-padding up-page billing-admin">
      <header className="page-title-row admin-billing-head">
        <div>
          <div className="eyebrow">ATELIER / BILLING</div>
          <h1>套餐与订单</h1>
          <p>先核对真实收付款，再登记到账或退款。每次变更保留审计记录。</p>
        </div>
        <button
          className="btn btn-light"
          disabled={loading || loadingMore}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </header>
      <div className="admin-billing-tabs" role="tablist" aria-label="账务管理">
        {(
          [
            { value: 'plans', label: '套餐管理', count: plans.length },
            { value: 'orders', label: '订单管理', count: orders.length },
          ] as const
        ).map(({ value, label, count }) => (
          <button
            key={value}
            id={`billing-tab-${value}`}
            role="tab"
            aria-label={label}
            aria-selected={tab === value}
            aria-controls={`billing-panel-${value}`}
            data-tip={
              value === 'orders'
                ? '数量为已加载订单，不代表全部订单'
                : '当前套餐数量'
            }
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={keyTab}
          >
            {label}
            {loaded && <span className="admin-billing-count">{count}</span>}
            {value === 'orders' && loaded && pendingCount > 0 && (
              <span className="admin-billing-pending">
                {pendingCount} 待付款
              </span>
            )}
          </button>
        ))}
      </div>
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
      {message && (
        <Feedback onDismiss={() => setMessage('')} variant="success">
          {message}
        </Feedback>
      )}
      {loading && !loaded && (
        <p role="status" className="admin-billing-loading">
          正在读取账务记录…
        </p>
      )}
      <section
        id="billing-panel-plans"
        role="tabpanel"
        aria-labelledby="billing-tab-plans"
        hidden={tab !== 'plans'}
      >
        <div className="admin-billing-plan-heading">
          <p>
            <Info size={16} aria-hidden="true" />
            套餐调整只影响新订单。下架后，历史订单仍按原价格和权益处理。
          </p>
          <button
            className="btn btn-dark"
            onClick={() => setPanel({ kind: 'plan' })}
          >
            <Plus size={15} />
            新增套餐
          </button>
        </div>
        <div className="billing-plans admin-billing-plans">
          {plans.map((plan) => (
            <article
              className="billing-plan admin-billing-plan"
              data-active={plan.details.active}
              key={plan.id}
            >
              <div className="admin-billing-plan-meta">
                <span
                  className="admin-billing-badge"
                  data-tone={plan.details.active ? 'paid' : 'cancelled'}
                >
                  {plan.details.active ? '已上架' : '已下架'}
                </span>
                <span>
                  {plan.details.kind === 'PACK' ? '积分包' : '订阅套餐'}
                </span>
              </div>
              <h3>{plan.details.name}</h3>
              <p className="billing-price">
                {money(plan.details.price_cents, plan.details.currency)}
                <small>
                  {plan.details.kind === 'MONTHLY'
                    ? ` / ${plan.details.period_days} 天`
                    : ' / 次'}
                </small>
              </p>
              <p className="admin-billing-quota">
                <strong>{plan.details.credits.toLocaleString('zh-CN')}</strong>{' '}
                积分
                {plan.details.kind === 'MONTHLY'
                  ? ` / ${plan.details.period_days} 天`
                  : ''}
              </p>
              {plan.details.description && (
                <p className="admin-billing-plan-description">
                  {plan.details.description}
                </p>
              )}
              <div className="admin-billing-chips">
                {plan.details.kind === 'MONTHLY' ? (
                  <>
                    <span>{plan.details.max_resolution}</span>
                    <span>{plan.details.concurrency_limit} 并发</span>
                    <span>新素材 {plan.details.retention_days} 天</span>
                    <span>
                      {plan.details.rollover
                        ? '积分可结转'
                        : '周期积分到期回收'}
                    </span>
                  </>
                ) : (
                  <span>一次性发放积分</span>
                )}
              </div>
              <footer>
                <button
                  className="btn btn-light"
                  onClick={() => setPanel({ kind: 'plan', plan })}
                >
                  <Pencil size={14} />
                  编辑套餐
                </button>
                <button
                  className="btn btn-light admin-billing-availability"
                  aria-label={`${plan.details.active ? '下架' : '上架'} ${plan.details.name}`}
                  onClick={() => setPanel({ kind: 'availability', plan })}
                >
                  <Power size={14} />
                  {plan.details.active ? '下架' : '上架'}
                </button>
              </footer>
            </article>
          ))}
        </div>
        {loaded && plans.length === 0 && (
          <div className="admin-billing-empty">
            <Layers3 size={27} />
            <h3>还没有套餐</h3>
            <p>创建并上架后，用户可在「积分与订阅」下单。</p>
          </div>
        )}
      </section>
      <section
        id="billing-panel-orders"
        role="tabpanel"
        aria-labelledby="billing-tab-orders"
        hidden={tab !== 'orders'}
      >
        <form
          className="admin-billing-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft.trim());
          }}
        >
          <label className="admin-billing-search">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="搜索订单"
              placeholder="搜索订单号、用户 ID 或套餐"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div
            className="admin-billing-statuses"
            role="group"
            aria-label="订单状态"
          >
            {orderFilters.map((filter) => (
              <button
                key={filter.value}
                type="button"
                aria-pressed={status === filter.value}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <button className="btn btn-dark">搜索</button>
        </form>
        <p className="admin-billing-notice">
          <Info size={16} aria-hidden="true" />
          <span>
            先核对真实收付款，再登记到账或退款。搜索、状态筛选和数量仅针对已加载的订单。
          </span>
        </p>
        <div className="admin-billing-table-card">
          <div className="admin-billing-table-scroll">
            <table className="admin-billing-table">
              <thead>
                <tr>
                  <th>套餐 / 创建时间</th>
                  <th>订单号 / 用户</th>
                  <th>金额 / 积分</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong className="admin-billing-plan-name">
                        {order.plan_snapshot.name}
                      </strong>
                      <small>{dateTime(order.created_at)}</small>
                    </td>
                    <td>
                      <div className="admin-billing-identifiers">
                        <span>订单</span>
                        {renderId('订单号', order.id)}
                        <span>用户</span>
                        {renderId('用户 ID', order.user_id)}
                      </div>
                    </td>
                    <td>
                      <strong className="admin-billing-amount">
                        {money(order.amount_cents, order.currency)}
                      </strong>
                      <small>
                        {order.plan_snapshot.credits.toLocaleString('zh-CN')}{' '}
                        积分
                      </small>
                    </td>
                    <td>
                      <OrderBadge order={order} />
                      {order.status === 'REFUNDED' && (
                        <small>
                          退款 {money(order.refund_cents, order.currency)}
                        </small>
                      )}
                    </td>
                    <td>
                      <div className="admin-billing-row-actions">
                        {order.status === 'PENDING' && (
                          <button
                            className="btn btn-dark"
                            onClick={() => setPanel({ kind: 'paid', order })}
                          >
                            确认到账
                          </button>
                        )}
                        {order.status === 'FULFILLED' && (
                          <button
                            className="btn btn-light"
                            onClick={() => setPanel({ kind: 'refund', order })}
                          >
                            办理退款
                          </button>
                        )}
                        <button
                          className="btn admin-billing-detail-button"
                          aria-label={`详情 ${order.id}`}
                          onClick={() => setPanel({ kind: 'details', order })}
                        >
                          <Eye size={14} />
                          详情
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loaded && matches.length === 0 && (
            <div className="admin-billing-empty">
              <ReceiptText size={27} />
              <h3>
                {search || status !== 'all' ? '暂无符合条件的订单' : '暂无订单'}
              </h3>
              <p>
                {search || status !== 'all'
                  ? '试试其他条件，或加载更多订单后继续查找。'
                  : '用户创建订单后，可在此核对到账与退款。'}
              </p>
              {(search || status !== 'all') && (
                <button
                  className="btn btn-light"
                  onClick={() => {
                    setDraft('');
                    setSearch('');
                    setStatus('all');
                  }}
                >
                  清除搜索
                </button>
              )}
            </div>
          )}
          <footer className="admin-billing-table-footer">
            <span>
              已加载 {orders.length} 条订单 · 符合条件 {matches.length} 条
            </span>
            {cursor && (
              <button
                className="btn btn-light"
                disabled={loading || loadingMore}
                onClick={() => void more()}
              >
                {loadingMore ? '正在加载…' : '加载更多订单'}
              </button>
            )}
          </footer>
        </div>
      </section>
      {panel?.kind === 'plan' && (
        <PlanEditor
          {...props}
          plan={panel.plan}
          hasKnownOrders={orders.some(
            (order) => order.plan_id === panel.plan?.id,
          )}
          onClose={() => setPanel(undefined)}
          onDone={done}
        />
      )}
      {panel?.kind === 'availability' && (
        <PlanAvailability
          {...props}
          plan={panel.plan}
          onClose={() => setPanel(undefined)}
          onDone={done}
        />
      )}
      {panel && (panel.kind === 'paid' || panel.kind === 'refund') && (
        <PaymentDialog
          {...props}
          mode={panel.kind}
          order={panel.order}
          onClose={() => setPanel(undefined)}
          onDone={done}
        />
      )}
      {panel?.kind === 'details' && (
        <OrderDetails
          order={panel.order}
          onClose={() => setPanel(undefined)}
          onCopy={copy}
        />
      )}
      {manualCopy && (
        <AdminDialog
          title={`手动复制${manualCopy.label}`}
          className="admin-billing-dialog"
          onClose={() => setManualCopy(undefined)}
        >
          <div className="billing-form">
            <p>浏览器未允许写入剪贴板，请选择完整编号手动复制。</p>
            <label>
              {manualCopy.label}
              <input
                className="input"
                readOnly
                data-initial-focus
                value={manualCopy.value}
                onFocus={(event) => event.target.select()}
              />
            </label>
            <div className="billing-actions">
              <button
                className="btn btn-dark"
                onClick={() => setManualCopy(undefined)}
              >
                完成
              </button>
            </div>
          </div>
        </AdminDialog>
      )}
    </main>
  );
}
function PlanAvailability(
  props: AdminProps & {
    plan: Plan;
    onClose: () => void;
    onDone: (text: string) => Promise<void>;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const { plan } = props;
  const label = plan.details.active ? '下架' : '上架';
  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await api.savePlan(
        { ...plan.details, active: !plan.details.active },
        props.me.csrf_token,
        plan,
      );
      await props.onDone(`套餐已${label}`);
    } catch (failure) {
      setError(billingError(failure, props));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <AdminDialog
      title={`${label}套餐`}
      className="admin-billing-dialog"
      busy={busy}
      onClose={props.onClose}
    >
      <div className="billing-form">
        <div className="admin-billing-summary">
          <h3>{plan.details.name}</h3>
          <strong>
            {money(plan.details.price_cents, plan.details.currency)}
          </strong>
          <span>{plan.details.credits.toLocaleString('zh-CN')} 积分</span>
        </div>
        <p className="admin-billing-dialog-note">
          {plan.details.active
            ? '下架后，用户不能再为此套餐创建新订单；历史订单仍按下单时的价格和权益处理。'
            : '上架后，用户可按当前价格和权益创建新订单。请确认套餐内容已核对。'}
        </p>
        {error && (
          <Feedback variant="error" onDismiss={() => setError('')}>
            {error}
          </Feedback>
        )}
        <footer className="billing-actions">
          <button
            className="btn btn-light"
            disabled={busy}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            className="btn btn-dark"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? '正在处理…' : `确认${label}`}
          </button>
        </footer>
      </div>
    </AdminDialog>
  );
}
function OrderDetails({
  order,
  onClose,
  onCopy,
}: {
  order: Order;
  onClose: () => void;
  onCopy: (label: string, value: string) => Promise<void>;
}) {
  return (
    <AdminDialog
      title="订单详情"
      className="admin-billing-dialog"
      onClose={onClose}
    >
      <div className="billing-form">
        <div className="admin-billing-summary">
          <div>
            <h3>{order.plan_snapshot.name}</h3>
            <OrderBadge order={order} />
          </div>
          <strong>{money(order.amount_cents, order.currency)}</strong>
          <span>
            {order.plan_snapshot.credits.toLocaleString('zh-CN')} 积分
          </span>
        </div>
        <dl className="admin-billing-details">
          <div>
            <dt>订单号</dt>
            <dd>
              <code>{order.id}</code>
              <Tooltip content="复制订单号">
                <button
                  className="admin-billing-copy"
                  aria-label="复制详情订单号"
                  onClick={() => void onCopy('订单号', order.id)}
                >
                  <Copy size={14} />
                </button>
              </Tooltip>
            </dd>
          </div>
          <div>
            <dt>用户 ID</dt>
            <dd>
              <code>{order.user_id}</code>
              <Tooltip content="复制用户 ID">
                <button
                  className="admin-billing-copy"
                  aria-label="复制详情用户 ID"
                  onClick={() => void onCopy('用户 ID', order.user_id)}
                >
                  <Copy size={14} />
                </button>
              </Tooltip>
            </dd>
          </div>
          <div>
            <dt>收款方式</dt>
            <dd>人工核对到账</dd>
          </div>
          {order.provider_trade_no && (
            <div>
              <dt>收款凭证</dt>
              <dd>{order.provider_trade_no}</dd>
            </div>
          )}
          <div>
            <dt>套餐类型</dt>
            <dd>
              {order.plan_snapshot.kind === 'PACK'
                ? '一次性积分包'
                : `${order.plan_snapshot.period_days} 天订阅`}
            </dd>
          </div>
          {order.status === 'REFUNDED' && (
            <>
              <div>
                <dt>登记退款</dt>
                <dd>{money(order.refund_cents, order.currency)}</dd>
              </div>
              <div>
                <dt>回收积分</dt>
                <dd>{order.recovered_credits.toLocaleString('zh-CN')} 积分</dd>
              </div>
            </>
          )}
        </dl>
        <section className="admin-billing-history">
          <h3>订单记录</h3>
          <ol>
            <li>
              <strong>订单已创建</strong>
              <time>{dateTime(order.created_at)}</time>
            </li>
            {order.paid_at && (
              <li>
                <strong>到账已确认</strong>
                <time>{dateTime(order.paid_at)}</time>
              </li>
            )}
          </ol>
        </section>
        <p className="admin-billing-dialog-note">
          金额和权益按下单时的套餐快照展示，后续套餐变更不影响此订单。
        </p>
        <footer className="billing-actions">
          <button className="btn btn-dark" onClick={onClose}>
            关闭详情
          </button>
        </footer>
      </div>
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
      className="admin-billing-dialog"
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
        <div className="admin-billing-payment-summary">
          <div>
            <h3>{o.plan_snapshot.name}</h3>
            <OrderBadge order={o} />
          </div>
          <p className="billing-order-id">
            订单 {o.id}
            <br />
            用户 {o.user_id}
          </p>
          <p>
            订单金额：<strong>{money(o.amount_cents, o.currency)}</strong> ·{' '}
            {o.plan_snapshot.credits} 积分
          </p>
        </div>
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
