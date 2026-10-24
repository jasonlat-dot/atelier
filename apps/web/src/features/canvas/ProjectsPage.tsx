import Select from '../../components/Select';
import Feedback from '../../components/Feedback';
import { useCallback, useState, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  Plus,
  GalleryHorizontal,
  Copy,
  Pencil,
  Trash2,
  Search,
  LayoutGrid,
  List,
  Upload,
  X,
} from 'lucide-react';
import { SessionError } from '../auth/sessionApi';
import AssetDialog from '../assets/AssetDialog';
import { projectApi, type ProjectInfo } from './projectApi';
import type { CanvasProps } from './LiveCanvasPage';
import ProjectPreview from './ProjectPreview';
import './LiveCanvas.css';
import './ProjectsPage.css';

function updatedLabel(value: string) {
  const date = new Date(value);
  const today = date.toDateString() === new Date().toDateString();
  return `${today ? '今天 ' : ''}${date.toLocaleString('zh-CN', {
    ...(today ? {} : { month: 'long', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
}
export function ProjectGrid({
  me,
  onExpired,
  onReload,
  home = false,
}: CanvasProps & { home?: boolean }) {
  const navigate = useNavigate(),
    [action, setAction] = useState<{
      type: 'rename' | 'delete';
      project: ProjectInfo;
    }>();
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [filter, setFilter] = useState(''),
    [sort, setSort] = useState('updated'),
    [view, setView] = useState<'grid' | 'list'>('grid');
  const query = useInfiniteQuery({
    queryKey: ['projects', me.user.id, home ? 'home' : 'library'],
    queryFn: ({ pageParam, signal }) => projectApi.list(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      home ? undefined : last.next_cursor || undefined,
    staleTime: 0,
  });
  const projects = (
    query.data?.pages.flatMap((page) => page.items) || []
  ).filter(
    (project, index, items) =>
      items.findIndex((item) => item.id === project.id) === index,
  );
  const visible = projects
    .filter(
      (project) =>
        home ||
        project.name
          .toLocaleLowerCase()
          .includes(filter.trim().toLocaleLowerCase()),
    )
    .sort((a, b) =>
      home || sort === 'updated'
        ? Date.parse(b.updated_at) - Date.parse(a.updated_at)
        : sort === 'name'
          ? a.name.localeCompare(b.name, 'zh-CN')
          : b.revision - a.revision,
    )
    .slice(0, home ? 3 : undefined);
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
        <>
          <div className="canvas-library-head">
            <div>
              <h1>我的创作画布</h1>
              <p>把想法、参考与生成结果，连接成你的下一件作品。</p>
            </div>
            <div className="canvas-library-head-actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() => importFile.current?.click()}
              >
                <Upload size={15} />
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
              <Link className="btn btn-dark" to="/canvas/new">
                <Plus size={16} />
                新建画布
              </Link>
            </div>
          </div>
          <div className="canvas-library-toolbar">
            <div className="canvas-library-search">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="筛选画布"
                placeholder="在已加载画布中筛选名称…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter && (
                <button
                  className="icon-btn"
                  aria-label="清除画布筛选"
                  onClick={() => setFilter('')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <span className="canvas-library-count" role="status">
              {query.isPending
                ? '正在读取画布…'
                : `${filter.trim() ? '匹配' : '已加载'} ${visible.length} 个画布`}
            </span>
            <Select
              aria-label="画布排序"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="updated">最近更新</option>
              <option value="name">名称</option>
              <option value="version">修订号</option>
            </Select>
            <div
              className="canvas-library-view"
              role="group"
              aria-label="画布视图"
            >
              <button
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <LayoutGrid size={15} />
                网格
              </button>
              <button
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <List size={15} />
                列表
              </button>
            </div>
          </div>
        </>
      )}
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
      {query.isError && (
        <Feedback variant="error">
          画布列表暂不可用。
          <button className="text-action" onClick={() => void query.refetch()}>
            重新加载列表
          </button>
        </Feedback>
      )}
      <div
        className={`workspace-projects live-projects ${home ? '' : 'canvas-library-grid'}`}
        data-view={view}
      >
        <Link className="project-card create-card" to="/canvas/new">
          <Plus size={23} />
          <strong>{home ? '创建新项目' : '新建空白画布'}</strong>
          <small>从一个想法开始，无限延伸</small>
        </Link>
        {visible.map((p) => (
          <article key={p.id} className="project-card live-project-card">
            <Link
              to={`/canvas/${p.id}`}
              className="live-project-link"
              aria-label={`打开 ${p.name}`}
            >
              <ProjectPreview project={p} userId={me.user.id} compact={home} />
              {!home && (
                <div className="canvas-library-meta">
                  <strong tabIndex={0} data-tip={p.name}>
                    {p.name}
                  </strong>
                  <div>
                    <time
                      tabIndex={0}
                      dateTime={p.updated_at}
                      data-tip={new Date(p.updated_at).toLocaleString('zh-CN')}
                    >
                      {updatedLabel(p.updated_at)}
                    </time>
                    <span className="canvas-library-version">
                      v{p.revision}
                    </span>
                  </div>
                </div>
              )}
            </Link>
            {!home && (
              <div className="gen-actions canvas-library-actions">
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
                  <span>重命名</span>
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
                  <span>复制</span>
                </button>
                <button
                  className="icon-btn"
                  aria-label={`删除 ${p.name}`}
                  disabled={busy}
                  onClick={() => setAction({ type: 'delete', project: p })}
                >
                  <Trash2 size={14} />
                  <span>删除</span>
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
              <span />
            </div>
          ) : (
            <div className="canvas-library-loading" role="status">
              正在加载项目…
            </div>
          ))}
        {!query.isPending &&
          !query.isError &&
          visible.length === 0 &&
          (home ? (
            <p className="home-project-empty">还没有项目，从一个想法开始吧。</p>
          ) : (
            <div className="workspace-empty">
              <GalleryHorizontal size={30} strokeWidth={1.2} />
              <h3>
                {filter.trim()
                  ? '没有匹配的画布'
                  : '留一片空间，给下一个好想法'}
              </h3>
              <p>
                {filter.trim()
                  ? '试试其他名称，或加载更多画布后继续筛选。'
                  : '创建画布，连接文字、参考图与生成结果。'}
              </p>
              {filter.trim() && (
                <button className="text-action" onClick={() => setFilter('')}>
                  清除筛选
                </button>
              )}
            </div>
          ))}
      </div>
      {!home && query.hasNextPage && (
        <div className="canvas-library-more">
          <button
            className="btn"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? '正在加载…' : '加载更多画布'}
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
          {error && (
            <Feedback onDismiss={() => setError('')} variant="error">
              {error}
            </Feedback>
          )}
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
    <main className="canvas-library-page">
      <ProjectGrid {...props} />
    </main>
  );
}
