import Select from '../../components/Select';
import Feedback from '../../components/Feedback';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Layers3, Plus, RefreshCw, Search } from 'lucide-react';
import Tooltip from '../../components/Tooltip';
import { chatApi } from '../chat/chatApi';
import {
  ModelPriceEditor,
  MultiplierEditor,
  priceRange,
  rangeText,
} from './ModelPricing';
import './AdminModelsPage.css';
import { Link } from 'react-router-dom';
import AdminDialog from './AdminDialog';
import {
  errorText,
  modelInput,
  upstreamApi as api,
  type Account,
  type AdminProps,
  type Model,
  type Pricing,
  type Schema,
} from './upstreamApi';
import './AdminUpstream.css';
const kindNames: Record<string, string> = {
  image: '图片',
  video: '视频',
  chat: '文本',
};
const qualityNames: Record<string, string> = {
  low: '快速',
  medium: '标准',
  high: '精细',
  standard: '标准',
};
type Panel =
  | { kind: 'edit'; model?: Model }
  | { kind: 'bind' | 'disable' | 'price'; model: Model };
export default function AdminModelsPage(props: AdminProps) {
  return props.me.user.role === 'USER' ? (
    <main className="page-padding">
      <h1>无权访问</h1>
      <p>此页面需要管理员权限。</p>
    </main>
  ) : (
    <Models {...props} />
  );
}
function Models(props: AdminProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [pricing, setPricing] = useState<Pricing>();
  const [chatPrice, setChatPrice] = useState<number>();
  const [tab, setTab] = useState('image');
  const [searches, setSearches] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const version = useRef(0);
  const { me, onExpired, onReload } = props;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const current = ++version.current;
      setLoading(true);
      try {
        const [m, p, chat] = await Promise.all([
          api.models(signal),
          api.pricing(signal),
          chatApi.config(signal).catch(() => undefined),
        ]);
        if (!signal?.aborted && current === version.current) {
          setModels(m);
          setPricing(p);
          setChatPrice(chat?.credits_per_message);
          setError('');
        }
      } catch (failure) {
        if (!signal?.aborted && current === version.current)
          setError(errorText(failure, { me, onExpired, onReload }));
      } finally {
        if (!signal?.aborted && current === version.current) setLoading(false);
      }
    },
    [me, onExpired, onReload],
  );
  useEffect(() => {
    const a = new AbortController();
    void load(a.signal);
    return () => {
      a.abort();
      version.current++;
    };
  }, [load]);
  async function act(work: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setMessage(await work());
      setPanel(undefined);
      await load();
    } catch (failure) {
      setError(errorText(failure, props));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const close = () => {
    if (!busy) {
      setPanel(undefined);
      setError('');
    }
  };
  const open = (kind: 'edit' | 'bind' | 'price', model: Model) => {
    setError('');
    setPanel({ kind, model });
  };
  const tabs = [
    { kind: 'chat', label: '文本模型' },
    { kind: 'image', label: '图片模型' },
    { kind: 'video', label: '视频模型' },
    { kind: 'pricing', label: '分辨率倍率' },
  ];
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex(
      (item) => `model-tab-${item.kind}` === event.currentTarget.id,
    );
    const next =
      event.key === 'Home'
        ? tabs[0]
        : event.key === 'End'
          ? tabs.at(-1)!
          : tabs[
              (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                tabs.length
            ];
    setTab(next.kind);
    document.getElementById(`model-tab-${next.kind}`)?.focus();
  };
  const ready = (model: Model) => {
    const route = model.account_ids.length > 0 || model.group_tags.length > 0;
    return {
      route,
      price:
        model.kind === 'chat'
          ? chatPrice !== undefined
          : priceRange(model, pricing) !== undefined,
    };
  };
  const toggle = (model: Model) =>
    model.enabled
      ? setPanel({ kind: 'disable', model })
      : void act(async () => {
          // The existing enable guard requires metadata rules even for chat. These
          // zero-valued prerequisites never replace the authoritative global chat rate.
          if (model.kind === 'chat' && pricing) {
            const missing = (model.capabilities.qualities || []).filter(
              (quality) =>
                !pricing.rules.some(
                  (rule) =>
                    rule.model_id === model.id && rule.quality === quality,
                ),
            );
            if (missing.length)
              await api.savePricing(
                {
                  ...pricing,
                  rules: [
                    ...pricing.rules,
                    ...missing.map((quality) => ({
                      model_id: model.id,
                      quality,
                      base_credits: 0,
                      edit_surcharge: 0,
                    })),
                  ],
                },
                me.csrf_token,
              );
          }
          await api.saveModel(
            { ...modelInput(model), enabled: true },
            me.csrf_token,
            true,
          );
          return '模型已启用，已进入用户模型目录。';
        });
  return (
    <main className="page-padding up-page models-page">
      <header className="page-title-row models-heading">
        <div>
          <div className="eyebrow">ATELIER / MODELS</div>
          <h1>模型与定价</h1>
          <p>按模型类型管理：用户能用什么、走哪些账号、每次消耗多少积分。</p>
        </div>
        <div className="up-actions">
          <button
            className="btn btn-light"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            刷新配置
          </button>
          <button
            className="btn btn-dark"
            onClick={() => {
              setError('');
              setPanel({ kind: 'edit' });
            }}
          >
            <Plus size={15} />
            新增模型
          </button>
        </div>
      </header>
      {message && (
        <Feedback variant="success" onDismiss={() => setMessage('')}>
          {message}
        </Feedback>
      )}
      {error && !panel && (
        <Feedback variant="error" onDismiss={() => setError('')}>
          {error}
          <button className="btn btn-light" onClick={() => void load()}>
            重新加载
          </button>
        </Feedback>
      )}
      <div className="models-tabs" role="tablist" aria-label="模型管理">
        {tabs.map((item) => (
          <button
            key={item.kind}
            id={`model-tab-${item.kind}`}
            role="tab"
            aria-label={item.label}
            aria-selected={tab === item.kind}
            aria-controls={`model-panel-${item.kind}`}
            tabIndex={tab === item.kind ? 0 : -1}
            onClick={() => setTab(item.kind)}
            onKeyDown={navigateTabs}
          >
            {item.label}
            {item.kind !== 'pricing' && !loading && (
              <span>
                {models.filter((model) => model.kind === item.kind).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {tabs
        .filter((item) => item.kind !== 'pricing')
        .map((item) => {
          const list = models.filter(
            (model) =>
              model.kind === item.kind &&
              `${model.id} ${model.display_name}`
                .toLowerCase()
                .includes((searches[item.kind] || '').trim().toLowerCase()),
          );
          return (
            <section
              key={item.kind}
              id={`model-panel-${item.kind}`}
              role="tabpanel"
              aria-labelledby={`model-tab-${item.kind}`}
              hidden={tab !== item.kind}
            >
              <p className="models-note">
                {item.kind === 'chat'
                  ? '文本模型按完整回复计费，使用全站统一价，不设置质量和分辨率。'
                  : item.kind === 'image'
                    ? '图片按张计费：基础积分 × 分辨率倍率；图片编辑在倍率计算后另加附加费。'
                    : '视频按秒计费：基础积分 × 分辨率倍率 × 时长。可选时长以模型实际能力为准。'}
              </p>
              <div className="models-toolbar">
                <label>
                  <Search size={16} aria-hidden="true" />
                  <input
                    aria-label={`搜索${item.label}`}
                    placeholder="搜索模型标识或名称"
                    value={searches[item.kind] || ''}
                    onChange={(event) =>
                      setSearches((current) => ({
                        ...current,
                        [item.kind]: event.target.value,
                      }))
                    }
                  />
                </label>
                <span>{loading ? '正在加载…' : `${list.length} 个模型`}</span>
              </div>
              <div className="models-list">
                <div className="up-table-scroll">
                  <table className={`models-table models-table-${item.kind}`}>
                    <thead>
                      <tr>
                        <th>模型</th>
                        {item.kind !== 'chat' && <th>能力</th>}
                        <th>账号路由</th>
                        <th>
                          {item.kind === 'chat'
                            ? '计费'
                            : `价格（积分/${item.kind === 'image' ? '张' : '秒'}）`}
                        </th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((model) => {
                        const state = ready(model);
                        const missing =
                          !state.route && !state.price
                            ? '缺账号和价格'
                            : !state.route
                              ? '缺账号'
                              : !state.price
                                ? model.kind === 'chat'
                                  ? '统一价未读取'
                                  : '缺价格'
                                : '';
                        const range = priceRange(model, pricing);
                        const values =
                          pricing?.rules
                            .filter((rule) => rule.model_id === model.id)
                            .map((rule) => rule.edit_surcharge) || [];
                        const edit = values.length ? rangeText(values) : '—';
                        return (
                          <tr key={model.id}>
                            <td>
                              <strong
                                className="models-name"
                                data-tip={model.display_name}
                              >
                                {model.display_name}
                              </strong>
                              <code
                                className="models-id"
                                data-tip={model.id}
                                tabIndex={0}
                              >
                                {model.id}
                              </code>
                            </td>
                            {item.kind !== 'chat' && (
                              <td>
                                <div className="models-capabilities">
                                  {model.kind === 'image'
                                    ? (model.capabilities.qualities || []).map(
                                        (quality) => (
                                          <span key={quality}>
                                            {qualityNames[quality] || quality}
                                          </span>
                                        ),
                                      )
                                    : (
                                        model.capabilities.resolutions || []
                                      ).map((resolution) => (
                                        <span key={resolution}>
                                          {resolution}
                                        </span>
                                      ))}
                                </div>
                                <small>
                                  {model.kind === 'image'
                                    ? `${model.capabilities.resolutions?.join(' · ')} · 最多 ${model.capabilities.max_n} 张`
                                    : `可选 ${model.capabilities.seconds?.join(' / ')} 秒`}
                                </small>
                              </td>
                            )}
                            <td>
                              {state.route ? (
                                <>
                                  <span>
                                    {model.account_ids.length} 个固定账号
                                  </span>
                                  <small>
                                    {model.group_tags.length
                                      ? `分组：${model.group_tags.join('、')}`
                                      : '未设账号分组'}
                                  </small>
                                </>
                              ) : (
                                <button
                                  className="models-link models-missing"
                                  aria-label={`未绑定，去绑定 ${model.display_name}`}
                                  onClick={() => open('bind', model)}
                                >
                                  未绑定，去绑定
                                </button>
                              )}
                            </td>
                            <td>
                              {model.kind === 'chat' ? (
                                <>
                                  <strong className="models-price">
                                    {chatPrice === undefined
                                      ? '—'
                                      : `${chatPrice} 积分 / 条`}
                                  </strong>
                                  <small>
                                    {chatPrice === undefined
                                      ? '暂未读取统一价，请刷新'
                                      : '全站统一价 · 完整回复计费'}
                                  </small>
                                </>
                              ) : range ? (
                                <>
                                  <strong className="models-price">
                                    {rangeText(range)}
                                  </strong>
                                  <small>
                                    {model.kind === 'image'
                                      ? model.capabilities.supports_edit
                                        ? `编辑另加 ${edit} 积分 / 张`
                                        : '未开放图片编辑'
                                      : `10 秒约 ${rangeText(range.map((value) => value * 10))} 积分`}
                                  </small>
                                </>
                              ) : (
                                <button
                                  className="models-link models-missing"
                                  aria-label={`未设置，去设置 ${model.display_name}`}
                                  disabled={!pricing}
                                  onClick={() => open('price', model)}
                                >
                                  未设置，去设置
                                </button>
                              )}
                            </td>
                            <td>
                              <div className="models-state">
                                <Tooltip
                                  content={
                                    !model.enabled && missing
                                      ? `启用前请完成配置：${missing}`
                                      : undefined
                                  }
                                >
                                  <button
                                    type="button"
                                    className="models-switch"
                                    role="switch"
                                    aria-checked={model.enabled}
                                    aria-label={`${model.enabled ? '停用' : '启用'} ${model.display_name}`}
                                    disabled={
                                      busy ||
                                      loading ||
                                      (!model.enabled && !!missing)
                                    }
                                    onClick={() => toggle(model)}
                                  />
                                </Tooltip>
                                <div>
                                  {model.enabled ? '已启用' : '未启用'}
                                  {missing && (
                                    <small className="models-warning">
                                      {missing}
                                    </small>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td>
                              <div className="models-row-actions">
                                <button
                                  className="models-link"
                                  aria-label={`编辑 ${model.display_name}`}
                                  disabled={busy || loading}
                                  onClick={() => open('edit', model)}
                                >
                                  编辑
                                </button>
                                <button
                                  className="models-link"
                                  aria-label={`绑定账号 ${model.display_name}`}
                                  disabled={busy || loading}
                                  onClick={() => open('bind', model)}
                                >
                                  绑定账号
                                </button>
                                {model.kind !== 'chat' && (
                                  <button
                                    className="models-link"
                                    aria-label={`配置价格 ${model.display_name}`}
                                    disabled={busy || loading || !pricing}
                                    onClick={() => open('price', model)}
                                  >
                                    设置价格
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!list.length && (
                  <div className="models-empty">
                    <Layers3 size={27} />
                    <h3>
                      {loading
                        ? '正在加载模型…'
                        : searches[item.kind]
                          ? '没有匹配的模型'
                          : `暂无${kindNames[item.kind]}模型`}
                    </h3>
                    <p>
                      {searches[item.kind]
                        ? '试试其他名称或标识。'
                        : '新增模型后，绑定账号并完成配置即可启用。'}
                    </p>
                    {searches[item.kind] && (
                      <button
                        className="btn btn-light"
                        onClick={() =>
                          setSearches((current) => ({
                            ...current,
                            [item.kind]: '',
                          }))
                        }
                      >
                        清除搜索
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      <section
        id="model-panel-pricing"
        role="tabpanel"
        aria-labelledby="model-tab-pricing"
        hidden={tab !== 'pricing'}
      >
        {pricing && (
          <MultiplierEditor
            key={pricing.revision}
            pricing={pricing}
            busy={busy}
            onSave={(body) =>
              void act(async () => {
                await api.savePricing(body, me.csrf_token);
                return '分辨率倍率已保存。';
              })
            }
          />
        )}
      </section>
      <p className="models-footnote">
        只有已启用模型进入用户目录。固定账号与分组取并集；绑定数量不代表当前可用账号数。
        <Link to="/admin/accounts">管理上游账号池</Link>
      </p>
      {panel && (
        <AdminDialog
          drawer={panel.kind !== 'disable'}
          className="models-dialog"
          title={
            panel.kind === 'edit'
              ? panel.model
                ? '编辑模型'
                : '新增模型'
              : panel.kind === 'bind'
                ? '绑定服务账号'
                : panel.kind === 'price'
                  ? `设置价格 · ${panel.model.display_name}`
                  : '停用模型？'
          }
          busy={busy}
          onClose={close}
        >
          {error && (
            <Feedback variant="error" onDismiss={() => setError('')}>
              {error}
            </Feedback>
          )}
          {panel.kind === 'edit' && (
            <ModelForm
              key={panel.model?.id || 'new'}
              model={panel.model}
              initialKind={tab === 'pricing' ? 'image' : tab}
              busy={busy}
              onCancel={close}
              onSave={(body) =>
                void act(async () => {
                  await api.saveModel(body, me.csrf_token, !!panel.model);
                  setTab(body.kind);
                  return panel.model
                    ? '模型配置已保存。'
                    : '模型已创建，当前未启用。请绑定账号并完成计费配置。';
                })
              }
            />
          )}
          {panel.kind === 'bind' && (
            <BindingForm
              model={panel.model}
              props={props}
              busy={busy}
              onCancel={close}
              onSave={(body) =>
                void act(async () => {
                  await api.bind(panel.model.id, body, me.csrf_token);
                  return '路由绑定已保存。请完成计费配置后启用模型。';
                })
              }
            />
          )}
          {panel.kind === 'price' && pricing && (
            <ModelPriceEditor
              model={panel.model}
              pricing={pricing}
              busy={busy}
              onCancel={close}
              onSave={(body) =>
                void act(async () => {
                  await api.savePricing(body, me.csrf_token);
                  return '积分价格已保存。';
                })
              }
            />
          )}
          {panel.kind === 'disable' && (
            <>
              <p className="up-note">
                停用“{panel.model.display_name}
                ”后用户将无法发起新请求，已有任务继续按提交时配置处理。
              </p>
              <div className="up-form-footer">
                <button
                  className="btn btn-light"
                  data-initial-focus
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </button>
                <button
                  className="btn btn-dark"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.saveModel(
                        { ...modelInput(panel.model), enabled: false },
                        me.csrf_token,
                        true,
                      );
                      return '模型已停用。';
                    })
                  }
                >
                  {busy ? '正在保存…' : '停用模型'}
                </button>
              </div>
            </>
          )}
        </AdminDialog>
      )}
    </main>
  );
}
export function defaultCaps(kind: string): Schema['Capabilities'] {
  return kind === 'chat'
    ? {
        qualities: ['message'],
        ratios: [],
        resolutions: ['text'],
        max_n: 1,
        max_refs: 0,
        size_mode: 'flex',
        sizes: [],
        seconds: [],
        supports_edit: false,
      }
    : kind === 'video'
      ? {
          qualities: ['standard'],
          ratios: ['16:9', '9:16'],
          resolutions: ['720p'],
          max_n: 1,
          max_refs: 1,
          size_mode: 'enum',
          sizes: ['1280x720', '720x1280', '1792x1024', '1024x1792'],
          seconds: [4, 8, 12],
          supports_edit: false,
        }
      : {
          qualities: ['low', 'medium', 'high'],
          ratios: ['1:1', '16:9', '9:16'],
          resolutions: ['1K'],
          max_n: 1,
          max_refs: 0,
          size_mode: 'flex',
          sizes: [],
          seconds: [],
          supports_edit: false,
        };
}
function Choices({
  title,
  options,
  values,
  onChange,
}: {
  title: string;
  options: string[];
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="up-actions">
        {options.map((o) => (
          <label className="up-check" key={o}>
            <input
              type="checkbox"
              checked={values.includes(o)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...values, o]
                    : values.filter((v) => v !== o),
                )
              }
            />
            {o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
function ModelForm({
  model: m,
  initialKind,
  busy,
  onCancel,
  onSave,
}: {
  model?: Model;
  initialKind: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Schema['ModelInput']) => void;
}) {
  const [kind, setKind] = useState(m?.kind || initialKind);
  const [caps, setCaps] = useState(m?.capabilities || defaultCaps(initialKind));
  const [error, setError] = useState('');
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !caps.qualities?.length ||
          !caps.resolutions?.length ||
          (kind !== 'chat' && !caps.ratios?.length)
        ) {
          setError('请至少选择一种质量、分辨率及适用比例。');
          return;
        }
        const f = new FormData(e.currentTarget);
        const body: Schema['Capabilities'] = {
          ...caps,
          sizes:
            caps.size_mode === 'enum'
              ? String(f.get('sizes') || '')
                  .split(/[\s,，]+/)
                  .filter(Boolean)
              : [],
          seconds:
            kind === 'video'
              ? String(f.get('seconds') || '')
                  .split(/[\s,，]+/)
                  .filter(Boolean)
                  .map(Number)
              : [],
        };
        onSave({
          id: m?.id || String(f.get('id')).trim(),
          kind,
          display_name: String(f.get('display_name')).trim(),
          upstream_model:
            String(f.get('upstream_model') || '').trim() || undefined,
          capabilities: body,
          sort_order: Number(f.get('sort_order')),
          enabled: m?.enabled || false,
          revision: m?.revision,
        });
      }}
    >
      <p className="up-note">
        公开标识和名称展示给用户，上游模型标识仅保存到服务端。新模型默认关闭，完成绑定与价格后再启用。
      </p>
      <label>
        公开模型标识
        <input
          data-initial-focus
          name="id"
          required
          pattern="[A-Za-z0-9][A-Za-z0-9_.\-]*"
          maxLength={64}
          defaultValue={m?.id}
          disabled={!!m}
          placeholder="atelier-image"
        />
      </label>
      <label>
        展示名称
        <input
          name="display_name"
          required
          maxLength={120}
          defaultValue={m?.display_name}
        />
      </label>
      <div className="up-grid">
        <label>
          模型类型
          <Select
            value={kind}
            disabled={!!m}
            onChange={(e) => {
              setKind(e.target.value);
              setCaps(defaultCaps(e.target.value));
            }}
          >
            {Object.entries(kindNames).map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <label>
          排序值
          <input
            name="sort_order"
            type="number"
            min={-10000}
            max={10000}
            required
            defaultValue={m?.sort_order || 0}
          />
        </label>
      </div>
      <label>
        上游模型标识
        <input
          name="upstream_model"
          required={!m}
          maxLength={200}
          autoComplete="off"
          placeholder={m ? '已配置，留空保留' : '填写上游接口支持的模型标识'}
        />
      </label>
      {kind === 'image' && (
        <Choices
          title="质量"
          options={
            kind === 'image'
              ? ['low', 'medium', 'high']
              : kind === 'video'
                ? ['standard']
                : ['message']
          }
          values={caps.qualities || []}
          onChange={(qualities) => setCaps({ ...caps, qualities })}
        />
      )}
      {kind !== 'chat' && (
        <Choices
          title="画面比例"
          options={
            kind === 'video'
              ? ['1:1', '16:9', '9:16']
              : ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9']
          }
          values={caps.ratios || []}
          onChange={(ratios) => setCaps({ ...caps, ratios })}
        />
      )}
      {kind !== 'chat' && (
        <Choices
          title="分辨率"
          options={
            kind === 'image'
              ? ['1K', '2K', '4K']
              : kind === 'video'
                ? ['720p', '1080p']
                : ['text']
          }
          values={caps.resolutions || []}
          onChange={(resolutions) => setCaps({ ...caps, resolutions })}
        />
      )}
      {kind === 'chat' && (
        <p className="models-form-note">
          文本模型使用全站统一的完整回复价格，不设置质量和分辨率。
        </p>
      )}
      {kind !== 'chat' && (
        <>
          <div className="up-grid">
            <label>
              单次张数上限
              <input
                type="number"
                min={1}
                max={kind === 'image' ? 4 : 1}
                required
                value={caps.max_n}
                onChange={(e) =>
                  setCaps({ ...caps, max_n: Number(e.target.value) })
                }
              />
            </label>
            <label>
              参考图上限
              <input
                type="number"
                min={caps.supports_edit ? 1 : 0}
                max={kind === 'image' ? 4 : 1}
                required
                value={caps.max_refs}
                onChange={(e) =>
                  setCaps({ ...caps, max_refs: Number(e.target.value) })
                }
              />
            </label>
          </div>
          {kind === 'image' && (
            <label className="up-check">
              <input
                type="checkbox"
                checked={caps.supports_edit}
                onChange={(e) =>
                  setCaps({
                    ...caps,
                    supports_edit: e.target.checked,
                    max_refs: e.target.checked
                      ? Math.max(1, caps.max_refs || 0)
                      : caps.max_refs,
                  })
                }
              />
              支持图片编辑
            </label>
          )}
          <label>
            尺寸模式
            <Select
              value={caps.size_mode}
              onChange={(e) => setCaps({ ...caps, size_mode: e.target.value })}
            >
              <option value="flex">按比例计算尺寸</option>
              <option value="enum">固定尺寸集合</option>
            </Select>
          </label>
          {caps.size_mode === 'enum' && (
            <label>
              支持尺寸
              <input
                name="sizes"
                required
                defaultValue={caps.sizes?.join(', ')}
                placeholder="1024x1024, 1536x1024"
              />
              <small>
                英文逗号分隔，需与上游支持一致；系统选取最接近的尺寸。
              </small>
            </label>
          )}
          {kind === 'video' && (
            <label>
              支持时长（秒）
              <input
                name="seconds"
                required
                defaultValue={caps.seconds?.join(', ')}
                placeholder="4, 8, 12"
              />
              <small>逗号分隔的 1–60 整数，按实际模型能力填写。</small>
            </label>
          )}
        </>
      )}
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
      <div className="up-form-footer">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button className="btn btn-dark" disabled={busy}>
          {busy ? '正在保存…' : '保存模型'}
        </button>
      </div>
    </form>
  );
}
function BindingForm({
  model,
  props,
  busy,
  onCancel,
  onSave,
}: {
  model: Model;
  props: AdminProps;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Schema['BindingInput']) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(model.account_ids);
  const { me, onExpired, onReload } = props;
  useEffect(() => {
    const a = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const all: Account[] = [];
        let before: string | undefined;
        do {
          const p = await api.accounts('', before, a.signal);
          all.push(...p.items);
          before = p.next_cursor || undefined;
        } while (before && all.length < 500);
        if (before) throw Error();
        if (!a.signal.aborted) {
          setAccounts(all);
          setError('');
        }
      } catch (e) {
        if (!a.signal.aborted)
          setError(errorText(e, { me, onExpired, onReload }));
      } finally {
        if (!a.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => a.abort();
  }, [me, onExpired, onReload, attempt]);
  return (
    <form
      className="up-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSave({
          revision: model.revision,
          account_ids: selected,
          group_tags: [
            ...new Set(
              String(f.get('groups') || '')
                .split(/[\s,，]+/)
                .filter(Boolean),
            ),
          ],
        });
      }}
    >
      <p className="up-note">
        {model.display_name} ·
        固定账号与分组取并集；分组中新加入的账号会自动参与路由，停用、冷却、无额度的账号暂不调度。
      </p>
      <label>
        动态分组
        <input
          name="groups"
          maxLength={2100}
          defaultValue={model.group_tags.join(', ')}
          placeholder="default, image-pool"
        />
        <small>英文逗号分隔，最多 32 个。</small>
      </label>
      <fieldset>
        <legend>固定账号</legend>
        {loading ? (
          <p role="status">正在加载账号…</p>
        ) : error ? (
          <Feedback onDismiss={() => setError('')} variant="error">
            {error}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAttempt(attempt + 1)}
            >
              重试加载
            </button>
          </Feedback>
        ) : !accounts.length ? (
          <p className="up-note">暂无账号，请先在账号池新增。</p>
        ) : (
          <div className="up-binding-list">
            {accounts.map((a) => (
              <label className="up-check" key={a.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(a.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, a.id]
                        : selected.filter((id) => id !== a.id),
                    )
                  }
                />
                {a.name} · {a.group_tag}
                <small>{a.status !== 'ACTIVE' ? `（${a.status}）` : ''}</small>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="up-form-footer">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button className="btn btn-dark" disabled={busy || loading || !!error}>
          {busy ? '正在保存…' : '保存绑定'}
        </button>
      </div>
    </form>
  );
}
