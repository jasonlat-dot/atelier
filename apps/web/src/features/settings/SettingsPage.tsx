import Feedback, { useConfirmNotice } from '../../components/Feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  KeyRound,
  LoaderCircle,
  LogOut,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  sessionApi,
  SessionError,
  type Device,
  type Me,
} from '../auth/sessionApi';
import './SettingsPage.css';

function deviceDetails(agent: string | null | undefined) {
  const ua = agent || '';
  const browser = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ] as const;
  const detected = browser.find(([, pattern]) => pattern.test(ua));
  const version = detected?.[1].exec(ua)?.[1].split('.')[0];
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '';
  return {
    title: detected
      ? `${detected[0]}${version ? ` ${version}` : ''}${os ? ` · ${os}` : ''}`
      : ua || '未知设备',
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua),
  };
}

export default function SettingsPage({
  me,
  onChange,
  onExpired,
  onReload,
}: {
  me: Me;
  onChange: (me: Me) => void;
  onExpired: () => void;
  onReload: () => void;
}) {
  const [name, setName] = useState(me.user.display_name);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const confirm = useConfirmNotice();
  const confirming = useRef(false);
  const canSave = !!name.trim() && name.trim() !== me.user.display_name;
  const role = {
    USER: '普通用户',
    ADMIN: '管理员',
    SUPER_ADMIN: '超级管理员',
  }[me.user.role];
  const failed = useCallback(
    (error: unknown) => {
      if (
        error instanceof SessionError &&
        (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
      ) {
        onExpired();
        return;
      }
      if (error instanceof SessionError && error.code === 'MFA_REQUIRED') {
        onReload();
        return;
      }
      setError(
        error instanceof SessionError
          ? error.message
          : '服务暂不可用，请稍后重试',
      );
    },
    [onExpired, onReload],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const response = await sessionApi.devices(signal);
        if (!signal?.aborted) setDevices(response.sessions);
      } catch (error) {
        if (!signal?.aborted) failed(error);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [failed],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const updated = await sessionApi.rename(name.trim(), me.csrf_token);
      onChange(updated);
      setName(updated.user.display_name);
      setMessage('显示名已更新');
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (device: Device) => {
    if (confirming.current || busy) return;
    confirming.current = true;
    const accepted = await confirm(
      device.current
        ? '撤销当前设备后将退出登录，是否继续？'
        : '确定撤销此设备的登录会话？',
      { title: '撤销设备会话？', confirmLabel: '确认撤销' },
    );
    confirming.current = false;
    if (!accepted) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await sessionApi.revoke(device.id, me.csrf_token);
      if (device.current) onExpired();
      else {
        setDevices((all) => all.filter((item) => item.id !== device.id));
        setMessage('设备会话已撤销');
      }
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (confirming.current || busy) return;
    confirming.current = true;
    const accepted = await confirm(
      '当前浏览器和其他设备的登录都会失效，再次使用时需要重新登录。',
      { title: '退出所有设备？', confirmLabel: '退出所有设备并返回登录' },
    );
    confirming.current = false;
    if (!accepted) return;
    setBusy(true);
    setError('');
    try {
      await sessionApi.logout(me.csrf_token);
      onExpired();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="account-settings">
      <header className="settings-heading">
        <div className="settings-eyebrow">ATELIER / ACCOUNT</div>
        <h1>账号设置</h1>
        <p>管理你的个人资料、账号安全与登录设备。</p>
      </header>
      <div className="settings-grid">
        <section className="settings-card" aria-labelledby="profile-heading">
          <div className="settings-card-heading">
            <div>
              <h2 id="profile-heading">个人资料</h2>
              <p>这些信息会显示在你的工作区中。</p>
            </div>
            <button
              className="settings-button settings-button-primary"
              disabled={busy || !canSave}
              type="submit"
              form="settings-profile-form"
            >
              {busy && <LoaderCircle size={15} className="settings-spinning" />}
              保存资料
            </button>
          </div>
          <form
            id="settings-profile-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="settings-profile-summary">
              <div className="settings-avatar" aria-hidden="true">
                {Array.from(
                  me.user.display_name || me.user.email,
                )[0]?.toUpperCase()}
              </div>
              <div className="settings-profile-identity">
                <strong>{me.user.display_name || me.user.email}</strong>
                <span className="settings-badge settings-badge-role">
                  {role}
                </span>
              </div>
            </div>
            <div className="settings-field">
              <label htmlFor="display-name">显示名</label>
              <input
                id="display-name"
                value={name}
                maxLength={100}
                disabled={busy}
                autoComplete="nickname"
                aria-describedby="display-name-hint"
                onChange={(event) => setName(event.target.value)}
              />
              <p className="settings-field-hint" id="display-name-hint">
                {name.length} / 100
              </p>
            </div>
            <div className="settings-field settings-field-last">
              <label htmlFor="settings-email">
                邮箱
                <span className="settings-badge settings-badge-ok">
                  <Check size={12} aria-hidden="true" /> 已验证
                </span>
              </label>
              <input id="settings-email" value={me.user.email} readOnly />
            </div>
          </form>
        </section>
        <section className="settings-card" aria-labelledby="security-heading">
          <div className="settings-card-heading">
            <div>
              <h2 id="security-heading">账号安全</h2>
              <p>保护你的账号和作品。</p>
            </div>
          </div>
          <div className="settings-security-row">
            <span className="settings-security-icon" aria-hidden="true">
              <KeyRound size={19} />
            </span>
            <div>
              <h3>登录方式</h3>
              <p>使用 Google 账号安全登录</p>
            </div>
            <span className="settings-badge settings-badge-ok">已绑定</span>
          </div>
          <div className="settings-security-row">
            <span className="settings-security-icon" aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <div>
              <h3>两步验证</h3>
              <p>
                {me.user.mfa_enabled
                  ? '使用手机验证器验证管理员身份'
                  : me.user.role === 'USER'
                    ? '管理员身份验证使用手机验证器'
                    : '管理员访问需要绑定手机验证器'}
              </p>
            </div>
            <span
              className={`settings-badge${me.user.mfa_enabled ? ' settings-badge-ok' : ''}`}
            >
              {me.user.mfa_enabled ? '已开启' : '未开启'}
            </span>
          </div>
          <p className="settings-security-note">
            登录密码和 Google 账号的安全设置，请在 Google 账号中管理。
          </p>
        </section>
        <section
          className="settings-card settings-devices"
          aria-labelledby="devices-heading"
        >
          <div className="settings-card-heading">
            <div>
              <h2 id="devices-heading">登录设备</h2>
              <p>查看当前的有效会话，撤销不再使用或不认识的设备。</p>
            </div>
            <button
              className="settings-button settings-refresh"
              disabled={busy || loading}
              onClick={() => {
                setError('');
                void load();
              }}
            >
              <RefreshCw
                size={15}
                aria-hidden="true"
                className={loading ? 'settings-spinning' : undefined}
              />
              刷新设备
            </button>
          </div>
          {loading ? (
            <p className="settings-devices-empty" role="status">
              正在加载登录设备…
            </p>
          ) : devices.length === 0 ? (
            <p className="settings-devices-empty">没有其他有效会话</p>
          ) : (
            <ul className="settings-device-list">
              {devices.map((device) => {
                const detail = deviceDetails(device.user_agent);
                const DeviceIcon = detail.mobile ? Smartphone : Monitor;
                return (
                  <li key={device.id}>
                    <span className="settings-device-icon" aria-hidden="true">
                      <DeviceIcon size={21} />
                    </span>
                    <div className="settings-device-info">
                      <div className="settings-device-title">
                        <strong title={device.user_agent || '未知设备'}>
                          {detail.title}
                        </strong>
                        {device.current && (
                          <span className="settings-badge settings-badge-ok">
                            当前设备
                          </span>
                        )}
                      </div>
                      <p>
                        <span>{device.ip || 'IP 未记录'}</span>
                        <span>
                          最近活动{' '}
                          {new Date(device.last_seen_at).toLocaleString(
                            'zh-CN',
                          )}
                        </span>
                      </p>
                    </div>
                    {!device.current && (
                      <button
                        className="settings-button settings-revoke"
                        disabled={busy}
                        aria-label={`撤销设备 ${device.user_agent || '未知设备'}`}
                        onClick={() => void revoke(device)}
                      >
                        撤销
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="settings-devices-footer">
            <p>退出所有设备后，当前浏览器也需要重新登录。</p>
            <button
              className="settings-button settings-button-danger"
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={15} aria-hidden="true" />
              退出所有设备
            </button>
          </div>
        </section>
      </div>
      {message && (
        <Feedback onDismiss={() => setMessage('')} variant="success">
          {message}
        </Feedback>
      )}
      {error && (
        <Feedback onDismiss={() => setError('')} variant="error">
          {error}
        </Feedback>
      )}
    </main>
  );
}
