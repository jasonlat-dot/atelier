import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Coins,
  Link2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
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
  chat: '对话',
};
type Panel =
  { kind: 'edit'; model?: Model } | { kind: 'bind' | 'disable'; model: Model };
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
  const [tab, setTab] = useState('models');
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const { me, onExpired, onReload } = props;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const [m, p] = await Promise.all([
          api.models(signal),
          api.pricing(signal),
        ]);
        if (!signal?.aborted) {
          setModels(m);
          setPricing(p);
          setError('');
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(errorText(e, { me, onExpired, onReload }));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [me, onExpired, onReload],
  );
  useEffect(() => {
    const a = new AbortController();
    void load(a.signal);
    return () => a.abort();
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
    } catch (e) {
      setError(errorText(e, props));
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
  return (
    <main className="page-padding up-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">MANAGEMENT / MODELS</div>
          <h1>模型与定价</h1>
          <p className="page-subtitle">面向用户的模型目录、能力与积分价格。</p>
        </div>
        <span className="neutral-status">
          <SlidersHorizontal size={14} /> MODEL CONFIGURATION
        </span>
      </div>
      <div className="up-toolbar">
        <p className="up-note">
          新建模型 → 绑定<Link to="/admin/accounts">服务账号</Link> → 设置价格 →
          启用
        </p>
        <div className="up-actions">
          <button
            className="btn btn-ghost"
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
      </div>
      {message && (
        <div className="up-message" role="status">
          {message}
        </div>
      )}
      {error && !panel && (
        <div className="up-message" role="alert">
          {error}
          <button className="btn btn-ghost" onClick={() => void load()}>
            重新加载
          </button>
        </div>
      )}
      <div className="up-tabs" role="tablist" aria-label="模型管理">
        <button
          role="tab"
          id="models-tab"
          aria-controls="models-panel"
          aria-selected={tab === 'models'}
          onClick={() => setTab('models')}
        >
          模型目录
        </button>
        <button
          role="tab"
          id="pricing-tab"
          aria-controls="pricing-panel"
          aria-selected={tab === 'pricing'}
          onClick={() => setTab('pricing')}
        >
          积分定价
        </button>
      </div>
      <section
        id="models-panel"
        role="tabpanel"
        aria-labelledby="models-tab"
        hidden={tab !== 'models'}
        className="surface-block"
      >
        <div className="surface-title">
          <strong>公开模型目录</strong>
          <span>
            {loading
              ? '正在加载…'
              : `${models.length} 个模型 · ${models.filter((m) => m.enabled).length} 个已启用`}
          </span>
        </div>
        <div className="up-table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>类型</th>
                <th>支持能力</th>
                <th>路由绑定</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.display_name}</strong>
                    <small className="muted-block">{m.id}</small>
                  </td>
                  <td>{kindNames[m.kind]}</td>
                  <td>
                    {m.capabilities.qualities?.join(' / ')}
                    <small className="muted-block">
                      {m.capabilities.resolutions?.join(' · ')}
                      {m.kind === 'image'
                        ? ` · 最多 ${m.capabilities.max_n} 张`
                        : m.kind === 'video'
                          ? ` · ${m.capabilities.seconds?.join('/')} 秒`
                          : ''}
                    </small>
                  </td>
                  <td>
                    {m.account_ids.length} 个指定账号
                    <small className="muted-block">
                      {m.group_tags.length
                        ? `分组：${m.group_tags.join('、')}`
                        : '未绑定分组'}
                    </small>
                  </td>
                  <td>
                    <span className={`up-tag ${m.enabled ? 'good' : ''}`}>
                      {m.enabled ? '已启用' : '未启用'}
                    </span>
                  </td>
                  <td>
                    <div className="up-actions">
                      <button
                        className="icon-btn"
                        aria-label={`编辑 ${m.display_name}`}
                        disabled={busy || loading}
                        onClick={() => {
                          setError('');
                          setPanel({ kind: 'edit', model: m });
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`绑定账号 ${m.display_name}`}
                        disabled={busy || loading}
                        onClick={() => {
                          setError('');
                          setPanel({ kind: 'bind', model: m });
                        }}
                      >
                        <Link2 size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`配置价格 ${m.display_name}`}
                        onClick={() => setTab('pricing')}
                      >
                        <Coins size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`${m.enabled ? '停用' : '启用'} ${m.display_name}`}
                        disabled={busy || loading}
                        onClick={() =>
                          m.enabled
                            ? setPanel({ kind: 'disable', model: m })
                            : void act(async () => {
                                await api.saveModel(
                                  { ...modelInput(m), enabled: true },
                                  me.csrf_token,
                                  true,
                                );
                                return '模型已启用，已进入用户模型目录。';
                              })
                        }
                      >
                        <Power size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!models.length && (
          <div className="up-empty">
            {loading
              ? '正在加载模型…'
              : error
                ? '暂时无法加载模型'
                : '先新建一个模型，逐步配置账号和价格。'}
          </div>
        )}
      </section>
      <div
        id="pricing-panel"
        role="tabpanel"
        aria-labelledby="pricing-tab"
        hidden={tab !== 'pricing'}
      >
        {pricing && (
          <PriceEditor
            key={pricing.revision}
            models={models}
            pricing={pricing}
            busy={busy}
            onSave={(body) =>
              void act(async () => {
                await api.savePricing(body, me.csrf_token);
                return '积分价格已保存。';
              })
            }
          />
        )}
      </div>
      <p className="up-note">
        仅已启用模型会进入用户目录。创作任务与积分结算将在后续阶段接入。
      </p>
      {panel && (
        <AdminDialog
          drawer={panel.kind !== 'disable'}
          title={
            panel.kind === 'edit'
              ? panel.model
                ? '编辑模型'
                : '新增模型'
              : panel.kind === 'bind'
                ? '绑定服务账号'
                : '停用模型？'
          }
          busy={busy}
          onClose={close}
        >
          {error && (
            <div className="up-message" role="alert">
              {error}
            </div>
          )}
          {panel.kind === 'edit' && (
            <ModelForm
              model={panel.model}
              busy={busy}
              onCancel={close}
              onSave={(body) =>
                void act(async () => {
                  await api.saveModel(body, me.csrf_token, !!panel.model);
                  return panel.model
                    ? '模型配置已保存。'
                    : '模型已创建，当前未启用。请绑定账号并配置价格。';
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
                  return '路由绑定已保存。请配置积分价格后启用模型。';
                })
              }
            />
          )}
          {panel.kind === 'disable' && (
            <>
              <p className="up-note">
                停用“{panel.model.display_name}”后用户将无法发起新请求。
              </p>
              <div className="up-form-footer">
                <button
                  className="btn btn-ghost"
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
  busy,
  onCancel,
  onSave,
}: {
  model?: Model;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Schema['ModelInput']) => void;
}) {
  const [kind, setKind] = useState(m?.kind || 'image');
  const [caps, setCaps] = useState(m?.capabilities || defaultCaps('image'));
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
          <select
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
          </select>
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
      <Choices
        title="质量档位"
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
            <select
              value={caps.size_mode}
              onChange={(e) => setCaps({ ...caps, size_mode: e.target.value })}
            >
              <option value="flex">按比例计算尺寸</option>
              <option value="enum">固定尺寸集合</option>
            </select>
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
      {error && <p role="alert">{error}</p>}
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
        指定账号与分组取并集；分组中新加入的账号会自动参与路由，停用、冷却、无额度的账号暂不调度。
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
        <legend>指定账号</legend>
        {loading ? (
          <p role="status">正在加载账号…</p>
        ) : error ? (
          <p role="alert">
            {error}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setAttempt(attempt + 1)}
            >
              重试加载
            </button>
          </p>
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
function PriceEditor({
  models,
  pricing,
  busy,
  onSave,
}: {
  models: Model[];
  pricing: Pricing;
  busy: boolean;
  onSave: (body: Pricing) => void;
}) {
  const [rules, setRules] = useState<
    Record<string, { base: string; edit: string }>
  >(() =>
    Object.fromEntries(
      pricing.rules.map((r) => [
        `${r.model_id}/${r.quality}`,
        { base: String(r.base_credits), edit: String(r.edit_surcharge) },
      ]),
    ),
  );
  const [multipliers, setMultipliers] = useState(pricing.multipliers);
  const [error, setError] = useState('');
  function change(
    id: string,
    quality: string,
    key: 'base' | 'edit',
    value: string,
  ) {
    const k = `${id}/${quality}`;
    setRules({
      ...rules,
      [k]: {
        base: rules[k]?.base ?? '',
        edit: rules[k]?.edit ?? '0',
        [key]: value,
      },
    });
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const output: Pricing['rules'] = [];
        for (const m of models)
          for (const q of m.capabilities.qualities || []) {
            const r = rules[`${m.id}/${q}`];
            if (!r || r.base === '') {
              if (m.enabled) {
                setError(`${m.display_name} 已启用，必须配置所有质量价格。`);
                return;
              }
              continue;
            }
            output.push({
              model_id: m.id,
              quality: q,
              base_credits: Number(r.base),
              edit_surcharge: m.kind === 'image' ? Number(r.edit || '0') : 0,
            });
          }
        setError('');
        onSave({ revision: pricing.revision, rules: output, multipliers });
      }}
    >
      <p className="up-note">
        基础价格 ×
        分辨率倍率。图片按张，视频按秒，对话按条；图片编辑附加费在倍率计算后按张增加。未启用模型可留空，0
        仅适用于对话。这里维护配置，不扣取用户积分。
      </p>
      <section className="surface-block up-pricing-section">
        <div className="surface-title">
          <strong>分辨率倍率</strong>
          <span>全局配置 · 版本 {pricing.revision}</span>
        </div>
        <div className="up-actions" style={{ padding: 20 }}>
          {multipliers.map((r, i) => (
            <label className="up-field" key={r.resolution}>
              {r.resolution}
              <input
                className="up-price-input"
                aria-label={`${r.resolution} 倍率`}
                type="number"
                min={1}
                max={100}
                required
                value={r.multiplier}
                onChange={(e) =>
                  setMultipliers(
                    multipliers.map((v, index) =>
                      index === i
                        ? { ...v, multiplier: Number(e.target.value) }
                        : v,
                    ),
                  )
                }
              />
            </label>
          ))}
        </div>
      </section>
      {models.map((m) => (
        <section className="surface-block up-pricing-section" key={m.id}>
          <div className="surface-title">
            <h3>{m.display_name}</h3>
            <span>
              {kindNames[m.kind]} ·{' '}
              {m.kind === 'video'
                ? '积分 / 秒'
                : m.kind === 'image'
                  ? '积分 / 张'
                  : '积分 / 条'}
            </span>
          </div>
          <div className="up-table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>质量</th>
                  <th>基础积分</th>
                  {m.kind === 'image' && <th>编辑附加费</th>}
                  {m.capabilities.resolutions?.map((res) => (
                    <th key={res}>{res} 价格</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.capabilities.qualities?.map((q) => {
                  const r = rules[`${m.id}/${q}`];
                  return (
                    <tr key={q}>
                      <td>{q}</td>
                      <td>
                        <input
                          className="up-price-input"
                          aria-label={`${m.display_name} ${q} 基础积分`}
                          type="number"
                          required={m.enabled}
                          min={m.kind === 'chat' ? 0 : 1}
                          max={1000000}
                          value={r?.base ?? ''}
                          placeholder="未配置"
                          onChange={(e) =>
                            change(m.id, q, 'base', e.target.value)
                          }
                        />
                      </td>
                      {m.kind === 'image' && (
                        <td>
                          <input
                            className="up-price-input"
                            aria-label={`${m.display_name} ${q} 编辑附加费`}
                            type="number"
                            min={0}
                            max={1000000}
                            value={r?.edit ?? '0'}
                            onChange={(e) =>
                              change(m.id, q, 'edit', e.target.value)
                            }
                          />
                        </td>
                      )}
                      {m.capabilities.resolutions?.map((res) => (
                        <td key={res}>
                          {r?.base
                            ? Number(r.base) *
                              (multipliers.find((v) => v.resolution === res)
                                ?.multiplier ?? 1)
                            : '—'}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {!models.length && (
        <div className="up-empty">添加模型后即可配置积分价格。</div>
      )}
      {error && (
        <p className="up-message" role="alert">
          {error}
        </p>
      )}
      <div className="up-actions">
        <button className="btn btn-dark" disabled={busy || !models.length}>
          {busy ? '正在保存…' : '保存全部价格'}
        </button>
        <span className="up-note">
          更改在保存后生效，切换标签不会丢失未保存输入。
        </span>
      </div>
    </form>
  );
}
