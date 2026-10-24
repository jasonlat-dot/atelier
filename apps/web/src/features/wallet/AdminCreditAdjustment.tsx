import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, RefreshCw, ShieldCheck } from 'lucide-react';
import Feedback, { useConfirmNotice } from '../../components/Feedback';
import Select from '../../components/Select';
import Tooltip from '../../components/Tooltip';
import { adminApi, type User } from '../admin/adminApi';
import { SessionError } from '../auth/sessionApi';
import type { AdminProps } from '../upstream/upstreamApi';
import { walletApi } from './walletApi';
import {
  CreditAdjustmentFields,
  CreditAdjustmentSummary,
} from './CreditAdjustmentFields';

const number = (value: number) => value.toLocaleString('zh-CN');

export default function AdminCreditAdjustment({
  me,
  onExpired,
  onReload,
}: AdminProps) {
  const [target, setTarget] = useState<User>();
  const [search, setSearch] = useState('');
  const [queryText, setQueryText] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const pending = useRef<{ fingerprint: string; key: string }>();
  const lock = useRef(false);
  const confirm = useConfirmNotice();
  const client = useQueryClient();
  const isAdmin = me.user.role !== 'USER';
  useEffect(() => {
    const timer = setTimeout(() => setQueryText(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const users = useQuery({
    queryKey: ['credit-user-search', me.user.id, queryText],
    queryFn: ({ signal }) =>
      adminApi.users(queryText, '', '', undefined, signal),
    enabled: isAdmin && !target,
    retry: false,
  });
  const recent = useQuery({
    queryKey: ['credit-adjustments', me.user.id],
    queryFn: ({ signal }) => walletApi.adjustments(signal),
    enabled: isAdmin,
    retry: false,
  });
  const fail = useCallback(
    (failure: unknown, fallback: string) => {
      if (failure instanceof SessionError) {
        if (failure.status === 401 || failure.code === 'ACCOUNT_DISABLED') {
          onExpired();
          return;
        }
        if (failure.code === 'MFA_REQUIRED') {
          onReload();
          return;
        }
      }
      setError(fallback);
    },
    [onExpired, onReload],
  );
  useEffect(() => {
    if (users.error) fail(users.error, '暂时无法搜索用户，请稍后重试。');
  }, [users.error, fail]);
  useEffect(() => {
    if (recent.error)
      fail(recent.error, '最近调整记录暂时不可用，请刷新重试。');
  }, [recent.error, fail]);
  const available = target ? target.balance - target.held : undefined;
  const quantity = Number(amount);
  const validAmount = Number.isSafeInteger(quantity) && quantity > 0;
  const delta = direction * quantity;
  const after =
    available !== undefined && validAmount ? available + delta : undefined;
  const overdrawn = after !== undefined && after < 0;
  const valid =
    !!target &&
    validAmount &&
    Number.isSafeInteger(after) &&
    !overdrawn &&
    !!reason &&
    note.trim().length >= 5;
  const searchPending = search.trim() !== queryText || users.isFetching;
  const results =
    searchPending || users.isError ? [] : users.data?.items.slice(0, 5) || [];
  if (!isAdmin) return null;
  const submit = async () => {
    if (lock.current || !valid || !target) return;
    const owner = target.id;
    const description = `${reason}：${note.trim()}`;
    lock.current = true;
    const accepted = await confirm(
      <CreditAdjustmentSummary
        user={target}
        delta={delta}
        reason={reason}
        note={note}
      />,
      { title: '确认调整积分？', confirmLabel: '确认调整并入账' },
    );
    if (!accepted) {
      lock.current = false;
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const fingerprint = JSON.stringify([owner, delta, description]);
    if (!pending.current || pending.current.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    try {
      await walletApi.adjust(
        owner,
        delta,
        description,
        me.csrf_token,
        pending.current.key,
      );
      pending.current = undefined;
      setAmount('');
      setReason('');
      setNote('');
      setMessage('积分调整已入账，审计记录已保存');
      void client.invalidateQueries({
        queryKey: ['credit-adjustments', me.user.id],
      });
      void client.invalidateQueries({
        queryKey: ['credit-user-search', me.user.id],
      });
      // Refresh, rather than add locally: the same idempotency key can return an earlier receipt.
      try {
        const detail = await adminApi.user(owner);
        setTarget(detail.user);
      } catch {
        setTarget(undefined);
      }
    } catch (failure) {
      fail(
        failure,
        failure instanceof SessionError &&
          failure.code === 'INSUFFICIENT_CREDITS'
          ? '用户可用积分不足，未扣减。请重新选择用户以刷新余额。'
          : '调整结果尚未确认，可保留相同内容重试，系统会复用原请求编号。',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <div className="admin-credit-layout">
        <section className="credit-adjustment-panel admin-credit-card">
          <h2>人工调整积分</h2>
          <p className="admin-credit-description">
            增加或扣减用户积分。扣减不能占用任务已预占的积分。
          </p>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="admin-credit-field">
              <label htmlFor="credit-owner">用户</label>
              {target ? (
                <div className="admin-credit-user">
                  <span className="admin-credit-avatar" aria-hidden="true">
                    {target.display_name.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="admin-credit-user-info">
                    <strong>{target.display_name}</strong>
                    <span>{target.email}</span>
                    <code tabIndex={0} data-tip={target.id}>
                      ID：{target.id.slice(0, 8)}…
                    </code>
                  </div>
                  <div className="admin-credit-user-balance">
                    <strong>{number(available!)}</strong>
                    <span>可用 · 预占 {number(target.held)}</span>
                  </div>
                  <button
                    className="admin-credit-text-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setTarget(undefined);
                      setSearch('');
                      setQueryText('');
                    }}
                  >
                    更换
                  </button>
                </div>
              ) : (
                <>
                  <Select
                    id="credit-owner"
                    aria-label="用户"
                    value=""
                    placeholder="搜索昵称、邮箱或用户 ID（UUID）"
                    searchable
                    disabled={busy}
                    onSearchChange={setSearch}
                    searchPlaceholder="输入昵称、邮箱或粘贴完整 UUID"
                    emptyMessage={
                      searchPending
                        ? '正在搜索用户…'
                        : users.isError
                          ? '搜索暂不可用'
                          : '没有找到用户'
                    }
                    options={results.map((user) => ({
                      value: user.id,
                      label: `${user.display_name} · ${user.email}`,
                      description: `可用 ${number(user.balance - user.held)}`,
                    }))}
                    onValueChange={(id) => {
                      const user = results.find((item) => item.id === id);
                      if (user) setTarget(user);
                    }}
                  />
                  <small>从搜索结果中核对用户身份后选择，最多显示 5 项。</small>
                  {users.isError && (
                    <button
                      className="admin-credit-text-button"
                      type="button"
                      onClick={() => void users.refetch()}
                    >
                      重新搜索
                    </button>
                  )}
                </>
              )}
            </div>
            <CreditAdjustmentFields
              amount={amount}
              direction={direction}
              reason={reason}
              note={note}
              available={available}
              disabled={busy}
              onAmountChange={setAmount}
              onDirectionChange={setDirection}
              onReasonChange={setReason}
              onNoteChange={setNote}
            />
            <Tooltip
              content={
                overdrawn
                  ? '扣减不能占用任务已预占的积分'
                  : !valid
                    ? '请选择用户并填写有效数量、原因和补充说明'
                    : undefined
              }
            >
              <button
                className="btn btn-dark admin-credit-submit"
                disabled={!valid || busy}
              >
                {busy ? '正在入账…' : '确认调整'}
              </button>
            </Tooltip>
          </form>
        </section>
        <section
          className="admin-credit-card admin-credit-recent"
          aria-label="最近调整记录"
        >
          <div className="admin-credit-section-head">
            <div>
              <h2>最近调整记录</h2>
              <p className="admin-credit-description">
                最近 5 条人工调整，帮助核对是否重复发放。
              </p>
            </div>
            <Tooltip content="刷新调整记录">
              <button
                className="icon-btn"
                aria-label="刷新调整记录"
                disabled={recent.isFetching}
                onClick={() => void recent.refetch()}
              >
                <RefreshCw size={16} />
              </button>
            </Tooltip>
          </div>
          {recent.isPending ? (
            <p className="admin-code-empty" role="status">
              正在读取调整记录…
            </p>
          ) : recent.data?.length ? (
            <div className="admin-credit-records">
              {recent.data.map((item) => (
                <article key={item.id}>
                  <div>
                    <strong>{item.display_name}</strong>
                    <p>{item.reason}</p>
                    <small>
                      {item.operator} ·{' '}
                      {new Date(item.created_at).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    </small>
                  </div>
                  <b data-direction={item.amount > 0 ? 'increase' : 'decrease'}>
                    {item.amount > 0 ? '+' : '−'}
                    {number(Math.abs(item.amount))}
                  </b>
                </article>
              ))}
            </div>
          ) : (
            <div className="admin-code-empty">
              <ShieldCheck size={28} />
              <p>
                {recent.isError
                  ? '记录暂不可用，可点击右上角刷新。'
                  : '还没有人工调整记录'}
              </p>
            </div>
          )}
          {me.user.role === 'SUPER_ADMIN' && (
            <Link className="admin-credit-audit-link" to="/admin/audit">
              查看审计日志 <ArrowRight size={14} />
            </Link>
          )}
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
    </>
  );
}
