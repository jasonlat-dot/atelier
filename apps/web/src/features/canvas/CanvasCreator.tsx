import Feedback from '../../components/Feedback';
import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Film, Sparkles, Plus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { generationApi, type Schema } from '../generation/generationApi';
import ReferencePicker from '../generation/ReferencePicker';
import type { Asset } from '../assets/assetsApi';
import type { GenerateData } from './projectApi';
export const blankGenerator = (): GenerateData => ({
  modelId: '',
  prompt: '',
  quality: 'low',
  ratio: '1:1',
  resolution: '1K',
  n: 1,
  seconds: null,
  status: 'IDLE',
  jobId: null,
  error: null,
});
export default function CanvasCreator({
  value,
  style,
  floating,
  onClose,
  onChange,
  references,
  onReferences,
  linkedPrompt,
  tail,
  selected,
  busy,
  readonly,
  csrf,
  onRun,
  onAdd,
  errorText,
}: {
  value: GenerateData;
  style?: CSSProperties;
  floating?: boolean;
  onClose: () => void;
  onChange: (value: GenerateData) => void;
  references: Asset[];
  onReferences: (refs: Asset[]) => void;
  linkedPrompt: string;
  tail: boolean;
  selected: boolean;
  busy: boolean;
  readonly: boolean;
  csrf: string;
  onRun: () => void;
  onAdd: (type: 'text' | 'generate' | 'upload' | 'library') => void;
  errorText: (error: unknown) => string;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [kind, setKind] = useState('image'),
    [picker, setPicker] = useState(false);
  const catalog = useQuery({
    queryKey: ['canvas-catalog'],
    queryFn: ({ signal }) => generationApi.catalog(signal),
    staleTime: 60000,
  });
  const limits = useQuery({
    queryKey: ['canvas-limits'],
    queryFn: ({ signal }) => generationApi.limits(signal),
    staleTime: 60000,
  });
  const models = catalog.data?.models || [];
  const model = models.find((m) => m.id === value.modelId);
  const actualKind = model?.kind || (value.seconds != null ? 'video' : kind);
  const level = (s: string) => ({ '1K': 1, '2K': 2, '4K': 3 })[s] || 0;
  const normalize = (
    model: Schema['CatalogModel'],
    current: GenerateData,
  ): GenerateData => {
    const caps = model.capabilities;
    const choose = (v: string, list: string[]) =>
      list.includes(v) ? v : list[0] || '';
    const resolutions = (caps.resolutions || []).filter(
      (r) =>
        model.kind !== 'image' ||
        level(r) <= level(limits.data?.max_resolution || '1K'),
    );
    return {
      ...current,
      modelId: model.id,
      quality: choose(current.quality, caps.qualities || []),
      ratio: choose(current.ratio, caps.ratios || []),
      resolution: choose(current.resolution, resolutions),
      n: Math.max(
        1,
        Math.min(current.n, caps.max_n || 1, model.kind === 'video' ? 1 : 4),
      ),
      seconds:
        model.kind === 'video'
          ? caps.seconds?.includes(current.seconds || 0)
            ? current.seconds
            : caps.seconds?.[0] || 4
          : null,
    };
  };
  useEffect(() => {
    if (!value.modelId && models.length && !readonly) {
      const first = models.find((m) => m.kind === actualKind);
      if (first) onChange(normalize(first, value));
    }
    // Initial defaults come from the server; explicit saved choices stay visible if disabled later.
  }, [catalog.data, limits.data, value.modelId, readonly, actualKind]);
  const maxRefs = Math.min(
    model?.capabilities.max_refs || 0,
    actualKind === 'video' ? 1 : model?.capabilities.supports_edit ? 4 : 0,
  );
  const body: Schema['QuoteInput'] = {
    model_id: value.modelId,
    quality: value.quality,
    ratio: value.ratio,
    resolution: value.resolution,
    n: value.n,
    ref_count: references.length,
    seconds: actualKind === 'video' ? value.seconds : null,
  };
  const [debounced, setDebounced] = useState(body);
  const serialized = JSON.stringify(body);
  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(JSON.parse(serialized) as Schema['QuoteInput']),
      400,
    );
    return () => clearTimeout(timer);
  }, [serialized]);
  const stale = JSON.stringify(debounced) !== serialized;
  const quote = useQuery({
    queryKey: ['canvas-quote', debounced],
    queryFn: ({ signal }) => generationApi.quote(debounced, csrf, signal),
    enabled:
      !!model && !readonly && !tail && references.length <= maxRefs && !stale,
    staleTime: 10000,
    retry: false,
  });
  const blocked =
    readonly ||
    busy ||
    !model ||
    tail ||
    !quote.data ||
    quote.isFetching ||
    stale ||
    references.length > maxRefs ||
    !(linkedPrompt + (value.prompt || '')).trim() ||
    (linkedPrompt + (value.prompt || '')).length > 4000;
  const change = (patch: Partial<GenerateData>) =>
    onChange({ ...value, ...patch });
  const submission = (
    <div className="canvas-submission">
      <div className="generation-summary">
        <span>本次预计消耗</span>
        <strong>
          {stale || quote.isFetching ? '…' : (quote.data?.cost ?? '—')}{' '}
          <small>积分</small>
        </strong>
      </div>
      {quote.isError && !stale && (
        <Feedback eventKey={quote.error} variant="error">
          {errorText(quote.error)}
          <button
            className="text-action"
            disabled={readonly || busy}
            onClick={() => void quote.refetch()}
          >
            重试报价
          </button>
        </Feedback>
      )}
      <button className="btn btn-dark full" disabled={blocked} onClick={onRun}>
        <Sparkles size={15} />
        {busy
          ? '正在确认任务…'
          : selected
            ? '生成并连接结果'
            : '生成并加入画布'}
      </button>
      <p className="subtle-hint">
        积分以服务端确认结果为准。<Link to="/wallet">查看积分</Link>
      </p>
    </div>
  );
  return (
    <section
      className={`canvas-tool-panel live-creator ${floating ? 'floating-creator' : ''}`}
      style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      aria-label="画布创作参数"
    >
      <div className="panel-overline">
        <span>{selected ? '生成节点参数' : '快速创作'}</span>
        <button
          className="icon-btn"
          aria-label="关闭创作参数"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="segmented">
        {(['image', 'video'] as const).map((k) => (
          <button
            key={k}
            className={actualKind === k ? 'on' : ''}
            disabled={readonly || busy}
            onClick={() => {
              setKind(k);
              const next = models.find((m) => m.kind === k);
              onChange(
                next
                  ? normalize(next, value)
                  : {
                      ...value,
                      modelId: '',
                      seconds: k === 'video' ? 4 : null,
                    },
              );
            }}
          >
            {k === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}
            {k === 'image' ? '图片生成' : '视频生成'}
          </button>
        ))}
      </div>
      <div className="panel-scroll">
        <fieldset disabled={readonly || busy}>
          <label className="field-label" htmlFor="canvas-model">
            生成模型
          </label>
          <select
            id="canvas-model"
            className="select"
            value={value.modelId}
            onChange={(e) => {
              const next = models.find((m) => m.id === e.target.value);
              if (next) onChange(normalize(next, value));
            }}
          >
            <option value="">请选择模型</option>
            {value.modelId && !model && (
              <option value={value.modelId}>模型已停用，请重新选择</option>
            )}
            {models
              .filter((m) => m.kind === actualKind)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
          </select>
          {!catalog.isPending &&
            !catalog.isError &&
            !models.some((m) => m.kind === actualKind) && (
              <p className="subtle-hint">
                暂未配置可用的{actualKind === 'video' ? '视频' : '图片'}
                模型，请联系管理员在“模型与定价”中配置。
              </p>
            )}
          {catalog.isError && (
            <Feedback eventKey={catalog.error} variant="error">
              {errorText(catalog.error)}
              <button
                className="text-action"
                onClick={() => void catalog.refetch()}
              >
                重新加载模型
              </button>
            </Feedback>
          )}
          <div className="field-label" id="canvas-quality-label">
            生成质量
          </div>
          <div
            className="canvas-quality-options"
            role="group"
            aria-labelledby="canvas-quality-label"
          >
            {(actualKind === 'image'
              ? Array.from(
                  new Set([
                    'low',
                    'medium',
                    'high',
                    ...(model?.capabilities.qualities || []),
                  ]),
                )
              : model?.capabilities.qualities || [value.quality]
            ).map((quality) => {
              const supported =
                !!model?.capabilities.qualities?.includes(quality);
              const price = model?.prices.find(
                (p) => p.quality === quality,
              )?.base_credits;
              const label =
                (
                  {
                    low: '低',
                    medium: '中',
                    high: '高',
                    standard: '标准',
                  } as Record<string, string>
                )[quality] || quality;
              return (
                <button
                  type="button"
                  key={quality}
                  aria-label={`${label}质量`}
                  aria-pressed={value.quality === quality}
                  disabled={!supported}
                  onClick={() => change({ quality })}
                >
                  <strong>{label}</strong>
                  <small>
                    {supported
                      ? price == null
                        ? '待报价'
                        : `${price} 积分起`
                      : '未开放'}
                  </small>
                </button>
              );
            })}
          </div>
          {model &&
            actualKind === 'image' &&
            ['low', 'medium', 'high'].some(
              (q) => !model.capabilities.qualities?.includes(q),
            ) && (
              <p className="subtle-hint">
                未开放的质量档位需由管理员在“模型与定价”中配置。
              </p>
            )}
          <label className="field-label" htmlFor="canvas-prompt">
            创意描述
          </label>
          <textarea
            id="canvas-prompt"
            className="textarea prompt-field"
            maxLength={4000}
            rows={5}
            value={value.prompt || ''}
            onChange={(e) => change({ prompt: e.target.value })}
            placeholder="描述要生成的画面、镜头与风格…"
          />
          {linkedPrompt && (
            <p className="subtle-hint">
              已连接文字：{linkedPrompt.slice(0, 120)}
              {linkedPrompt.length > 120 ? '…' : ''}（与描述合并提交）
            </p>
          )}
          {floating && (
            <button
              type="button"
              className="canvas-parameter-toggle"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
            >
              <span>生成参数</span>
              <span>
                {value.ratio} · {value.resolution} ·{' '}
                {actualKind === 'video'
                  ? `${value.seconds || 4}秒`
                  : `${value.n}张`}{' '}
                {advanced ? '⌃' : '⌄'}
              </span>
            </button>
          )}
          <div hidden={floating && !advanced}>
            <div className="live-field-pair only-resolution">
              <div>
                <label className="field-label" htmlFor="canvas-resolution">
                  分辨率
                </label>
                <select
                  id="canvas-resolution"
                  className="select"
                  value={value.resolution}
                  onChange={(e) => change({ resolution: e.target.value })}
                >
                  {(model?.capabilities.resolutions || [value.resolution])
                    .filter(
                      (r) =>
                        actualKind !== 'image' ||
                        level(r) <= level(limits.data?.max_resolution || '1K'),
                    )
                    .map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                </select>
              </div>
            </div>
            <label className="field-label">画幅比例</label>
            <div className="ratio-options">
              {(model?.capabilities.ratios || ['1:1']).map((r) => (
                <button
                  type="button"
                  key={r}
                  className={value.ratio === r ? 'on' : ''}
                  aria-pressed={value.ratio === r}
                  onClick={() => change({ ratio: r })}
                >
                  {r}
                </button>
              ))}
            </div>
            {actualKind === 'video' ? (
              <>
                <label className="field-label" htmlFor="canvas-seconds">
                  视频时长
                </label>
                <select
                  id="canvas-seconds"
                  className="select"
                  value={value.seconds || 4}
                  onChange={(e) => change({ seconds: Number(e.target.value) })}
                >
                  {(model?.capabilities.seconds || [4]).map((s) => (
                    <option key={s} value={s}>
                      {s} 秒
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="canvas-count">
                  生成数量
                </label>
                <select
                  id="canvas-count"
                  className="select"
                  value={value.n}
                  onChange={(e) => change({ n: Number(e.target.value) })}
                >
                  {Array.from(
                    { length: Math.min(model?.capabilities.max_n || 1, 4) },
                    (_, i) => i + 1,
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n} 张
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <label className="field-label">
            {actualKind === 'video' ? '首帧参考图片' : '参考图片'}
          </label>
          <div className="live-references">
            {references.map((a) => (
              <div key={a.id}>
                <img src={a.thumbnail_url || ''} alt={a.name} />
                <button
                  className="icon-btn"
                  aria-label={`移除参考 ${a.name}`}
                  onClick={() =>
                    onReferences(references.filter((r) => r.id !== a.id))
                  }
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              className="tool-button"
              disabled={maxRefs === 0}
              onClick={() => setPicker(true)}
            >
              <Plus size={14} />
              选择参考
            </button>
          </div>
          <p className="subtle-hint">
            {actualKind === 'video'
              ? '当前视频接口支持一张首帧参考图；尾帧暂不可用。'
              : maxRefs === 0
                ? '当前模型仅支持文字生图。使用参考图需要选择已开启图片编辑的模型。'
                : `最多使用 ${maxRefs} 张参考图。拖动节点端口可连接提示词与参考。`}
          </p>
          {tail && (
            <Feedback variant="error">
              当前模型不支持尾帧输入，请移除尾帧连线后继续。
            </Feedback>
          )}
          {references.length > maxRefs && (
            <Feedback variant="error">
              {actualKind === 'image' && !model?.capabilities.supports_edit
                ? '当前模型尚未开启图片编辑。请更换支持参考图的模型，或请管理员核对模型能力。'
                : `当前模型最多支持 ${maxRefs} 张参考图，已连接 ${references.length} 张，请移除多余参考。`}
            </Feedback>
          )}
          {!floating && submission}
          {!floating && (
            <>
              <div className="section-divider" />
              <h4>添加到画布</h4>
              <div className="add-tiles">
                <button onClick={() => onAdd('text')}>文字节点</button>
                <button onClick={() => onAdd('generate')}>生成节点</button>
                <button onClick={() => onAdd('upload')}>上传图片／视频</button>
                <button onClick={() => onAdd('library')}>从素材库添加</button>
              </div>
            </>
          )}
        </fieldset>
      </div>
      {floating && submission}
      {picker && (
        <ReferencePicker
          selected={references}
          max={maxRefs}
          onSelect={(refs) => {
            onReferences(refs);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
          onError={errorText}
        />
      )}
    </section>
  );
}
