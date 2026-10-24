import { useToast } from '../../components/Toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Copy, Download, Plus, RefreshCw, Search, Info } from 'lucide-react';
import Feedback from '../../components/Feedback';
import DatePicker from '../../components/DatePicker';
import Tooltip from '../../components/Tooltip';
import AdminDialog from '../upstream/AdminDialog';
import type { AdminProps } from '../upstream/upstreamApi';
import { SessionError } from '../auth/sessionApi';
import { walletApi, type CreatedCodes, type CodeInfo } from './walletApi';
import '../upstream/AdminUpstream.css';

const dateLabel = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
const statusOf = (item: CodeInfo) =>
  item.expires_at && Date.parse(item.expires_at) <= Date.now()
    ? 'expired'
    : item.used_count >= item.max_uses
      ? 'exhausted'
      : 'available';
const filters = [
  { value: 'all', label: '全部' },
  { value: 'available', label: '可用' },
  { value: 'exhausted', label: '已用完' },
  { value: 'expired', label: '已过期' },
];
function expiryLabel(value: string | null | undefined) {
  if (!value) return '永久有效';
  const remaining = Date.parse(value) - Date.now();
  if (remaining <= 0) return '已过期';
  return remaining >= 86400000
    ? `还剩 ${Math.ceil(remaining / 86400000)} 天`
    : remaining >= 3600000
      ? `还剩 ${Math.ceil(remaining / 3600000)} 小时`
      : '不足 1 小时';
}

export default function AdminRedeemCodes({
  me,
  onExpired,
  onReload,
}: AdminProps) {
  const [mode, setMode] = useState<'create' | 'result'>();
  const [draft, setDraft] = useState({
    count: '1',
    credits: '100',
    uses: '1',
    expires: '',
  });
  const [created, setCreated] = useState<CreatedCodes>();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [copying, setCopying] = useState<string>();
  const [manualCopy, setManualCopy] = useState<{ code: string; id: string }>();
  const copyLock = useRef(false);
  const lock = useRef(false);
  const query = useInfiniteQuery({
    queryKey: ['admin-redeem-codes', me.user.id],
    queryFn: ({ pageParam, signal }) => walletApi.codes(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.length === 50 ? last[last.length - 1].id : undefined,
    retry: false,
  });
  const fail = useCallback(
    (failure: unknown, fallback = '兑换码记录暂不可用，请重试。') => {
      if (failure instanceof SessionError) {
        if (failure.status === 401 || failure.code === 'ACCOUNT_DISABLED') {
          onExpired();
          return;
        }
        if (failure.code === 'MFA_REQUIRED') {
          onReload();
          return;
        }
        if (failure.status === 403) {
          setError('没有管理兑换码的权限。');
          return;
        }
      }
      setError(fallback);
    },
    [onExpired, onReload],
  );
  useEffect(() => {
    if (query.error) fail(query.error);
  }, [query.error, fail]);
  const items = (query.data?.pages.flat() || []).filter(
    (item, index, all) =>
      all.findIndex((other) => other.id === item.id) === index,
  );
  const visible = items.filter(
    (item) =>
      (filter === 'all' || statusOf(item) === filter) &&
      item.id.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const sumCredits = (used: boolean) => {
    if (
      !items.every(
        (item) =>
          Number.isSafeInteger(item.credits) &&
          Number.isSafeInteger(item.used_count) &&
          Number.isSafeInteger(item.max_uses),
      )
    )
      return '—';
    return items
      .reduce(
        (sum, item) =>
          sum +
          BigInt(item.credits) *
            BigInt(
              used
                ? item.used_count
                : statusOf(item) === 'available'
                  ? item.max_uses - item.used_count
                  : 0,
            ),
        0n,
      )
      .toLocaleString('zh-CN');
  };
  const copyCode = async (item: CodeInfo) => {
    if (copyLock.current || !item.copyable) return;
    copyLock.current = true;
    setCopying(item.id);
    try {
      // Deliberately outside React Query: never cache or persist a revealed code.
      const result = await walletApi.copyCode(item.id, me.csrf_token);
      try {
        await navigator.clipboard.writeText(result.code);
        toast('兑换码已复制');
      } catch {
        setManualCopy(result);
      }
    } catch (failure) {
      fail(failure, '暂时无法复制兑换码，请刷新列表后重试。');
    } finally {
      copyLock.current = false;
      setCopying(undefined);
    }
  };
  const create = async () => {
    if (lock.current || uncertain) return;
    const count = Number(draft.count),
      credits = Number(draft.credits),
      maxUses = Number(draft.uses);
    const expiration = draft.expires ? new Date(draft.expires) : undefined;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100 ||
      !Number.isSafeInteger(credits) ||
      credits < 1 ||
      !Number.isSafeInteger(maxUses) ||
      maxUses < 1 ||
      maxUses > 10000 ||
      (expiration &&
        (!Number.isFinite(expiration.getTime()) ||
          expiration.getTime() <= Date.now()))
    ) {
      setError(
        '请填写 1–100 个兑换码、正整数积分、1–10000 次可用次数，并选择未来的过期时间或留空。',
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      // Issuance has no idempotency contract. Copy existing codes instead of retrying issuance.
      const result = await walletApi.createCodes(
        {
          count,
          credits,
          max_uses: maxUses,
          expires_at: expiration?.toISOString() || null,
        },
        me.csrf_token,
      );
      setCreated(result);
      setMode('result');
      void query.refetch();
    } catch (failure) {
      const ambiguous =
        !(failure instanceof SessionError) || failure.status >= 500;
      setUncertain(ambiguous);
      fail(
        failure,
        ambiguous
          ? '创建结果暂未确认，请先关闭窗口并刷新列表核对。不要直接重复提交；新生成的兑换码可从列表复制。'
          : '兑换码未生成，请核对填写内容后重试。',
      );
      if (ambiguous) void query.refetch();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const plaintext = created?.codes.map((item) => item.code).join('\n') || '';
  const close = () => {
    if (lock.current) return;
    setMode(undefined);
    setCreated(undefined);
  };
  return (
    <>
      <section className="admin-code-card" aria-label="兑换码管理">
        <div className="admin-code-heading">
          <div>
            <h2>兑换码管理</h2>
            <p>生成并分发积分兑换码，查看已使用次数与有效期。</p>
          </div>
          <div className="admin-code-actions">
            <button
              className="btn"
              disabled={query.isFetching}
              onClick={() => {
                setError('');
                void query.refetch();
              }}
            >
              <RefreshCw size={15} />
              刷新
            </button>
            <button
              className="btn btn-dark"
              onClick={() => {
                setUncertain(false);
                setMode('create');
              }}
            >
              <Plus size={15} />
              生成兑换码
            </button>
          </div>
        </div>
        <div className="admin-code-stats" aria-label="已加载兑换码统计">
          <div>
            <span>可用兑换码</span>
            <strong>
              {query.data
                ? items
                    .filter((item) => statusOf(item) === 'available')
                    .length.toLocaleString('zh-CN')
                : '—'}
            </strong>
          </div>
          <div>
            <span>已兑换积分</span>
            <strong>{query.data ? sumCredits(true) : '—'}</strong>
          </div>
          <div>
            <span>未兑换积分（仅可用码）</span>
            <strong>{query.data ? sumCredits(false) : '—'}</strong>
          </div>
        </div>
        <p className="admin-code-note">
          <Info size={16} aria-hidden="true" />
          新生成的兑换码可在列表中复制，读取操作会记录审计；旧版仅存哈希的兑换码无法恢复。用户可在“积分与订阅
          → 积分账本”中兑换。
        </p>
        <p className="admin-code-scope">
          统计、筛选和搜索仅针对已加载的 {items.length} 个兑换码。
        </p>
        <div className="admin-code-filters">
          <div role="group" aria-label="兑换码状态">
            {filters.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
                <span>
                  {value === 'all'
                    ? items.length
                    : items.filter((item) => statusOf(item) === value).length}
                </span>
              </button>
            ))}
          </div>
          <label className="admin-code-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索兑换码编号"
              placeholder="搜索编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        {query.isPending ? (
          <p className="admin-code-empty" role="status">
            正在读取兑换码…
          </p>
        ) : !query.isError && items.length === 0 ? (
          <div className="admin-code-empty">
            <h3>还没有兑换码</h3>
            <p>点击右上角生成兑换码，成功兑换的积分会记入用户账本。</p>
          </div>
        ) : (
          items.length > 0 && (
            <>
              <div className="admin-code-table-scroll">
                <table className="admin-code-table">
                  <thead>
                    <tr>
                      <th>编号</th>
                      <th>每次积分</th>
                      <th>使用次数</th>
                      <th>有效期</th>
                      <th>状态</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!visible.length && (
                      <tr>
                        <td colSpan={7} className="admin-code-empty">
                          没有符合条件的兑换码
                        </td>
                      </tr>
                    )}
                    {visible.map((item) => {
                      const expired =
                        !!item.expires_at &&
                        Date.parse(item.expires_at) <= Date.now();
                      const exhausted = item.used_count >= item.max_uses;
                      const status = expired
                        ? '已过期'
                        : exhausted
                          ? '已用完'
                          : '可用';
                      return (
                        <tr key={item.id}>
                          <td>
                            <code tabIndex={0} data-tip={item.id}>
                              {item.id.slice(0, 8)}…
                            </code>
                          </td>
                          <td>{item.credits.toLocaleString('zh-CN')}</td>
                          <td>
                            {item.used_count.toLocaleString('zh-CN')} /{' '}
                            {item.max_uses.toLocaleString('zh-CN')}
                            <span
                              className="admin-code-usage-track"
                              aria-hidden="true"
                            >
                              <i
                                style={{
                                  width: `${Math.min(100, (item.used_count / Math.max(1, item.max_uses)) * 100)}%`,
                                }}
                              />
                            </span>
                          </td>
                          <td>
                            <span
                              tabIndex={item.expires_at ? 0 : undefined}
                              data-tip={
                                item.expires_at
                                  ? dateLabel(item.expires_at)
                                  : undefined
                              }
                            >
                              {expiryLabel(item.expires_at)}
                            </span>
                          </td>
                          <td>
                            <span
                              className="admin-code-status"
                              data-active={!expired && !exhausted}
                              data-state={statusOf(item)}
                            >
                              {status}
                            </span>
                          </td>
                          <td>{dateLabel(item.created_at)}</td>
                          <td>
                            <Tooltip
                              content={
                                !item.copyable
                                  ? '旧版兑换码仅保存哈希，无法恢复完整内容'
                                  : '复制完整兑换码，读取操作将记录审计'
                              }
                            >
                              <button
                                type="button"
                                className="admin-code-copy"
                                aria-label={`复制兑换码 ${item.id}`}
                                disabled={!item.copyable || !!copying}
                                onClick={() => void copyCode(item)}
                              >
                                <Copy size={14} />
                                {copying === item.id ? '正在复制…' : '复制'}
                              </button>
                            </Tooltip>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="admin-code-pagination">
                <small>已加载 {items.length} 个兑换码</small>
                {query.hasNextPage && (
                  <button
                    className="btn"
                    disabled={query.isFetching}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchingNextPage ? '正在加载…' : '加载更多兑换码'}
                  </button>
                )}
              </div>
            </>
          )
        )}
      </section>
      {mode && (
        <AdminDialog
          title={mode === 'create' ? '生成兑换码' : '兑换码已生成'}
          onClose={close}
          busy={busy}
          className="redeem-code-dialog"
        >
          {mode === 'create' ? (
            <form
              className="admin-code-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <p>
                每个兑换码按设定次数兑换，每次发放相同积分，同一用户只能兑换同一码一次。新码加密保存，生成后也可从列表复制。
              </p>
              <div className="admin-code-fields">
                <label>
                  兑换码数量
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={draft.count}
                    disabled={busy}
                    required
                    onChange={(event) =>
                      setDraft({ ...draft, count: event.target.value })
                    }
                  />
                </label>
                <label>
                  每次兑换积分
                  <input
                    className="input"
                    type="number"
                    min="1"
                    step="1"
                    value={draft.credits}
                    disabled={busy}
                    required
                    onChange={(event) =>
                      setDraft({ ...draft, credits: event.target.value })
                    }
                  />
                </label>
                <label>
                  每码可用次数
                  <input
                    className="input"
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    value={draft.uses}
                    disabled={busy}
                    required
                    onChange={(event) =>
                      setDraft({ ...draft, uses: event.target.value })
                    }
                  />
                </label>
                <label>
                  过期时间（可选）
                  <DatePicker
                    value={draft.expires}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft({ ...draft, expires: event.target.value })
                    }
                  />
                  <small>
                    按当前设备本地时间选择，保存为 UTC；留空表示不限。
                  </small>
                </label>
              </div>
              <div className="admin-code-issuance">
                <span>最多发放积分</span>
                <strong>
                  {[draft.credits, draft.uses, draft.count].every(
                    (value) =>
                      /^[1-9]\d*$/.test(value) &&
                      Number.isSafeInteger(Number(value)),
                  )
                    ? (
                        BigInt(draft.credits) *
                        BigInt(draft.uses) *
                        BigInt(draft.count)
                      ).toLocaleString('zh-CN')
                    : '—'}
                </strong>
              </div>
              <footer className="admin-code-dialog-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </button>
                <button
                  className="btn btn-dark"
                  data-initial-focus
                  disabled={busy || uncertain}
                >
                  {busy
                    ? '正在生成…'
                    : uncertain
                      ? '请先核对创建结果'
                      : '确认生成'}
                </button>
              </footer>
            </form>
          ) : (
            <div className="admin-code-result">
              <p>
                已生成 {created?.codes.length || 0}{' '}
                个兑换码。可立即复制或下载，也可关闭后在列表中逐项复制。
              </p>
              <label>
                本次生成的兑换码
                <textarea
                  className="input"
                  readOnly
                  rows={8}
                  value={plaintext}
                  spellCheck={false}
                />
              </label>
              <footer className="admin-code-dialog-actions">
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(plaintext);
                      toast('兑换码已复制');
                    } catch {
                      toast.error('复制未完成', {
                        description: '请手动复制文本或下载保存。',
                      });
                    }
                  }}
                >
                  <Copy size={15} />
                  复制全部
                </button>
                <button
                  className="btn btn-dark"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([plaintext], {
                        type: 'text/plain;charset=utf-8',
                      }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `atelier-redeem-codes-${Date.now()}.txt`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={15} />
                  下载兑换码
                </button>
              </footer>
            </div>
          )}
        </AdminDialog>
      )}
      {manualCopy && (
        <AdminDialog
          title="手动复制兑换码"
          onClose={() => setManualCopy(undefined)}
          className="redeem-code-dialog"
        >
          <div className="admin-code-result">
            <p>浏览器未允许写入剪贴板，请选中下方文本手动复制。</p>
            <label>
              完整兑换码
              <textarea
                className="input"
                readOnly
                rows={3}
                value={manualCopy.code}
                onFocus={(event) => event.target.select()}
                spellCheck={false}
              />
            </label>
            <footer className="admin-code-dialog-actions">
              <button
                className="btn btn-dark"
                onClick={() => setManualCopy(undefined)}
              >
                完成
              </button>
            </footer>
          </div>
        </AdminDialog>
      )}
      {error && (
        <Feedback variant="error" onDismiss={() => setError('')}>
          {error}
        </Feedback>
      )}
    </>
  );
}
