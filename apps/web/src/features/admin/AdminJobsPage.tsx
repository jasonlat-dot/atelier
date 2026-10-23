import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { SessionError } from '../auth/sessionApi';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import { adminApi as api, integer, statuses, when, type Job } from './adminApi';
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
  const [message, setMessage] = useState('');
  const query = useQuery({
    queryKey: ['adminJobs', q, status, owner, cursor.before],
    queryFn: ({ signal }) => api.jobs(q, status, owner, cursor.before, signal),
  });
  return (
    <AdminFrame
      title="任务管理"
      description="查看生成任务、取消未完成任务或补偿已实际结算的积分。"
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
        <input
          className="input admin-search"
          aria-label="搜索任务"
          placeholder="任务 ID、用户邮箱、公开模型"
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
        />
        <select
          className="input"
          aria-label="任务状态"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            cursor.reset();
          }}
        >
          <option value="">全部状态</option>
          {[
            'QUEUED',
            'ROUTING',
            'RUNNING',
            'STORING',
            'SUCCEEDED',
            'PARTIAL',
            'FAILED',
            'CANCELLED',
          ].map((s) => (
            <option key={s} value={s}>
              {statuses[s]}
            </option>
          ))}
        </select>
        <button className="btn btn-light">搜索</button>
        {owner && (
          <button
            className="text-action"
            type="button"
            onClick={() => {
              setUrl({});
              cursor.reset();
            }}
          >
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
          <table className="admin-table">
            <thead>
              <tr>
                <th>任务与模型</th>
                <th>用户</th>
                <th>状态</th>
                <th>积分结算</th>
                <th>创建时间</th>
                <th>处置</th>
              </tr>
            </thead>
            <tbody>
              {query.isPending ? (
                <TableLoading columns={6} />
              ) : query.data?.items.length ? (
                query.data.items.map((j) => {
                  const active = [
                    'QUEUED',
                    'ROUTING',
                    'RUNNING',
                    'STORING',
                  ].includes(j.status);
                  return (
                    <tr key={j.id}>
                      <td>
                        <strong>{j.display_name}</strong>
                        <small className="admin-id">{j.id}</small>
                        <small>
                          {j.kind === 'image' ? '图片' : '视频'} · {j.model_id}
                        </small>
                      </td>
                      <td>
                        <Link to={`/admin/users?user=${j.owner_id}`}>
                          {j.email}
                        </Link>
                      </td>
                      <td>
                        <Badge bad={j.status === 'FAILED'}>
                          {statuses[j.status] || j.status}
                        </Badge>
                        <small>
                          {active
                            ? `${j.progress}% · 尝试 ${j.attempts} 次`
                            : when(j.finished_at)}
                        </small>
                        {j.cancel_requested && active && (
                          <small>已请求取消，等待任务释放</small>
                        )}
                        {j.error_code && <small>{j.error_code}</small>}
                      </td>
                      <td>
                        <strong>结算 {integer(j.settled)}</strong>
                        <small>
                          总预占 {integer(j.cost)} · 已释放{' '}
                          {integer(j.released)}
                        </small>
                        <small>已补偿 {integer(j.refunded)}</small>
                      </td>
                      <td>{when(j.created_at)}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button
                            className="btn btn-light"
                            disabled={!active || j.cancel_requested}
                            onClick={() =>
                              setAction({ job: j, action: 'cancel' })
                            }
                          >
                            取消任务
                          </button>
                          <button
                            className="btn btn-light"
                            disabled={
                              active || j.settled <= 0 || j.refunded > 0
                            }
                            onClick={() =>
                              setAction({ job: j, action: 'refund' })
                            }
                          >
                            补偿积分
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                !query.error && (
                  <EmptyRow columns={6}>没有符合条件的生成任务。</EmptyRow>
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
      <p className="admin-note">
        普通管理员只能处置普通用户的任务；管理员账号的任务由超级管理员处理。补偿只返还实际结算积分，任务结果与原订单现金退款份额不会改变。
      </p>
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
