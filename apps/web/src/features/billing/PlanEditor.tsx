import { useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Coins, Layers3 } from 'lucide-react';
import Select from '../../components/Select';
import Feedback from '../../components/Feedback';
import AdminDialog from '../upstream/AdminDialog';
import type { AdminProps } from '../upstream/upstreamApi';
import {
  billingApi,
  billingError,
  money,
  type Plan,
  type PlanInput,
} from './billingApi';
import './PlanEditor.css';

const initial: PlanInput = {
  name: '',
  kind: 'PACK',
  description: '',
  price_cents: 100,
  currency: 'CNY',
  credits: 100,
  period_days: null,
  rollover: true,
  concurrency_limit: 3,
  max_resolution: '4K',
  retention_days: 180,
  active: false,
};
type NumberField =
  'credits' | 'period_days' | 'concurrency_limit' | 'retention_days';
type Field = 'name' | 'price' | 'description' | NumberField;
type Errors = Partial<Record<Field, string>>;
const integer = (text: string) => (/^\d+$/.test(text) ? Number(text) : NaN);
// Parse decimal currency without floating point multiplication or silent rounding.
const cents = (text: string) => {
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null;
  const [whole, decimal = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(value) && value >= 1 && value <= 100000000
    ? value
    : null;
};

function NumberInput({
  field,
  label,
  unit,
  value,
  error,
  hideError = false,
  id,
  onChange,
}: {
  field: NumberField;
  label: string;
  unit: string;
  value: string;
  error?: string;
  hideError?: boolean;
  id: string;
  onChange: (field: NumberField, value: string) => void;
}) {
  return (
    <div className="plan-editor-field">
      <label htmlFor={id}>
        {label}
        <span className="plan-editor-required">必填</span>
      </label>
      <div className="plan-editor-affix" data-invalid={!!error}>
        <input
          id={id}
          aria-label={label}
          inputMode="numeric"
          value={value}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onChange(field, event.target.value)}
        />
        <span>{unit}</span>
      </div>
      {error && !hideError && (
        <small id={`${id}-error`} className="plan-editor-error">
          {error}
        </small>
      )}
    </div>
  );
}

export default function PlanEditor(
  props: AdminProps & {
    plan?: Plan;
    hasKnownOrders: boolean;
    onClose: () => void;
    onDone: (text: string) => Promise<void>;
  },
) {
  const original = props.plan?.details || initial;
  const [p, setP] = useState<PlanInput>(original);
  const [price, setPrice] = useState((original.price_cents / 100).toFixed(2));
  const [numbers, setNumbers] = useState<Record<NumberField, string>>({
    credits: String(original.credits),
    period_days: String(original.period_days ?? 30),
    concurrency_limit: String(original.concurrency_limit),
    retention_days: String(original.retention_days),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [discard, setDiscard] = useState(false);
  const lock = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const fieldId = (field: string) => `${id}-${field}`;
  const priceCents = cents(price);
  const candidate: PlanInput = {
    ...p,
    name: p.name.trim(),
    price_cents: priceCents ?? 0,
    credits: integer(numbers.credits),
    period_days: p.kind === 'MONTHLY' ? integer(numbers.period_days) : null,
    concurrency_limit:
      p.kind === 'MONTHLY'
        ? integer(numbers.concurrency_limit)
        : original.concurrency_limit,
    retention_days:
      p.kind === 'MONTHLY'
        ? integer(numbers.retention_days)
        : original.retention_days,
  };
  const amount = (value: number, suffix: string) =>
    Number.isFinite(value)
      ? `${value.toLocaleString('zh-CN')} ${suffix}`
      : '待填写';
  const specs: {
    key: keyof PlanInput;
    label: string;
    display: (plan: PlanInput) => string;
  }[] = [
    {
      key: 'name',
      label: '套餐名称',
      display: (plan) => plan.name || '未填写',
    },
    {
      key: 'kind',
      label: '套餐类型',
      display: (plan) => (plan.kind === 'PACK' ? '一次性积分包' : '订阅套餐'),
    },
    {
      key: 'description',
      label: '套餐说明',
      display: (plan) => plan.description || '未填写',
    },
    { key: 'currency', label: '币种', display: (plan) => plan.currency },
    {
      key: 'price_cents',
      label: '价格',
      display: (plan) =>
        plan.price_cents > 0
          ? money(plan.price_cents, plan.currency)
          : '待填写',
    },
    {
      key: 'credits',
      label: '发放积分',
      display: (plan) => amount(plan.credits, '积分'),
    },
    {
      key: 'period_days',
      label: '周期',
      display: (plan) =>
        plan.period_days == null ? '不适用' : amount(plan.period_days, '天'),
    },
    {
      key: 'concurrency_limit',
      label: '并发任务数',
      display: (plan) => amount(plan.concurrency_limit, '个'),
    },
    {
      key: 'max_resolution',
      label: '最高分辨率',
      display: (plan) => plan.max_resolution,
    },
    {
      key: 'retention_days',
      label: '新素材保留',
      display: (plan) => amount(plan.retention_days, '天'),
    },
    {
      key: 'rollover',
      label: '积分结转',
      display: (plan) => (plan.rollover ? '允许结转' : '到期回收'),
    },
    {
      key: 'active',
      label: '销售状态',
      display: (plan) => (plan.active ? '已上架' : '已下架'),
    },
  ];
  const changes = specs.filter(
    (spec) => !Object.is(original[spec.key], candidate[spec.key]),
  );
  const dirty = changes.length > 0;
  const clearError = (field: Field) =>
    setErrors((current) => ({ ...current, [field]: undefined }));
  const patch = (next: Partial<PlanInput>) => {
    setP((current) => ({ ...current, ...next }));
    setDiscard(false);
  };
  const changeNumber = (field: NumberField, value: string) => {
    setNumbers((current) => ({ ...current, [field]: value }));
    clearError(field);
    setDiscard(false);
  };
  const close = () => {
    if (lock.current) return;
    if (!dirty) return props.onClose();
    returnFocus.current = document.activeElement as HTMLElement | null;
    setDiscard(true);
    requestAnimationFrame(() =>
      document.getElementById(fieldId('continue'))?.focus(),
    );
  };
  const validate = () => {
    const next: Errors = {};
    if (
      !candidate.name ||
      [...candidate.name].length > 80 ||
      [...candidate.name].some(
        (char) =>
          char.charCodeAt(0) < 32 ||
          (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
      )
    )
      next.name = '请填写 1–80 字的套餐名称，不含控制字符。';
    if ([...candidate.description].length > 2000)
      next.description = '套餐说明不能超过 2000 字。';
    if (priceCents === null)
      next.price = '请输入 0.01–1,000,000.00 元，最多两位小数。';
    for (const [field, min, max] of [
      ['credits', 1, 100000000],
      ['period_days', 1, 366],
      ['concurrency_limit', 1, 64],
      ['retention_days', 1, 3650],
    ] as const) {
      if (field !== 'credits' && candidate.kind !== 'MONTHLY') continue;
      const value = integer(numbers[field]);
      if (!Number.isSafeInteger(value) || value < min || value > max)
        next[field] = `请输入 ${min}–${max.toLocaleString('zh-CN')} 的整数。`;
    }
    return next;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current || !dirty || discard) return;
    const invalid = validate();
    setErrors(invalid);
    const first = Object.keys(invalid)[0];
    if (first) {
      requestAnimationFrame(() =>
        document.getElementById(fieldId(first))?.focus(),
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await billingApi.savePlan(candidate, props.me.csrf_token, props.plan);
      await props.onDone('套餐已保存');
    } catch (failure) {
      setError(billingError(failure, props));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const nameLimit = Math.max(80, [...original.name].length);
  const descriptionLimit = Math.max(2000, [...original.description].length);
  return (
    <AdminDialog
      title={props.plan ? '编辑套餐' : '新增套餐'}
      subtitle={`${props.plan ? original.name : '创建新的套餐'} · ${original.active ? '已上架' : '未上架'}${props.hasKnownOrders ? ' · 已有订单' : ''}`}
      className="plan-editor"
      busy={busy}
      onClose={close}
    >
      <form
        ref={form}
        noValidate
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            form.current?.requestSubmit();
          }
        }}
      >
        <div className="plan-editor-body">
          <fieldset className="plan-editor-content" disabled={busy}>
            <div className="plan-editor-fields">
              <section
                className="plan-editor-section"
                aria-labelledby={fieldId('basic')}
              >
                <h3 id={fieldId('basic')}>基本信息</h3>
                <div className="plan-editor-field">
                  <label htmlFor={fieldId('name')}>
                    套餐名称<span className="plan-editor-required">必填</span>
                    <small>{[...p.name].length} / 80</small>
                  </label>
                  <input
                    className="plan-editor-input"
                    id={fieldId('name')}
                    aria-label="套餐名称"
                    data-initial-focus
                    value={p.name}
                    maxLength={nameLimit}
                    aria-invalid={!!errors.name}
                    aria-describedby={
                      errors.name ? fieldId('name-error') : undefined
                    }
                    onChange={(event) => {
                      patch({ name: event.target.value });
                      clearError('name');
                    }}
                  />
                  {errors.name && (
                    <small
                      className="plan-editor-error"
                      id={fieldId('name-error')}
                    >
                      {errors.name}
                    </small>
                  )}
                </div>
                <fieldset
                  className="plan-editor-type"
                  disabled={props.hasKnownOrders}
                >
                  <legend>类型</legend>
                  <div>
                    {(
                      [
                        {
                          kind: 'MONTHLY',
                          label: '订阅套餐',
                          note: '购买一个周期的积分与权益',
                          Icon: Layers3,
                        },
                        {
                          kind: 'PACK',
                          label: '一次性积分包',
                          note: '一次发放积分，不改变订阅权益',
                          Icon: Coins,
                        },
                      ] as const
                    ).map(({ kind, label, note, Icon }) => (
                      <label key={kind}>
                        <input
                          type="radio"
                          name={fieldId('kind')}
                          value={kind}
                          checked={p.kind === kind}
                          aria-label={label}
                          onChange={() => patch({ kind })}
                        />
                        <Icon size={17} aria-hidden="true" />
                        <span>
                          <strong>{label}</strong>
                          <small>{note}</small>
                        </span>
                        <Check
                          className="plan-editor-type-check"
                          size={15}
                          aria-hidden="true"
                        />
                      </label>
                    ))}
                  </div>
                  {props.hasKnownOrders && (
                    <p className="plan-editor-help">
                      此套餐已有订单，编辑时保留原类型。历史订单继续按下单时的权益处理。
                    </p>
                  )}
                </fieldset>
                <div className="plan-editor-field">
                  <label htmlFor={fieldId('description')}>
                    套餐说明<span className="plan-editor-optional">选填</span>
                    <small>{[...p.description].length} / 2000</small>
                  </label>
                  <textarea
                    className="plan-editor-input"
                    rows={2}
                    id={fieldId('description')}
                    aria-label="套餐说明"
                    maxLength={descriptionLimit}
                    value={p.description}
                    aria-invalid={!!errors.description}
                    aria-describedby={
                      errors.description
                        ? fieldId('description-error')
                        : undefined
                    }
                    onChange={(event) => {
                      patch({ description: event.target.value });
                      clearError('description');
                    }}
                    placeholder="简要说明套餐适合谁、包含什么"
                  />
                  {errors.description && (
                    <small
                      className="plan-editor-error"
                      id={fieldId('description-error')}
                    >
                      {errors.description}
                    </small>
                  )}
                </div>
              </section>
              <section
                className="plan-editor-section"
                aria-labelledby={fieldId('pricing')}
              >
                <h3 id={fieldId('pricing')}>价格与额度</h3>
                <div className="plan-editor-pricing">
                  <div className="plan-editor-field">
                    <label htmlFor={fieldId('currency')}>币种</label>
                    <Select
                      id={fieldId('currency')}
                      aria-label="币种"
                      value={p.currency}
                      onValueChange={(currency) => patch({ currency })}
                    >
                      <option>CNY</option>
                      <option>USD</option>
                    </Select>
                  </div>
                  <div className="plan-editor-field">
                    <label htmlFor={fieldId('price')}>
                      价格（元）
                      <span className="plan-editor-required">必填</span>
                    </label>
                    <div
                      className="plan-editor-affix"
                      data-invalid={!!errors.price}
                    >
                      <span>{p.currency === 'CNY' ? '¥' : '$'}</span>
                      <input
                        id={fieldId('price')}
                        aria-label="价格（元）"
                        value={price}
                        inputMode="decimal"
                        aria-invalid={!!errors.price}
                        aria-describedby={`${fieldId('price-help')}${errors.price ? ` ${fieldId('price-error')}` : ''}`}
                        onChange={(event) => {
                          setPrice(event.target.value);
                          clearError('price');
                          setDiscard(false);
                        }}
                      />
                    </div>
                  </div>
                  <NumberInput
                    field="credits"
                    label="发放积分"
                    unit="积分"
                    value={numbers.credits}
                    id={fieldId('credits')}
                    error={errors.credits}
                    hideError
                    onChange={changeNumber}
                  />
                </div>
                <p className="plan-editor-help" id={fieldId('price-help')}>
                  {priceCents === null
                    ? '价格以元填写，最多两位小数；保存时精确转换为分。'
                    : `= ${priceCents.toLocaleString('zh-CN')} 分 · ${candidate.credits > 0 ? `约 ${money(priceCents / candidate.credits, p.currency)} / 积分` : '填写积分数量后可预览单价'}`}
                </p>
                {errors.price && (
                  <p className="plan-editor-error" id={fieldId('price-error')}>
                    {errors.price}
                  </p>
                )}
                {errors.credits && (
                  <p
                    className="plan-editor-error"
                    id={fieldId('credits-error')}
                  >
                    发放积分：{errors.credits}
                  </p>
                )}
              </section>
              {p.kind === 'MONTHLY' && (
                <section
                  className="plan-editor-section"
                  aria-labelledby={fieldId('rights')}
                >
                  <h3 id={fieldId('rights')}>订阅权益</h3>
                  <div className="plan-editor-rights">
                    <NumberInput
                      field="period_days"
                      label="周期天数"
                      unit="天"
                      value={numbers.period_days}
                      id={fieldId('period_days')}
                      error={errors.period_days}
                      onChange={changeNumber}
                    />
                    <NumberInput
                      field="concurrency_limit"
                      label="并发任务数"
                      unit="个"
                      value={numbers.concurrency_limit}
                      id={fieldId('concurrency_limit')}
                      error={errors.concurrency_limit}
                      onChange={changeNumber}
                    />
                    <fieldset className="plan-editor-resolution">
                      <legend>最高分辨率</legend>
                      <div>
                        {['1K', '2K', '4K'].map((value) => (
                          <label key={value}>
                            <input
                              type="radio"
                              name={fieldId('resolution')}
                              aria-label={value}
                              value={value}
                              checked={p.max_resolution === value}
                              onChange={() => patch({ max_resolution: value })}
                            />
                            <span>{value}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <NumberInput
                      field="retention_days"
                      label="新素材保留天数"
                      unit="天"
                      value={numbers.retention_days}
                      id={fieldId('retention_days')}
                      error={errors.retention_days}
                      onChange={changeNumber}
                    />
                  </div>
                  <div className="plan-editor-switch-row">
                    <button
                      type="button"
                      className="plan-editor-switch"
                      role="switch"
                      aria-checked={p.rollover}
                      aria-label="周期未用积分可结转至到期后"
                      onClick={() => patch({ rollover: !p.rollover })}
                    />
                    <div>
                      <strong>周期未用积分可结转至到期后</strong>
                      <p className="plan-editor-help">
                        关闭后回收本周期未用积分；任务预占部分在释放后回收。每次付款购买一个周期，不会自动扣费。
                      </p>
                    </div>
                  </div>
                </section>
              )}
              <section
                className="plan-editor-section"
                aria-labelledby={fieldId('sales')}
              >
                <h3 id={fieldId('sales')}>销售状态</h3>
                <div className="plan-editor-switch-row">
                  <button
                    type="button"
                    className="plan-editor-switch"
                    role="switch"
                    aria-label="上架，允许用户创建新订单"
                    aria-checked={p.active}
                    onClick={() => patch({ active: !p.active })}
                  />
                  <div>
                    <strong>
                      {p.active ? '已上架，允许用户创建新订单' : '暂不上架'}
                    </strong>
                    <p className="plan-editor-help">
                      关闭后无法创建新订单，已有订单的价格与权益不受影响。
                    </p>
                  </div>
                </div>
              </section>
              <section
                className="plan-editor-section"
                aria-labelledby={fieldId('changes')}
              >
                <h3 id={fieldId('changes')}>
                  {props.plan ? '变更确认' : '创建确认'}
                </h3>
                <div className="plan-editor-diff">
                  <strong>{props.plan ? '本次变更' : '新套餐内容'}</strong>
                  {props.plan ? (
                    changes.length ? (
                      <ul>
                        {changes.map((spec) => (
                          <li key={spec.key}>
                            <span>{spec.label}</span>
                            <div>
                              <del>{spec.display(original)}</del>
                              <ArrowRight size={13} aria-label="变为" />
                              <b>{spec.display(candidate)}</b>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>尚未修改套餐内容</p>
                    )
                  ) : (
                    <p>
                      {candidate.name || '未命名套餐'} ·{' '}
                      {priceCents === null
                        ? '待填写价格'
                        : money(priceCents, p.currency)}{' '}
                      · {amount(candidate.credits, '积分')} ·{' '}
                      {p.active ? '立即上架' : '暂不上架'}
                    </p>
                  )}
                </div>
                <p className="plan-editor-help">
                  保存后记录套餐变更，已有订单仍按下单时的价格和权益处理。
                </p>
              </section>
            </div>
            <aside className="plan-editor-preview" aria-label="套餐实时预览">
              <div>
                <h3>实时预览</h3>
                <p className="plan-editor-help">套餐名称、价格与权益预览</p>
                <article
                  className="billing-plan admin-billing-plan"
                  data-active={p.active}
                >
                  <div className="admin-billing-plan-meta">
                    <span
                      className="admin-billing-badge"
                      data-tone={p.active ? 'paid' : 'cancelled'}
                    >
                      {p.active ? '已上架' : '未上架'}
                    </span>
                    <span>{p.kind === 'PACK' ? '积分包' : '订阅套餐'}</span>
                  </div>
                  <h3>{p.name.trim() || '套餐名称'}</h3>
                  <p className="billing-price">
                    {priceCents === null ? '—' : money(priceCents, p.currency)}
                  </p>
                  <p className="admin-billing-quota">
                    {amount(candidate.credits, '积分')}
                    {p.kind === 'MONTHLY' &&
                      ` / ${amount(candidate.period_days ?? NaN, '天')}`}
                  </p>
                  {p.description && (
                    <p className="admin-billing-plan-description">
                      {p.description}
                    </p>
                  )}
                  <div className="admin-billing-chips">
                    {p.kind === 'MONTHLY' ? (
                      <>
                        <span>{p.max_resolution}</span>
                        <span>
                          {amount(candidate.concurrency_limit, '并发')}
                        </span>
                        <span>
                          新素材 {amount(candidate.retention_days, '天')}
                        </span>
                        <span>
                          {p.rollover ? '积分可结转' : '周期积分到期回收'}
                        </span>
                      </>
                    ) : (
                      <span>一次性发放积分</span>
                    )}
                  </div>
                </article>
                <p className="plan-editor-preview-note">
                  订阅按次购买周期，不会自动续费或扣款。
                </p>
              </div>
            </aside>
          </fieldset>
        </div>
        {error && (
          <Feedback variant="error" onDismiss={() => setError('')}>
            {error}
          </Feedback>
        )}
        <footer className="plan-editor-footer">
          {discard ? (
            <>
              <span aria-live="polite" className="plan-editor-discard">
                放弃未保存的修改？
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-light"
                  id={fieldId('continue')}
                  onClick={() => {
                    setDiscard(false);
                    returnFocus.current?.focus();
                  }}
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  className="btn btn-dark"
                  onClick={props.onClose}
                >
                  放弃修改
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="plan-editor-save-status">
                {busy
                  ? '正在保存，请稍候'
                  : dirty
                    ? props.plan
                      ? `${changes.length} 项修改尚未保存`
                      : '新套餐尚未保存'
                    : '暂无未保存的修改'}
                <small>Ctrl / ⌘ + Enter 保存</small>
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-light"
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-dark"
                  disabled={busy || !dirty}
                >
                  {busy ? '正在保存…' : '保存套餐'}
                </button>
              </div>
            </>
          )}
        </footer>
      </form>
    </AdminDialog>
  );
}
