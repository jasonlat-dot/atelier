import { useToast } from '../../components/Toast';
import Tooltip from '../../components/Tooltip';
import { useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, SlidersHorizontal } from 'lucide-react';
import Feedback from '../../components/Feedback';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import { adminApi as api, integer, roles, statuses, when } from './adminApi';
import { AdminFeedback, Badge } from './AdminUI';
import UserAction, { type Action } from './UserActionDialog';
import UserLedger from './UserLedger';
import { UserDevices, UserReview } from './UserDetailsPanels';
import './AdminUsersPage.css';
import './UserDetailsDrawer.css';

const tabs = [
  ['overview', '概览'],
  ['ledger', '积分流水'],
  ['devices', '登录设备'],
  ['review', '违规与审计'],
] as const;
type Tab = (typeof tabs)[number][0];

export default function UserDrawer(
  props: AdminProps & { id: string; onClose: () => void },
) {
  const client = useQueryClient();
  const updateWallet = useWalletSummaryUpdate();
  const query = useQuery({
    queryKey: ['adminUser', props.id],
    queryFn: ({ signal }) => api.user(props.id, signal),
  });
  const [tab, setTab] = useState<Tab>('overview');
  const [action, setAction] = useState<Action>();
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [copyFailed, setCopyFailed] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const tabId = useId();
  const d = query.data;
  const u = d?.user;
  const own = u?.id === props.me.user.id;
  const canManage =
    !!u && (props.me.user.role === 'SUPER_ADMIN' || u.role === 'USER');
  const protectedAccount = own || u?.role === 'SUPER_ADMIN';
  const selectTab = (next: Tab) => {
    setTab(next);
    if (body.current) body.current.scrollTop = 0;
  };
  async function done(text: string) {
    setAction(undefined);
    setMessage(text);
    if (own)
      void walletApi
        .summary()
        .then(updateWallet)
        .catch(() => {});
    await Promise.all([
      client.invalidateQueries({ queryKey: ['adminUsers'] }),
      client.invalidateQueries({ queryKey: ['adminUser', props.id] }),
      client.invalidateQueries({ queryKey: ['adminDashboard'] }),
      client.invalidateQueries({ queryKey: ['adminJobs'] }),
      client.invalidateQueries({ queryKey: ['userAudit', props.id] }),
      client.invalidateQueries({ queryKey: ['ownSessions', props.id] }),
    ]);
  }
  return (
    <AdminDialog
      title="用户详情"
      drawer
      className="users-detail-dialog"
      onClose={props.onClose}
    >
      <AdminFeedback
        props={props}
        error={query.error}
        message={message}
        onDismissMessage={() => setMessage('')}
      />
      {copyFailed && (
        <Feedback variant="error" onDismiss={() => setCopyFailed(false)}>
          复制失败，请手动复制完整用户 ID：{props.id}
        </Feedback>
      )}
      {u && d && (
        <>
          <div className="users-detail-header">
            <section className="admin-profile">
              <span className="admin-avatar large" aria-hidden="true">
                {Array.from(u.display_name || u.email)[0]?.toUpperCase()}
              </span>
              <div className="users-profile-identity">
                <h3>{u.display_name}</h3>
                <p>{u.email}</p>
                <div className="users-profile-badges">
                  <span
                    className={`users-role-tag ${u.role === 'SUPER_ADMIN' ? 'users-role-super' : ''}`}
                  >
                    {roles[u.role] || u.role}
                  </span>
                  <Badge bad={u.status === 'DISABLED'}>
                    {u.status === 'ACTIVE' ? '正常' : '已禁用'}
                  </Badge>
                  {d.pending_review && (
                    <span className="users-review-badge">待复核</span>
                  )}
                </div>
              </div>
            </section>
            <div className="admin-detail-metrics">
              <div>
                <small>可用积分</small>
                <strong>{integer(u.balance - u.held)}</strong>
              </div>
              <div>
                <small>积分总额</small>
                <strong>{integer(u.balance)}</strong>
              </div>
              <div>
                <small>任务预占</small>
                <strong>{integer(u.held)}</strong>
              </div>
            </div>
          </div>
          <div
            className="users-detail-tabs"
            role="tablist"
            aria-label="用户详情分类"
            onKeyDown={(event) => {
              const index = tabs.findIndex(([value]) => value === tab);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : undefined;
              if (next == null) return;
              event.preventDefault();
              selectTab(tabs[next][0]);
              const buttons =
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              buttons[next]?.focus();
            }}
          >
            {tabs.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                id={`${tabId}-${value}`}
                aria-controls={`${tabId}-${value}-panel`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => selectTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="users-detail-body" ref={body}>
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
        {!u && query.isError && (
          <div className="users-detail-empty">
            <p>用户详情暂未读取</p>
            <button
              className="btn btn-light"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              重新加载
            </button>
          </div>
        )}
        {u && d && (
          <>
            <section
              role="tabpanel"
              id={`${tabId}-overview-panel`}
              aria-labelledby={`${tabId}-overview`}
              hidden={tab !== 'overview'}
              tabIndex={0}
            >
              <h3 className="users-panel-title">基本信息</h3>
              <dl className="admin-detail-list">
                <div>
                  <dt>用户 ID</dt>
                  <dd className="users-id-field">
                    <span tabIndex={0} className="admin-id" data-tip={u.id}>
                      {u.id.slice(0, 8)}…
                    </span>
                    <button
                      className="users-copy-button"
                      data-tip={`复制完整用户 ID：${u.id}`}
                      aria-label="复制用户 ID"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(u.id);
                          toast('用户 ID 已复制');
                        } catch {
                          setCopyFailed(true);
                        }
                      }}
                    >
                      <Copy size={13} aria-hidden="true" />
                      复制
                    </button>
                  </dd>
                </div>
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
                <div>
                  <dt>最近会话 IP</dt>
                  <dd>{d.sessions[0]?.ip || '未记录'}</dd>
                </div>
              </dl>
              {u.disabled_reason && (
                <div className="users-disabled-reason">
                  禁用原因：{u.disabled_reason}
                </div>
              )}
              <section className="users-recent-jobs">
                <header>
                  <h3 className="users-panel-title">最近任务</h3>
                  <Link to={`/admin/jobs?user=${encodeURIComponent(u.id)}`}>
                    查看全部 →
                  </Link>
                </header>
                {d.jobs.length ? (
                  d.jobs.map((job) => (
                    <div className="users-job-row" key={job.id}>
                      <div>
                        <strong>{job.display_name}</strong>
                        <small>
                          {when(job.created_at)} · {job.id.slice(0, 8)}
                        </small>
                      </div>
                      <span
                        className={`users-job-state ${job.status === 'FAILED' ? 'users-negative' : ''}`}
                      >
                        {statuses[job.status] || job.status}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="users-detail-empty">暂无生成任务</p>
                )}
              </section>
            </section>
            <section
              role="tabpanel"
              id={`${tabId}-ledger-panel`}
              aria-labelledby={`${tabId}-ledger`}
              hidden={tab !== 'ledger'}
              tabIndex={0}
            >
              <UserLedger
                key={query.dataUpdatedAt}
                user={u.id}
                initial={d.ledger}
                jobs={d.jobs}
                props={props}
              />
            </section>
            <section
              role="tabpanel"
              id={`${tabId}-devices-panel`}
              aria-labelledby={`${tabId}-devices`}
              hidden={tab !== 'devices'}
              tabIndex={0}
            >
              {tab === 'devices' && (
                <UserDevices sessions={d.sessions} user={u.id} props={props} />
              )}
            </section>
            <section
              role="tabpanel"
              id={`${tabId}-review-panel`}
              aria-labelledby={`${tabId}-review`}
              hidden={tab !== 'review'}
              tabIndex={0}
            >
              {tab === 'review' && <UserReview user={u} props={props} />}
            </section>
          </>
        )}
      </div>
      {u && d && (
        <footer className="users-detail-footer">
          {!canManage && <p>其他管理员账号由超级管理员管理。</p>}
          <div className="users-detail-actions">
            <button
              className="btn btn-dark"
              disabled={!canManage}
              onClick={() => setAction('credits')}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              调整积分
            </button>
            <button
              className="btn btn-light"
              disabled={!canManage}
              onClick={() => setAction('revoke-sessions')}
            >
              强制下线
            </button>
            {d.pending_review && (
              <button
                className="btn btn-light"
                disabled={!canManage}
                onClick={() => setAction('review')}
              >
                标记已复核
              </button>
            )}
            {props.me.user.role === 'SUPER_ADMIN' && (
              <Tooltip
                content={
                  own
                    ? '请由其他超级管理员变更当前账号的角色，必须保留有效超级管理员。'
                    : undefined
                }
              >
                <button
                  className="btn btn-light"
                  disabled={own}
                  onClick={() => setAction('role')}
                >
                  变更角色
                </button>
              </Tooltip>
            )}
            <Tooltip
              wrapperClassName="users-account-status-action"
              content={
                u.status === 'ACTIVE' && protectedAccount
                  ? u.role === 'SUPER_ADMIN'
                    ? '不能禁用超级管理员账号'
                    : '不能禁用当前登录账号'
                  : undefined
              }
            >
              <button
                className={`btn btn-light users-account-status-action ${u.status === 'ACTIVE' ? 'users-disable-button' : ''}`}
                disabled={
                  !canManage || (u.status === 'ACTIVE' && protectedAccount)
                }
                onClick={() =>
                  setAction(u.status === 'ACTIVE' ? 'disable' : 'enable')
                }
              >
                {u.status === 'ACTIVE' ? '禁用账号' : '恢复账号'}
              </button>
            </Tooltip>
          </div>
        </footer>
      )}
      {u && d && action && (
        <UserAction
          {...props}
          user={u}
          action={action}
          limit={d.adjust_limit}
          onClose={() => setAction(undefined)}
          onDone={done}
        />
      )}
    </AdminDialog>
  );
}
