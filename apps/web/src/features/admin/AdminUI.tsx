import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { SessionError } from '../auth/sessionApi';
import { adminError } from './adminApi';
import './AdminConsole.css';
export function AdminAccess({
  props,
  superOnly = false,
  children,
}: {
  props: AdminProps;
  superOnly?: boolean;
  children: ReactNode;
}) {
  return props.me.user.role === 'USER' ||
    (superOnly && props.me.user.role !== 'SUPER_ADMIN') ? (
    <main className="page-padding">
      <h1>无权访问</h1>
      <p>
        {superOnly ? '此页面仅对超级管理员开放。' : '此页面需要管理员权限。'}
      </p>
    </main>
  ) : (
    children
  );
}
export function AdminFeedback({
  error,
  message,
  props,
}: {
  error?: unknown;
  message?: string;
  props: AdminProps;
}) {
  useEffect(() => {
    if (error instanceof SessionError) {
      if (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
        props.onExpired();
      else if (error.code === 'MFA_REQUIRED') props.onReload();
    }
  }, [error, props.onExpired, props.onReload]);
  return (
    <>
      {!!error && (
        <p className="admin-feedback admin-error" role="alert">
          {adminError(error)}
        </p>
      )}
      {message && (
        <p className="admin-feedback admin-success" role="status">
          {message}
        </p>
      )}
    </>
  );
}
export function AdminFrame({
  title,
  description,
  loading,
  onRefresh,
  children,
  tools,
}: {
  title: string;
  description: string;
  loading?: boolean;
  onRefresh?: () => void;
  children: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <main className="page-padding admin-console">
      <header className="admin-title">
        <div>
          <div className="eyebrow">ATELIER / MANAGEMENT</div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="admin-toolbar">
          {tools}
          {onRefresh && (
            <button
              className="btn btn-light"
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw size={15} />
              刷新数据
            </button>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}
export function useAdminCursor<T extends string | number>() {
  const [before, setBefore] = useState<T>();
  const [stack, setStack] = useState<(T | undefined)[]>([]);
  return {
    before,
    hasPrevious: stack.length > 0,
    next: (cursor: T) => {
      setStack((s) => [...s, before]);
      setBefore(cursor);
    },
    previous: () => {
      setBefore(stack.at(-1));
      setStack((s) => s.slice(0, -1));
    },
    reset: () => {
      setBefore(undefined);
      setStack([]);
    },
  };
}
export function PageNav<T extends string | number>({
  cursor,
  next,
  loading,
}: {
  cursor: { hasPrevious: boolean; previous: () => void; next: (v: T) => void };
  next?: T | null;
  loading?: boolean;
}) {
  return (
    <nav className="admin-pagination" aria-label="列表分页">
      <button
        className="btn btn-light"
        disabled={loading || !cursor.hasPrevious}
        onClick={cursor.previous}
      >
        上一页
      </button>
      <button
        className="btn btn-light"
        disabled={loading || !next}
        onClick={() => {
          if (next) cursor.next(next);
        }}
      >
        下一页
      </button>
    </nav>
  );
}
export function TableLoading({ columns }: { columns: number }) {
  return (
    <tr>
      <td colSpan={columns}>
        <div className="admin-skeleton" role="status" aria-label="正在加载列表">
          <span />
          <span />
          <span />
        </div>
      </td>
    </tr>
  );
}
export function EmptyRow({
  columns,
  children,
}: {
  columns: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={columns}>
        <div className="admin-empty">{children}</div>
      </td>
    </tr>
  );
}
export function Badge({
  children,
  bad = false,
}: {
  children: ReactNode;
  bad?: boolean;
}) {
  return (
    <span className={`admin-badge ${bad ? 'is-warning' : ''}`}>{children}</span>
  );
}
