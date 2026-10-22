import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Me, SessionError } from '../auth/sessionApi';
import { walletApi, type Summary, type Entry } from './walletApi';

const labels: Record<string, string> = {
  SIGNUP_BONUS: '注册赠送',
  CHECKIN: '每日签到',
  PURCHASE: '积分入账',
  REDEEM: '兑换码',
  ADMIN_ADJUST: '人工调整',
  HOLD: '任务预占',
  RELEASE: '解除预占',
  SETTLE: '任务结算',
  REFUND: '任务补偿',
};
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
          setEntries(ledger?.items || []);
          setCursor(ledger?.next_cursor);
        }
      } catch (failure) {
        if (!signal?.aborted) failed(failure);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [failed, home],
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
  return (
    <main className="account-shell wallet-page">
      <header>
        <div className="eyebrow">
          ATELIER / {home ? 'WORKSPACE' : 'CREDITS'}
        </div>
        <h1>{home ? `你好，${me.user.display_name}` : '我的积分'}</h1>
        <p>
          {home ? '每天积累一点创作的可能。' : '每一笔获得与使用，都有记录。'}
        </p>
        <nav className="account-nav" aria-label="账号导航">
          <Link to="/">工作台</Link>
          <Link to="/wallet">积分账本</Link>
          <Link to="/settings">账号设置</Link>
          {me.user.role !== 'USER' && <Link to="/admin/credits">积分管理</Link>}
        </nav>
      </header>
      {loading && !summary && <p role="status">正在读取积分…</p>}
      {summary && (
        <>
          <section className="wallet-hero" aria-label="钱包余额">
            <span>可用积分</span>
            <strong>{summary.available.toLocaleString('zh-CN')}</strong>
            <p>
              总额 {summary.balance.toLocaleString('zh-CN')} · 预占{' '}
              {summary.held.toLocaleString('zh-CN')}
            </p>
            {summary.available < 10 && (
              <p>可用积分较少，可以签到或使用兑换码补充。</p>
            )}
          </section>
          <section className="surface-block account-section checkin-row">
            <div>
              <h2>每日签到</h2>
              <p>
                连续 {summary.streak} 天 ·{' '}
                {summary.checked_in_today ? '明日' : '本次'}可得{' '}
                {summary.next_reward} 积分
              </p>
              <small>
                {summary.local_date} · {summary.timezone} 日界
              </small>
            </div>
            <button
              className="btn btn-dark"
              disabled={busy || loading || summary.checked_in_today}
              onClick={() => void mutate('checkin')}
            >
              {summary.checked_in_today ? '今日已签到' : '领取今日积分'}
            </button>
          </section>
          {!home && (
            <>
              <section className="surface-block account-section">
                <h2>兑换积分</h2>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate('redeem');
                  }}
                >
                  <label htmlFor="redeem-code">兑换码</label>
                  <input
                    className="input"
                    id="redeem-code"
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
              <section className="surface-block account-section">
                <h2>积分流水</h2>
                {entries.length === 0 ? (
                  <p>暂无积分记录</p>
                ) : (
                  <div className="ledger-scroll">
                    <table className="ledger-table">
                      <thead>
                        <tr>
                          <th>来源</th>
                          <th>余额变动</th>
                          <th>预占变动</th>
                          <th>时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry) => (
                          <tr key={entry.id}>
                            <td>
                              {labels[entry.type] || entry.type}
                              {entry.reason && <small>{entry.reason}</small>}
                            </td>
                            <td>
                              {entry.balance_delta > 0 ? '+' : ''}
                              {entry.balance_delta}
                            </td>
                            <td>
                              {entry.held_delta > 0 ? '+' : ''}
                              {entry.held_delta}
                            </td>
                            <td>
                              {new Date(entry.created_at).toLocaleString(
                                'zh-CN',
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {cursor && (
                  <button
                    className="btn btn-light"
                    disabled={busy}
                    onClick={() => void more()}
                  >
                    加载更多
                  </button>
                )}
              </section>
            </>
          )}
          {home && (
            <Link className="text-action" to="/wallet">
              查看完整积分账本 →
            </Link>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
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
    </main>
  );
}
