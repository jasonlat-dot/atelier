import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { sessionApi } from './sessionApi';
export default function LoginPage({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    setMode(undefined);
    void sessionApi
      .publicConfig(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted) {
          if (
            !['OPEN', 'INVITE_ONLY', 'CLOSED'].includes(
              config.registration_mode,
            )
          )
            throw Error('config');
          setMode(config.registration_mode);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <div className="eyebrow">ATELIER</div>
        <h1>登录 Atelier</h1>
        <p>使用已验证的个人 Gmail 账号登录。</p>
        {disabled && (
          <p role="alert">账号已禁用，请联系管理员或使用其他账号。</p>
        )}
        {mode === 'CLOSED' && <p>新账号注册已关闭，已有账号仍可登录。</p>}
        {mode === 'INVITE_ONLY' && (
          <p>新账号需要邀请码或已加入白名单，已有账号可直接登录。</p>
        )}
        {error ? (
          <>
            <p role="alert">暂时无法读取登录配置，请重试。</p>
            <button
              className="btn btn-light"
              onClick={() => setAttempt((v) => v + 1)}
            >
              重试
            </button>
          </>
        ) : (
          !mode && <p role="status">正在读取登录配置…</p>
        )}
        <form action="/api/v1/auth/google/start" method="get">
          {mode === 'INVITE_ONLY' && (
            <label>
              邀请码（可选）
              <input
                className="input"
                name="invite"
                maxLength={128}
                autoComplete="off"
              />
            </label>
          )}
          <button
            className="btn btn-dark"
            type="submit"
            disabled={!mode || error}
          >
            使用 Google 登录
          </button>
        </form>
        <p>
          <Link to="/terms">服务条款</Link>
        </p>
      </section>
    </main>
  );
}
