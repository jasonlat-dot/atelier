import type { AdminSchema } from './adminApi';

export type LedgerEntry = AdminSchema['LedgerEntry'];
const taskTypes = new Set(['HOLD', 'SETTLE', 'RELEASE', 'REFUND']);
export const ledgerLabels: Record<string, string> = {
  ADMIN_ADJUST: '管理员调整',
  REFUND: '任务补偿',
  SETTLE: '任务结算',
  HOLD: '任务预占',
  RELEASE: '解除预占',
  SIGNUP: '注册赠送',
  SIGNUP_BONUS: '注册赠送',
  CHECKIN: '签到奖励',
  REDEEM: '兑换入账',
  PURCHASE: '购买积分',
};

export function groupLedger(entries: LedgerEntry[]) {
  const groups = new Map<
    string,
    { key: string; reference?: string; entries: LedgerEntry[] }
  >();
  const unique = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of [...unique.values()].sort((a, b) => b.id - a.id)) {
    const reference =
      (entry.ref_type === 'job' || entry.ref_type === 'job_refund') &&
      entry.ref_id
        ? entry.ref_id
        : undefined;
    const key = reference ? `job:${reference}` : `entry:${entry.id}`;
    if (!groups.has(key)) groups.set(key, { key, reference, entries: [] });
    groups.get(key)!.entries.push(entry);
  }
  return [...groups.values()].map((group) => {
    const types = new Set(group.entries.map((entry) => entry.type));
    const amount = group.entries.reduce(
      (sum, entry) => sum + entry.balance_delta,
      0,
    );
    const held = group.entries.reduce(
      (sum, entry) => sum + entry.held_delta,
      0,
    );
    const task =
      !!group.reference ||
      group.entries.some((entry) => taskTypes.has(entry.type));
    return {
      ...group,
      amount,
      held,
      category: task ? 'task' : types.has('ADMIN_ADJUST') ? 'admin' : 'reward',
      title: group.reference
        ? '创作任务'
        : ledgerLabels[group.entries[0].type] || group.entries[0].type,
      state: !task
        ? ''
        : types.has('REFUND')
          ? '已补偿'
          : types.has('SETTLE')
            ? types.has('HOLD') && held > 0
              ? '部分结算'
              : '已结算'
            : types.has('RELEASE') && held <= 0
              ? '已释放'
              : types.has('HOLD') && held > 0
                ? '预占中'
                : '明细记录',
      time: group.entries[0].created_at,
    };
  });
}
