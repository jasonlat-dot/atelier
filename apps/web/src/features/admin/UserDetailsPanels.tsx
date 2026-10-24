import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { sessionApi } from '../auth/sessionApi';
import { deviceDetails } from '../auth/deviceDetails';
import { adminApi as api, integer, when, type AdminSchema } from './adminApi';
import { AdminFeedback } from './AdminUI';
import { auditActionLabel } from './auditLabels';

export function UserDevices({
  sessions,
  user,
  props,
}: {
  sessions: AdminSchema['AdminSession'][];
  user: string;
  props: AdminProps;
}) {
  const own = user === props.me.user.id;
  const current = useQuery({
    queryKey: ['ownSessions', props.me.user.id],
    queryFn: ({ signal }) => sessionApi.devices(signal),
    enabled: own,
  });
  return (
    <section aria-label="用户登录设备">
      <h3 className="users-panel-title">有效登录设备</h3>
      <p className="users-panel-note">最多显示最近 20 台有效设备。</p>
      <AdminFeedback props={props} error={current.error} />
      {!sessions.length && (
        <p className="users-detail-empty">当前没有有效设备</p>
      )}
      {sessions.map((session) => {
        const detail = deviceDetails(session.user_agent);
        const Icon = detail.mobile ? Smartphone : Monitor;
        const active =
          own &&
          current.data?.sessions.some(
            (item) => item.id === session.id && item.current,
          );
        return (
          <div className="users-device-row" key={session.id}>
            <span className="users-device-icon">
              <Icon size={19} aria-hidden="true" />
            </span>
            <div>
              <strong tabIndex={0} data-tip={session.user_agent || '未知设备'}>
                {detail.title}
              </strong>
              {active && <span className="admin-badge">当前会话</span>}
              <p>{session.ip || 'IP 未记录'}</p>
              <small>最近活动 {when(session.last_seen_at)}</small>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function AuditRecords({ user, props }: { user: string; props: AdminProps }) {
  const query = useQuery({
    queryKey: ['userAudit', user],
    queryFn: ({ signal }) => api.audit(user, undefined, signal),
  });
  const [older, setOlder] = useState<AdminSchema['AdminAudit'][]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const rows = [
    ...new Map(
      [...(query.data?.items ?? []), ...older]
        .filter(
          (entry) =>
            entry.target_id === user &&
            (entry.target_type === 'users' || entry.target_type === 'wallet'),
        )
        .map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const next = cursor === undefined ? query.data?.next_cursor : cursor;
  return (
    <>
      <AdminFeedback props={props} error={error || query.error} />
      {query.isPending && (
        <p role="status" className="users-panel-note">
          正在读取操作记录…
        </p>
      )}
      {!query.isPending && !query.error && !rows.length && (
        <p className="users-detail-empty">暂无已读取的管理变更</p>
      )}
      {rows.map((entry) => {
        const after = entry.after;
        const reason =
          after &&
          typeof after === 'object' &&
          'reason' in after &&
          typeof after.reason === 'string'
            ? after.reason
            : '';
        return (
          <div className="users-audit-row" key={entry.id}>
            <strong>{auditActionLabel(entry.action)}</strong>
            <code className="users-audit-code">{entry.action}</code>
            <small>
              {when(entry.created_at)} · {entry.email || '系统自动处理'}
            </small>
            {reason && <p>{reason}</p>}
          </div>
        );
      })}
      {next && (
        <button
          className="btn btn-light users-more"
          disabled={busy}
          onClick={async () => {
            if (lock.current) return;
            lock.current = true;
            setBusy(true);
            setError(undefined);
            try {
              const page = await api.audit(user, next);
              setOlder((old) => [...old, ...page.items]);
              setCursor(page.next_cursor ?? null);
            } catch (error) {
              setError(error);
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          {busy ? '正在加载…' : '加载更多操作记录'}
        </button>
      )}
    </>
  );
}

export function UserReview({
  user,
  props,
}: {
  user: AdminSchema['AdminUser'];
  props: AdminProps;
}) {
  return (
    <section aria-label="用户违规与审计">
      <h3 className="users-panel-title">违规概况</h3>
      <div className="users-violations">
        <strong>
          30 天内违规 <span>{integer(user.violations)}</span> 次
        </strong>
        <p>
          {user.violations
            ? '达到配置阈值后会限制账号；复核不会自动恢复账号状态。'
            : '当前没有内容违规记录。'}
        </p>
        {user.disabled_reason && <p>禁用原因：{user.disabled_reason}</p>}
      </div>
      <h3 className="users-panel-title users-audit-title">管理操作记录</h3>
      {props.me.user.role === 'SUPER_ADMIN' ? (
        <AuditRecords user={user.id} props={props} />
      ) : (
        <p className="users-panel-note">审计记录仅超级管理员可查看。</p>
      )}
    </section>
  );
}
