import { ArrowRight } from 'lucide-react';
import Select from '../../components/Select';
import type { User } from '../admin/adminApi';
import './CreditAdjustmentFields.css';

const reasons = [
  '补偿（任务失败/故障）',
  '活动赠送',
  '运营奖励',
  '错误纠正',
  '其他',
];
const number = (value: number) => value.toLocaleString('zh-CN');

export function CreditAdjustmentFields({
  amount,
  direction,
  reason,
  note,
  available,
  limit,
  disabled = false,
  idPrefix = 'credit',
  initialFocus = false,
  onAmountChange,
  onDirectionChange,
  onReasonChange,
  onNoteChange,
}: {
  amount: string;
  direction: 1 | -1;
  reason: string;
  note: string;
  available?: number;
  limit?: number;
  disabled?: boolean;
  idPrefix?: string;
  initialFocus?: boolean;
  onAmountChange: (value: string) => void;
  onDirectionChange: (value: 1 | -1) => void;
  onReasonChange: (value: string) => void;
  onNoteChange: (value: string) => void;
}) {
  const quantity = Number(amount);
  const after =
    available !== undefined && Number.isSafeInteger(quantity) && quantity > 0
      ? available + direction * quantity
      : undefined;
  const overdrawn = after !== undefined && after < 0;
  return (
    <div className="credit-adjustment-fields">
      <div className="admin-credit-field">
        <label htmlFor={`${idPrefix}-amount`}>调整积分</label>
        <div className="admin-credit-amount-row">
          <div
            className="admin-credit-direction"
            role="group"
            aria-label="调整方式"
          >
            <button
              type="button"
              aria-pressed={direction === 1}
              disabled={disabled}
              onClick={() => onDirectionChange(1)}
            >
              增加
            </button>
            <button
              type="button"
              aria-pressed={direction === -1}
              disabled={disabled}
              onClick={() => onDirectionChange(-1)}
            >
              扣减
            </button>
          </div>
          <input
            id={`${idPrefix}-amount`}
            className="input"
            type="number"
            min="1"
            max={limit}
            data-initial-focus={initialFocus || undefined}
            step="1"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            disabled={disabled}
            placeholder="积分数量"
            required
          />
        </div>
        <div className="admin-credit-quick-amounts">
          {[10, 50, 100, 500].map((value) => (
            <button
              type="button"
              key={value}
              disabled={disabled}
              onClick={() => {
                onDirectionChange(1);
                onAmountChange(String(value));
              }}
            >
              +{value}
            </button>
          ))}
        </div>
        <small>
          仅填正整数，通过“增加 / 扣减”选择方向。
          {limit !== undefined && `单次最多 ${number(limit)} 积分。`}
          {overdrawn && `当前可扣减上限 ${number(available!)} 积分。`}
        </small>
      </div>
      <div className="admin-credit-preview">
        <span>
          调整后可用积分<small>按当前读取的余额预览</small>
        </span>
        <div>
          <span>{available === undefined ? '—' : number(available)}</span>
          <ArrowRight size={16} />
          <strong
            data-direction={
              overdrawn ? 'invalid' : direction === 1 ? 'increase' : 'decrease'
            }
          >
            {after === undefined ? '—' : number(after)}
          </strong>
        </div>
      </div>
      <div className="admin-credit-field">
        <label htmlFor={`${idPrefix}-reason`}>调整原因</label>
        <Select
          id={`${idPrefix}-reason`}
          aria-label="调整原因"
          value={reason}
          onValueChange={onReasonChange}
          disabled={disabled}
          placeholder="选择原因"
          options={reasons.map((value) => ({ value, label: value }))}
        />
      </div>
      <div className="admin-credit-field">
        <label htmlFor={`${idPrefix}-note`}>补充说明</label>
        <textarea
          id={`${idPrefix}-note`}
          className="input"
          rows={3}
          maxLength={450}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          disabled={disabled}
          placeholder="请说明调整原因，至少 5 个字"
          required
        />
        <small>必填，至少 5 个字，原因与说明一并写入审计日志。</small>
      </div>
    </div>
  );
}

export function CreditAdjustmentSummary({
  user,
  delta,
  reason,
  note,
}: {
  user: Pick<User, 'id' | 'display_name' | 'email' | 'balance' | 'held'>;
  delta: number;
  reason: string;
  note: string;
}) {
  const available = user.balance - user.held;
  const after = available + delta;
  const quantity = Math.abs(delta);
  return (
    <div className="credit-adjust-confirm">
      <dl className="credit-confirm-details">
        <div>
          <dt>调整用户</dt>
          <dd>
            <strong>{user.display_name}</strong>
            <span className="credit-confirm-email">{user.email}</span>
          </dd>
        </div>
        <div>
          <dt>用户 ID</dt>
          <dd>
            <code>{user.id}</code>
          </dd>
        </div>
      </dl>
      <div
        className="credit-confirm-summary"
        data-direction={delta > 0 ? 'increase' : 'decrease'}
      >
        <div className="credit-confirm-amount">
          <span>本次{delta > 0 ? '增加' : '扣减'}</span>
          <strong>
            {delta > 0 ? '+' : '−'}
            {number(quantity)}
            <small>积分</small>
          </strong>
        </div>
        <div className="credit-confirm-balance">
          <span>可用积分</span>
          <div>
            <span>{number(available)}</span>
            <ArrowRight size={16} aria-hidden="true" />
            <strong>{number(after)}</strong>
          </div>
        </div>
      </div>
      <dl className="credit-confirm-details">
        <div>
          <dt>调整原因</dt>
          <dd>{reason}</dd>
        </div>
        <div>
          <dt>补充说明</dt>
          <dd className="credit-confirm-note" tabIndex={0}>
            {note.trim()}
          </dd>
        </div>
      </dl>
      <p className="credit-confirm-footnote">
        本次调整将写入积分账本和审计记录，提交后不能直接撤销。最终余额以服务端为准。
      </p>
    </div>
  );
}
