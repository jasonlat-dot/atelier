import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, UserRound } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { SessionError } from '../auth/sessionApi';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import {
  adminApi as api,
  integer,
  roles,
  statuses,
  when,
  type AdminSchema,
  type User,
} from './adminApi';
import {
  AdminAccess,
  AdminFeedback,
  AdminFrame,
  Badge,
  EmptyRow,
  PageNav,
  TableLoading,
  useAdminCursor,
} from './AdminUI';
import '../upstream/AdminUpstream.css';
type Action =
  'credits' | 'disable' | 'enable' | 'role' | 'revoke-sessions' | 'review';
export default function AdminUsersPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Users {...props} />
    </AdminAccess>
  );
}
function Users(props: AdminProps) {
  const [url] = useSearchParams();
  const [q, setQ] = useState(url.get('q') || '');
  const [draft, setDraft] = useState(q);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [selected, setSelected] = useState<string | undefined>(
    url.get('user') || undefined,
  );
  const cursor = useAdminCursor<string>();
  const query = useQuery({
    queryKey: ['adminUsers', q, status, role, cursor.before],
    queryFn: ({ signal }) => api.users(q, status, role, cursor.before, signal),
  });
  return (
    <AdminFrame
      title="用户管理"
      description="核对账户状态、积分与任务。所有管理变更都需要说明并保留记录。"
      loading={query.isFetching}
      onRefresh={() => void query.refetch()}
    >
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          cursor.reset();
          setQ(draft.trim());
        }}
      >
        <label className="admin-search">
          <Search size={16} />
          <input
            className="input"
            aria-label="搜索用户"
            placeholder="搜索昵称、邮箱或用户 ID"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={120}
          />
        </label>
        <select
          className="input"
          aria-label="用户状态筛选"
          value={status}
          onChange={(e) => {
            cursor.reset();
            setStatus(e.target.value);
          }}
        >
          <option value="">全部状态</option>
          <option value="ACTIVE">正常</option>
          <option value="DISABLED">已禁用</option>
        </select>
        <select
          className="input"
          aria-label="用户角色筛选"
          value={role}
          onChange={(e) => {
            cursor.reset();
            setRole(e.target.value);
          }}
        >
          <option value="">全部角色</option>
          {Object.entries(roles).map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
        <button className="btn btn-light">搜索</button>
        <button
          className="text-action"
          type="button"
          onClick={() => {
            setDraft('');
            setQ('');
            setStatus('');
            setRole('');
            cursor.reset();
          }}
        >
          重置筛选
        </button>
      </form>
      <AdminFeedback props={props} error={query.error} />
      <section className="admin-panel admin-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>积分</th>
                <th>状态</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.isPending ? (
                <TableLoading columns={6} />
              ) : query.data?.items.length ? (
                query.data.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="admin-person">
                        <span className="admin-avatar">
                          <UserRound size={18} />
                        </span>
                        <div>
                          <strong>{u.display_name}</strong>
                          <small>{u.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>{roles[u.role] || u.role}</td>
                    <td>
                      <strong className="admin-number">
                        {integer(u.balance - u.held)}
                      </strong>
                      <small>
                        总额 {integer(u.balance)} · 预占 {integer(u.held)}
                      </small>
                    </td>
                    <td>
                      <Badge bad={u.status === 'DISABLED'}>
                        {u.status === 'ACTIVE' ? '正常' : '已禁用'}
                      </Badge>
                      {u.violations > 0 && (
                        <small>30 天内违规 {u.violations} 次</small>
                      )}
                    </td>
                    <td>{when(u.last_login_at)}</td>
                    <td>
                      <button
                        className="btn btn-light"
                        onClick={() => setSelected(u.id)}
                      >
                        查看用户
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                !query.error && (
                  <EmptyRow columns={6}>没有符合筛选条件的用户。</EmptyRow>
                )
              )}
            </tbody>
          </table>
        </div>
        <PageNav
          cursor={cursor}
          next={query.data?.next_cursor}
          loading={query.isFetching}
        />
      </section>
      {selected && (
        <UserDrawer
          {...props}
          id={selected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </AdminFrame>
  );
}
function UserDrawer(props: AdminProps & { id: string; onClose: () => void }) {
  const client = useQueryClient();
  const updateWallet = useWalletSummaryUpdate();
  const query = useQuery({
    queryKey: ['adminUser', props.id],
    queryFn: ({ signal }) => api.user(props.id, signal),
  });
  const [action, setAction] = useState<Action>();
  const [message, setMessage] = useState('');
  const d = query.data;
  const u = d?.user;
  const canManage =
    u && (props.me.user.role === 'SUPER_ADMIN' || u.role === 'USER');
  async function done(text: string) {
    setAction(undefined);
    setMessage(text);
    if (props.id === props.me.user.id) {
      void walletApi
        .summary()
        .then(updateWallet)
        .catch(() => {});
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: ['adminUsers'] }),
      client.invalidateQueries({ queryKey: ['adminUser', props.id] }),
      client.invalidateQueries({ queryKey: ['adminDashboard'] }),
    ]);
  }
  return (
    <AdminDialog title="用户详情" drawer onClose={props.onClose}>
      <AdminFeedback props={props} error={query.error} message={message} />
      {query.isPending && (
        <div
          className="admin-skeleton"
          role="status"
          aria-label="正在读取用户详情"
        >
          <span />
          <span />
          <span />
        </div>
      )}
      {u && d && (
        <>
          <section className="admin-profile">
            <span className="admin-avatar large">
              <UserRound size={25} />
            </span>
            <h3>{u.display_name}</h3>
            <p>{u.email}</p>
            <div>
              <Badge>{roles[u.role] || u.role}</Badge>
              <Badge bad={u.status === 'DISABLED'}>
                {u.status === 'ACTIVE' ? '正常' : '已禁用'}
              </Badge>
            </div>
            <small className="admin-id">{u.id}</small>
          </section>
          <div className="admin-detail-metrics">
            <div>
              <small>可用积分</small>
              <strong>{integer(u.balance - u.held)}</strong>
            </div>
            <div>
              <small>任务预占</small>
              <strong>{integer(u.held)}</strong>
            </div>
            <div>
              <small>30 天违规</small>
              <strong>{integer(u.violations)}</strong>
            </div>
          </div>
          {u.disabled_reason && (
            <p className="admin-feedback admin-error">
              禁用原因：{u.disabled_reason}
            </p>
          )}
          <dl className="admin-detail-list">
            <div>
              <dt>注册时间</dt>
              <dd>{when(u.created_at)}</dd>
            </div>
            <div>
              <dt>最近登录</dt>
              <dd>{when(u.last_login_at)}</dd>
            </div>
            <div>
              <dt>验证器</dt>
              <dd>{u.mfa_enabled ? '已绑定' : '未绑定'}</dd>
            </div>
          </dl>
          <div className="admin-user-actions">
            <button
              className="btn btn-dark"
              disabled={!canManage}
              onClick={() => setAction('credits')}
            >
              <SlidersHorizontal size={15} />
              调整积分
            </button>
            <button
              className="btn btn-light"
              disabled={
                !canManage ||
                (u.id === props.me.user.id && u.status === 'ACTIVE')
              }
              onClick={() =>
                setAction(u.status === 'ACTIVE' ? 'disable' : 'enable')
              }
            >
              {u.status === 'ACTIVE' ? '禁用账号' : '恢复账号'}
            </button>
            <button
              className="btn btn-light"
              disabled={!canManage}
              onClick={() => setAction('revoke-sessions')}
            >
              强制下线
            </button>
            <button
              className="btn btn-light"
              disabled={!canManage}
              onClick={() => setAction('review')}
            >
              标记已复核
            </button>
            {props.me.user.role === 'SUPER_ADMIN' && (
              <button
                className="btn btn-light"
                onClick={() => setAction('role')}
              >
                变更角色
              </button>
            )}
          </div>
          {!canManage && (
            <p className="admin-note">其他管理员账号由超级管理员管理。</p>
          )}
          <section className="admin-drawer-section">
            <header>
              <h3>最近任务</h3>
              <Link to={`/admin/jobs?user=${encodeURIComponent(u.id)}`}>
                查看全部 →
              </Link>
            </header>
            {d.jobs.length ? (
              d.jobs.map((j) => (
                <div className="admin-detail-row" key={j.id}>
                  <div>
                    <strong>{j.display_name}</strong>
                    <small>{j.id}</small>
                  </div>
                  <span>{statuses[j.status] || j.status}</span>
                </div>
              ))
            ) : (
              <p className="admin-note">暂无生成任务</p>
            )}
          </section>
          <section className="admin-drawer-section">
            <header>
              <h3>有效登录设备</h3>
              <small>最多展示最近 20 台</small>
            </header>
            {d.sessions.length ? (
              d.sessions.map((s) => (
                <div className="admin-detail-row" key={s.id}>
                  <div>
                    <strong>{s.user_agent || '未知设备'}</strong>
                    <small>
                      {s.ip || '未记录 IP'} · {when(s.last_seen_at)}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="admin-note">当前没有有效设备</p>
            )}
          </section>
          <Ledger
            key={query.dataUpdatedAt}
            user={u.id}
            initial={d.ledger}
            props={props}
          />
          {action && (
            <UserAction
              {...props}
              user={u}
              action={action}
              limit={d.adjust_limit}
              onClose={() => setAction(undefined)}
              onDone={done}
            />
          )}
        </>
      )}
    </AdminDialog>
  );
}
function Ledger({
  user,
  initial,
  props,
}: {
  user: string;
  initial: AdminSchema['LedgerPage'];
  props: AdminProps;
}) {
  const [entries, setEntries] = useState(initial.items);
  const [next, setNext] = useState(initial.next_cursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <section className="admin-drawer-section">
      <header>
        <h3>积分流水</h3>
      </header>
      <AdminFeedback props={props} error={error} />
      {entries.length ? (
        entries.map((l) => (
          <div className="admin-detail-row" key={l.id}>
            <div>
              <strong>
                {{
                  ADMIN_ADJUST: '管理员调整',
                  REFUND: '积分返还',
                  SETTLE: '任务结算',
                  HOLD: '任务预占',
                  RELEASE: '释放预占',
                  SIGNUP: '注册赠送',
                  CHECKIN: '签到奖励',
                  REDEEM: '兑换入账',
                  PURCHASE: '购买积分',
                }[l.type] || l.type}
              </strong>
              <small>{l.reason || when(l.created_at)}</small>
            </div>
            <span className="admin-ledger-amount">
              {l.balance_delta > 0 ? '+' : ''}
              {integer(l.balance_delta)}
              <small>
                预占 {l.held_delta > 0 ? '+' : ''}
                {integer(l.held_delta)}
              </small>
            </span>
          </div>
        ))
      ) : (
        <p className="admin-note">暂无积分流水</p>
      )}
      {next && (
        <button
          className="btn btn-light"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try {
              const p = await api.ledger(user, next);
              setEntries((v) => [...v, ...p.items]);
              setNext(p.next_cursor);
              setError(undefined);
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          加载更多流水
        </button>
      )}
    </section>
  );
}
function UserAction(
  props: AdminProps & {
    user: User;
    action: Action;
    limit: number;
    onClose: () => void;
    onDone: (message: string) => Promise<void>;
  },
) {
  const u = props.user;
  const a = props.action;
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [role, setRole] = useState(u.role);
  const [review, setReview] = useState(a !== 'credits');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const pending = useRef<{ key: string; amount: number; reason: string }>();
  const labels: Record<Action, string> = {
    credits: '调整积分',
    disable: '禁用账号',
    enable: '恢复账号',
    role: '变更角色',
    'revoke-sessions': '强制下线',
    review: '标记已复核',
  };
  const delta = Number(amount);
  const invalid =
    a === 'credits' &&
    (!Number.isSafeInteger(delta) ||
      !delta ||
      Math.abs(delta) > props.limit ||
      (delta < 0 && -delta > u.balance - u.held));
  return (
    <AdminDialog title={labels[a]} busy={busy} onClose={props.onClose}>
      <form
        className="admin-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (lock.current || invalid || !reason.trim()) return;
          if (!review) {
            setReview(true);
            return;
          }
          lock.current = true;
          setBusy(true);
          setError(undefined);
          try {
            if (a === 'credits') {
              if (!pending.current)
                pending.current = {
                  key: crypto.randomUUID(),
                  amount: delta,
                  reason: reason.trim(),
                };
              await api.credits(
                u.id,
                pending.current.amount,
                pending.current.reason,
                props.me.csrf_token,
                pending.current.key,
              );
            } else {
              await api.userAction(
                u.id,
                a,
                {
                  revision: u.revision,
                  reason: reason.trim(),
                  role: a === 'role' ? role : null,
                },
                props.me.csrf_token,
              );
            }
            if (
              u.id === props.me.user.id &&
              (a === 'role' || a === 'revoke-sessions')
            ) {
              props.onExpired();
              return;
            }
            await props.onDone(`${labels[a]}已完成`);
          } catch (e) {
            setError(e);
            if (
              a === 'credits' &&
              (!(e instanceof SessionError) || e.status >= 500)
            )
              setUncertain(true);
            else pending.current = undefined;
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="admin-confirm-target">
          <strong>{u.display_name}</strong>
          <span>{u.email}</span>
        </div>
        {a === 'credits' ? (
          <>
            {review ? (
              <div className="admin-confirm-summary">
                <h3>
                  确认{delta > 0 ? '增加' : '扣减'} {integer(Math.abs(delta))}{' '}
                  积分？
                </h3>
                <p>
                  当前可用 {integer(u.balance - u.held)}，调整后预计可用{' '}
                  {integer(u.balance - u.held + delta)}
                  。提交时会重新核对可用余额。
                </p>
                <p>处理说明：{reason}</p>
              </div>
            ) : (
              <label>
                调整积分
                <input
                  data-initial-focus
                  className="input"
                  type="number"
                  required
                  step={1}
                  min={-props.limit}
                  max={props.limit}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <small>
                  正数增加，负数扣减；单次最多 {integer(props.limit)}
                  ，不能扣减任务预占部分。
                </small>
              </label>
            )}
          </>
        ) : a === 'role' ? (
          <>
            <label>
              新角色
              <select
                aria-label="新角色"
                className="input"
                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value)}
              >
                {Object.entries(roles).map(([r, label]) => (
                  <option key={r} value={r}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p className="admin-note">
              变更后立即撤销此账号的全部会话；管理员再次登录必须完成验证器验证。必须保留至少一个有效超级管理员。
            </p>
          </>
        ) : (
          <p className="admin-note">
            {a === 'disable'
              ? '禁用后立即撤销全部会话并取消排队任务；运行中的生成会停止，未结算的预占由任务释放。恢复账号不会重新提交这些任务。'
              : a === 'enable'
                ? '恢复后可以重新登录。之前取消的任务不会自动重新运行。'
                : a === 'revoke-sessions'
                  ? '此账号的全部设备将立即退出，需要重新使用 Google 登录。'
                  : '标记后会从运营总览的待复核通知中移除，不会自动改变账号状态。'}
          </p>
        )}
        {(!review || a !== 'credits') && (
          <label>
            处理说明
            <textarea
              data-initial-focus={a !== 'credits' ? true : undefined}
              className="input"
              required
              maxLength={500}
              value={reason}
              disabled={busy || uncertain}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <AdminFeedback props={props} error={error} />
        {uncertain && (
          <p className="admin-note">
            本次结果尚未确认，重试会保持原积分与说明；也可以关闭后先核对最新流水。
          </p>
        )}
        <footer className="admin-form-actions">
          {a === 'credits' && review && !uncertain && (
            <button
              className="btn btn-light"
              type="button"
              disabled={busy}
              onClick={() => {
                setReview(false);
                pending.current = undefined;
              }}
            >
              返回修改
            </button>
          )}
          <button
            className="btn btn-light"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            className="btn btn-dark"
            disabled={
              busy ||
              !reason.trim() ||
              invalid ||
              (a === 'role' && role === u.role)
            }
          >
            {busy
              ? '正在处理…'
              : a === 'credits'
                ? review
                  ? uncertain
                    ? '按原内容重试'
                    : '确认调整积分'
                  : '核对调整'
                : `确认${labels[a]}`}
          </button>
        </footer>
      </form>
    </AdminDialog>
  );
}
