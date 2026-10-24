import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { adminApi as api, integer, when, type AdminSchema } from './adminApi';
import { AdminFeedback } from './AdminUI';
import { groupLedger, ledgerLabels } from './userLedgerGroups';

export default function UserLedger({
  user,
  initial,
  jobs,
  props,
}: {
  user: string;
  initial: AdminSchema['LedgerPage'];
  jobs: AdminSchema['AdminJob'][];
  props: AdminProps;
}) {
  const [entries, setEntries] = useState(initial.items);
  const [next, setNext] = useState(initial.next_cursor);
  const [filter, setFilter] = useState('all');
  const [visible, setVisible] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const rows = groupLedger(entries).filter(
    (row) => filter === 'all' || row.category === filter,
  );
  const more = async () => {
    if (lock.current) return;
    if (visible < rows.length) {
      setVisible((v) => v + 8);
      return;
    }
    if (!next) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const page = await api.ledger(user, next);
      setEntries((old) => [
        ...new Map(
          [...old, ...page.items].map((entry) => [entry.id, entry]),
        ).values(),
      ]);
      setNext(page.next_cursor);
      setVisible((v) => v + 8);
    } catch (error) {
      setError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="users-ledger" aria-label="用户积分流水">
      <div className="users-ledger-filters" role="group" aria-label="流水分类">
        {[
          ['all', '全部'],
          ['task', '任务消耗'],
          ['reward', '奖励充值'],
          ['admin', '管理调整'],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setVisible(8);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="users-panel-note">
        按已加载流水汇总；预占不计扣款，展开可核对原始明细。
      </p>
      <AdminFeedback props={props} error={error} />
      {!rows.length && (
        <p className="users-detail-empty">
          {entries.length ? '已加载记录中暂无此类流水' : '暂无积分流水'}
        </p>
      )}
      {rows.slice(0, visible).map((row) => {
        const job = jobs.find((job) => job.id === row.reference);
        return (
          <details key={row.key} className="users-ledger-group">
            <summary>
              <div className="users-ledger-summary">
                <strong>{job?.display_name || row.title}</strong>
                <span>
                  {when(row.time)}{' '}
                  {row.state && (
                    <span className="users-ledger-state">{row.state}</span>
                  )}
                </span>
              </div>
              <strong
                className={`users-ledger-net ${row.amount > 0 ? 'users-positive' : row.amount < 0 ? 'users-negative' : ''}`}
              >
                {row.amount > 0 ? '+' : ''}
                {integer(row.amount)}
              </strong>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="users-ledger-details">
              {row.reference && (
                <p className="admin-id">任务 {row.reference}</p>
              )}
              {row.entries.map((entry) => (
                <div key={entry.id} className="users-ledger-detail">
                  <div>
                    <strong>{ledgerLabels[entry.type] || entry.type}</strong>
                    <small>
                      {when(entry.created_at)} · #{entry.id}
                    </small>
                    {entry.reason && <small>{entry.reason}</small>}
                  </div>
                  <span>
                    余额 {entry.balance_delta > 0 ? '+' : ''}
                    {integer(entry.balance_delta)}
                    <small>
                      预占 {entry.held_delta > 0 ? '+' : ''}
                      {integer(entry.held_delta)}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          </details>
        );
      })}
      {(visible < rows.length || next) && (
        <button
          className="btn btn-light users-more"
          disabled={busy}
          onClick={() => void more()}
        >
          {busy ? '正在加载…' : '加载更多流水'}
        </button>
      )}
    </section>
  );
}
