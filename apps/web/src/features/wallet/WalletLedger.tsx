import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Clock3,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { SessionError } from '../auth/sessionApi';
import { walletApi, type Entry, type Summary } from './walletApi';

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
const integer = (value: number) => value.toLocaleString('zh-CN');
const signed = (value: number) => `${value > 0 ? '+' : ''}${integer(value)}`;

export default function WalletLedger({
  entries,
  summary,
  cursor,
  loading,
  busy,
  onMore,
  onRefresh,
  onFailure,
}: {
  entries: Entry[];
  summary?: Summary;
  cursor?: number | null;
  loading: boolean;
  busy: boolean;
  onMore: () => void;
  onRefresh: () => void;
  onFailure: (error: unknown) => void;
}) {
  const [filter, setFilter] = useState('all');
  const [usage, setUsage] =
    useState<Awaited<ReturnType<typeof walletApi.usage>>>();
  const [usageState, setUsageState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  useEffect(() => {
    if (!summary) return;
    const abort = new AbortController();
    setUsageState('loading');
    void walletApi
      .usage(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) {
          setUsage(data);
          setUsageState('ready');
        }
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setUsageState('error');
        if (
          error instanceof SessionError &&
          (error.status === 401 ||
            ['ACCOUNT_DISABLED', 'MFA_REQUIRED'].includes(error.code))
        )
          onFailure(error);
      });
    return () => abort.abort();
  }, [summary, onFailure]);
  const daily = usage?.daily || [];
  const max = Math.max(1, ...daily.map((day) => day.consumed));
  const filtered = entries.filter(
    (entry) =>
      filter === 'all' ||
      (filter === 'in'
        ? entry.balance_delta > 0
        : entry.type === 'SETTLE' && entry.balance_delta < 0),
  );
  const timezone = summary?.timezone || 'UTC';
  const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });
  const yesterday = summary
    ? new Date(Date.parse(`${summary.local_date}T00:00:00Z`) - 86400000)
        .toISOString()
        .slice(0, 10)
    : '';
  const groups = new Map<string, Entry[]>();
  for (const entry of filtered) {
    const day = dayFormat.format(new Date(entry.created_at));
    groups.set(day, [...(groups.get(day) || []), entry]);
  }
  return (
    <section className="wallet-card wallet-ledger" aria-label="积分流水">
      <div className="wallet-usage">
        <div>
          <small>近 7 天消耗</small>
          <div className="wallet-usage-total">
            <strong>
              {usageState === 'ready'
                ? integer(daily.reduce((sum, day) => sum + day.consumed, 0))
                : '—'}
            </strong>
            <span>积分</span>
          </div>
          <p>
            {usageState === 'loading'
              ? '正在读取用量…'
              : usageState === 'error'
                ? '用量暂不可用，请刷新重试'
                : '按 UTC 自然日统计 · 包含生成与对话'}
          </p>
        </div>
        {usageState === 'ready' && (
          <figure
            className="wallet-usage-chart"
            aria-label="近 7 天每日积分消耗，按 UTC 统计"
          >
            <svg
              viewBox={`0 0 ${Math.max(7, daily.length) * 32} 80`}
              role="img"
              aria-label="每日积分消耗柱状图"
            >
              {daily.map((day, i) => {
                const height = (day.consumed / max) * 52;
                return (
                  <g key={day.day}>
                    <title>
                      {day.day}：{integer(day.consumed)} 积分
                    </title>
                    <rect
                      x={i * 32 + 5}
                      y={56 - height}
                      width="20"
                      height={height}
                      rx="3"
                      className={i === daily.length - 1 ? 'is-latest' : ''}
                    />
                    <line x1={i * 32 + 5} y1="57" x2={i * 32 + 25} y2="57" />
                    <text x={i * 32 + 15} y="76" textAnchor="middle">
                      {day.day.slice(5)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </figure>
        )}
      </div>
      <div className="wallet-ledger-head">
        <h2>积分流水</h2>
        <div
          className="wallet-ledger-filters"
          role="group"
          aria-label="流水类型"
        >
          {[
            ['all', '全部'],
            ['in', '获得'],
            ['out', '消耗'],
          ].map(([value, label]) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="wallet-refresh icon-btn"
          title="刷新积分"
          aria-label="刷新积分"
          disabled={busy || loading}
          onClick={onRefresh}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <p className="wallet-ledger-scope">
        {cursor
          ? '当前显示已加载流水，可继续加载更早记录。'
          : `按 ${timezone} 分组。`}
        {filter === 'out' && '消耗仅计已结算任务，预占不算扣款。'}
      </p>
      {loading && !entries.length ? (
        <p className="wallet-ledger-empty" role="status">
          正在读取积分流水…
        </p>
      ) : !filtered.length ? (
        <div className="wallet-ledger-empty">
          <p>{entries.length ? '已加载记录中暂无此类流水' : '暂无积分记录'}</p>
          <small>
            {cursor
              ? '可加载更早的记录，或切换其他类型。'
              : '签到、兑换或完成创作后，记录会显示在这里。'}
          </small>
        </div>
      ) : (
        [...groups].map(([day, rows]) => (
          <div className="wallet-ledger-group" key={day}>
            <div className="wallet-ledger-day">
              <span>
                {day === summary?.local_date
                  ? '今天'
                  : day === yesterday
                    ? '昨天'
                    : day}
              </span>
              <span>
                净变动{' '}
                {signed(
                  rows.reduce((sum, entry) => sum + entry.balance_delta, 0),
                )}
              </span>
            </div>
            {rows.map((entry) => {
              const incoming = entry.balance_delta > 0;
              const held = entry.type === 'HOLD';
              const released = entry.type === 'RELEASE';
              const Icon = incoming
                ? ArrowDown
                : held
                  ? Clock3
                  : released
                    ? RotateCcw
                    : ArrowUp;
              return (
                <details className="wallet-ledger-entry" key={entry.id}>
                  <summary role="button">
                    <span
                      className={`wallet-entry-icon ${incoming ? 'is-in' : held ? 'is-held' : ''}`}
                    >
                      <Icon size={17} />
                    </span>
                    <span className="wallet-entry-title">
                      <strong>{labels[entry.type] || entry.type}</strong>
                      <small>
                        {held
                          ? '暂时预留，结算前不扣款'
                          : released
                            ? '已解除预占，余额未扣减'
                            : new Date(entry.created_at).toLocaleTimeString(
                                'zh-CN',
                                {
                                  timeZone: timezone,
                                  hour: '2-digit',
                                  minute: '2-digit',
                                },
                              )}
                      </small>
                    </span>
                    <span
                      className={`wallet-entry-amount ${incoming ? 'is-in' : entry.balance_delta === 0 ? 'is-zero' : ''}`}
                    >
                      {signed(entry.balance_delta)}
                      <small>
                        {held ? `预占 +${integer(entry.held_delta)}` : '积分'}
                      </small>
                    </span>
                    <ChevronRight className="wallet-entry-chevron" size={16} />
                  </summary>
                  <dl className="wallet-entry-detail">
                    <div>
                      <dt>余额变动</dt>
                      <dd>{signed(entry.balance_delta)}</dd>
                    </div>
                    <div>
                      <dt>预占变动</dt>
                      <dd>{signed(entry.held_delta)}</dd>
                    </div>
                    <div>
                      <dt>时间（{timezone}）</dt>
                      <dd>
                        {new Date(entry.created_at).toLocaleString('zh-CN', {
                          timeZone: timezone,
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>流水编号</dt>
                      <dd>{entry.id}</dd>
                    </div>
                    {entry.reason && (
                      <div>
                        <dt>说明</dt>
                        <dd>{entry.reason}</dd>
                      </div>
                    )}
                  </dl>
                </details>
              );
            })}
          </div>
        ))
      )}
      {cursor && (
        <div className="wallet-ledger-more">
          <button
            className="btn btn-light"
            disabled={busy || loading}
            onClick={onMore}
          >
            {busy ? '正在读取…' : '加载更多'}
          </button>
        </div>
      )}
    </section>
  );
}
