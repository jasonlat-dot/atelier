import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  sessionApi,
  SessionError,
  type Device,
  type Me,
} from '../auth/sessionApi';

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
    if (
      !window.confirm(
        device.current
          ? '撤销当前设备后将退出登录，是否继续？'
          : '确定撤销此设备的登录会话？',
      )
    )
      return;
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
    if (!window.confirm('将退出所有设备，是否继续？')) return;
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
    <main className="account-shell">
      <header>
        <div className="eyebrow">ATELIER / ACCOUNT</div>
        <h1>账号设置</h1>
        <p>{me.user.email}</p>
        <nav className="account-nav" aria-label="账号导航">
          <Link to="/">工作台</Link>
          <Link to="/wallet">积分账本</Link>
        </nav>
      </header>
      <section className="surface-block account-section">
        <h2>个人资料</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="display-name">显示名</label>
          <input
            id="display-name"
            className="input"
            value={name}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="btn btn-dark"
            disabled={busy || !name.trim()}
            type="submit"
          >
            保存显示名
          </button>
        </form>
      </section>
      <section className="surface-block account-section">
        <h2>登录设备</h2>
        {loading ? (
          <p role="status">正在加载登录设备…</p>
        ) : devices.length === 0 ? (
          <p>没有其他有效会话</p>
        ) : (
          <ul className="device-list">
            {devices.map((device) => (
              <li key={device.id}>
                <div>
                  <strong>{device.user_agent || '未知设备'}</strong>
                  {device.current && (
                    <span className="soft-pill">当前设备</span>
                  )}
                  <p>
                    {device.ip || 'IP 未记录'} · 最近活动{' '}
                    {new Date(device.last_seen_at).toLocaleString('zh-CN')}
                  </p>
                </div>
                <button
                  className="btn btn-light"
                  disabled={busy}
                  aria-label={`撤销设备 ${device.user_agent || '未知设备'}`}
                  onClick={() => void revoke(device)}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="text-action"
          disabled={busy || loading}
          onClick={() => {
            setError('');
            void load();
          }}
        >
          刷新设备
        </button>
      </section>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <button
        className="btn btn-light"
        disabled={busy}
        onClick={() => void logout()}
      >
        退出所有设备
      </button>
    </main>
  );
}
