import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AssetDialog from '../assets/AssetDialog';
import { assetsApi, type Asset } from '../assets/assetsApi';

export default function ReferencePicker({
  selected,
  max,
  onSelect,
  onClose,
  onError,
  media = false,
}: {
  selected: Asset[];
  max: number;
  onSelect: (assets: Asset[]) => void;
  onClose: () => void;
  onError: (error: unknown) => string;
  media?: boolean;
}) {
  const [items, setItems] = useState<Asset[]>([]);
  const [picked, setPicked] = useState(selected);
  const [before, setBefore] = useState<string>();
  const [next, setNext] = useState<string | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void assetsApi
      .list(
        { kind: media ? '' : 'image', source: '', search: '' },
        before,
        abort.signal,
      )
      .then((page) => {
        if (!abort.signal.aborted) {
          setItems(page.items.filter((a) => a.state === 'READY'));
          setNext(page.next_cursor);
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) setError(onError(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [before, retry, onError, media]);
  return (
    <AssetDialog
      title={media ? '添加素材到画布' : '选择参考图片'}
      onClose={onClose}
    >
      <p className="muted">
        从素材库选择最多 {max} {media ? '个素材' : '张图片'}，已选{' '}
        {picked.length} 个。
      </p>
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            className="btn"
            onClick={() => {
              setBusy(true);
              setRetry((v) => v + 1);
            }}
          >
            重试加载
          </button>
        </p>
      )}
      {busy ? (
        <p role="status">正在加载图片…</p>
      ) : (
        <div className="gen-picker">
          {items.map((a) => (
            <label
              key={a.id}
              className={picked.some((p) => p.id === a.id) ? 'selected' : ''}
            >
              <input
                type="checkbox"
                checked={picked.some((p) => p.id === a.id)}
                disabled={
                  !picked.some((p) => p.id === a.id) && picked.length >= max
                }
                onChange={(e) =>
                  setPicked((list) =>
                    e.target.checked
                      ? [...list, a]
                      : list.filter((p) => p.id !== a.id),
                  )
                }
              />
              <img src={a.thumbnail_url || a.media_url || ''} alt="" />
              <span>{a.name}</span>
            </label>
          ))}
          {!items.length && (
            <p>
              当前页没有可用图片。<Link to="/assets">前往素材库上传</Link>
            </p>
          )}
        </div>
      )}
      <div className="gen-actions">
        <button
          className="btn"
          disabled={!before || busy}
          onClick={() => {
            setBusy(true);
            setBefore(undefined);
          }}
        >
          返回首批
        </button>
        <button
          className="btn"
          disabled={!next || busy}
          onClick={() => {
            setBusy(true);
            setBefore(next || undefined);
          }}
        >
          下一批
        </button>
        <button
          className="btn btn-dark"
          onClick={() => {
            onSelect(picked);
            onClose();
          }}
        >
          {media ? '添加所选素材' : '使用所选图片'}
        </button>
      </div>
    </AssetDialog>
  );
}
