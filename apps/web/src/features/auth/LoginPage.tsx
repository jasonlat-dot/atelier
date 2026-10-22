import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { sessionApi } from './sessionApi';
import './LoginPage.css';

function GoogleMark() {
  return (
    <svg className="login-google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.92A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.92V7.49H3.07A10 10 0 0 0 2 12c0 1.61.38 3.14 1.07 4.51l3.34-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59A6 6 0 0 1 12 5.96Z"
      />
    </svg>
  );
}

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
    <main className="login-page">
      <div className="login-layout">
        <div className="login-brand" aria-label="Atelier">
          <span className="login-brand-mark" aria-hidden="true">
            A
          </span>
          <span className="login-brand-name" aria-hidden="true">
            ATELIER
          </span>
        </div>
        <section className="login-card" aria-labelledby="login-title">
          <h1 id="login-title">登录 Atelier</h1>
          <p className="login-description">使用已验证的个人 Gmail 账号登录。</p>
          {disabled && (
            <p className="login-alert" role="alert">
              账号已禁用，请联系管理员或使用其他账号。
            </p>
          )}
          {(mode === 'CLOSED' || mode === 'INVITE_ONLY') && (
            <div className="login-notice">
              <Info size={16} strokeWidth={1.8} aria-hidden="true" />
              <p>
                {mode === 'CLOSED'
                  ? '新账号注册已关闭，已有账号仍可登录。'
                  : '新账号需要邀请码或已加入白名单，已有账号可直接登录。'}
              </p>
            </div>
          )}
          {error ? (
            <div className="login-config-error">
              <p className="login-alert" role="alert">
                暂时无法读取登录配置，请重试。
              </p>
              <button
                className="login-retry"
                onClick={() => setAttempt((v) => v + 1)}
              >
                重试
              </button>
            </div>
          ) : (
            !mode && (
              <p className="login-loading" role="status">
                正在读取登录配置…
              </p>
            )
          )}
          <form
            className="login-form"
            action="/api/v1/auth/google/start"
            method="get"
          >
            {mode === 'INVITE_ONLY' && (
              <label className="login-invite">
                邀请码（可选）
                <input name="invite" maxLength={128} autoComplete="off" />
              </label>
            )}
            <button
              className="login-google-button"
              type="submit"
              disabled={!mode || error}
            >
              <GoogleMark />
              <span>使用 Google 登录</span>
            </button>
          </form>
          <p className="login-terms">
            登录即表示你同意 <Link to="/terms">服务条款</Link>
          </p>
        </section>
      </div>
    </main>
  );
}
