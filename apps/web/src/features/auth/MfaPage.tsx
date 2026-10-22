import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { sessionApi, SessionError, type Me } from './sessionApi';
import './MfaPage.css';

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
  const [showSecret, setShowSecret] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const fail = (reason: unknown, operation: 'setup' | 'verify' | 'logout') => {
    if (reason instanceof SessionError && reason.code === 'UNAUTHENTICATED')
      onExpired();
    else if (reason instanceof SessionError && reason.status === 429)
      setError('尝试过于频繁，请稍后再试。');
    else if (reason instanceof SessionError && reason.code === 'FORBIDDEN')
      setError('请求被拒绝，请刷新页面后重试；若仍失败，请联系管理员。');
    else if (reason instanceof SessionError && reason.code === 'MFA_INVALID')
      setError(
        me.user.mfa_enabled
          ? '验证码无效，请输入验证器中最新的六位数字，并确认手机时间准确。'
          : '验证码无效或绑定已过期。请使用最新验证码；若绑定已超过 10 分钟，请刷新页面后重新绑定。',
      );
    else
      setError(
        operation === 'setup'
          ? '暂时无法生成绑定二维码，请稍后重试。'
          : operation === 'logout'
            ? '退出未成功，请稍后重试。'
            : '暂时无法完成验证，请稍后重试。',
      );
  };
  const secret = uri ? new URL(uri).searchParams.get('secret') || '' : '';
  return (
    <main className="signin-screen mfa-screen">
      <section className="signin-card mfa-card" aria-labelledby="mfa-title">
        <div className="mfa-eyebrow">ATELIER · 账号安全</div>
        <h1 id="mfa-title">管理员身份验证</h1>
        <p className="mfa-intro">
          {me.user.mfa_enabled
            ? '打开手机验证器，找到 Atelier 账号，输入当前显示的六位验证码。'
            : 'Google 登录已完成。你的账号拥有管理员权限，请绑定手机验证器后继续。'}
        </p>
        {error && (
          <p className="mfa-error" role="alert">
            {error}
          </p>
        )}
        {!me.user.mfa_enabled && (
          <ol className="mfa-steps" aria-label="验证器绑定步骤">
            <li>
              <h2>准备手机验证器</h2>
              <p>
                打开 Google Authenticator（Google 身份验证器）或其他支持 TOTP
                的验证器。还没安装？{' '}
                <a
                  href="https://support.google.com/accounts/answer/1066447?hl=zh-Hans"
                  target="_blank"
                  rel="noreferrer"
                >
                  查看安装说明 ↗
                </a>
              </p>
            </li>
            <li>
              <h2>{showSecret ? '手动添加 Atelier' : '扫描绑定二维码'}</h2>
              <p>
                {showSecret
                  ? '在手机 App 中点击「＋」→「输入设置密钥」，按下方信息填写并添加。'
                  : uri
                    ? '在手机 App 中点击「＋」→「扫描二维码」，扫描下方二维码，添加 Atelier 账号。'
                    : '点击下方按钮生成二维码，再用手机验证器的「＋」→「扫描二维码」添加账号。'}
              </p>
              {!uri && (
                <button
                  className="btn btn-dark"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm('为当前账号绑定验证器，是否继续？'))
                      return;
                    setBusy(true);
                    setError('');
                    void sessionApi
                      .mfaSetup(me.csrf_token)
                      .then((result) => {
                        setUri(result.otpauth_uri);
                        setShowSecret(false);
                        setCopyMessage('');
                      })
                      .catch((reason: unknown) => fail(reason, 'setup'))
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? '正在生成二维码…' : '绑定验证器'}
                </button>
              )}
              {uri && (
                <>
                  <div className="mfa-enrollment" id="mfa-enrollment">
                    {showSecret ? (
                      <div className="mfa-manual">
                        <dl className="mfa-details">
                          <div>
                            <dt>账号名称</dt>
                            <dd>Atelier · {me.user.email}</dd>
                          </div>
                          <div>
                            <dt>密钥类型</dt>
                            <dd>基于时间（Time based）</dd>
                          </div>
                        </dl>
                        <label>
                          验证器密钥
                          <input
                            className="input mfa-secret"
                            readOnly
                            value={secret}
                            autoComplete="off"
                            spellCheck={false}
                            onFocus={(event) => event.currentTarget.select()}
                          />
                        </label>
                        <button
                          className="btn btn-light"
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(secret);
                              setCopyMessage('密钥已复制。');
                            } catch {
                              setCopyMessage(
                                '暂时无法复制，请点击密钥全选后手动复制。',
                              );
                            }
                          }}
                        >
                          复制密钥
                        </button>
                        {copyMessage && <p role="status">{copyMessage}</p>}
                      </div>
                    ) : (
                      <figure className="mfa-qr">
                        <QRCodeSVG
                          value={uri}
                          size={208}
                          level="M"
                          marginSize={4}
                          role="img"
                          aria-label="Atelier 验证器绑定二维码"
                        />
                        <figcaption>用手机验证器扫描，添加 Atelier</figcaption>
                      </figure>
                    )}
                  </div>
                  <button
                    className="mfa-switch"
                    type="button"
                    aria-controls="mfa-enrollment"
                    onClick={() => {
                      setShowSecret((value) => !value);
                      setCopyMessage('');
                    }}
                  >
                    {showSecret ? '返回二维码绑定' : '无法扫码？使用密钥'}
                  </button>
                  <p className="mfa-help">
                    请在 10
                    分钟内完成绑定，过期后刷新页面重新绑定。二维码和密钥请妥善保管，不要分享。
                  </p>
                </>
              )}
            </li>
            <li>
              <h2>输入手机上的六位验证码</h2>
              <p>
                添加成功后，将手机 App 中 Atelier
                对应的六位数字填入下方，点击「验证并继续」。
              </p>
            </li>
          </ol>
        )}
        {(me.user.mfa_enabled || uri) && (
          <form
            className="mfa-form"
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
                  setCopyMessage('');
                  onVerified();
                })
                .catch((reason: unknown) => fail(reason, 'verify'))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              六位验证码
              <input
                className="input mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))
                }
                aria-describedby="mfa-code-help"
                required
              />
            </label>
            <p id="mfa-code-help" className="mfa-help">
              验证码每 30
              秒更新，请使用手机验证器中的最新数字，不是邮箱或短信验证码。
            </p>
            <button
              className="btn btn-dark"
              type="submit"
              disabled={busy || code.length !== 6}
            >
              {busy ? '正在验证…' : '验证并继续'}
            </button>
          </form>
        )}
        <div className="mfa-footer">
          <span>绑定后请保留手机验证器，后续管理员验证仍需使用。</span>
          <button
            className="btn btn-light"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('将退出所有设备，是否继续？')) return;
              setBusy(true);
              void sessionApi
                .logout(me.csrf_token)
                .then(onExpired)
                .catch((reason: unknown) => fail(reason, 'logout'))
                .finally(() => setBusy(false));
            }}
          >
            退出所有设备
          </button>
        </div>
      </section>
    </main>
  );
}
