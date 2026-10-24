import Select from '../../components/Select';
import { useRef, useState } from 'react';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { SessionError } from '../auth/sessionApi';
import { adminApi as api, roles, type User } from './adminApi';
import { AdminFeedback } from './AdminUI';
import {
  CreditAdjustmentFields,
  CreditAdjustmentSummary,
} from '../wallet/CreditAdjustmentFields';
export type Action =
  'credits' | 'disable' | 'enable' | 'role' | 'revoke-sessions' | 'review';
export default function UserAction(
  props: AdminProps & {
    user: User;
    action: Action;
    limit: number;
    onClose: () => void;
    onDone: (message: string) => Promise<void>;
  },
) {
  const u = props.user;
  const a = props.action;
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [creditReason, setCreditReason] = useState('');
  const [note, setNote] = useState('');
  const [role, setRole] = useState(u.role);
  const [review, setReview] = useState(a !== 'credits');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const pending = useRef<{ key: string; amount: number; reason: string }>();
  const labels: Record<Action, string> = {
    credits: '调整积分',
    disable: '禁用账号',
    enable: '恢复账号',
    role: '变更角色',
    'revoke-sessions': '强制下线',
    review: '标记已复核',
  };
  const quantity = Number(amount);
  const delta = direction * quantity;
  const description =
    a === 'credits' ? `${creditReason}：${note.trim()}` : reason.trim();
  const invalid =
    a === 'credits' &&
    (!Number.isSafeInteger(delta) ||
      quantity <= 0 ||
      !creditReason ||
      note.trim().length < 5 ||
      !Number.isSafeInteger(u.balance - u.held + delta) ||
      Math.abs(delta) > props.limit ||
      (delta < 0 && -delta > u.balance - u.held));
  return (
    <AdminDialog
      title={labels[a]}
      className={a === 'credits' ? 'user-credit-dialog' : ''}
      busy={busy}
      onClose={props.onClose}
    >
      <form
        className="admin-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (lock.current || invalid || !description) return;
          if (!review) {
            setReview(true);
            return;
          }
          lock.current = true;
          setBusy(true);
          setError(undefined);
          try {
            if (a === 'credits') {
              if (!pending.current)
                pending.current = {
                  key: crypto.randomUUID(),
                  amount: delta,
                  reason: description,
                };
              await api.credits(
                u.id,
                pending.current.amount,
                pending.current.reason,
                props.me.csrf_token,
                pending.current.key,
              );
            } else {
              await api.userAction(
                u.id,
                a,
                {
                  revision: u.revision,
                  reason: description,
                  role: a === 'role' ? role : null,
                },
                props.me.csrf_token,
              );
            }
            if (
              u.id === props.me.user.id &&
              (a === 'role' || a === 'revoke-sessions')
            ) {
              props.onExpired();
              return;
            }
            await props.onDone(`${labels[a]}已完成`);
          } catch (e) {
            setError(e);
            if (
              a === 'credits' &&
              (!(e instanceof SessionError) || e.status >= 500)
            )
              setUncertain(true);
            else pending.current = undefined;
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {!(a === 'credits' && review) && (
          <div className="admin-confirm-target">
            <strong>{u.display_name}</strong>
            <span>{u.email}</span>
          </div>
        )}
        {a === 'credits' ? (
          review ? (
            <CreditAdjustmentSummary
              user={u}
              delta={delta}
              reason={creditReason}
              note={note}
            />
          ) : (
            <CreditAdjustmentFields
              idPrefix="user-credit"
              initialFocus
              amount={amount}
              direction={direction}
              reason={creditReason}
              note={note}
              available={u.balance - u.held}
              limit={props.limit}
              disabled={busy || uncertain}
              onAmountChange={setAmount}
              onDirectionChange={setDirection}
              onReasonChange={setCreditReason}
              onNoteChange={setNote}
            />
          )
        ) : a === 'role' ? (
          <>
            <label>
              新角色
              <Select
                aria-label="新角色"

                value={role}
                disabled={busy}
                onChange={(e) => setRole(e.target.value)}
              >
                {Object.entries(roles).map(([r, label]) => (
                  <option key={r} value={r}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <p className="admin-note">
              变更后立即撤销此账号的全部会话；管理员再次登录必须完成验证器验证。必须保留至少一个有效超级管理员。
            </p>
          </>
        ) : (
          <p className="admin-note">
            {a === 'disable'
              ? '禁用后立即撤销全部会话并取消排队任务；运行中的生成会停止，未结算的预占由任务释放。恢复账号不会重新提交这些任务。'
              : a === 'enable'
                ? '恢复后可以重新登录。之前取消的任务不会自动重新运行。'
                : a === 'revoke-sessions'
                  ? '此账号的全部设备将立即退出，需要重新使用 Google 登录。'
                  : '标记后会从运营总览的待复核通知中移除，不会自动改变账号状态。'}
          </p>
        )}
        {a !== 'credits' && (
          <label>
            处理说明
            <textarea
              data-initial-focus
              className="input"
              required
              maxLength={500}
              value={reason}
              disabled={busy || uncertain}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <AdminFeedback props={props} error={error} />
        {uncertain && (
          <p className="admin-note">
            本次结果尚未确认，重试会保持原积分与说明；也可以关闭后先核对最新流水。
          </p>
        )}
        <footer className="admin-form-actions">
          {a === 'credits' && review && !uncertain && (
            <button
              className="btn btn-light"
              type="button"
              disabled={busy}
              onClick={() => {
                setReview(false);
                pending.current = undefined;
              }}
            >
              返回修改
            </button>
          )}
          <button
            className="btn btn-light"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            className="btn btn-dark"
            disabled={
              busy ||
              !description ||
              invalid ||
              (a === 'role' && role === u.role)
            }
          >
            {busy
              ? '正在处理…'
              : a === 'credits'
                ? review
                  ? uncertain
                    ? '按原内容重试'
                    : '确认调整积分'
                  : '核对调整'
                : `确认${labels[a]}`}
          </button>
        </footer>
      </form>
    </AdminDialog>
  );
}
