import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { sessionApi, SessionError, type Me } from './features/auth/sessionApi';
import WorkspaceShell from './features/workspace/WorkspaceShell';
import HomePage from './features/workspace/HomePage';
import AssetsPage from './features/assets/AssetsPage';
import SettingsPage from './features/settings/SettingsPage';
import LoginPage from './features/auth/LoginPage';
import MfaPage from './features/auth/MfaPage';
import WalletPage from './features/wallet/WalletPage';
import AdminCreditsPage from './features/wallet/AdminCreditsPage';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous'; disabled?: boolean }
  | { status: 'error' }
  | { status: 'authenticated'; me: Me };
export default function ProductionApp() {
  const navigate = useNavigate();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const generation = useRef(0);
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
          element={<LoginPage disabled={state.disabled} />}
        />
        <Route
          path="/terms"
          element={
            <main className="signin-screen">
              <section className="signin-card">
                <h1>服务条款</h1>
                <p>服务条款尚未发布，当前项目仍处于开发与验收阶段。</p>
                <a href="/login">返回登录</a>
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
      <MfaPage
        me={me}
        onVerified={() => {
          navigate('/', { replace: true });
          reload();
        }}
        onExpired={expired}
      />
    );
  return (
    <WorkspaceShell me={me} onExpired={expired} onReload={reload}>
      <Routes>
        <Route
          path="/assets"
          element={<AssetsPage me={me} onExpired={expired} onReload={reload} />}
        />
        <Route
          path="/"
          element={<HomePage me={me} onExpired={expired} onReload={reload} />}
        />
        <Route
          path="/wallet"
          element={<WalletPage me={me} onExpired={expired} onReload={reload} />}
        />
        <Route
          path="/admin/credits"
          element={
            <AdminCreditsPage me={me} onExpired={expired} onReload={reload} />
          }
        />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </WorkspaceShell>
  );
}
