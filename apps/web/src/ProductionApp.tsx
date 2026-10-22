import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { sessionApi, SessionError, type Me } from './features/auth/sessionApi';
import SettingsPage from './features/settings/SettingsPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous'; disabled?: boolean }
  | { status: 'error' }
  | { status: 'authenticated'; me: Me };
export default function ProductionApp() {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const generation = useRef(0);
  const [logoutError, setLogoutError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++generation.current;
    setState({ status: 'loading' });
    try {
      const me = await sessionApi.me(signal);
      if (!signal?.aborted && sequence === generation.current)
        setState({ status: 'authenticated', me });
    } catch (error) {
      if (signal?.aborted || sequence !== generation.current) return;
      if (error instanceof SessionError && error.status === 401)
        setState({ status: 'anonymous' });
      else if (
        error instanceof SessionError &&
        error.code === 'ACCOUNT_DISABLED'
      )
        setState({ status: 'anonymous', disabled: true });
      else setState({ status: 'error' });
    }
  }, []);
  const expired = useCallback(() => {
    ++generation.current;
    setState({ status: 'anonymous' });
  }, []);
  const changed = useCallback(
    (me: Me) => setState({ status: 'authenticated', me }),
    [],
  );
  const reload = useCallback(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  if (state.status === 'loading')
    return (
      <main className="signin-screen">
        <p role="status">正在验证登录状态…</p>
      </main>
    );
  if (state.status === 'error')
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <h1>服务暂不可用</h1>
          <p role="alert">暂时无法验证登录状态，请稍后重试。</p>
          <button className="btn btn-dark" onClick={reload}>
            重试连接
          </button>
        </section>
      </main>
    );
  if (state.status === 'anonymous')
    return (
      <Routes>
        <Route
          path="/login"
          element={
            <main className="signin-screen">
              <section className="signin-card">
                <div className="eyebrow">ATELIER</div>
                <h1>登录 Atelier</h1>
                {state.disabled ? (
                  <p role="alert">账号已禁用，请联系管理员。</p>
                ) : (
                  <p>仅支持 Gmail 账号，登录功能正在准备中。</p>
                )}
                <button className="btn btn-dark" disabled>
                  Google 登录暂未开放
                </button>
              </section>
            </main>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  const { me } = state;
  if (me.mfa_required)
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <h1>管理员身份验证</h1>
          <p>需要先绑定或验证 MFA。验证入口正在准备中。</p>
          {logoutError && <p role="alert">{logoutError}</p>}
          <button
            className="btn btn-light"
            onClick={() => {
              if (!window.confirm('将退出所有设备，是否继续？')) return;
              void sessionApi
                .logout(me.csrf_token)
                .then(expired)
                .catch(() => setLogoutError('退出未成功，请稍后重试'));
            }}
          >
            退出所有设备
          </button>
        </section>
      </main>
    );
  return (
    <Routes>
      <Route
        path="/settings"
        element={
          <SettingsPage
            me={me}
            onChange={changed}
            onExpired={expired}
            onReload={reload}
          />
        }
      />
      <Route
        path="/admin/*"
        element={
          <main className="account-shell">
            <h1>
              {me.user.role === 'USER' ? '无权访问' : '管理功能正在准备中'}
            </h1>
          </main>
        }
      />
      <Route path="*" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}
