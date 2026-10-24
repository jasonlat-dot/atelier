import Tooltip from '../../components/Tooltip';
import DatePicker from '../../components/DatePicker';
import Feedback from '../../components/Feedback';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Activity,
  BarChart3,
  Coins,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Upload,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import AdminDialog from './AdminDialog';
import {
  accountInput,
  errorText,
  failureNames,
  upstreamApi as api,
  type Account,
  type AdminProps,
  type Schema,
} from './upstreamApi';
import './AdminUpstream.css';
const statusNames: Record<string, string> = {
  ACTIVE: '可用',
  COOLDOWN: '冷却中',
  QUOTA_EXHAUSTED: '额度耗尽',
  INVALID: '凭据失效',
  DISABLED: '已停用',
};
type Panel =
  | { kind: 'edit'; account?: Account }
  | { kind: 'quota' | 'stats' | 'disable' | 'delete'; account: Account }
  | { kind: 'import' };
export default function AdminAccountsPage(props: AdminProps) {
  return props.me.user.role === 'USER' ? (
    <main className="page-padding">
      <h1>无权访问</h1>
      <p>此页面需要管理员权限。</p>
    </main>
  ) : (
    <Accounts {...props} />
  );
}
function Accounts(props: AdminProps) {
  const [items, setItems] = useState<Account[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [next, setNext] = useState<string | null>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [messageFailed, setMessageFailed] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [tick, setTick] = useState(0);
  const { onExpired, onReload, me } = props;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const data = await api.accounts(query, cursor, signal);
        if (!signal?.aborted) {
          setItems(data.items);
          setNext(data.next_cursor);
          setError('');
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(errorText(e, { me, onExpired, onReload }));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [query, cursor, me, onExpired, onReload],
  );
  useEffect(() => {
    if (search.trim() === query) return;
    const t = window.setTimeout(() => {
      setQuery(search.trim());
      setCursor(undefined);
      setHistory([]);
    }, 300);
    return () => clearTimeout(t);
  }, [search, query]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!panel && !busy && document.visibilityState === 'visible')
        void load();
    }, 15000);
    return () => clearInterval(t);
  }, [load, panel, busy]);
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  async function act(
    work: () => Promise<string | { text: string; failed: boolean }>,
    close = true,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    setMessageFailed(false);
    try {
      const result = await work();
      setMessage(typeof result === 'string' ? result : result.text);
      setMessageFailed(typeof result !== 'string' && result.failed);
      if (close) setPanel(undefined);
      await load();
    } catch (e) {
      setError(errorText(e, props));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const close = () => {
    if (!busy) {
      setPanel(undefined);
      setError('');
    }
  };
  return (
    <main className="page-padding up-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">MANAGEMENT / ACCOUNTS</div>
          <h1>上游账号池</h1>
          <p className="page-subtitle">
            管理连接、额度与路由健康，为模型提供稳定的服务。
          </p>
        </div>
        <span className="neutral-status">
          <Server size={14} /> OPENAI COMPATIBLE
        </span>
      </div>
      <div className="up-toolbar">
        <label className="up-search">
          <Search size={16} />
          <input
            className="input"
            aria-label="搜索账号名称或分组"
            placeholder="搜索账号名称或分组"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="up-actions">
          <button
            className="btn btn-ghost"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setError('');
              setPanel({ kind: 'import' });
            }}
          >
            <Upload size={14} />
            JSON 导入
          </button>
          <button
            className="btn btn-dark"
            onClick={() => {
              setError('');
              setPanel({ kind: 'edit' });
            }}
          >
            <Plus size={15} />
            新增账号
          </button>
        </div>
      </div>
      {busy && !panel && (
        <p role="status" className="up-note">
          正在处理请求，请稍候…
        </p>
      )}
      {message && (
        <Feedback
          onDismiss={() => setMessage('')}
          className="up-message"
          variant={messageFailed ? 'error' : 'success'}
        >
          {message}
        </Feedback>
      )}
      {error && !panel && (
        <Feedback
          onDismiss={() => setError('')}
          className="up-message"
          variant="error"
        >
          {error}{' '}
          <button className="btn btn-ghost" onClick={() => void load()}>
            重试加载
          </button>
        </Feedback>
      )}
      {items.some((a) => a.status === 'INVALID') && (
        <p className="up-note">部分账号凭据失效，请编辑密钥后执行连接测试。</p>
      )}
      <section className="surface-block">
        <div className="surface-title">
          <strong>服务账号</strong>
          <span>
            {loading ? '正在同步…' : `${items.length} 个账号 · 每 15 秒刷新`}
          </span>
        </div>
        <div className="up-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>账号 / 分组</th>
                <th>状态</th>
                <th>并发</th>
                <th>剩余额度</th>
                <th>近 24 小时</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    <small className="muted-block">
                      {a.group_tag} · •••• {a.secret_last4}
                    </small>
                  </td>
                  <td>
                    <span
                      className={`up-tag ${a.status === 'ACTIVE' ? 'good' : a.status === 'INVALID' ? 'bad' : ''}`}
                    >
                      {statusNames[a.status] || a.status}
                    </span>
                    {a.cooldown_until && a.status === 'COOLDOWN' && (
                      <small className="muted-block">
                        {Math.max(
                          0,
                          Math.ceil(
                            (Date.parse(a.cooldown_until) -
                              (tick || Date.now())) /
                              1000,
                          ),
                        )}{' '}
                        秒后可探测
                      </small>
                    )}
                  </td>
                  <td>
                    {a.in_flight} / {a.concurrency_limit}
                    <small className="muted-block">
                      优先级 {a.priority} · 权重 {a.weight}
                    </small>
                  </td>
                  <td className="up-quota">
                    {a.quota_remaining.toLocaleString()} /{' '}
                    {a.quota_total.toLocaleString()}
                    <progress
                      value={a.quota_remaining}
                      max={a.quota_total}
                      aria-label={`${a.name} 剩余额度`}
                    />
                  </td>
                  <td>
                    {a.requests_24h
                      ? `${Math.round((a.successes_24h / a.requests_24h) * 100)}% 成功`
                      : '暂无请求'}
                    <small className="muted-block">
                      {a.requests_24h} 次 ·{' '}
                      {a.average_ms == null
                        ? '—'
                        : `${Math.round(a.average_ms)} ms`}
                    </small>
                  </td>
                  <td>
                    <div className="up-actions">
                      {[
                        [
                          '编辑',
                          Pencil,
                          () => setPanel({ kind: 'edit', account: a }),
                        ],
                        [
                          '测试连接',
                          Activity,
                          () =>
                            void act(async () => {
                              const r = await api.probe(a.id, me.csrf_token);
                              return r.ok
                                ? `${a.name} 连接正常 · ${r.elapsed_ms} ms`
                                : {
                                    text: `${a.name}：${failureNames[r.code || ''] || '测试失败'}`,
                                    failed: true,
                                  };
                            }, false),
                        ],
                        [
                          '更新额度',
                          Coins,
                          () => setPanel({ kind: 'quota', account: a }),
                        ],
                        [
                          '查看统计',
                          BarChart3,
                          () => setPanel({ kind: 'stats', account: a }),
                        ],
                        [
                          a.status === 'DISABLED' ? '启用' : '停用',
                          Power,
                          () =>
                            a.status === 'DISABLED'
                              ? void act(async () => {
                                  await api.saveAccount(
                                    { ...accountInput(a), enabled: true },
                                    me.csrf_token,
                                    a.id,
                                  );
                                  return '账号已启用，请测试连接。';
                                })
                              : setPanel({ kind: 'disable', account: a }),
                        ],
                        [
                          '删除',
                          Trash2,
                          () => setPanel({ kind: 'delete', account: a }),
                        ],
                      ].map(([label, Icon, action]) => {
                        const I = Icon as typeof Pencil;
                        return (
                          <Tooltip key={String(label)} content={String(label)}>
                            <button
                              key={String(label)}
                              className="icon-btn"
                              aria-label={`${label} ${a.name}`}
                              disabled={busy || loading}
                              onClick={() => {
                                setError('');
                                (action as () => void)();
                              }}
                            >
                              <I size={15} />
                            </button>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!items.length && (
          <div className="up-empty">
            {loading
              ? '正在加载账号…'
              : error
                ? '暂时无法加载账号'
                : query
                  ? '没有匹配的账号'
                  : '还没有服务账号，添加后即可为模型配置路由。'}
          </div>
        )}
      </section>
      <div className="up-toolbar">
        <p className="up-note">
          配额由管理员核对后维护；统计包含连接测试。新增后前往{' '}
          <Link to="/admin/models">模型与定价</Link> 完成绑定。
        </p>
        <div className="up-actions">
          <button
            className="btn btn-ghost"
            disabled={!history.length || loading}
            onClick={() => {
              setCursor(history[history.length - 1]);
              setHistory(history.slice(0, -1));
            }}
          >
            上一页
          </button>
          <button
            className="btn btn-ghost"
            disabled={!next || loading}
            onClick={() => {
              setHistory([...history, cursor]);
              setCursor(next || undefined);
            }}
          >
            下一页
          </button>
        </div>
      </div>
      {panel && (
        <AdminDialog
          drawer={!['disable', 'delete'].includes(panel.kind)}
          title={
            panel.kind === 'edit'
              ? panel.account
                ? '编辑服务账号'
                : '新增服务账号'
              : panel.kind === 'quota'
                ? '更新账号额度'
                : panel.kind === 'stats'
                  ? '近 24 小时统计'
                  : panel.kind === 'import'
                    ? '批量导入账号'
                    : panel.kind === 'disable'
                      ? '停用账号？'
                      : '删除账号？'
          }
          busy={busy}
          onClose={close}
        >
          {error && (
            <Feedback
              onDismiss={() => setError('')}
              className="up-message"
              variant="error"
            >
              {error}
            </Feedback>
          )}
          {panel.kind === 'edit' && (
            <AccountForm
              account={panel.account}
              busy={busy}
              onCancel={close}
              onSubmit={(body) =>
                void act(async () => {
                  await api.saveAccount(body, me.csrf_token, panel.account?.id);
                  return '账号配置已保存。下一步：测试连接，再前往模型与定价绑定账号。';
                })
              }
            />
          )}
          {panel.kind === 'quota' && (
            <QuotaForm
              account={panel.account}
              busy={busy}
              onCancel={close}
              onSubmit={(body) =>
                void act(async () => {
                  await api.quota(panel.account.id, body, me.csrf_token);
                  return '额度已更新。';
                })
              }
            />
          )}
          {panel.kind === 'import' && (
            <ImportForm
              busy={busy}
              onCancel={close}
              onSubmit={(body) =>
                void act(async () => {
                  const rows = await api.importAccounts(body, me.csrf_token);
                  return `已导入 ${rows.length} 个账号，请逐一测试连接。`;
                })
              }
            />
          )}
          {panel.kind === 'stats' && (
            <Stats account={panel.account} props={props} />
          )}
          {(panel.kind === 'disable' || panel.kind === 'delete') && (
            <>
              <p className="up-note">
                {panel.kind === 'delete'
                  ? `删除“${panel.account.name}”后将不再参与路由，历史统计和审计仍会保留。处理中请求结束前不能删除。`
                  : `停用“${panel.account.name}”后不再接收新请求，已有请求可正常结束。`}
              </p>
              <div className="up-form-footer">
                <button
                  className="btn btn-ghost"
                  data-initial-focus
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </button>
                <button
                  className="btn btn-dark"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      if (panel.kind === 'delete')
                        await api.deleteAccount(panel.account, me.csrf_token);
                      else
                        await api.saveAccount(
                          { ...accountInput(panel.account), enabled: false },
                          me.csrf_token,
                          panel.account.id,
                        );
                      return panel.kind === 'delete'
                        ? '账号已删除。'
                        : '账号已停用。';
                    })
                  }
                >
                  {busy
                    ? '正在处理…'
                    : panel.kind === 'delete'
                      ? '删除账号'
                      : '停用账号'}
                </button>
              </div>
            </>
          )}
        </AdminDialog>
      )}
    </main>
  );
}
const numeric = (form: FormData, key: string) => Number(form.get(key));
const text = (form: FormData, key: string) =>
  String(form.get(key) || '').trim();
function Footer({
  busy,
  onCancel,
  label = '保存配置',
}: {
  busy: boolean;
  onCancel: () => void;
  label?: string;
}) {
  return (
    <div className="up-form-footer">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={onCancel}
      >
        取消
      </button>
      <button className="btn btn-dark" disabled={busy}>
        {busy ? '正在保存…' : label}
      </button>
    </div>
  );
}
function QuotaFields({
  account,
  disabled = false,
}: {
  account?: Account;
  disabled?: boolean;
}) {
  return (
    <div className="up-grid">
      <label>
        总额度
        <input
          name="quota_total"
          type="number"
          min={1}
          max={1000000000000}
          required
          defaultValue={account?.quota_total ?? 100}
          disabled={disabled}
        />
      </label>
      <label>
        剩余额度
        <input
          name="quota_remaining"
          type="number"
          min={0}
          max={1000000000000}
          required
          defaultValue={account?.quota_remaining ?? 100}
          disabled={disabled}
        />
      </label>
    </div>
  );
}
function AccountForm({
  account: a,
  busy,
  onCancel,
  onSubmit,
}: {
  account?: Account;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Schema['AccountInput']) => void;
}) {
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit({
          ...(a ? accountInput(a) : {}),
          name: text(f, 'name'),
          base_url: text(f, 'base_url') || undefined,
          secret: String(f.get('secret') || '') || undefined,
          group_tag: text(f, 'group_tag'),
          priority: numeric(f, 'priority'),
          weight: numeric(f, 'weight'),
          concurrency_limit: numeric(f, 'concurrency_limit'),
          quota_total: a?.quota_total ?? numeric(f, 'quota_total'),
          quota_remaining: a?.quota_remaining ?? numeric(f, 'quota_remaining'),
          quota_reset_at:
            a?.quota_reset_at ??
            (text(f, 'reset')
              ? new Date(text(f, 'reset')).toISOString()
              : null),
          enabled: f.has('enabled'),
        });
      }}
    >
      <p className="up-note">
        连接使用 OpenAI
        兼容协议。地址和密钥保存后不再显示；编辑时留空可保留。优先级数值越小越优先，同组按权重和剩余容量分配。
      </p>
      <label>
        账号名称
        <input
          data-initial-focus
          name="name"
          required
          maxLength={120}
          defaultValue={a?.name}
        />
      </label>
      <label>
        接口地址
        <input
          name="base_url"
          type="url"
          required={!a}
          maxLength={2048}
          autoComplete="off"
          placeholder={a ? '已配置，留空保留' : 'https://api.example.com/v1'}
        />
        <small>
          支持 HTTP 和 HTTPS，可填写 localhost、本机、内网或公网地址，例如
          http://localhost:3000/v1。
        </small>
      </label>
      <label>
        API 密钥
        <input
          name="secret"
          type="password"
          required={!a}
          minLength={8}
          maxLength={8192}
          autoComplete="new-password"
          placeholder={
            a ? `已配置 •••• ${a.secret_last4}，留空保留` : '输入上游 API 密钥'
          }
        />
      </label>
      <label>
        分组
        <input
          name="group_tag"
          required
          maxLength={64}
          pattern="[A-Za-z0-9_.\-]+"
          defaultValue={a?.group_tag ?? 'default'}
        />
        <small>英文、数字、点、下划线或短横线；模型可按分组动态绑定。</small>
      </label>
      <div className="up-grid">
        <label>
          优先级
          <input
            name="priority"
            type="number"
            min={0}
            max={1000}
            required
            defaultValue={a?.priority ?? 0}
          />
        </label>
        <label>
          权重
          <input
            name="weight"
            type="number"
            min={1}
            max={1000}
            required
            defaultValue={a?.weight ?? 100}
          />
        </label>
        <label>
          并发上限
          <input
            name="concurrency_limit"
            type="number"
            min={1}
            max={64}
            required
            defaultValue={a?.concurrency_limit ?? 2}
          />
        </label>
      </div>
      <QuotaFields account={a} disabled={!!a} />
      {a ? (
        <p className="up-note">修改额度请使用列表中的“更新额度”。</p>
      ) : (
        <label>
          额度重置时间（可选）
          <DatePicker name="reset" />
          <small>
            按本地时间选择，保存为
            UTC。仅在明确的周期重置时间填写，到期探测正常后恢复总额度。
          </small>
        </label>
      )}
      <label className="up-check">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={!a || a.status !== 'DISABLED'}
        />
        参与账号池调度
      </label>
      <Footer busy={busy} onCancel={onCancel} />
    </form>
  );
}
function QuotaForm({
  account: a,
  busy,
  onCancel,
  onSubmit,
}: {
  account: Account;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Schema['QuotaInput']) => void;
}) {
  const [error, setError] = useState('');
  const local = a.quota_reset_at
    ? new Date(
        Date.parse(a.quota_reset_at) -
          new Date(a.quota_reset_at).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : '';
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const total = numeric(f, 'quota_total');
        const remaining = numeric(f, 'quota_remaining');
        if (remaining > total) {
          setError('剩余额度不能超过总额度。');
          return;
        }
        const reset = text(f, 'reset');
        onSubmit({
          revision: a.revision,
          quota_total: total,
          quota_remaining: remaining,
          quota_reset_at:
            reset === local
              ? a.quota_reset_at
              : reset
                ? new Date(reset).toISOString()
                : null,
        });
      }}
    >
      <p className="up-note">
        {a.name} ·
        请先在上游核对余额。此操作手动维护路由额度，不会查询或改变上游余额，也不修改用户积分。
      </p>
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
      <QuotaFields account={a} />
      <label>
        额度重置时间（可选）
        <DatePicker name="reset" defaultValue={local} />
        <small>按本地时间选择，保存为 UTC。</small>
      </label>
      <Footer busy={busy} onCancel={onCancel} label="更新额度" />
    </form>
  );
}
function ImportForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Schema['AccountInput'][]) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (new Blob([value]).size > 1024 * 1024) throw Error();
      const rows: unknown = JSON.parse(value);
      if (!Array.isArray(rows) || !rows.length || rows.length > 100)
        throw Error();
      onSubmit(rows as Schema['AccountInput'][]);
    } catch {
      setError('请输入有效 JSON 数组，1–100 个账号，文件不超过 1 MB。');
    }
  }
  return (
    <form className="up-form" onSubmit={submit}>
      <p className="up-note">
        一次最多 100 个账号，全部校验通过后统一保存。文件内须包含
        name、base_url、secret、group_tag、priority、weight、concurrency_limit、quota_total、quota_remaining、enabled。导入材料仅在此页面临时使用。
      </p>
      <label>
        选择 JSON 文件
        <input
          type="file"
          accept=".json,application/json"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            if (file.size > 1024 * 1024) {
              setError('文件不能超过 1 MB。');
              return;
            }
            setValue(await file.text());
            setError('');
          }}
        />
      </label>
      <label>
        账号 JSON
        <textarea
          data-initial-focus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          placeholder={
            '[{"name":"主账号","base_url":"https://api.example.com/v1","secret":"…","group_tag":"default","priority":0,"weight":100,"concurrency_limit":2,"quota_total":100,"quota_remaining":100,"enabled":true}]'
          }
        />
      </label>
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
      <Footer busy={busy} onCancel={onCancel} label="校验并导入" />
    </form>
  );
}
function Stats({ account, props }: { account: Account; props: AdminProps }) {
  const [data, setData] = useState<Schema['AccountStats']>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const { me, onExpired, onReload } = props;
  useEffect(() => {
    const a = new AbortController();
    void api
      .stats(account.id, a.signal)
      .then(setData)
      .catch((e) => {
        if (!a.signal.aborted)
          setError(errorText(e, { me, onExpired, onReload }));
      });
    return () => a.abort();
  }, [account.id, me, onExpired, onReload, attempt]);
  return (
    <>
      <p className="up-note">{account.name} · 最近 24 小时，包含连接测试</p>
      {error ? (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
          <button
            className="btn btn-ghost"
            onClick={() => {
              setError('');
              setAttempt(attempt + 1);
            }}
          >
            重试加载
          </button>
        </Feedback>
      ) : !data ? (
        <p role="status">正在加载统计…</p>
      ) : (
        <>
          <div className="up-metrics">
            <div>
              <small>请求总数</small>
              <strong>{data.total}</strong>
            </div>
            <div>
              <small>成功率</small>
              <strong>
                {data.total
                  ? `${Math.round((data.successes / data.total) * 100)}%`
                  : '—'}
              </strong>
            </div>
            <div>
              <small>平均耗时</small>
              <strong>
                {data.average_ms == null ? '—' : Math.round(data.average_ms)}
              </strong>
              <small>ms</small>
            </div>
          </div>
          {data.errors.length ? (
            data.errors.map((v) => (
              <p className="up-note" key={v.code}>
                {failureNames[v.code] || v.code} · {v.count} 次
              </p>
            ))
          ) : (
            <p className="up-note">暂无失败请求。</p>
          )}
        </>
      )}
    </>
  );
}
