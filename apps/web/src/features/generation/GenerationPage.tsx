import Feedback from '../../components/Feedback';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Download,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  Trash2,
  X,
} from 'lucide-react';
import { SessionError, type Me } from '../auth/sessionApi';
import { walletApi, type Summary } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import AssetDialog from '../assets/AssetDialog';
import { assetsApi, type Asset } from '../assets/assetsApi';
import ReferencePicker from './ReferencePicker';
import GenerationHistoryMenu, {
  type HistoryMenu,
} from './GenerationHistoryMenu';
import {
  active,
  failures,
  generationApi,
  statuses,
  type Draft,
  type Job,
  type Schema,
} from './generationApi';
import '../assets/AssetsPage.css';
import './GenerationPage.css';

type Props = { me: Me; onExpired: () => void; onReload: () => void };
type Form = {
  kind: string;
  model_id: string;
  prompt: string;
  quality: string;
  ratio: string;
  resolution: string;
  n: number;
  seconds: number;
  referenced: boolean;
  references: Asset[];
};
const initial: Form = {
  kind: 'image',
  model_id: '',
  prompt: '',
  quality: 'low',
  ratio: '1:1',
  resolution: '1K',
  n: 1,
  seconds: 4,
  referenced: false,
  references: [],
};
const qualityNames: Record<string, string> = {
  low: '快速',
  medium: '标准',
  high: '精细',
};
const level = (s: string) => ({ '1K': 1, '2K': 2, '4K': 3 })[s] || 0;
function normalize(
  f: Form,
  m: Schema['CatalogModel'],
  limits: Schema['GenerationLimits'],
): Form {
  const c = m.capabilities;
  const choose = (value: string, values: string[]) =>
    values.includes(value) ? value : values[0] || '';
  const resolutions = (c.resolutions || []).filter(
    (r) => m.kind !== 'image' || level(r) <= level(limits.max_resolution),
  );
  const referenced =
    f.referenced &&
    (c.max_refs || 0) > 0 &&
    (m.kind === 'video' || !!c.supports_edit);
  return {
    ...f,
    kind: m.kind,
    model_id: m.id,
    quality: choose(f.quality, c.qualities || []),
    ratio: choose(f.ratio, c.ratios || []),
    resolution: choose(f.resolution, resolutions),
    n: Math.min(f.n, c.max_n || 1, m.kind === 'video' ? 1 : 4),
    seconds: (c.seconds || []).includes(f.seconds)
      ? f.seconds
      : c.seconds?.[0] || 4,
    referenced,
    references: referenced
      ? f.references.slice(
          0,
          Math.min(c.max_refs || 0, m.kind === 'video' ? 1 : 4),
        )
      : [],
  };
}
export default function GenerationPage(props: Props) {
  const { me, onExpired, onReload } = props;
  const location = useLocation();
  const updateWallet = useWalletSummaryUpdate();
  const [catalog, setCatalog] = useState<Schema['CatalogModel'][]>([]);
  const [limits, setLimits] = useState<Schema['GenerationLimits']>();
  const [wallet, setWallet] = useState<Summary>();
  const [form, setForm] = useState<Form>(() => {
    const draft = (location.state as { workspacePrompt?: unknown } | null)
      ?.workspacePrompt;
    return {
      ...initial,
      prompt:
        typeof draft === 'string' && draft.length <= 4000 ? draft.trim() : '',
    };
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job>();
  const selectedId = useRef<string>();
  const [before, setBefore] = useState<string>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [next, setNext] = useState<string | null>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [quote, setQuote] = useState<Schema['Quote']>();
  const [quoteError, setQuoteError] = useState('');
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteRetry, setQuoteRetry] = useState(0);
  const [submitBusy, setSubmitBusy] = useState(false);
  const submission = useRef<{ key: string; body: Draft }>();
  const submitLock = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [cancelling, setCancelling] = useState<string>();
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Asset>();
  const [historyMenu, setHistoryMenu] = useState<HistoryMenu>();
  const [historyDelete, setHistoryDelete] = useState<Job>();
  const [historyDeleteError, setHistoryDeleteError] = useState('');
  const [deletingHistory, setDeletingHistory] = useState(false);
  const historyDeleteLock = useRef(false);
  const [connection, setConnection] = useState('正在连接');
  const cursor = useRef('');
  const loadVersion = useRef(0);
  const mounted = useRef(false);
  const errorText = useCallback(
    (error: unknown) => {
      if (error instanceof SessionError) {
        if (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
          onExpired();
        if (error.code === 'MFA_REQUIRED') onReload();
        if (error.code === 'TOO_MANY_ACTIVE_JOBS')
          return '已有任务正在进行，请等待完成或取消后再生成。';
        if (error.status === 402)
          return '可用积分不足，请前往积分页面查看余额。';
        if (error.code === 'RESOLUTION_NOT_ALLOWED')
          return '当前账号不支持此分辨率，请重新选择。';
        if (error.code === 'CONTENT_POLICY') return failures.CONTENT_POLICY;
        if (error.status === 404)
          return '任务或参考图片已删除、过期或不可用，请重新选择。';
        if (error.status === 429) return '请求过于频繁，请稍后重试。';
        if (error.status === 422)
          return '当前模型或参考图片不支持这些参数，请检查后重试。';
        if (error.status === 403) return '安全验证已失效，请刷新页面重新验证。';
      }
      return '服务连接暂时异常，请重试。';
    },
    [onExpired, onReload],
  );
  const selectJob = useCallback((job: Job) => {
    selectedId.current = job.id;
    setSelected(job);
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++loadVersion.current;
      try {
        const [page, balance] = await Promise.all([
          generationApi.list(before, signal),
          walletApi.summary(signal),
        ]);
        const current = selectedId.current;
        const job =
          page.items.find((j) => j.id === current) ||
          (current ? await generationApi.get(current, signal) : page.items[0]);
        if (
          signal?.aborted ||
          !mounted.current ||
          version !== loadVersion.current
        )
          return;
        setJobs(page.items);
        setNext(page.next_cursor);
        setWallet(balance);
        updateWallet(balance);
        setLoadError('');
        if (job && current === selectedId.current) selectJob(job);
      } catch (e) {
        if (
          !signal?.aborted &&
          mounted.current &&
          version === loadVersion.current
        )
          setLoadError(errorText(e));
      }
    },
    [before, updateWallet, errorText, selectJob],
  );
  const loadConfig = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const [data, capabilities] = await Promise.all([
          generationApi.catalog(signal),
          generationApi.limits(signal),
        ]);
        if (signal?.aborted || !mounted.current) return;
        const models = data.models.filter(
          (m) =>
            m.kind === 'image' ||
            (m.kind === 'video' && capabilities.video_enabled),
        );
        setCatalog(models);
        setLimits(capabilities);
        setForm((f) => {
          const model =
            models.find((m) => m.id === f.model_id) ||
            models.find(
              (m) => m.kind === 'image' || capabilities.video_enabled,
            );
          return model ? normalize(f, model, capabilities) : f;
        });
        await refresh(signal);
      } catch (e) {
        if (!signal?.aborted && mounted.current) setLoadError(errorText(e));
      } finally {
        if (!signal?.aborted && mounted.current) setLoading(false);
      }
    },
    [refresh, errorText],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++loadVersion.current;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void loadConfig(abort.signal);
    return () => abort.abort();
  }, [loadConfig]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = false;
    const stream = new EventSource(
      `/api/v1/events${cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : ''}`,
    );
    const update = (event: MessageEvent) => {
      cursor.current = event.lastEventId || cursor.current;
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 200);
    };
    stream.addEventListener('job.updated', update as EventListener);
    stream.onopen = () => {
      live = true;
      setConnection('实时更新');
      void refresh();
    };
    stream.onerror = () => {
      live = false;
      setConnection('连接恢复中 · 自动刷新');
      void refresh();
    };
    let ticks = 0;
    const poll = setInterval(() => {
      ticks++;
      if (!live || ticks % 3 === 0) void refresh();
    }, 5000);
    return () => {
      stream.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [refresh]);
  const model = catalog.find((m) => m.id === form.model_id);
  const quoteInput = useMemo(
    () => ({
      model_id: form.model_id,
      quality: form.quality,
      ratio: form.ratio,
      resolution: form.resolution,
      n: form.n,
      seconds: form.kind === 'video' ? form.seconds : null,
      ref_count: form.references.length,
    }),
    [
      form.model_id,
      form.quality,
      form.ratio,
      form.resolution,
      form.n,
      form.kind,
      form.seconds,
      form.references.length,
    ],
  );
  // Match a response to its exact parameter snapshot; a stale quote never enables submission.
  const quoteKey = JSON.stringify(quoteInput);
  const [pricedKey, setPricedKey] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    if (!quoteInput.model_id) return;
    setQuoteBusy(true);
    setQuoteError('');
    const timeout = setTimeout(() => {
      void generationApi
        .quote(quoteInput, me.csrf_token, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) {
            setQuote(value);
            setPricedKey(quoteKey);
          }
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) {
            setQuote(undefined);
            setQuoteError(errorText(e));
          }
        })
        .finally(() => {
          if (!abort.signal.aborted) setQuoteBusy(false);
        });
    }, 350);
    return () => {
      abort.abort();
      clearTimeout(timeout);
    };
  }, [quoteInput, quoteKey, me.csrf_token, errorText, quoteRetry]);
  const edit = (patch: Partial<Form>) => {
    if (!uncertain && !submitLock.current) {
      setForm((f) => ({ ...f, ...patch }));
      setFeedback('');
      setActionError('');
    }
  };
  const changeModel = (id: string, kind?: string) => {
    const m =
      catalog.find((m) => m.id === id) || catalog.find((m) => m.kind === kind);
    if (m && limits)
      setForm((f) =>
        normalize({ ...f, referenced: false, references: [] }, m, limits),
      );
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      submitLock.current ||
      !model ||
      (!uncertain && (!quote || pricedKey !== quoteKey))
    )
      return;
    submitLock.current = true;
    setSubmitBusy(true);
    setActionError('');
    submission.current ||= {
      key: crypto.randomUUID(),
      body: {
        model_id: form.model_id,
        prompt: form.prompt.trim(),
        quality: form.quality,
        ratio: form.ratio,
        resolution: form.resolution,
        n: form.n,
        seconds: form.kind === 'video' ? form.seconds : null,
        references: form.references.map((a) => ({
          asset_id: a.id,
          role: 'reference',
        })),
      },
    };
    try {
      const { job } = await generationApi.create(
        submission.current.body,
        me.csrf_token,
        submission.current.key,
      );
      if (!mounted.current) return;
      submission.current = undefined;
      setUncertain(false);
      selectJob(job);
      setBefore(undefined);
      setPrevious([]);
      await refresh();
    } catch (e) {
      if (!mounted.current) return;
      const ambiguous = !(e instanceof SessionError) || e.status >= 500;
      setUncertain(ambiguous);
      if (!ambiguous) submission.current = undefined;
      setActionError(
        ambiguous
          ? '提交结果尚未确认。请点击下方重试，使用同一请求编号不会重复扣分。'
          : errorText(e),
      );
      if (!ambiguous) {
        setQuoteRetry((v) => v + 1);
        void refresh();
      }
    } finally {
      submitLock.current = false;
      if (mounted.current) setSubmitBusy(false);
    }
  };
  const cancel = async (job: Job) => {
    setCancelling(job.id);
    setActionError('');
    try {
      const receipt = await generationApi.cancel(job.id, me.csrf_token);
      if (mounted.current) {
        if (selectedId.current === job.id) selectJob(receipt.job);
        await refresh();
      }
    } catch (e) {
      if (mounted.current) setActionError(errorText(e));
    } finally {
      if (mounted.current) setCancelling(undefined);
    }
  };
  const maxRefs = Math.min(
    model?.capabilities.max_refs || 0,
    form.kind === 'video' ? 1 : 4,
  );
  const upload = async (file?: File) => {
    if (!file) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    ) {
      setActionError('请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片。');
      return;
    }
    setUploading(true);
    setActionError('');
    try {
      const asset = await assetsApi.upload(file, me.csrf_token);
      if (mounted.current)
        setForm((f) => ({
          ...f,
          references: [
            ...f.references.filter((a) => a.id !== asset.id),
            asset,
          ].slice(0, maxRefs),
        }));
    } catch (e) {
      if (mounted.current) setActionError(errorText(e));
    } finally {
      if (mounted.current) setUploading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };
  const reuse = async (job: Job) => {
    const m = catalog.find((m) => m.id === job.model_id);
    if (!m || !limits) {
      setActionError('原模型已下架，请选择其他模型。');
      return;
    }
    try {
      const references = await Promise.all(
        job.params.references.map((r) => assetsApi.get(r.asset_id)),
      );
      if (!mounted.current) return;
      setForm(
        normalize(
          {
            ...initial,
            ...job.params,
            prompt: job.prompt,
            n: job.n,
            seconds: job.params.seconds || 4,
            referenced: references.length > 0,
            references,
          },
          m,
          limits,
        ),
      );
      setActionError('');
      setFeedback('参数已填入，请检查报价后点击生成。');
      document.getElementById('generation-prompt')?.focus();
    } catch (e) {
      if (mounted.current) setActionError(errorText(e));
    }
  };
  const ready = quote && pricedKey === quoteKey && !quoteBusy && !quoteError;
  const disabled = submitBusy || uncertain;
  const deleteHistory = async () => {
    if (!historyDelete || historyDeleteLock.current) return;
    historyDeleteLock.current = true;
    setDeletingHistory(true);
    setHistoryDeleteError('');
    try {
      await generationApi.deleteHistory(historyDelete.id, me.csrf_token);
      if (!mounted.current) return;
      ++loadVersion.current;
      if (selectedId.current === historyDelete.id) {
        selectedId.current = undefined;
        setSelected(undefined);
      }
      setJobs((items) => items.filter((job) => job.id !== historyDelete.id));
      setHistoryDelete(undefined);
      setFeedback('已删除生成记录，素材与积分流水仍会保留。');
      await refresh();
    } catch (error) {
      if (mounted.current)
        setHistoryDeleteError(
          error instanceof SessionError && error.code === 'JOB_STATE_CONFLICT'
            ? '任务仍在进行中，请等待完成或取消任务后再删除记录。'
            : errorText(error),
        );
    } finally {
      historyDeleteLock.current = false;
      if (mounted.current) setDeletingHistory(false);
    }
  };
  return (
    <main className="generation-page" aria-label="图片与视频生成">
      <header className="gen-heading">
        <div>
          <div className="eyebrow">GENERATE</div>
          <p className="muted">让一个想法，成为看得见的作品。</p>
        </div>
        <span
          className={`gen-connection ${connection === '实时更新' ? 'connected' : ''}`}
          role="status"
        >
          <i aria-hidden="true" />
          {connection}
        </span>
      </header>
      {loadError && (
        <Feedback
          onDismiss={() => setLoadError('')}
          className="gen-notice"
          variant="error"
        >
          {loadError}
          <button className="btn" onClick={() => void loadConfig()}>
            重新连接
          </button>
        </Feedback>
      )}
      <div className="gen-layout">
        <section className="gen-controls" aria-label="生成参数">
          <div className="gen-panel-heading">
            <Sparkles size={17} />
            <h2>开始创作</h2>
          </div>
          {loading && !catalog.length ? (
            <p role="status">正在加载模型…</p>
          ) : !catalog.length ? (
            <div className="gen-empty-small">
              <Layers size={28} />
              <h3>还没有可用模型</h3>
              <p>请联系管理员配置上游账号、模型与积分价格。</p>
              {me.user.role !== 'USER' && (
                <Link className="btn" to="/admin/models">
                  配置模型
                </Link>
              )}
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)}>
              <fieldset disabled={disabled || uploading}>
                <div className="gen-kind" aria-label="生成类型">
                  {[
                    ['image', '图片', ImageIcon],
                    ['video', '视频', Clapperboard],
                  ].map(([kind, label, Icon]) => {
                    const Glyph = Icon as typeof ImageIcon;
                    return (
                      <button
                        key={kind as string}
                        type="button"
                        className={form.kind === kind ? 'active' : ''}
                        aria-pressed={form.kind === kind}
                        disabled={
                          !catalog.some((m) => m.kind === kind) ||
                          (kind === 'video' && !limits?.video_enabled)
                        }
                        onClick={() => changeModel('', kind as string)}
                      >
                        <Glyph size={16} />
                        {label as string}
                      </button>
                    );
                  })}
                </div>
                <label>
                  生成模型
                  <select
                    value={form.model_id}
                    onChange={(e) => changeModel(e.target.value)}
                  >
                    {catalog
                      .filter((m) => m.kind === form.kind)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                  </select>
                </label>
                {maxRefs > 0 &&
                  (form.kind === 'video' ||
                    model?.capabilities.supports_edit) && (
                    <div className="gen-mode">
                      <button
                        type="button"
                        aria-pressed={!form.referenced}
                        onClick={() =>
                          edit({ referenced: false, references: [] })
                        }
                      >
                        文字生成
                      </button>
                      <button
                        type="button"
                        aria-pressed={form.referenced}
                        onClick={() => edit({ referenced: true })}
                      >
                        参考图生成
                      </button>
                    </div>
                  )}
                <label className="gen-prompt-label" htmlFor="generation-prompt">
                  画面描述<span>{form.prompt.length} / 4000</span>
                </label>
                <textarea
                  id="generation-prompt"
                  value={form.prompt}
                  maxLength={4000}
                  placeholder="描述主体、场景、光线与构图，例如：黄昏海边的白色小屋，柔和自然光，电影感构图…"
                  rows={6}
                  onChange={(e) => edit({ prompt: e.target.value })}
                />
                {form.referenced && (
                  <div className="gen-references">
                    <div className="gen-label-row">
                      <strong>参考图片</strong>
                      <span>
                        {form.references.length} / {maxRefs}
                      </span>
                    </div>
                    <div className="gen-ref-list">
                      {form.references.map((a) => (
                        <div key={a.id}>
                          <img
                            src={a.thumbnail_url || a.media_url || ''}
                            alt={a.name}
                          />
                          <button
                            type="button"
                            aria-label={`移除参考图 ${a.name}`}
                            onClick={() =>
                              edit({
                                references: form.references.filter(
                                  (r) => r.id !== a.id,
                                ),
                              })
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="gen-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={form.references.length >= maxRefs}
                        onClick={() => setPicker(true)}
                      >
                        <Plus size={13} />
                        素材库
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={form.references.length >= maxRefs}
                        onClick={() => uploadRef.current?.click()}
                      >
                        <Upload size={13} />
                        {uploading ? '上传中…' : '上传图片'}
                      </button>
                    </div>
                    <small className="muted">
                      PNG / JPEG / WebP，单张不超过 20 MB
                    </small>
                    <input
                      ref={uploadRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      aria-label="上传参考图片"
                      hidden
                      onChange={(e) => void upload(e.target.files?.[0])}
                    />
                  </div>
                )}
                <div className="gen-options">
                  <label>
                    质量
                    <select
                      value={form.quality}
                      onChange={(e) => edit({ quality: e.target.value })}
                    >
                      {model?.capabilities.qualities?.map((q) => (
                        <option key={q} value={q}>
                          {qualityNames[q] || q}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    画面比例
                    <select
                      value={form.ratio}
                      onChange={(e) => edit({ ratio: e.target.value })}
                    >
                      {model?.capabilities.ratios?.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    分辨率
                    <select
                      value={form.resolution}
                      onChange={(e) => edit({ resolution: e.target.value })}
                    >
                      {model?.capabilities.resolutions
                        ?.filter(
                          (r) =>
                            form.kind !== 'image' ||
                            !limits ||
                            level(r) <= level(limits.max_resolution),
                        )
                        .map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                    </select>
                  </label>
                  {form.kind === 'image' ? (
                    <label>
                      生成数量
                      <select
                        value={form.n}
                        onChange={(e) => edit({ n: Number(e.target.value) })}
                      >
                        {Array.from(
                          {
                            length: Math.min(model?.capabilities.max_n || 1, 4),
                          },
                          (_, i) => (
                            <option key={i} value={i + 1}>
                              {i + 1} 张
                            </option>
                          ),
                        )}
                      </select>
                    </label>
                  ) : (
                    <label>
                      视频时长
                      <select
                        value={form.seconds}
                        onChange={(e) =>
                          edit({ seconds: Number(e.target.value) })
                        }
                      >
                        {model?.capabilities.seconds?.map((s) => (
                          <option key={s} value={s}>
                            {s} 秒
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </fieldset>
              <div className="gen-price" aria-live="polite">
                <div>
                  <span>本次预计消耗</span>
                  <strong>
                    {ready ? quote.cost : '—'} <small>积分</small>
                  </strong>
                </div>
                <p>
                  {quoteBusy
                    ? '正在获取报价…'
                    : quoteError
                      ? '暂未获取报价'
                      : pricedKey !== quoteKey
                        ? '正在获取报价…'
                        : quote
                          ? `${quote.size} · 每${form.kind === 'image' ? '张' : '段'} ${quote.cost_per_output} 积分`
                          : '请选择生成参数'}
                </p>
                {quoteError && (
                  <>
                    <Feedback variant="error" title="暂时无法获取报价">
                      {quoteError}
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setQuoteRetry((v) => v + 1)}
                      >
                        重试报价
                      </button>
                    </Feedback>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setQuoteRetry((v) => v + 1)}
                    >
                      重试报价
                    </button>
                  </>
                )}
              </div>
              {feedback && (
                <Feedback
                  onDismiss={() => setFeedback('')}
                  className="gen-feedback"
                  variant="success"
                >
                  {feedback}
                </Feedback>
              )}
              {actionError && (
                <Feedback
                  onDismiss={() => setActionError('')}
                  className="gen-form-message"
                  variant="error"
                >
                  {actionError}
                </Feedback>
              )}
              <button
                className="btn btn-dark gen-submit"
                type="submit"
                disabled={
                  submitBusy ||
                  uploading ||
                  (!uncertain &&
                    (!ready ||
                      !form.prompt.trim() ||
                      (form.referenced && !form.references.length) ||
                      !wallet ||
                      wallet.available < (quote?.cost || 0)))
                }
              >
                {submitBusy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Sparkles size={16} />
                )}
                {submitBusy
                  ? '正在提交…'
                  : uncertain
                    ? '重试确认提交'
                    : `生成${form.kind === 'image' ? '图片' : '视频'}`}
              </button>
              <p className="gen-budget">
                可用 <strong>{wallet?.available ?? '—'}</strong> · 预占{' '}
                {wallet?.held ?? '—'} 积分 <Link to="/wallet">查看</Link>
              </p>
              {ready && wallet && wallet.available < quote.cost && (
                <p className="gen-form-message">
                  可用积分不足，请先补充积分或调整参数。
                </p>
              )}
              <p className="gen-hint">
                提交时按最新价格预占，未产出的积分自动退回。最多同时进行{' '}
                {limits?.max_active_jobs ?? '—'} 个任务。
              </p>
            </form>
          )}
        </section>
        <section className="gen-stage" aria-label="生成结果">
          <div className="gen-panel-heading">
            <h2>创作预览</h2>
            <Link to="/assets">
              查看素材库 <ChevronRight size={13} />
            </Link>
          </div>
          {!selected ? (
            <div className="gen-stage-empty">
              <div className="gen-empty-symbol">
                <ImageIcon size={32} strokeWidth={1} />
                <Sparkles size={16} />
              </div>
              <h2>下一幅作品，从这里开始</h2>
              <p>
                写下画面描述，选择模型和参数。
                <br />
                生成的图片与视频会在这里呈现，并自动保存到素材库。
              </p>
              <div className="gen-suggestions">
                {['雨后街角的花店，胶片质感', '海边日落，柔和的金色光线'].map(
                  (prompt) => (
                    <button
                      key={prompt}
                      disabled={disabled}
                      onClick={() => {
                        edit({ prompt });
                        document.getElementById('generation-prompt')?.focus();
                      }}
                    >
                      {prompt} <Plus size={12} />
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="gen-result-meta">
                <span className={`gen-status ${selected.status.toLowerCase()}`}>
                  {selected.status === 'SUCCEEDED' && (
                    <Check size={13} aria-hidden="true" />
                  )}
                  {selected.cancel_requested && active(selected)
                    ? '正在取消'
                    : statuses[selected.status] || selected.status}
                </span>
                <span>
                  {selected.display_name} · {selected.size}
                </span>
              </div>
              {active(selected) && (
                <div className="gen-progress" role="status">
                  <LoaderCircle size={23} className="spin" />
                  <strong>
                    {selected.cancel_requested
                      ? '正在停止任务…'
                      : statuses[selected.status]}
                  </strong>
                  <p>
                    可离开页面，任务会在后台继续。已有结果保存后再结算积分。
                  </p>
                  <progress
                    aria-label="生成进度"
                    max={100}
                    value={selected.progress}
                  />
                  <small>{selected.progress}%</small>
                </div>
              )}
              {!!selected.outputs.length && (
                <div
                  className={`gen-outputs ${selected.outputs.length === 1 ? 'single' : ''}`}
                >
                  {selected.outputs.map(({ idx, asset }) => (
                    <article key={asset.id}>
                      <button
                        className="gen-output-preview"
                        aria-label={`预览结果 ${idx + 1}`}
                        onClick={() => setPreview(asset)}
                      >
                        {asset.kind === 'video' ? (
                          <>
                            <img
                              src={asset.thumbnail_url || ''}
                              alt={`视频封面 ${idx + 1}`}
                            />
                            <Clapperboard size={25} />
                          </>
                        ) : (
                          <img
                            src={asset.media_url || ''}
                            alt={`生成结果 ${idx + 1}`}
                            onError={(e) => {
                              e.currentTarget.alt = '预览链接失效，请刷新结果';
                            }}
                          />
                        )}
                      </button>
                      <div>
                        <span>结果 {idx + 1}</span>
                        {asset.media_url && (
                          <a
                            href={asset.media_url}
                            download={asset.name}
                            aria-label={`下载结果 ${idx + 1}`}
                          >
                            <Download size={14} />
                            下载
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {!active(selected) && !selected.outputs.length && (
                <div className="gen-no-output">
                  <ImageIcon size={34} strokeWidth={1} />
                  <h3>
                    {selected.status === 'CANCELLED'
                      ? '任务已取消'
                      : selected.status === 'SUCCEEDED' ||
                          selected.status === 'PARTIAL'
                        ? '结果素材已删除或过期'
                        : '这次没有生成结果'}
                  </h3>
                  <p>
                    {failures[selected.error_code || ''] ||
                      '未产出的积分已退回，可调整参数后再试。'}
                  </p>
                </div>
              )}
              {selected.status === 'PARTIAL' && (
                <p className="gen-notice">
                  已完成 {selected.outputs.length} / {selected.n}{' '}
                  个结果，未完成部分已退回积分。
                </p>
              )}
              <div className="gen-job-detail">
                <p>{selected.prompt}</p>
                <div>
                  <span>
                    {selected.params.ratio} · {selected.params.resolution} ·{' '}
                    {qualityNames[selected.params.quality] ||
                      selected.params.quality}
                    {selected.params.seconds
                      ? ` · ${selected.params.seconds} 秒`
                      : ''}
                  </span>
                  <time dateTime={selected.created_at}>
                    {new Date(selected.created_at).toLocaleString('zh-CN')}
                  </time>
                </div>
                <div className="gen-settlement">
                  <div>
                    <span>预占</span> <strong>{selected.cost}</strong>
                  </div>
                  <div>
                    <span>已结算</span> <strong>{selected.settled}</strong>
                  </div>
                  <div>
                    <span>已退回</span>{' '}
                    <strong>
                      {selected.released} <small>积分</small>
                    </strong>
                  </div>
                </div>
                <div className="gen-actions">
                  <button
                    className="btn btn-dark"
                    disabled={disabled || uploading}
                    onClick={() => void reuse(selected)}
                  >
                    <RefreshCw size={13} />
                    复用参数
                  </button>
                  <button className="btn" onClick={() => void refresh()}>
                    刷新结果
                  </button>
                  {active(selected) && (
                    <button
                      className="btn"
                      disabled={!!cancelling || selected.cancel_requested}
                      onClick={() => void cancel(selected)}
                    >
                      {cancelling || selected.cancel_requested
                        ? '正在取消…'
                        : '取消任务'}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
        <aside className="gen-history" aria-label="生成任务列表">
          <div className="gen-panel-heading">
            <h2>生成记录</h2>
            <button
              className="icon-btn"
              aria-label="刷新生成记录"
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {!jobs.length && (
            <div className="gen-history-empty">
              <Layers size={24} strokeWidth={1.2} />
              <p>你的创作记录会留在这里</p>
            </div>
          )}
          <div className="gen-task-list">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="gen-task-row"
                onContextMenu={(event) => {
                  event.preventDefault();
                  const trigger =
                    event.currentTarget.querySelector<HTMLButtonElement>(
                      '.gen-task',
                    )!;
                  trigger.focus({ preventScroll: true });
                  setHistoryMenu({
                    job,
                    x: event.clientX,
                    y: event.clientY,
                    trigger,
                  });
                }}
              >
                <button
                  className={`gen-task ${selected?.id === job.id ? 'selected' : ''}`}
                  data-status={job.status}
                  aria-pressed={selected?.id === job.id}
                  title={job.prompt}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'ContextMenu' ||
                      (event.shiftKey && event.key === 'F10')
                    ) {
                      event.preventDefault();
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      setHistoryMenu({
                        job,
                        x: bounds.left + 20,
                        y: bounds.top + 20,
                        trigger: event.currentTarget,
                      });
                    }
                  }}
                  onClick={() => selectJob(job)}
                >
                  <div className="gen-task-icon">
                    {job.outputs[0]?.asset.thumbnail_url ? (
                      <img src={job.outputs[0].asset.thumbnail_url} alt="" />
                    ) : job.kind === 'video' ? (
                      <Clapperboard size={18} />
                    ) : (
                      <ImageIcon size={18} />
                    )}
                  </div>
                  <div>
                    <strong>{job.prompt}</strong>
                    <span>
                      {job.status === 'SUCCEEDED' && (
                        <Check size={12} aria-hidden="true" />
                      )}
                      {job.cancel_requested && active(job)
                        ? '正在取消'
                        : statuses[job.status]}
                    </span>
                    <small>
                      {job.display_name} ·{' '}
                      {new Date(job.created_at).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </small>
                  </div>
                </button>
                <button
                  className="gen-task-more"
                  aria-label={`记录操作 ${job.prompt}`}
                  title="记录操作"
                  aria-haspopup="menu"
                  aria-expanded={historyMenu?.job.id === job.id}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setHistoryMenu({
                      job,
                      x: bounds.right - 224,
                      y: bounds.bottom + 4,
                      trigger: event.currentTarget,
                    });
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="gen-pagination">
            <button
              className="icon-btn"
              aria-label="较新任务"
              disabled={!previous.length}
              onClick={() => {
                setBefore(previous.at(-1));
                setPrevious((v) => v.slice(0, -1));
              }}
            >
              <ChevronLeft size={15} />
            </button>
            <span>第 {previous.length + 1} 页</span>
            <button
              className="icon-btn"
              aria-label="较早任务"
              disabled={!next}
              onClick={() => {
                setPrevious((v) => [...v, before]);
                setBefore(next || undefined);
              }}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </aside>
      </div>
      {historyMenu && (
        <GenerationHistoryMenu
          menu={historyMenu}
          onClose={() => setHistoryMenu(undefined)}
          reuseDisabled={disabled || uploading}
          onView={() => {
            selectJob(historyMenu.job);
            setHistoryMenu(undefined);
            historyMenu.trigger.focus({ preventScroll: true });
          }}
          onReuse={() => {
            void reuse(historyMenu.job);
            setHistoryMenu(undefined);
          }}
          onDelete={() => {
            setHistoryDelete(historyMenu.job);
            setHistoryDeleteError('');
            setHistoryMenu(undefined);
          }}
        />
      )}
      {historyDelete && (
        <AssetDialog
          title="删除这条生成记录？"
          busy={deletingHistory}
          onClose={() => setHistoryDelete(undefined)}
        >
          <div className="gen-delete-record">
            <div className="gen-delete-record-icon">
              <Trash2 size={21} />
            </div>
            <p>这条记录将从生成记录列表中移除。</p>
            <blockquote>{historyDelete.prompt}</blockquote>
            <p className="gen-delete-record-note">
              生成的图片或视频仍保留在素材库，画布引用与积分流水不受影响。
            </p>
            {historyDeleteError && (
              <Feedback
                onDismiss={() => setHistoryDeleteError('')}
                variant="error"
              >
                {historyDeleteError}
              </Feedback>
            )}
            <div className="gen-delete-record-actions">
              <button
                className="btn"
                disabled={deletingHistory}
                data-initial-focus
                onClick={() => setHistoryDelete(undefined)}
              >
                保留记录
              </button>
              <button
                className="btn gen-delete-record-confirm"
                disabled={deletingHistory}
                onClick={() => void deleteHistory()}
              >
                {deletingHistory ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Trash2 size={15} />
                )}
                {deletingHistory ? '正在删除…' : '确认删除记录'}
              </button>
            </div>
          </div>
        </AssetDialog>
      )}
      {picker && (
        <ReferencePicker
          selected={form.references}
          max={maxRefs}
          onSelect={(references) => edit({ references })}
          onClose={() => setPicker(false)}
          onError={errorText}
        />
      )}
      {preview && (
        <AssetDialog
          title="生成结果预览"
          preview
          onClose={() => setPreview(undefined)}
        >
          {preview.kind === 'video' ? (
            <video
              src={preview.media_url || ''}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={preview.media_url || ''} alt="生成结果大图" />
          )}
          <div className="gen-actions">
            {preview.media_url && (
              <a
                className="btn btn-dark"
                href={preview.media_url}
                download={preview.name}
              >
                <Download size={15} />
                下载原文件
              </a>
            )}
            <button
              className="btn"
              onClick={() => {
                void assetsApi
                  .get(preview.id)
                  .then((a) => setPreview(a))
                  .catch((e: unknown) => {
                    setPreview(undefined);
                    setActionError(errorText(e));
                  });
              }}
            >
              刷新预览链接
            </button>
          </div>
        </AssetDialog>
      )}
    </main>
  );
}
