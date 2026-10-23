import Feedback, { useConfirmNotice } from '../../components/Feedback';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Me, SessionError } from '../auth/sessionApi';
import { walletApi } from './walletApi';
export default function AdminCreditsPage({
  me,
  onExpired,
  onReload,
}: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
}) {
  const [owner, setOwner] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef<{ fingerprint: string; key: string }>();
  const lock = useRef(false);
  const confirm = useConfirmNotice();
  if (me.user.role === 'USER')
    return (
      <main className="account-shell">
        <h1>无权访问</h1>
        <Link to="/wallet">返回积分账本</Link>
      </main>
    );
  const submit = async () => {
    if (lock.current) return;
    const value = Number(amount);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        owner.trim(),
      ) ||
      !Number.isSafeInteger(value) ||
      value === 0 ||
      !reason.trim()
    ) {
      setError('请填写有效的用户 UUID、非零整数和调整原因');
      return;
    }
    lock.current = true;
    const accepted = await confirm(
      `为用户 ${owner.trim()} ${value > 0 ? '增加' : '扣减'} ${Math.abs(value)} 积分？\n原因：${reason.trim()}`,
      { title: '确认调整积分？', confirmLabel: '确认调整并入账' },
    );
    if (!accepted) {
      lock.current = false;
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const fingerprint = JSON.stringify([owner.trim(), value, reason.trim()]);
    if (!pending.current || pending.current.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await walletApi.adjust(
        owner.trim(),
        value,
        reason.trim(),
        me.csrf_token,
        pending.current.key,
      );
      pending.current = undefined;
      setMessage('积分调整已入账，审计记录已保存');
      setAmount('');
      setReason('');
    } catch (failure) {
      if (failure instanceof SessionError) {
        if (failure.status === 401 || failure.code === 'ACCOUNT_DISABLED') {
          onExpired();
          return;
        }
        if (failure.code === 'MFA_REQUIRED') {
          onReload();
          return;
        }
        setError(
          failure.code === 'INSUFFICIENT_CREDITS'
            ? '用户可用积分不足，未扣减'
            : failure.code === 'NOT_FOUND'
              ? '用户钱包不存在'
              : '调整未完成，可使用相同内容重试',
        );
      } else setError('连接中断，可使用相同内容重试');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="account-shell">
      <header>
        <div className="eyebrow">ATELIER / ADMIN</div>
        <h1>积分管理</h1>
        <Link to="/wallet">返回积分账本</Link>
      </header>
      <section className="surface-block account-section">
        <h2>人工调整积分</h2>
        <p>正数增加，负数扣减。扣减不能占用任务已预占的积分。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="credit-owner">用户 UUID</label>
          <input
            id="credit-owner"
            className="input"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="credit-amount">调整积分</label>
          <input
            id="credit-amount"
            className="input"
            type="number"
            step="1"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={busy}
            required
          />
          <label htmlFor="credit-reason">调整原因</label>
          <input
            id="credit-reason"
            className="input"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
            required
          />
          <button className="btn btn-dark" disabled={busy}>
            确认调整
          </button>
        </form>
      </section>
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
