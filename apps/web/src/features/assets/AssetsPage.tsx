import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  Image as ImageIcon,
  Plus,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { SessionError, type Me } from '../auth/sessionApi';
import {
  assetsApi,
  type Asset,
  type AssetLimits,
  type Filters,
} from './assetsApi';
import AssetDialog from './AssetDialog';
import './AssetsPage.css';

const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
export default function AssetsPage({
  me,
  onExpired,
  onReload,
}: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
}) {
  const [items, setItems] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>();
  const [filters, setFilters] = useState<Filters>({
    kind: '',
    source: '',
    search: '',
  });
  const [draft, setDraft] = useState('');
  const [limits, setLimits] = useState<AssetLimits>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string[]>();
  const [preview, setPreview] = useState<Asset>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const uploadAbort = useRef<AbortController>();
  const failed = useCallback(
    (failure: unknown) => {
      if (failure instanceof SessionError) {
        if (failure.status === 401 || failure.code === 'ACCOUNT_DISABLED') {
          onExpired();
          return;
        }
        if (failure.code === 'MFA_REQUIRED') {
          onReload();
          return;
        }
        const messages: Record<string, string> = {
          INVALID_MEDIA:
            '文件格式或内容无效，请选择 PNG、JPEG、WebP 图片或 MP4、WebM 视频。',
          VIDEO_UNAVAILABLE: '视频处理暂不可用，请稍后再上传。',
          MEDIA_TOO_LARGE: '文件超过上传限制，请压缩后重试。',
          ASSET_QUOTA_EXCEEDED: '素材空间已满，请删除不需要的素材后重试。',
          TOO_MANY_REQUESTS: '上传或处理较繁忙，请稍后重试。',
          NOT_FOUND: '素材已删除或过期，请刷新列表。',
        };
        setError(messages[failure.code] || '素材服务暂不可用，请稍后重试。');
      } else setError('连接中断，请重试；若上传已完成，可以先刷新素材列表。');
    },
    [onExpired, onReload],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++generation.current;
      setLoading(true);
      try {
        const page = await assetsApi.list(filters, undefined, signal);
        if (!signal?.aborted && sequence === generation.current) {
          setItems(page.items);
          setTotal(page.total);
          setCursor(page.next_cursor);
          setSelected([]);
        }
      } catch (failure) {
        if (!signal?.aborted && sequence === generation.current)
          failed(failure);
      } finally {
        if (!signal?.aborted && sequence === generation.current)
          setLoading(false);
      }
    },
    [filters, failed],
  );
  const currentLoad = useRef(load);
  useEffect(() => {
    currentLoad.current = load;
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  const loadLimits = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await assetsApi.limits(signal);
        if (!signal?.aborted) setLimits(value);
      } catch (failure) {
        if (!signal?.aborted) failed(failure);
      }
    },
    [failed],
  );
  useEffect(() => {
    const abort = new AbortController();
    void loadLimits(abort.signal);
    return () => abort.abort();
  }, [loadLimits]);
  useEffect(() => {
    const timeout = setTimeout(
      () => setFilters((current) => ({ ...current, search: draft.trim() })),
      300,
    );
    return () => clearTimeout(timeout);
  }, [draft]);
  useEffect(() => () => uploadAbort.current?.abort(), []);
  useEffect(() => {
    // Signed previews expire; periodically fetch fresh links while this page is open.
    const interval = setInterval(
      () => {
        if (!lock.current && !document.hidden) void load();
      },
      items.some((item) => item.state === 'PROCESSING') ? 3000 : 240000,
    );
    return () => clearInterval(interval);
  }, [items, load]);
  const upload = async (files: File[]) => {
    if (!limits || lock.current || !files.length) return;
    setError('');
    setMessage('');
    if (files.length > 10) {
      setError('每次最多上传 10 个文件，请分批选择。');
      return;
    }
    lock.current = true;
    setBusy(true);
    const abort = new AbortController();
    uploadAbort.current = abort;
    let count = 0;
    try {
      for (const file of files) {
        if (abort.signal.aborted) break;
        const video = file.type.startsWith('video/');
        if (
          (!video &&
            !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) ||
          (video &&
            (!limits.video_enabled ||
              !['video/mp4', 'video/webm'].includes(file.type)))
        ) {
          setError(
            `“${file.name}”暂不支持上传。请选择 PNG、JPEG、WebP 图片${limits.video_enabled ? '或 MP4、WebM 视频' : ''}。`,
          );
          continue;
        }
        if (
          !file.size ||
          file.size > (video ? limits.video_max_bytes : limits.image_max_bytes)
        ) {
          setError(`“${file.name}”超过上传限制或为空文件。`);
          continue;
        }
        setUploading(file.name);
        try {
          await assetsApi.upload(file, me.csrf_token, abort.signal);
          ++count;
        } catch (failure) {
          if (!abort.signal.aborted) failed(failure);
          break;
        }
      }
      if (!abort.signal.aborted) {
        if (count) setMessage(`已上传 ${count} 个素材`);
        await currentLoad.current();
      }
    } finally {
      lock.current = false;
      if (!abort.signal.aborted) {
        setBusy(false);
        setUploading('');
      }
    }
  };
  const remove = async () => {
    if (!deleting || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await assetsApi.delete(deleting, me.csrf_token);
      setDeleting(undefined);
      setMessage(`已删除 ${deleting.length} 个素材`);
      await currentLoad.current();
    } catch (failure) {
      setDeleting(undefined);
      failed(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const more = async () => {
    if (!cursor || lock.current || loading) return;
    lock.current = true;
    setBusy(true);
    const sequence = generation.current;
    try {
      const page = await assetsApi.list(filters, cursor);
      if (sequence === generation.current) {
        setItems((current) => [...current, ...page.items]);
        setCursor(page.next_cursor);
        setTotal(page.total);
      }
    } catch (failure) {
      failed(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const open = async (asset: Asset) => {
    try {
      setError('');
      setPreview(await assetsApi.get(asset.id));
    } catch (failure) {
      failed(failure);
    }
  };
  const refresh = () => {
    setError('');
    void load();
    if (!limits) void loadLimits();
  };
  return (
    <main
      className={`page-padding assets-page ${dragging ? 'assets-dragging' : ''}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="page-title-row">
        <div>
          <div className="eyebrow">LIBRARY</div>
          <h1>我的素材库</h1>
          <p className="page-subtitle">
            在同一空间里管理图片、视频和生成结果。
          </p>
        </div>
        <button
          className="btn btn-dark"
          disabled={busy || !limits}
          onClick={() => fileInput.current?.click()}
        >
          <Plus size={15} />
          上传素材
        </button>
      </div>
      <input
        ref={fileInput}
        className="asset-file-input"
        type="file"
        aria-label="选择上传素材"
        multiple
        accept={
          limits?.video_enabled
            ? 'image/png,image/jpeg,image/webp,video/mp4,video/webm'
            : 'image/png,image/jpeg,image/webp'
        }
        disabled={busy || !limits}
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = '';
          void upload(files);
        }}
      />
      <div className="assets-toolbar">
        <div className="filter-tabs" role="group" aria-label="素材类型">
          {[
            ['', '全部素材'],
            ['image', '图片'],
            ['video', '视频'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filters.kind === value ? 'on' : ''}
              aria-pressed={filters.kind === value}
              onClick={() =>
                setFilters((current) => ({ ...current, kind: value }))
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="assets-search">
          <Search size={15} />
          <input
            aria-label="搜索素材"
            type="search"
            placeholder="搜索素材名称"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <select
          className="input"
          aria-label="素材来源"
          value={filters.source}
          onChange={(event) =>
            setFilters((current) => ({
              ...current,
              source: event.target.value,
            }))
          }
        >
          <option value="">全部来源</option>
          <option value="upload">上传的素材</option>
          <option value="generated">生成的素材</option>
        </select>
      </div>
      <div className="assets-list-summary">
        <span>{loading ? '正在读取素材…' : `共 ${total} 个素材`}</span>
        <div>
          {items.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={selected.length === items.length && items.length > 0}
                disabled={busy || loading}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? items.map((item) => item.id) : [],
                  )
                }
              />
              选择本页
            </label>
          )}
          {selected.length > 0 && (
            <button
              className="text-action asset-delete-action"
              disabled={busy || loading}
              onClick={() => setDeleting(selected)}
            >
              <Trash2 size={14} />
              删除已选（{selected.length}）
            </button>
          )}
          <button
            className="text-action"
            disabled={busy || loading}
            onClick={refresh}
          >
            刷新列表
          </button>
        </div>
      </div>
      {message && (
        <p className="assets-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="assets-error" role="alert">
          <span>{error}</span>
          <button
            className="text-action"
            disabled={busy || loading}
            onClick={refresh}
          >
            重试读取
          </button>
        </div>
      )}
      {uploading && (
        <div className="assets-upload-status" role="status">
          <UploadCloud size={18} />
          <span>正在上传并处理 {uploading}…</span>
        </div>
      )}
      {loading && !items.length ? (
        <div
          className="asset-grid assets-skeleton"
          aria-label="正在加载素材"
          aria-busy="true"
        >
          {[0, 1, 2, 3].map((index) => (
            <div key={index} />
          ))}
        </div>
      ) : (
        <div className="asset-grid">
          {items.map((asset) => (
            <article className="asset-card" key={asset.id}>
              <div className="asset-cover">
                <label className="asset-select">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${asset.name}`}
                    checked={selected.includes(asset.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, asset.id]
                          : current.filter((id) => id !== asset.id),
                      )
                    }
                  />
                </label>
                <button
                  className="asset-preview-trigger"
                  aria-label={`预览 ${asset.name}`}
                  disabled={asset.state !== 'READY'}
                  onClick={() => void open(asset)}
                >
                  {asset.thumbnail_url ? (
                    <img
                      loading="lazy"
                      src={asset.thumbnail_url}
                      alt={asset.name}
                    />
                  ) : (
                    <span className="asset-state">
                      <ImageIcon size={26} />
                      {asset.state === 'FAILED'
                        ? '处理失败，请重新上传'
                        : '正在处理…'}
                    </span>
                  )}
                </button>
                <span className="asset-type">
                  {asset.kind === 'video' ? '视频' : '图片'}
                </span>
              </div>
              <div className="asset-info">
                <strong title={asset.name}>{asset.name}</strong>
                <span>
                  {asset.width && asset.height
                    ? `${asset.width} × ${asset.height} · `
                    : ''}
                  {size(asset.bytes)}
                  {asset.duration_ms
                    ? ` · ${(asset.duration_ms / 1000).toFixed(1)} 秒`
                    : ''}
                </span>
                <div className="asset-card-footer">
                  <small>
                    {asset.source === 'upload' ? '已上传' : '生成结果'} ·{' '}
                    {new Date(asset.created_at).toLocaleDateString('zh-CN')}
                  </small>
                  <button
                    className="icon-btn"
                    aria-label={`删除 ${asset.name}`}
                    disabled={busy}
                    onClick={() => setDeleting([asset.id])}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !items.length && !error && (
        <div className="assets-empty">
          <FolderOpen size={38} strokeWidth={1.2} />
          <h2>
            {filters.search || filters.source || filters.kind
              ? '没有符合条件的素材'
              : '为你的下一个想法，准备一些素材'}
          </h2>
          <p>
            {filters.search || filters.source || filters.kind
              ? '试试其他名称、类型或来源。'
              : '选择本地文件上传，或将图片拖到这个页面。'}
          </p>
          {!filters.search && !filters.source && !filters.kind && (
            <button
              className="btn btn-light"
              disabled={busy || !limits}
              onClick={() => fileInput.current?.click()}
            >
              <UploadCloud size={15} />
              上传第一份素材
            </button>
          )}
        </div>
      )}
      {cursor && (
        <div className="assets-load-more">
          <button
            className="btn btn-light"
            disabled={busy || loading}
            onClick={() => void more()}
          >
            加载更多
          </button>
        </div>
      )}
      <p className="assets-help">
        图片支持 PNG、JPEG、WebP，单张不超过 20 MB。
        {limits?.video_enabled
          ? '视频支持 MP4、WebM，不超过 200 MB、60 秒，上传后自动转码。'
          : '视频处理服务尚未启用，当前可上传图片。'}
        素材默认保留 30 天。
      </p>
      {dragging && (
        <div className="assets-drop-indicator">
          <UploadCloud size={38} />
          <strong>松开即可上传素材</strong>
        </div>
      )}
      {deleting && (
        <AssetDialog
          title={`删除 ${deleting.length} 个素材？`}
          busy={busy}
          onClose={() => setDeleting(undefined)}
        >
          <p>删除后，素材及其预览链接将立即无法访问。此操作无法撤销。</p>
          <div className="asset-dialog-actions">
            <button
              className="btn btn-light"
              data-initial-focus
              disabled={busy}
              onClick={() => setDeleting(undefined)}
            >
              取消
            </button>
            <button
              className="btn btn-dark"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? '正在删除…' : '确认删除素材'}
            </button>
          </div>
        </AssetDialog>
      )}
      {preview && (
        <AssetDialog
          title={preview.name}
          preview
          onClose={() => setPreview(undefined)}
        >
          <div className="asset-preview-content">
            {preview.media_url ? (
              preview.kind === 'video' ? (
                <video
                  src={preview.media_url}
                  poster={preview.thumbnail_url || undefined}
                  controls
                  playsInline
                />
              ) : (
                <img src={preview.media_url} alt={preview.name} />
              )
            ) : (
              <p>素材正在处理，稍后刷新查看。</p>
            )}
          </div>
          <footer>
            <span>
              {preview.width} × {preview.height} · {size(preview.bytes)}
              {preview.duration_ms
                ? ` · ${(preview.duration_ms / 1000).toFixed(1)} 秒`
                : ''}{' '}
              · 保留至{' '}
              {new Date(preview.expires_at).toLocaleDateString('zh-CN')}
            </span>
            {preview.media_url && (
              <a
                className="btn btn-light"
                href={preview.media_url}
                download={`Atelier-${preview.id}.${preview.kind === 'video' ? 'mp4' : 'png'}`}
              >
                <Download size={15} />
                下载素材
              </a>
            )}
          </footer>
        </AssetDialog>
      )}
    </main>
  );
}
