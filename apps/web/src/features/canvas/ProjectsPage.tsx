import { useCallback, useState, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus,
  GalleryHorizontal,
  Copy,
  Pencil,
  Trash2,
  ArrowRight,
} from 'lucide-react';
import { SessionError } from '../auth/sessionApi';
import AssetDialog from '../assets/AssetDialog';
import { projectApi, type ProjectInfo } from './projectApi';
import type { CanvasProps } from './LiveCanvasPage';
import './LiveCanvas.css';
export function ProjectGrid({
  me,
  onExpired,
  onReload,
  home = false,
}: CanvasProps & { home?: boolean }) {
  const navigate = useNavigate(),
    [before, setBefore] = useState<string>(),
    [action, setAction] = useState<{
      type: 'rename' | 'delete';
      project: ProjectInfo;
    }>();
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['projects', me.user.id, before],
    queryFn: ({ signal }) => projectApi.list(before, signal),
    staleTime: 0,
  });
  const importFile = useRef<HTMLInputElement>(null);
  const importing = useRef<{ file: File; key: string }>();
  const failed = useCallback(
    (error: unknown) => {
      if (error instanceof SessionError) {
        if (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
          onExpired();
        if (error.code === 'MFA_REQUIRED') onReload();
        if (error.status === 409)
          return '项目已被更新，请关闭弹窗并重新加载列表。';
        if (error.status === 404) return '项目已删除或不可访问。';
      }
      return '操作未完成，请重试。';
    },
    [onExpired, onReload],
  );
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      setAction(undefined);
      await query.refetch();
    } catch (e) {
      setError(failed(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!home && (
        <div className="gen-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => importFile.current?.click()}
          >
            导入项目 ZIP
          </button>
          {importing.current && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const item = importing.current!;
                  const project = await projectApi.import(
                    item.file,
                    me.csrf_token,
                    item.key,
                  );
                  importing.current = undefined;
                  navigate(`/canvas/${project.project.id}`);
                })
              }
            >
              重试上次导入
            </button>
          )}
          <input
            hidden
            ref={importFile}
            type="file"
            aria-label="导入项目 ZIP"
            accept=".zip,application/zip"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              importing.current = { file, key: crypto.randomUUID() };
              void act(async () => {
                const project = await projectApi.import(
                  file,
                  me.csrf_token,
                  importing.current!.key,
                );
                importing.current = undefined;
                navigate(`/canvas/${project.project.id}`);
              });
            }}
          />
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {query.isError && (
        <p role="alert">
          画布列表暂不可用。
          <button className="text-action" onClick={() => void query.refetch()}>
            重新加载列表
          </button>
        </p>
      )}
      <div className="workspace-projects live-projects">
        <Link className="project-card create-card" to="/canvas/new">
          <Plus size={23} />
          <strong>创建新项目</strong>
          <small>从一个想法开始，无限延伸</small>
        </Link>
        {query.data?.items.slice(0, home ? 2 : 25).map((p) => (
          <article key={p.id} className="project-card live-project-card">
            <Link to={`/canvas/${p.id}`} className="live-project-link">
              <div className="live-project-art">
                <GalleryHorizontal size={32} strokeWidth={1} />
              </div>
              {home ? (
                <div className="home-project-caption">
                  <div>
                    <strong>{p.name}</strong>
                    <small>
                      更新于{' '}
                      {new Date(p.updated_at).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </small>
                  </div>
                  <span className="home-project-version">v{p.revision}</span>
                </div>
              ) : (
                <>
                  <strong>
                    {p.name}
                    <ArrowRight size={14} />
                  </strong>
                  <small>
                    更新于 {new Date(p.updated_at).toLocaleString('zh-CN')} · v
                    {p.revision}
                  </small>
                </>
              )}
            </Link>
            {!home && (
              <div className="gen-actions">
                <button
                  className="icon-btn"
                  aria-label={`重命名 ${p.name}`}
                  disabled={busy}
                  onClick={() => {
                    setName(p.name);
                    setAction({ type: 'rename', project: p });
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`复制 ${p.name}`}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const copy = await projectApi.duplicate(
                        p.id,
                        me.csrf_token,
                        crypto.randomUUID(),
                      );
                      navigate(`/canvas/${copy.project.id}`);
                    })
                  }
                >
                  <Copy size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`删除 ${p.name}`}
                  disabled={busy}
                  onClick={() => setAction({ type: 'delete', project: p })}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </article>
        ))}
        {query.isPending &&
          (home ? (
            <div
              className="home-project-loading"
              role="status"
              aria-label="正在加载项目"
            >
              <span />
              <span />
            </div>
          ) : (
            <p role="status">正在加载项目…</p>
          ))}
        {!query.isPending && query.data?.items.length === 0 && (
          <div className="workspace-empty">
            <GalleryHorizontal size={30} strokeWidth={1.2} />
            <h3>留一片空间，给下一个好想法</h3>
            <p>创建画布，连接文字、参考图与生成结果。</p>
          </div>
        )}
      </div>
      {!home && (
        <div className="gen-actions">
          <button
            className="btn"
            disabled={!before || query.isFetching}
            onClick={() => setBefore(undefined)}
          >
            返回首批
          </button>
          <button
            className="btn"
            disabled={!query.data?.next_cursor || query.isFetching}
            onClick={() => setBefore(query.data?.next_cursor || undefined)}
          >
            下一批项目
          </button>
        </div>
      )}
      {action && (
        <AssetDialog
          title={action.type === 'rename' ? '重命名画布' : '删除画布？'}
          busy={busy}
          onClose={() => {
            setAction(undefined);
            setError('');
          }}
        >
          {action.type === 'rename' ? (
            <label>
              画布名称
              <input
                className="input"
                aria-label="画布名称"
                maxLength={100}
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          ) : (
            <p>
              删除「{action.project.name}
              」后将无法从项目列表打开。已有素材和已提交的生成任务仍会保留。
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="gen-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => setAction(undefined)}
            >
              取消
            </button>
            <button
              className="btn btn-dark"
              data-initial-focus
              disabled={busy || (action.type === 'rename' && !name.trim())}
              onClick={() =>
                void act(() =>
                  action.type === 'rename'
                    ? projectApi.rename(
                        action.project.id,
                        name,
                        action.project.revision,
                        me.csrf_token,
                      )
                    : projectApi.delete(
                        action.project.id,
                        action.project.revision,
                        me.csrf_token,
                      ),
                )
              }
            >
              {busy
                ? '处理中…'
                : action.type === 'rename'
                  ? '保存名称'
                  : '删除画布'}
            </button>
          </div>
        </AssetDialog>
      )}
    </>
  );
}
export default function ProjectsPage(props: CanvasProps) {
  return (
    <main className="page-padding dashboard-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">INFINITE CANVAS</div>
          <h1>我的创作画布</h1>
          <p className="page-subtitle">
            把想法、参考与生成结果，连接成你的下一件作品。
          </p>
        </div>
        <Link className="btn btn-dark" to="/canvas/new">
          <Plus size={16} />
          新建画布
        </Link>
      </div>
      <ProjectGrid {...props} />
    </main>
  );
}
