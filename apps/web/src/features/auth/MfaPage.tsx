import { useState } from 'react';
import { sessionApi, SessionError, type Me } from './sessionApi';
export default function MfaPage({
  me,
  onVerified,
  onExpired,
}: {
  me: Me;
  onVerified: () => void;
  onExpired: () => void;
}) {
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (reason: unknown) => {
    if (reason instanceof SessionError && reason.code === 'UNAUTHENTICATED')
      onExpired();
    else if (reason instanceof SessionError && reason.status === 429)
      setError('尝试过于频繁，请稍后再试。');
    else setError('操作未成功，请检查验证码或稍后重试。');
  };
  const secret = uri ? new URL(uri).searchParams.get('secret') || '' : '';
  return (
    <main className="signin-screen">
      <section className="signin-card">
        <h1>管理员身份验证</h1>
        <p>
          {me.user.mfa_enabled
            ? '输入验证器中的六位验证码。'
            : '请先绑定验证器，再输入六位验证码完成绑定。'}
        </p>
        {error && <p role="alert">{error}</p>}
        {!me.user.mfa_enabled && !uri && (
          <button
            className="btn btn-dark"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('为当前账号绑定验证器，是否继续？')) return;
              setBusy(true);
              setError('');
              void sessionApi
                .mfaSetup(me.csrf_token)
                .then((result) => setUri(result.otpauth_uri))
                .catch(fail)
                .finally(() => setBusy(false));
            }}
          >
            绑定验证器
          </button>
        )}
        {uri && (
          <div>
            <p>
              在验证器中手动添加账号，使用下面的密钥。仅在此页面展示，请妥善保存。
            </p>
            <label>
              验证器密钥
              <input
                className="input"
                readOnly
                value={secret}
                autoComplete="off"
              />
            </label>
          </div>
        )}
        {(me.user.mfa_enabled || uri) && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              void sessionApi
                .mfaVerify(code, me.csrf_token)
                .then(() => {
                  setUri('');
                  setCode('');
                  onVerified();
                })
                .catch(fail)
                .finally(() => setBusy(false));
            }}
          >
            <label>
              六位验证码
              <input
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
                }
                required
              />
            </label>
            <button
              className="btn btn-dark"
              type="submit"
              disabled={busy || code.length !== 6}
            >
              验证并继续
            </button>
          </form>
        )}
        <button
          className="btn btn-light"
          disabled={busy}
          onClick={() => {
            if (!window.confirm('将退出所有设备，是否继续？')) return;
            setBusy(true);
            void sessionApi
              .logout(me.csrf_token)
              .then(onExpired)
              .catch(fail)
              .finally(() => setBusy(false));
          }}
        >
          退出所有设备
        </button>
      </section>
    </main>
  );
}
