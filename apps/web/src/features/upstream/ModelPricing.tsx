import { useState } from 'react';
import Feedback from '../../components/Feedback';
import type { Model, Pricing } from './upstreamApi';

export const rangeText = (values: number[]) => {
  const low = Math.min(...values),
    high = Math.max(...values);
  return low === high
    ? low.toLocaleString('zh-CN')
    : `${low.toLocaleString('zh-CN')} – ${high.toLocaleString('zh-CN')}`;
};
export function priceRange(model: Model, pricing?: Pricing) {
  if (
    !pricing ||
    !model.capabilities.qualities?.length ||
    !model.capabilities.resolutions?.length
  )
    return;
  const output: number[] = [];
  for (const quality of model.capabilities.qualities) {
    const rule = pricing.rules.find(
      (item) => item.model_id === model.id && item.quality === quality,
    );
    if (!rule || rule.base_credits <= 0) return;
    for (const resolution of model.capabilities.resolutions) {
      const multiplier = pricing.multipliers.find(
        (item) => item.resolution === resolution,
      )?.multiplier;
      if (!multiplier) return;
      output.push(rule.base_credits * multiplier);
    }
  }
  return output;
}
const int = (value: string, min: number, max: number) =>
  /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= min &&
  Number(value) <= max;
const labels: Record<string, string> = {
  low: '快速',
  medium: '标准',
  high: '精细',
  standard: '标准',
};

export function ModelPriceEditor({
  model,
  pricing,
  busy,
  onSave,
  onCancel,
}: {
  model: Model;
  pricing: Pricing;
  busy: boolean;
  onSave: (value: Pricing) => void;
  onCancel: () => void;
}) {
  const qualities = model.capabilities.qualities || [];
  const resolutions = model.capabilities.resolutions || [];
  const [rules, setRules] = useState<
    Record<string, { base: string; edit: string }>
  >(() =>
    Object.fromEntries(
      qualities.map((quality) => {
        const saved = pricing.rules.find(
          (rule) => rule.model_id === model.id && rule.quality === quality,
        );
        return [
          quality,
          {
            base: saved ? String(saved.base_credits) : '',
            edit: String(saved?.edit_surcharge ?? 0),
          },
        ];
      }),
    ),
  );
  const [unified, setUnified] = useState(false);
  const [error, setError] = useState('');
  const multiplier = (resolution: string) =>
    pricing.multipliers.find((item) => item.resolution === resolution)
      ?.multiplier;
  const finalPrice = (quality: string, resolution: string) =>
    int(rules[quality]?.base ?? '', 1, 1000000) && multiplier(resolution)
      ? Number(rules[quality].base) * multiplier(resolution)!
      : undefined;
  const change = (quality: string, field: 'base' | 'edit', value: string) =>
    setRules((current) =>
      Object.fromEntries(
        Object.entries(current).map(([key, rule]) => [
          key,
          key === quality || unified ? { ...rule, [field]: value } : rule,
        ]),
      ),
    );
  const visible = unified ? qualities.slice(0, 1) : qualities;
  const exampleQuality = qualities.includes('high') ? 'high' : qualities[0];
  const exampleResolution = resolutions.includes('2K') ? '2K' : resolutions[0];
  const example =
    exampleQuality && exampleResolution
      ? finalPrice(exampleQuality, exampleResolution)
      : undefined;
  return (
    <form
      className="up-form models-price-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !qualities.length ||
          !resolutions.length ||
          resolutions.some((resolution) => !multiplier(resolution))
        ) {
          setError('模型能力或分辨率倍率尚未配置完整，请先补齐。');
          return;
        }
        if (
          qualities.some(
            (quality) =>
              !int(rules[quality].base, 1, 1000000) ||
              !int(rules[quality].edit, 0, 1000000),
          )
        ) {
          setError(
            '请为每种质量填写 1–1,000,000 的整数基础积分，编辑附加费为 0–1,000,000 的整数。',
          );
          return;
        }
        onSave({
          ...pricing,
          rules: [
            ...pricing.rules.filter((rule) => rule.model_id !== model.id),
            ...qualities.map((quality) => ({
              model_id: model.id,
              quality,
              base_credits: Number(rules[quality].base),
              edit_surcharge:
                model.kind === 'image' ? Number(rules[quality].edit) : 0,
            })),
          ],
        });
      }}
    >
      <p className="models-form-note">
        {model.kind === 'image'
          ? '每格显示最终积分 = 基础积分 × 分辨率倍率。图片编辑在倍率计算后另加附加费。'
          : '按秒计费：每秒基础积分 × 分辨率倍率。下表同时展示 10 秒的参考价格。'}
        倍率在「分辨率倍率」页签调整。
      </p>
      <fieldset className="models-price-fields" disabled={busy}>
        {model.kind === 'image' && qualities.length > 1 && (
          <label className="up-check models-unified">
            <input
              type="checkbox"
              checked={unified}
              onChange={(event) => {
                setUnified(event.target.checked);
                if (event.target.checked) {
                  const first = rules[qualities[0]];
                  setRules(
                    Object.fromEntries(
                      qualities.map((quality) => [quality, { ...first }]),
                    ),
                  );
                }
              }}
            />
            所有质量使用同一价格和编辑附加费
          </label>
        )}
        <div className="models-matrix-scroll">
          <table className="models-matrix">
            <thead>
              <tr>
                <th>
                  {model.kind === 'video' && qualities.length === 1
                    ? '计费'
                    : '质量'}
                </th>
                <th>基础积分{model.kind === 'video' && ' / 秒'}</th>
                {model.kind === 'image' && <th>编辑附加费</th>}
                {resolutions.map((resolution) => (
                  <th key={resolution}>
                    {resolution}
                    <small>×{multiplier(resolution) ?? '未配置'}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((quality) => (
                <tr key={quality}>
                  <td>
                    {unified
                      ? '全部质量'
                      : model.kind === 'video' && qualities.length === 1
                        ? '每秒'
                        : labels[quality] || quality}
                  </td>
                  <td>
                    <input
                      data-initial-focus={quality === visible[0] || undefined}
                      aria-label={`${model.display_name} ${quality} 基础积分`}
                      type="number"
                      min={1}
                      max={1000000}
                      step={1}
                      required
                      value={rules[quality].base}
                      placeholder="未配置"
                      onChange={(event) =>
                        change(quality, 'base', event.target.value)
                      }
                    />
                  </td>
                  {model.kind === 'image' && (
                    <td>
                      <input
                        aria-label={`${model.display_name} ${quality} 编辑附加费`}
                        type="number"
                        min={0}
                        max={1000000}
                        step={1}
                        required
                        value={rules[quality].edit}
                        onChange={(event) =>
                          change(quality, 'edit', event.target.value)
                        }
                      />
                    </td>
                  )}
                  {resolutions.map((resolution) => (
                    <td key={resolution} className="models-final">
                      {finalPrice(quality, resolution)?.toLocaleString(
                        'zh-CN',
                      ) ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {model.kind === 'video' && (
          <div className="models-matrix-scroll">
            <table className="models-matrix models-video-example">
              <thead>
                <tr>
                  <th>分辨率</th>
                  <th>每秒积分</th>
                  <th>10 秒参考价</th>
                </tr>
              </thead>
              <tbody>
                {qualities.flatMap((quality) =>
                  resolutions.map((resolution) => (
                    <tr key={`${quality}/${resolution}`}>
                      <td>
                        {resolution}
                        {qualities.length > 1 &&
                          ` · ${labels[quality] || quality}`}
                      </td>
                      <td>
                        {finalPrice(quality, resolution)?.toLocaleString(
                          'zh-CN',
                        ) ?? '—'}
                      </td>
                      <td>
                        {finalPrice(quality, resolution) === undefined
                          ? '—'
                          : (
                              finalPrice(quality, resolution)! * 10
                            ).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        {model.kind === 'image' && (
          <p className="models-price-example">
            示例：1 张 {exampleResolution}{' '}
            {labels[exampleQuality] || exampleQuality}图片 ={' '}
            <strong>{example?.toLocaleString('zh-CN') ?? '—'}</strong> 积分
            {model.capabilities.supports_edit && (
              <>
                ；图片编辑再加{' '}
                {int(rules[exampleQuality]?.edit ?? '', 0, 1000000)
                  ? rules[exampleQuality].edit
                  : '—'}{' '}
                ={' '}
                <strong>
                  {example !== undefined &&
                  int(rules[exampleQuality]?.edit ?? '', 0, 1000000)
                    ? (
                        example + Number(rules[exampleQuality].edit)
                      ).toLocaleString('zh-CN')
                    : '—'}
                </strong>{' '}
                积分
              </>
            )}
            。
          </p>
        )}
      </fieldset>
      <p className="models-draft-note">
        只更新此模型价格，保留其他模型与倍率。版本 {pricing.revision}
        ，最终报价以服务端确认为准。
      </p>
      {error && (
        <Feedback variant="error" onDismiss={() => setError('')}>
          {error}
        </Feedback>
      )}
      <footer className="up-form-footer">
        <button
          type="button"
          className="btn btn-light"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
        <button className="btn btn-dark" disabled={busy || !qualities.length}>
          {busy ? '正在保存…' : '保存价格'}
        </button>
      </footer>
    </form>
  );
}

export function MultiplierEditor({
  pricing,
  busy,
  onSave,
}: {
  pricing: Pricing;
  busy: boolean;
  onSave: (value: Pricing) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      pricing.multipliers.map((item) => [
        item.resolution,
        String(item.multiplier),
      ]),
    ),
  );
  const [error, setError] = useState('');
  return (
    <form
      className="models-multipliers"
      onSubmit={(event) => {
        event.preventDefault();
        const editable = ['1K', '2K', '4K', '720p', '1080p'];
        if (
          editable.some((resolution) => !int(values[resolution] ?? '', 1, 100))
        ) {
          setError('所有分辨率倍率必须为 1–100 的整数。');
          return;
        }
        onSave({
          ...pricing,
          multipliers: pricing.multipliers.map((item) =>
            item.resolution === 'text'
              ? item
              : { ...item, multiplier: Number(values[item.resolution]) },
          ),
        });
      }}
    >
      <p className="models-note">
        倍率为共用配置，修改会影响对应分辨率下所有模型的新报价。文本模型按全站统一价计费，不使用这些倍率。
      </p>
      <div className="models-multiplier-card">
        <fieldset disabled={busy}>
          {[
            { title: '图片模型 · 分辨率', resolutions: ['1K', '2K', '4K'] },
            { title: '视频模型 · 分辨率', resolutions: ['720p', '1080p'] },
          ].map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <div>
                {group.resolutions.map((resolution) => (
                  <label key={resolution}>
                    {resolution}
                    <div className="models-multiplier-input">
                      <span>×</span>
                      <input
                        aria-label={`${resolution} 倍率`}
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        required
                        value={values[resolution] ?? ''}
                        onChange={(event) =>
                          setValues((current) => ({
                            ...current,
                            [resolution]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </fieldset>
        <footer>
          <button className="btn btn-dark" disabled={busy}>
            {busy ? '正在保存…' : '保存倍率'}
          </button>
          <span>版本 {pricing.revision} · 保存后生效，切换页签保留输入</span>
        </footer>
      </div>
      {error && (
        <Feedback variant="error" onDismiss={() => setError('')}>
          {error}
        </Feedback>
      )}
    </form>
  );
}
