import Feedback from '../../components/Feedback';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import './WalletPage.css';
import { type Me, SessionError } from '../auth/sessionApi';
import { walletApi, type Summary, type Entry } from './walletApi';

const WalletLedger = lazy(() => import('./WalletLedger'));
const BillingPanel = lazy(() => import('../billing/BillingPanel'));

export default function WalletPage({
  me,
  onExpired,
  onReload,
  home = false,
}: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
  home?: boolean;
}) {
  const [tab, setTab] = useState<'ledger' | 'plans' | 'orders'>('ledger');
  const tabs = (
    <nav className="billing-tabs" aria-label="积分与订阅导航">
      <button aria-pressed={tab === 'ledger'} onClick={() => setTab('ledger')}>
        积分账本
      </button>
      <button aria-pressed={tab === 'plans'} onClick={() => setTab('plans')}>
        套餐与订阅
      </button>
      <button aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}>
        我的订单
      </button>
    </nav>
  );
  const updateSummary = useWalletSummaryUpdate();
  const [summary, setSummary] = useState<Summary>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<number | null>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [code, setCode] = useState('');
  const pending = useRef<{ code: string; key: string }>();
  const lock = useRef(false);
  const failed = useCallback(
    (failure: unknown) => {
      if (
        failure instanceof SessionError &&
        (failure.status === 401 || failure.code === 'ACCOUNT_DISABLED')
      ) {
        onExpired();
        return;
      }
      if (failure instanceof SessionError && failure.code === 'MFA_REQUIRED') {
        onReload();
        return;
      }
      const errors: Record<string, string> = {
        INVALID_REDEEM_CODE: '兑换码无效、已使用或已过期',
        TOO_MANY_REQUESTS: '操作太频繁，请稍后重试',
        IDEMPOTENCY_CONFLICT: '请求内容已变化，请刷新后重试',
        INSUFFICIENT_CREDITS: '可用积分不足',
      };
      setError(
        failure instanceof SessionError
          ? errors[failure.code] || '服务暂不可用，请稍后重试'
          : '连接中断，可使用相同内容重试',
      );
    },
    [onExpired, onReload],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const [wallet, ledger] = await Promise.all([
          walletApi.summary(signal),
          home
            ? Promise.resolve(undefined)
            : walletApi.ledger(undefined, signal),
        ]);
        if (!signal?.aborted) {
          setSummary(wallet);
          updateSummary(wallet);
          setEntries(ledger?.items || []);
          setCursor(ledger?.next_cursor);
        }
      } catch (failure) {
        if (!signal?.aborted) failed(failure);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [failed, home, updateSummary],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const mutate = async (kind: 'checkin' | 'redeem') => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (kind === 'checkin') {
        const result = await walletApi.checkin(me.csrf_token);
        setMessage(
          result.already_checked_in
            ? '今日已签到'
            : `签到成功，获得 ${result.credits} 积分，连续 ${result.streak} 天`,
        );
      } else {
        const value = code.trim();
        if (!pending.current || pending.current.code !== value)
          pending.current = { code: value, key: crypto.randomUUID() };
        const result = await walletApi.redeem(
          value,
          me.csrf_token,
          pending.current.key,
        );
        pending.current = undefined;
        setCode('');
        setMessage(`兑换成功，获得 ${result.credits} 积分`);
      }
      await load();
    } catch (failure) {
      failed(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const more = async () => {
    if (!cursor || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await walletApi.ledger(cursor);
      setEntries((all) => [...all, ...result.items]);
      setCursor(result.next_cursor);
    } catch (failure) {
      failed(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const balanceCard = summary && (
    <section
      className={home ? 'wallet-hero' : 'wallet-card wallet-balance'}
      aria-label="钱包余额"
    >
      <span>可用积分</span>
      <strong aria-label="可用积分">
        {summary.available.toLocaleString('zh-CN')}
      </strong>
      {home ? (
        <p>
          总额 {summary.balance.toLocaleString('zh-CN')} · 预占{' '}
          {summary.held.toLocaleString('zh-CN')}
        </p>
      ) : (
        <p>
          预占 <b>{summary.held.toLocaleString('zh-CN')}</b>
          <span className="wallet-balance-divider"> · </span>总额{' '}
          <b>{summary.balance.toLocaleString('zh-CN')}</b>
        </p>
      )}
      {summary.available < 10 && (
        <p>可用积分较少，可以签到或使用兑换码补充。</p>
      )}
      {!home && (
        <button className="btn btn-light" onClick={() => setTab('plans')}>
          获取更多积分
        </button>
      )}
    </section>
  );
  const checkinCard = summary && (
    <section
      className={
        home
          ? 'surface-block account-section checkin-row'
          : 'wallet-card wallet-checkin'
      }
    >
      <div className="checkin-heading">
        <div>
          <h2>每日签到</h2>
          <p>
            连续 {summary.streak} 天 ·{' '}
            {summary.checked_in_today ? '明日' : '本次'}可得{' '}
            {summary.next_reward} 积分
          </p>
          {home && (
            <small>
              {summary.local_date} · {summary.timezone} 日界
            </small>
          )}
        </div>
        {home && (
          <button
            className="btn btn-dark"
            disabled={busy || loading || summary.checked_in_today}
            onClick={() => void mutate('checkin')}
          >
            {summary.checked_in_today ? '今日已签到' : '领取今日积分'}
          </button>
        )}
      </div>
      {home ? (
        <div
          className="home-checkin-progress"
          role="img"
          aria-label={`已连续签到 ${summary.streak} 天`}
        >
          {Array.from({ length: 7 }, (_, i) => (
            <span
              key={i}
              className={i < Math.min(summary.streak, 7) ? 'is-complete' : ''}
            />
          ))}
        </div>
      ) : (
        <>
          <div
            className="wallet-checkin-days"
            role="img"
            aria-label={`已连续签到 ${summary.streak} 天，进度最多显示 7 天`}
          >
            {Array.from({ length: 7 }, (_, i) => (
              <span
                key={i}
                className={
                  i < Math.min(summary.streak, 7)
                    ? 'is-complete'
                    : !summary.checked_in_today && i === summary.streak
                      ? 'is-next'
                      : ''
                }
              >
                {i < Math.min(summary.streak, 7) ? <Check size={16} /> : i + 1}
              </span>
            ))}
          </div>
          <button
            className="btn btn-dark"
            disabled={busy || loading || summary.checked_in_today}
            onClick={() => void mutate('checkin')}
          >
            {summary.checked_in_today ? '今日已签到' : '领取今日积分'}
          </button>
          <small className="wallet-timezone" title={summary.local_date}>
            每天 0 点刷新 · {summary.timezone}
          </small>
        </>
      )}
    </section>
  );
  const feedback = (
    <>
      {message && (
        <Feedback
          onDismiss={() => setMessage('')}
          className={home ? undefined : 'wallet-feedback wallet-success'}
          variant="success"
        >
          {message}
        </Feedback>
      )}
      {error && (
        <Feedback
          onDismiss={() => setError('')}
          className={home ? undefined : 'wallet-feedback wallet-error'}
          variant="error"
        >
          {error}
        </Feedback>
      )}
    </>
  );
  const refresh = (
    <button
      className="text-action"
      disabled={busy || loading}
      onClick={() => {
        setError('');
        void load();
      }}
    >
      刷新积分
    </button>
  );
  if (home)
    return (
      <section className="dashboard-wallet">
        {loading && !summary && <p role="status">正在读取积分…</p>}
        {balanceCard}
        {checkinCard}
        {feedback}
        <div className="home-wallet-actions">
          {summary && (
            <Link className="text-action" to="/wallet">
              查看完整积分账本 →
            </Link>
          )}
          {refresh}
        </div>
      </section>
    );
  return (
    <main className="account-shell wallet-page">
      <header className="wallet-page-heading">
        <h1>我的积分</h1>
        <p>每一笔获得与使用，都有记录。</p>
      </header>
      {tabs}
      {tab === 'ledger' ? (
        <>
          {feedback}
          {loading && !summary && <p role="status">正在读取积分…</p>}
          {!summary && !loading && (
            <div className="wallet-retry">{refresh}</div>
          )}
          <div className="wallet-layout">
            <Suspense
              fallback={
                <section className="wallet-card" role="status">
                  正在读取积分流水…
                </section>
              }
            >
              <WalletLedger
                entries={entries}
                summary={summary}
                cursor={cursor}
                busy={busy}
                loading={loading}
                onFailure={failed}
                onMore={() => void more()}
                onRefresh={() => {
                  setError('');
                  void load();
                }}
              />
            </Suspense>
            <aside className="wallet-sidebar" aria-label="积分管理">
              {balanceCard}
              {checkinCard}
              {summary && (
                <section className="wallet-card wallet-redeem">
                  <h2>兑换积分</h2>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate('redeem');
                    }}
                  >
                    <label
                      className="wallet-visually-hidden"
                      htmlFor="redeem-code"
                    >
                      兑换码
                    </label>
                    <input
                      className="input"
                      id="redeem-code"
                      placeholder="输入兑换码"
                      autoComplete="off"
                      maxLength={128}
                      value={code}
                      disabled={busy}
                      onChange={(event) => setCode(event.target.value)}
                    />
                    <button
                      className="btn btn-dark"
                      disabled={busy || loading || !code.trim()}
                    >
                      兑换
                    </button>
                  </form>
                </section>
              )}
            </aside>
          </div>
        </>
      ) : (
        <Suspense
          fallback={
            <section className="wallet-card" role="status">
              正在读取套餐和订单…
            </section>
          }
        >
          <BillingPanel
            me={me}
            onExpired={onExpired}
            onReload={onReload}
            mode={tab}
            onOrders={() => setTab('orders')}
            onWalletChanged={() => void load()}
          />
        </Suspense>
      )}
    </main>
  );
}
