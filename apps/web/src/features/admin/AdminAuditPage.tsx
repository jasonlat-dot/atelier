import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { adminApi as api, when, type AdminSchema } from './adminApi';
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
export default function AdminAuditPage(props: AdminProps) {
  return (
    <AdminAccess props={props} superOnly>
      <Audit {...props} />
    </AdminAccess>
  );
}
function Audit(props: AdminProps) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const cursor = useAdminCursor<number>();
  const [selected, setSelected] = useState<AdminSchema['AdminAudit']>();
  const query = useQuery({
    queryKey: ['adminAudit', q, cursor.before],
    queryFn: ({ signal }) => api.audit(q, cursor.before, signal),
  });
  return (
    <AdminFrame
      title="审计日志"
      description="管理操作的只读记录。敏感凭据与内容已脱敏，仅超级管理员可查看。"
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
          aria-label="搜索审计日志"
          placeholder="操作、目标或操作者邮箱"
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-light">搜索</button>
      </form>
      <AdminFeedback props={props} error={query.error} />
      <section className="admin-panel admin-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>发生时间</th>
                <th>操作者</th>
                <th>操作</th>
                <th>目标</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {query.isPending ? (
                <TableLoading columns={5} />
              ) : query.data?.items.length ? (
                query.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>{when(a.created_at)}</td>
                    <td>{a.email || '系统自动处理'}</td>
                    <td>{a.action}</td>
                    <td>
                      {a.target_type}
                      <small className="admin-id">{a.target_id || '—'}</small>
                    </td>
                    <td>
                      <button
                        className="btn btn-light"
                        onClick={() => setSelected(a)}
                      >
                        查看变更
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                !query.error && (
                  <EmptyRow columns={5}>没有匹配的审计记录。</EmptyRow>
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
        <AdminDialog
          title="审计变更详情"
          drawer
          onClose={() => setSelected(undefined)}
        >
          <p className="admin-note">
            {selected.action} · {when(selected.created_at)}
          </p>
          <p>{selected.email || '系统自动处理'}</p>
          <h3>变更前</h3>
          <pre className="admin-json">
            {JSON.stringify(selected.before, null, 2)}
          </pre>
          <h3>变更后与说明</h3>
          <pre className="admin-json">
            {JSON.stringify(selected.after, null, 2)}
          </pre>
        </AdminDialog>
      )}
    </AdminFrame>
  );
}
