import { useToast } from '../../components/Toast';
import Feedback from '../../components/Feedback';
import Tooltip from '../../components/Tooltip';
import {
  Copy,
  Search,
  Layers,
  Clock3,
  CircleCheck,
  Ban,
  Timer,
  Route,
  Save,
  CircleX,
  CircleDashed,
  Image,
  Video,
  Inbox,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { SessionError } from '../auth/sessionApi';
import { failureDescription } from '../generation/generationApi';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import { adminApi as api, integer, statuses, type Job } from './adminApi';
import UserDrawer from './UserDetailsDrawer';
import {
  AdminAccess,
  AdminFeedback,
  AdminFrame,
  EmptyRow,
  PageNav,
  TableLoading,
  useAdminCursor,
} from './AdminUI';
import '../upstream/AdminUpstream.css';
import './AdminJobsPage.css';
const activeStatuses = ['QUEUED', 'ROUTING', 'RUNNING', 'STORING'];
const statusCards = [
  { status: '', label: '全部任务', Icon: Layers, tone: 'all' },
  { status: 'SUCCEEDED', label: '已完成', Icon: CircleCheck, tone: 'done' },
  { status: 'CANCELLED', label: '已取消', Icon: Ban, tone: 'cancelled' },
  { status: 'FAILED', label: '已失败', Icon: CircleX, tone: 'failed' },
  { status: 'PARTIAL', label: '部分完成', Icon: CircleDashed, tone: 'partial' },
  { status: 'QUEUED', label: '排队中', Icon: Timer, tone: 'active' },
  { status: 'ROUTING', label: '正在分配', Icon: Route, tone: 'active' },
  { status: 'RUNNING', label: '生成中', Icon: Clock3, tone: 'active' },
  { status: 'STORING', label: '正在保存', Icon: Save, tone: 'active' },
];
function JobTime({ value }: { value?: string | null }) {
  if (!value) return <span className="jobs-muted">—</span>;
  const date = new Date(value);
  return (
    <time className="jobs-time" dateTime={value}>
      <span>
        {date.toLocaleDateString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })}
      </span>
      <small>{date.toLocaleTimeString('zh-CN', { hour12: false })}</small>
    </time>
  );
}
export default function AdminJobsPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Jobs {...props} />
    </AdminAccess>
  );
}
function Jobs(props: AdminProps) {
  const updateWallet = useWalletSummaryUpdate();
  const [url, setUrl] = useSearchParams();
  const owner = url.get('user') || undefined;
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const cursor = useAdminCursor<string>();
  const client = useQueryClient();
  const [action, setAction] = useState<{
    job: Job;
    action: 'cancel' | 'refund';
  }>();
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>();
  const [copyFallback, setCopyFallback] = useState<{
    value: string;
    label: '任务编号' | '邮箱';
  }>();
  const query = useQuery({
    queryKey: ['adminJobs', q, status, owner, cursor.before],
    queryFn: ({ signal }) => api.jobs(q, status, owner, cursor.before, signal),
  });
  const items = query.data?.items;
  const clearOwner = () => {
    setUrl((current) => {
      const next = new URLSearchParams(current);
      next.delete('user');
      return next;
    });
    cursor.reset();
  };
  const clearFilters = () => {
    setDraft('');
    setQ('');
    setStatus('');
    clearOwner();
  };
  const copyText = async (value: string, label: '任务编号' | '邮箱') => {
    setCopyFallback(undefined);
    try {
      await navigator.clipboard.writeText(value);
      toast(label === '邮箱' ? '邮箱已复制' : '任务 ID 已复制');
    } catch {
      setCopyFallback({ value, label });
    }
  };
  return (
    <>
      <AdminFrame
        className="admin-jobs-page"
        title="任务管理"
        description="查看生成任务、取消未完成任务或补偿已实际结算的积分。"
        loading={query.isFetching}
        onRefresh={() => void query.refetch()}
      >
        <section className="jobs-stats" aria-label="任务状态筛选">
          {statusCards.map(({ status: value, label, Icon, tone }) => (
            <button
              type="button"
              className="jobs-stat"
              key={value}
              data-tone={tone}
              aria-pressed={status === value}
              aria-label={label}
              onClick={() => {
                setStatus(value);
                cursor.reset();
              }}
            >
              <span className="jobs-stat-heading">
                <span>{label}</span>
                <Icon size={17} aria-hidden="true" />
              </span>
              <strong>
                {query.data?.counts?.[value || 'ALL'] === undefined
                  ? '—'
                  : integer(query.data.counts[value || 'ALL'])}
              </strong>
            </button>
          ))}
        </section>
        <p className="jobs-stats-scope">
          点击卡片筛选状态；数量按当前搜索和用户范围汇总，不受状态筛选或分页影响。
        </p>
        <form
          className="admin-filters jobs-filters"
          onSubmit={(e) => {
            e.preventDefault();
            cursor.reset();
            setQ(draft.trim());
          }}
        >
          <label className="jobs-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索任务"
              placeholder="任务 ID、用户邮箱、公开模型"
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button className="btn btn-dark">搜索</button>
          {owner && (
            <button className="text-action" type="button" onClick={clearOwner}>
              清除用户限定
            </button>
          )}
        </form>
        <AdminFeedback
          props={props}
          error={query.error}
          message={message}
          onDismissMessage={() => setMessage('')}
        />
        <section className="admin-panel admin-table-panel">
          <div className="admin-table-scroll">
            <table className="admin-table jobs-table">
              <colgroup>
                <col className="jobs-col-model" />
                <col className="jobs-col-user" />
                <col className="jobs-col-status" />
                <col className="jobs-col-credits" />
                <col className="jobs-col-created" />
                <col className="jobs-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">任务与模型</th>
                  <th scope="col">用户</th>
                  <th scope="col">状态</th>
                  <th scope="col">积分结算</th>
                  <th scope="col">创建时间</th>
                  <th scope="col">处置</th>
                </tr>
              </thead>
              <tbody>
                {query.isPending ? (
                  <TableLoading columns={6} />
                ) : query.data?.items.length ? (
                  query.data.items.map((j) => {
                    const active = activeStatuses.includes(j.status);
                    const failure =
                      j.error_code || j.status === 'FAILED'
                        ? failureDescription(j.error_code)
                        : undefined;
                    const tone = active
                      ? 'active'
                      : j.status === 'FAILED'
                        ? 'failed'
                        : j.status === 'SUCCEEDED'
                          ? 'done'
                          : j.status === 'PARTIAL'
                            ? 'partial'
                            : 'cancelled';
                    const cancelReason = !active
                      ? '任务已结束，无法取消'
                      : j.cancel_requested
                        ? '已提交取消请求，等待任务释放'
                        : undefined;
                    const refundReason = active
                      ? '请等待任务结束后再补偿'
                      : j.settled <= 0
                        ? '没有实际结算积分可补偿'
                        : j.refunded > 0
                          ? '该任务已补偿，不能重复补偿'
                          : undefined;
                    return (
                      <tr key={j.id}>
                        <td data-label="任务与模型" className="jobs-model-cell">
                          <strong
                            className="jobs-model-name"
                            tabIndex={0}
                            data-tip={j.display_name}
                          >
                            {j.display_name}
                          </strong>
                          <button
                            className="jobs-id"
                            type="button"
                            aria-label={`复制任务 ID ${j.id}`}
                            data-tip={j.id}
                            onClick={() => void copyText(j.id, '任务编号')}
                          >
                            <span>{j.id}</span>
                            <Copy size={12} aria-hidden="true" />
                          </button>
                          <div className="jobs-model-meta">
                            <span className="jobs-kind">
                              {j.kind === 'image' ? (
                                <Image size={12} aria-hidden="true" />
                              ) : (
                                <Video size={12} aria-hidden="true" />
                              )}
                              {j.kind === 'image' ? '图片' : '视频'}
                            </span>
                            <span
                              className="jobs-model-id"
                              tabIndex={0}
                              data-tip={j.model_id}
                            >
                              {j.model_id}
                            </span>
                          </div>
                        </td>
                        <td data-label="用户" className="jobs-user-cell">
                          <div className="jobs-user-actions">
                            <button
                              type="button"
                              className="jobs-user-link"
                              data-tip={j.email}
                              aria-label={`查看用户 ${j.email}`}
                              onClick={() => setSelectedUser(j.owner_id)}
                            >
                              {j.email}
                            </button>
                            <Tooltip content="复制邮箱">
                              <button
                                type="button"
                                className="jobs-copy-email"
                                aria-label={`复制邮箱 ${j.email}`}
                                onClick={() => void copyText(j.email, '邮箱')}
                              >
                                <Copy size={13} aria-hidden="true" />
                              </button>
                            </Tooltip>
                          </div>
                        </td>
                        <td data-label="状态">
                          <span className="jobs-status" data-tone={tone}>
                            <i aria-hidden="true" />
                            {statuses[j.status] || j.status}
                          </span>
                          <div className="jobs-status-meta">
                            {active ? (
                              <>
                                <span>
                                  {j.progress}% · 尝试 {j.attempts} 次
                                </span>
                                <span
                                  className="jobs-progress"
                                  aria-hidden="true"
                                >
                                  <i
                                    style={{
                                      width: `${Math.min(100, Math.max(0, j.progress))}%`,
                                    }}
                                  />
                                </span>
                              </>
                            ) : (
                              <JobTime value={j.finished_at} />
                            )}
                          </div>
                          {j.cancel_requested && active && (
                            <small className="jobs-cancel-pending">
                              等待取消确认
                            </small>
                          )}
                          {failure && (
                            <small
                              className="jobs-error-description"
                              tabIndex={0}
                              data-tip-title="失败原因"
                              data-tip={
                                j.error_code
                                  ? `${failure}（错误编码：${j.error_code}）`
                                  : failure
                              }
                            >
                              {failure}
                            </small>
                          )}
                        </td>
                        <td data-label="积分结算">
                          <strong className="jobs-settled">
                            {integer(j.settled)}
                            <span>积分</span>
                          </strong>
                          <div className="jobs-credit-details">
                            <span>总预占 {integer(j.cost)}</span>
                            <span>已释放 {integer(j.released)}</span>
                            <span>已补偿 {integer(j.refunded)}</span>
                          </div>
                        </td>
                        <td data-label="创建时间">
                          <JobTime value={j.created_at} />
                        </td>
                        <td data-label="处置" className="jobs-action-cell">
                          <div className="admin-row-actions jobs-actions">
                            <Tooltip content={cancelReason}>
                              <button
                                className="btn btn-light"
                                disabled={!active || j.cancel_requested}
                                onClick={() =>
                                  setAction({ job: j, action: 'cancel' })
                                }
                              >
                                取消任务
                              </button>
                            </Tooltip>
                            <Tooltip content={refundReason}>
                              <button
                                className="btn btn-light jobs-refund-button"
                                disabled={
                                  active || j.settled <= 0 || j.refunded > 0
                                }
                                onClick={() =>
                                  setAction({ job: j, action: 'refund' })
                                }
                              >
                                补偿积分
                              </button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  !query.error && (
                    <EmptyRow columns={6}>
                      <Inbox size={30} strokeWidth={1.4} aria-hidden="true" />
                      <p>没有符合条件的生成任务。</p>
                      {(q || status || owner) && (
                        <button
                          className="btn btn-light"
                          onClick={clearFilters}
                        >
                          清除筛选
                        </button>
                      )}
                    </EmptyRow>
                  )
                )}
              </tbody>
            </table>
          </div>
          <div className="jobs-table-footer">
            <span>
              {items
                ? `本页 ${items.length} 条任务`
                : query.isError
                  ? '暂未读取任务'
                  : '正在读取任务'}{' '}
              · 每页最多 25 条
            </span>
            <PageNav
              cursor={cursor}
              next={query.data?.next_cursor}
              loading={query.isFetching}
            />
          </div>
        </section>
        <p className="admin-note">
          普通管理员只能处置普通用户的任务；管理员账号的任务由超级管理员处理。补偿只返还实际结算积分，任务结果与原订单现金退款份额不会改变。
        </p>
        {copyFallback && (
          <Feedback
            variant="error"
            title={`请手动复制${copyFallback.label}`}
            onDismiss={() => setCopyFallback(undefined)}
          >
            <p>
              浏览器未允许写入剪贴板，可选中并复制下方完整{copyFallback.label}。
            </p>
            <code className="jobs-copy-fallback">{copyFallback.value}</code>
          </Feedback>
        )}
        {action && (
          <JobAction
            {...props}
            {...action}
            onClose={() => setAction(undefined)}
            onDone={async () => {
              setAction(undefined);
              setMessage(
                action.action === 'refund'
                  ? '积分补偿已入账，同一任务不会重复补偿。'
                  : '取消请求已提交。',
              );
              if (action.job.owner_id === props.me.user.id)
                void walletApi
                  .summary()
                  .then(updateWallet)
                  .catch(() => {});
              await Promise.all([
                client.invalidateQueries({ queryKey: ['adminJobs'] }),
                client.invalidateQueries({ queryKey: ['adminDashboard'] }),
              ]);
            }}
          />
        )}
      </AdminFrame>
      {selectedUser && (
        <div className="user-management">
          <UserDrawer
            key={selectedUser}
            {...props}
            id={selectedUser}
            onClose={() => setSelectedUser(undefined)}
          />
        </div>
      )}
    </>
  );
}
function JobAction(
  props: AdminProps & {
    job: Job;
    action: 'cancel' | 'refund';
    onClose: () => void;
    onDone: () => Promise<void>;
  },
) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [uncertain, setUncertain] = useState(false);
  const key = useRef(crypto.randomUUID());
  const frozen = useRef<string>();
  const refund = props.action === 'refund';
  async function submit() {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    frozen.current ??= reason.trim();
    try {
      await api.jobAction(
        props.job.id,
        props.action,
        {
          reason: frozen.current,
          expected_credits: refund ? props.job.settled : undefined,
        },
        props.me.csrf_token,
        key.current,
      );
      await props.onDone();
    } catch (e) {
      setError(e);
      const unknown = !(e instanceof SessionError) || e.status >= 500;
      setUncertain(unknown);
      if (!unknown) frozen.current = undefined;
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminDialog
      title={refund ? '确认补偿积分' : '取消生成任务'}
      busy={busy}
      onClose={props.onClose}
    >
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="admin-confirm">
          <h3>
            {refund
              ? `返还 ${integer(props.job.settled)} 积分给 ${props.job.email}`
              : `取消 ${props.job.display_name} 的任务？`}
          </h3>
          <p>
            {refund
              ? '按实际结算全额补偿一次，追加独立积分流水。不撤销生成结果，也不会恢复原订单的可现金退款份额。'
              : '排队任务立即取消并释放预占；正在执行的任务会收到取消请求，由任务处理后释放剩余预占。'}
          </p>
          <small className="admin-id">{props.job.id}</small>
        </div>
        <label>
          处理说明
          <textarea
            className="input"
            data-initial-focus
            required
            maxLength={500}
            value={reason}
            disabled={busy || uncertain}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <AdminFeedback props={props} error={error} />
        {uncertain && (
          <p className="admin-note">
            结果尚未确认。重试将使用原请求，或关闭后刷新核对。
          </p>
        )}
        <footer className="admin-form-actions">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy}
            onClick={props.onClose}
          >
            返回
          </button>
          <button className="btn btn-dark" disabled={busy || !reason.trim()}>
            {busy
              ? '正在处理…'
              : uncertain
                ? '按原请求重试'
                : refund
                  ? '确认补偿积分'
                  : '确认取消任务'}
          </button>
        </footer>
      </form>
    </AdminDialog>
  );
}
