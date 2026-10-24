import Select from '../../components/Select';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import UserDrawer from './UserDetailsDrawer';
import { adminApi as api, integer, roles, when } from './adminApi';
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
import './AdminUsersPage.css';
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
  const [sort, setSort] = useState('created');
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const [selected, setSelected] = useState<string | undefined>(
    url.get('user') || undefined,
  );
  const cursor = useAdminCursor<string>();
  const query = useQuery({
    queryKey: ['adminUsers', props.me.user.id, q, status, role, cursor.before],
    queryFn: ({ signal }) => api.users(q, status, role, cursor.before, signal),
  });
  const items = [...(query.data?.items ?? [])].sort((a, b) =>
    sort === 'credits'
      ? b.balance - b.held - (a.balance - a.held)
      : sort === 'login'
        ? (b.last_login_at ? Date.parse(b.last_login_at) : 0) -
          (a.last_login_at ? Date.parse(a.last_login_at) : 0)
        : 0,
  );
  const reset = () => {
    clearTimeout(searchTimer.current);
    setDraft('');
    setQ('');
    setStatus('');
    setRole('');
    setSort('created');
    cursor.reset();
  };
  return (
    <div className="user-management">
      <AdminFrame
        title="用户管理"
        description="核对账户状态、积分与任务。所有管理变更都需要说明并保留记录。"
        loading={query.isFetching}
        onRefresh={() => void query.refetch()}
      >
        <div
          className="users-status-tabs"
          role="group"
          aria-label="用户状态筛选"
        >
          {[
            ['', '全部用户'],
            ['ACTIVE', '正常'],
            ['DISABLED', '已禁用'],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={status === value}
              onClick={() => {
                cursor.reset();
                setStatus(value);
              }}
            >
              <span
                className={`users-status-dot ${value === 'ACTIVE' ? 'users-dot-active' : value === 'DISABLED' ? 'users-dot-disabled' : ''}`}
                aria-hidden="true"
              />
              {label}
            </button>
          ))}
        </div>
        <form
          className="admin-filters"
          onSubmit={(e) => {
            e.preventDefault();
            clearTimeout(searchTimer.current);
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
              onChange={(e) => {
                const value = e.target.value;
                setDraft(value);
                clearTimeout(searchTimer.current);
                if (value.trim() === q) return;
                searchTimer.current = setTimeout(() => {
                  cursor.reset();
                  setQ(value.trim());
                }, 300);
              }}
              maxLength={120}
            />
          </label>
          <Select
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
          </Select>
          <label className="users-sort">
            本页排序
            <Select
              aria-label="本页排序"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="created">注册最新</option>
              <option value="login">最近登录</option>
              <option value="credits">可用积分最多</option>
            </Select>
          </label>
          <button className="btn btn-light users-search-submit">搜索</button>
          <button className="text-action" type="button" onClick={reset}>
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
                  items.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="admin-person">
                          <span className="admin-avatar" aria-hidden="true">
                            {Array.from(
                              u.display_name || u.email,
                            )[0]?.toUpperCase()}
                          </span>
                          <div>
                            <strong tabIndex={0} data-tip={u.display_name}>
                              {u.display_name}
                            </strong>
                            <small>{u.email}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`users-role-tag ${u.role === 'SUPER_ADMIN' ? 'users-role-super' : ''}`}
                        >
                          {roles[u.role] || u.role}
                        </span>
                      </td>
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
                        <small>30 天内违规 {integer(u.violations)} 次</small>
                      </td>
                      <td className="users-last-login">
                        {when(u.last_login_at)}
                      </td>
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
                    <EmptyRow columns={6}>
                      没有符合筛选条件的用户。
                      <button
                        type="button"
                        className="text-action"
                        onClick={reset}
                      >
                        重置筛选
                      </button>
                    </EmptyRow>
                  )
                )}
              </tbody>
            </table>
          </div>
          {!query.data && query.isError && (
            <div className="users-table-unavailable">
              暂未读取用户列表，请刷新数据后重试。
            </div>
          )}
          <footer className="users-table-footer">
            <span>
              {query.data
                ? `本页 ${integer(query.data.items.length)} 位用户`
                : '用户列表'}
              <small>列表按注册时间分页；排序仅作用于本页。</small>
            </span>
            <PageNav
              cursor={cursor}
              next={query.data?.next_cursor}
              loading={query.isFetching || draft.trim() !== q}
            />
          </footer>
        </section>
        {selected && (
          <UserDrawer
            {...props}
            id={selected}
            onClose={() => setSelected(undefined)}
          />
        )}
      </AdminFrame>
    </div>
  );
}
