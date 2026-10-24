import { useToast } from '../../components/Toast';
import Select from '../../components/Select';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { adminApi as api, type AdminSchema, type Settings } from './adminApi';
import { AdminAccess, AdminFeedback, AdminFrame } from './AdminUI';
import '../upstream/AdminUpstream.css';
type Values = AdminSchema['AdminSettingsValues'];
type NumberKey = {
  [K in keyof Values]: Values[K] extends number ? K : never;
}[keyof Values];
const numeric: {
  key: NumberKey;
  label: string;
  min: number;
  max: number;
  note?: string;
}[] = [
  {
    key: 'signup_max_per_ip_24h',
    label: '每 IP 每日注册上限',
    min: 1,
    max: 100,
  },
  { key: 'signup_bonus', label: '注册赠送积分', min: 0, max: 1000000 },
  { key: 'checkin_base', label: '每日签到基础积分', min: 0, max: 1000000 },
  { key: 'checkin_streak_cap', label: '连续签到加成上限', min: 0, max: 1000 },
  { key: 'max_active_jobs_free', label: '免费用户并发任务数', min: 1, max: 64 },
  {
    key: 'asset_retention_days_free',
    label: '免费素材保留天数',
    min: 1,
    max: 3650,
    note: '仅影响新上传与新生成素材。',
  },
  {
    key: 'chat_credits_per_message',
    label: '每条成功对话积分',
    min: 0,
    max: 10000,
  },
  {
    key: 'chat_context_window',
    label: '对话上下文上限',
    min: 2048,
    max: 131072,
    note: '必须大于输出上限的两倍。',
  },
  { key: 'chat_output_tokens', label: '单次对话输出上限', min: 128, max: 8192 },
  {
    key: 'admin_adjust_limit',
    label: '单次人工积分调整上限',
    min: 1,
    max: 1000000,
  },
  {
    key: 'moderation_threshold',
    label: '30 天违规自动禁用阈值',
    min: 1,
    max: 100,
  },
];
const names: Record<string, string> = {
  registration_mode: '注册模式',
  registration_whitelist: '注册白名单',
  checkin_tz: '签到时区',
  free_max_resolution: '免费分辨率上限',
  maintenance_mode: '维护模式',
  upstream_cost_rates: '成本估算单价',
  ...Object.fromEntries(numeric.map((n) => [n.key, n.label])),
};
export default function AdminSettingsPage(props: AdminProps) {
  return (
    <AdminAccess props={props} superOnly>
      <SettingsPage {...props} />
    </AdminAccess>
  );
}
function SettingsPage(props: AdminProps) {
  const query = useQuery({
    queryKey: ['adminSettings'],
    queryFn: ({ signal }) => api.settings(signal),
  });
  return (
    <AdminFrame
      title="平台设置"
      description="仅超级管理员可变更。提交前核对影响，每次变更保留完整审计。"
      loading={query.isFetching}
      onRefresh={() => void query.refetch()}
    >
      <AdminFeedback props={props} error={query.error} />
      {query.isPending && <p role="status">正在读取设置…</p>}
      {query.data && (
        <SettingsForm
          key={query.data.revision}
          {...props}
          settings={query.data}
        />
      )}
    </AdminFrame>
  );
}
function SettingsForm(props: AdminProps & { settings: Settings }) {
  const original = props.settings.values;
  const [values, setValues] = useState<Values>(structuredClone(original));
  const [whitelist, setWhitelist] = useState(
    original.registration_whitelist.join('\n'),
  );
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const client = useQueryClient();
  const changed = Object.keys(values).filter(
    (k) =>
      JSON.stringify(values[k as keyof Values]) !==
      JSON.stringify(original[k as keyof Values]),
  );
  function change<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.saveSettings(
        { revision: props.settings.revision, values, reason: reason.trim() },
        props.me.csrf_token,
      );
      setOpen(false);
      client.setQueryData(['adminSettings'], result);
      await client.invalidateQueries({ queryKey: ['adminDashboard'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        className="admin-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          setReason('');
          setError(undefined);
          setOpen(true);
        }}
      >
        <section className="admin-panel">
          <header>
            <div>
              <h2>注册与访问</h2>
              <p>
                关闭注册不影响已有用户登录。白名单 Gmail 在关闭模式下仍可注册。
              </p>
            </div>
          </header>
          <div className="admin-settings-body">
            <fieldset className="admin-choice-group">
              <legend>新用户注册模式</legend>
              {[
                ['CLOSED', '关闭注册', '仅白名单可注册'],
                ['OPEN', '开放注册', '通过验证的个人 Gmail 可注册'],
                ['INVITE_ONLY', '仅限邀请', '白名单或有效邀请码可注册'],
              ].map(([id, title, note]) => (
                <label key={id}>
                  <input
                    type="radio"
                    name="registration_mode"
                    value={id}
                    checked={values.registration_mode === id}
                    onChange={() => change('registration_mode', id)}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{note}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label>
              注册白名单
              <textarea
                aria-label="注册白名单"
                className="input"
                rows={4}
                value={whitelist}
                onChange={(e) => {
                  setWhitelist(e.target.value);
                  change(
                    'registration_whitelist',
                    e.target.value.split(/\s+/).filter(Boolean),
                  );
                }}
              />
              <small>
                每行一个个人 Gmail，最多 200 个。保存时会规范化地址。
              </small>
            </label>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={values.maintenance_mode}
                onChange={(e) => change('maintenance_mode', e.target.checked)}
              />
              <span>
                <strong>维护模式</strong>
                <small>
                  暂停新生成任务与新对话请求；已提交任务继续处理，管理页面仍可访问。
                </small>
              </span>
            </label>
          </div>
        </section>
        <section className="admin-panel">
          <header>
            <div>
              <h2>积分、权益与内容控制</h2>
              <p>
                订阅用户的权益在「套餐与订单」中配置。违规阈值在下一次违规记录写入时判定。
              </p>
            </div>
          </header>
          <div className="admin-settings-body admin-fields-grid">
            {numeric.map((n) => (
              <label key={n.key}>
                {n.label}
                <input
                  className="input"
                  type="number"
                  required
                  step={1}
                  min={n.min}
                  max={n.max}
                  value={values[n.key]}
                  onChange={(e) => change(n.key, Number(e.target.value))}
                />
                <small>
                  {n.note ||
                    `范围 ${n.min.toLocaleString()}–${n.max.toLocaleString()}`}
                </small>
              </label>
            ))}
            <label>
              签到时区
              <input
                className="input"
                required
                value={values.checkin_tz}
                maxLength={100}
                placeholder="Asia/Shanghai"
                onChange={(e) => change('checkin_tz', e.target.value)}
              />
              <small>IANA 时区，例如 Asia/Shanghai。</small>
            </label>
            <label>
              免费分辨率上限
              <Select
                value={values.free_max_resolution}
                onChange={(e) => change('free_max_resolution', e.target.value)}
              >
                <option value="1K">1K</option>
                <option value="2K">2K</option>
              </Select>
              <small>模型能力和定价仍需在模型管理中配置。</small>
            </label>
          </div>
        </section>
        <section className="admin-panel">
          <header>
            <div>
              <h2>上游成本估算</h2>
              <p>
                按图片张数、视频秒数或成功对话条数计价。留空表示未知，不会按零成本计算。
              </p>
            </div>
          </header>
          <div className="admin-settings-body">
            <div className="admin-rate-list">
              {props.settings.models.map((m) => {
                const rate = values.upstream_cost_rates.find(
                  (r) => r.model_id === m.id,
                );
                return (
                  <div className="admin-rate" key={m.id}>
                    <label className="admin-toggle">
                      <input
                        type="checkbox"
                        aria-label={`计入 ${m.display_name} 成本`}
                        checked={!!rate}
                        onChange={(e) =>
                          change(
                            'upstream_cost_rates',
                            e.target.checked
                              ? [
                                  ...values.upstream_cost_rates,
                                  {
                                    model_id: m.id,
                                    currency: 'CNY',
                                    unit_cost_micros: 0,
                                  },
                                ]
                              : values.upstream_cost_rates.filter(
                                  (r) => r.model_id !== m.id,
                                ),
                          )
                        }
                      />
                      <span>
                        <strong>{m.display_name}</strong>
                        <small>
                          {m.id} · 每
                          {m.kind === 'video'
                            ? '秒'
                            : m.kind === 'chat'
                              ? '条'
                              : '张'}
                        </small>
                      </span>
                    </label>
                    {rate && (
                      <>
                        <Select
                          aria-label={`${m.display_name} 成本币种`}
                          value={rate.currency}
                          onChange={(e) =>
                            change(
                              'upstream_cost_rates',
                              values.upstream_cost_rates.map((r) =>
                                r.model_id === m.id
                                  ? { ...r, currency: e.target.value }
                                  : r,
                              ),
                            )
                          }
                        >
                          <option>CNY</option>
                          <option>USD</option>
                        </Select>
                        <input
                          className="input"
                          aria-label={`${m.display_name} 成本单价`}
                          type="number"
                          required
                          min={0}
                          max={1000000}
                          step="0.000001"
                          value={rate.unit_cost_micros / 1000000}
                          onChange={(e) =>
                            change(
                              'upstream_cost_rates',
                              values.upstream_cost_rates.map((r) =>
                                r.model_id === m.id
                                  ? {
                                      ...r,
                                      unit_cost_micros: Math.round(
                                        Number(e.target.value) * 1000000,
                                      ),
                                    }
                                  : r,
                              ),
                            )
                          }
                        />
                      </>
                    )}
                  </div>
                );
              })}
              {!props.settings.models.length && (
                <p className="admin-note">先在模型管理中添加公开模型。</p>
              )}
            </div>
            <p className="admin-note">
              最多六位小数。这里的单价只用于运营估算，按当前单价回算所选时段，不代表供应商历史账单，也不改变用户积分定价。
            </p>
          </div>
        </section>
        <div className="admin-save-bar">
          <span>
            {changed.length
              ? `${changed.length} 项设置尚未保存`
              : '当前设置已保存'}
          </span>
          <button
            className="btn btn-light"
            type="button"
            disabled={!changed.length}
            onClick={() => {
              setValues(structuredClone(original));
              setWhitelist(original.registration_whitelist.join('\n'));
              toast('已撤销本次未保存修改。', 'info');
            }}
          >
            撤销修改
          </button>
          <button className="btn btn-dark" disabled={!changed.length}>
            核对并保存
          </button>
        </div>
      </form>
      {open && (
        <AdminDialog
          title="确认变更平台设置"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <form
            className="admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p className="admin-note">
              这些设置将影响后续请求。页面版本为 {props.settings.revision}
              ，如其他管理员已修改，将拒绝覆盖，请刷新核对。
            </p>
            <ul className="admin-change-list">
              {changed.map((k) => (
                <li key={k}>
                  <strong>{names[k] || k}</strong>
                  {k === 'registration_mode' && (
                    <span>
                      {original.registration_mode} → {values.registration_mode}
                    </span>
                  )}
                  {k === 'maintenance_mode' && (
                    <span>
                      {values.maintenance_mode
                        ? '将暂停新的生成和对话'
                        : '将恢复新的生成和对话'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <label>
              变更说明
              <textarea
                data-initial-focus
                className="input"
                required
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </label>
            <AdminFeedback props={props} error={error} />
            <footer className="admin-form-actions">
              <button
                className="btn btn-light"
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                返回修改
              </button>
              <button
                className="btn btn-dark"
                disabled={busy || !reason.trim()}
              >
                {busy ? '正在保存…' : '确认保存设置'}
              </button>
            </footer>
          </form>
        </AdminDialog>
      )}
    </>
  );
}
