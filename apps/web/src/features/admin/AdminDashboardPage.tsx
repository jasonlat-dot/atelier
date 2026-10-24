import Select from '../../components/Select';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Activity,
  Coins,
  Users,
  Server,
  ArrowUpRight,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { adminApi as api, integer, statuses, when } from './adminApi';
import { AdminAccess, AdminFeedback } from './AdminUI';
import UsageCharts, { GenerationDistribution } from './UsageCharts';
import './AdminDashboardPage.css';

export default function AdminDashboardPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Dashboard {...props} />
    </AdminAccess>
  );
}

function Dashboard(props: AdminProps) {
  const [days, setDays] = useState(7);
  const query = useQuery({
    queryKey: ['adminDashboard', props.me.user.id, days],
    queryFn: ({ signal }) => api.dashboard(days, signal),
  });
  const d = query.data;
  const finished = d ? d.succeeded_jobs + d.failed_jobs : 0;
  const successRate =
    d && finished
      ? `${((d.succeeded_jobs / finished) * 100).toFixed(1)}%`
      : '—';
  const totalAccounts =
    d?.health.reduce((sum, row) => sum + row.accounts, 0) ?? 0;
  const activeAccounts =
    d?.health.find((row) => row.status === 'ACTIVE')?.accounts ?? 0;
  const ReviewIcon = d?.pending_reviews ? ShieldAlert : ShieldCheck;

  return (
    <main
      className="ops-page"
      aria-label="运营总览"
      aria-busy={query.isFetching}
    >
      <header className="ops-heading">
        <div>
          <div className="ops-eyebrow">ATELIER / OPERATIONS</div>
          <h1>运营总览</h1>
          <p>查看平台使用、积分流转与账号池状态。</p>
        </div>
        <div className="ops-controls">
          <label htmlFor="ops-period">统计时段</label>
          <Select
            id="ops-period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>最近 7 天</option>
            <option value={14}>最近 14 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </Select>
          <button
            className="ops-button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw
              size={15}
              aria-hidden="true"
              className={query.isFetching ? 'ops-spinning' : undefined}
            />
            刷新数据
          </button>
        </div>
      </header>
      <AdminFeedback props={props} error={query.error} />
      {query.isPending && (
        <div
          className="ops-loading"
          role="status"
          aria-label="正在加载运营总览"
        >
          <span className="ops-placeholder ops-loading-review" />
          <div>
            {[0, 1, 2, 3].map((n) => (
              <span className="ops-placeholder" key={n} />
            ))}
          </div>
          <span className="ops-placeholder ops-loading-chart" />
        </div>
      )}
      {!d && query.isError && (
        <section className="ops-card ops-unavailable">
          <Server size={28} aria-hidden="true" />
          <h2>运营数据暂未读取</h2>
          <p>刷新数据后重试。</p>
          <button
            className="ops-button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重新加载
          </button>
        </section>
      )}
      {d && (
        <>
          <section
            className={`ops-review${d.pending_reviews ? ' ops-review-pending' : ''}`}
            aria-label="待复核通知"
          >
            <div className="ops-review-summary">
              <ReviewIcon size={22} aria-hidden="true" />
              <div>
                <h2>
                  {d.pending_reviews
                    ? `有 ${integer(d.pending_reviews)} 项待复核`
                    : '暂无待复核账号'}
                </h2>
                <p>
                  内容违规达到阈值后，账号会被限制；最后一个超级管理员保留处理权限并收到提醒。
                </p>
              </div>
            </div>
            <Link className="ops-button" to="/admin/users">
              查看用户 <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            {d.notifications.length > 0 && (
              <ul className="ops-review-list">
                {d.notifications.map((n) => (
                  <li key={n.id}>
                    <Link
                      to={`/admin/users?user=${encodeURIComponent(n.user_id)}`}
                    >
                      {n.email}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </Link>
                    <span>
                      30 天内 {n.violation_count} 次 ·{' '}
                      {n.kind === 'PROTECTED_ADMIN'
                        ? '管理员待复核'
                        : '已自动禁用'}
                    </span>
                    <small>{when(n.created_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="ops-metrics" aria-label="平台运营指标">
            <div className="ops-user-metrics">
              <article className="ops-card ops-metric ops-metric-compact">
                <h2>
                  平台注册用户 <Users size={17} aria-hidden="true" />
                </h2>
                <strong>{integer(d.users_total)}</strong>
                <p>本期新增 {integer(d.new_users)}</p>
              </article>
              <article className="ops-card ops-metric ops-metric-compact">
                <h2>
                  今日活跃用户 <Activity size={17} aria-hidden="true" />
                </h2>
                <strong>{integer(d.active_users_today)}</strong>
                <p>按 UTC 自然日统计</p>
              </article>
            </div>
            <article className="ops-card ops-metric">
              <h2>
                本期生成任务 <Server size={17} aria-hidden="true" />
              </h2>
              <strong>{integer(d.jobs_total)}</strong>
              <div
                tabIndex={0}
                className="ops-task-stack"
                data-tip="绿色为成功（含部分完成），红色为失败，灰色为其余任务（含取消和未结束）。"
                aria-label={`本期成功 ${integer(d.succeeded_jobs)}，失败 ${integer(d.failed_jobs)}，共 ${integer(d.jobs_total)} 个任务`}
              >
                <i
                  className="ops-task-success"
                  style={{
                    width: `${d.jobs_total ? (d.succeeded_jobs / d.jobs_total) * 100 : 0}%`,
                  }}
                />
                <i
                  className="ops-task-failed"
                  style={{
                    width: `${d.jobs_total ? (d.failed_jobs / d.jobs_total) * 100 : 0}%`,
                  }}
                />
              </div>
              <p>
                成功 {integer(d.succeeded_jobs)} · 失败 {integer(d.failed_jobs)}{' '}
                <span
                  tabIndex={0}
                  className="ops-success-rate"
                  data-tip="成功含部分完成；仅按成功与失败计算，不计取消及进行中的任务。"
                >
                  成功率 {successRate}
                </span>
              </p>
              <p
                tabIndex={0}
                data-tip="当前进行中为全平台未结束任务，不限于所选创建时段。"
              >
                当前进行中 {integer(d.active_jobs)}（全平台）
              </p>
            </article>
            <article className="ops-card ops-metric ops-metric-highlight">
              <h2>
                本期积分消费 <Coins size={17} aria-hidden="true" />
              </h2>
              <strong>{integer(d.consumed_credits)}</strong>
              <p>
                发放 {integer(d.issued_credits)} · 补偿{' '}
                {integer(d.compensated_credits)}
              </p>
            </article>
            <GenerationDistribution qualities={d.qualities} />
          </section>
          <div className="ops-content-row">
            <div className="ops-main-column">
              <UsageCharts daily={d.daily} />
              <section className="ops-card" aria-labelledby="ops-pool-title">
                <header className="ops-card-heading">
                  <div>
                    <h2 id="ops-pool-title">账号池健康</h2>
                    <p>当前有效租约与可用额度，按账号状态汇总。</p>
                  </div>
                  <Link to="/admin/accounts" className="ops-link">
                    管理账号池 →
                  </Link>
                </header>
                <div className="ops-pool-summary">
                  <span>共 {integer(totalAccounts)} 个账号</span>
                  <span className="ops-tag-ok">
                    正常 {integer(activeAccounts)}
                  </span>
                  <span>非正常 {integer(totalAccounts - activeAccounts)}</span>
                </div>
                <div className="ops-table-scroll">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>状态</th>
                        <th>账号</th>
                        <th>并发占用</th>
                        <th>剩余额度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.health.map((h) => (
                        <tr key={h.status}>
                          <td>
                            <span
                              className={`ops-tag ${h.status === 'ACTIVE' ? 'ops-tag-ok' : h.status === 'COOLDOWN' || h.status === 'QUOTA_EXHAUSTED' ? 'ops-tag-warning' : 'ops-tag-bad'}`}
                            >
                              {statuses[h.status] || h.status}
                            </span>
                          </td>
                          <td>{integer(h.accounts)}</td>
                          <td>
                            <div className="ops-concurrency">
                              <span>
                                {integer(h.live_slots)} / {integer(h.capacity)}
                              </span>
                              <progress
                                aria-label={`${statuses[h.status] || h.status}账号并发占用`}
                                max={Math.max(1, h.capacity)}
                                value={h.live_slots}
                              />
                            </div>
                          </td>
                          <td>{integer(h.quota_remaining)}</td>
                        </tr>
                      ))}
                      {!d.health.length && (
                        <tr>
                          <td colSpan={4}>
                            <div className="ops-empty">尚未接入账号</div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            <section
              className="ops-card ops-finance"
              aria-labelledby="ops-cost-title"
            >
              <header className="ops-card-heading">
                <div>
                  <h2 id="ops-cost-title">成本与订单</h2>
                  <p>估算与人工确认的金额分开列示。</p>
                </div>
              </header>
              <div className="ops-finance-block">
                <h3>上游成本估算</h3>
                {d.estimated_costs.length ? (
                  d.estimated_costs.map((c) => (
                    <strong key={c.currency}>
                      {new Intl.NumberFormat('zh-CN', {
                        style: 'currency',
                        currency: c.currency,
                        maximumFractionDigits: 6,
                      }).format(c.amount_micros / 1000000)}
                    </strong>
                  ))
                ) : (
                  <strong>—</strong>
                )}
                {!d.estimated_costs.length && (
                  <p>
                    {d.unpriced_units
                      ? '尚未配置对应模型的成本单价'
                      : '本期暂无可估算的成功结果'}
                  </p>
                )}
                {d.unpriced_units > 0 && (
                  <p className="ops-cost-unpriced">
                    {integer(d.unpriced_units)} 个输出单位未计入估算。
                  </p>
                )}
                <p className="ops-finance-note">
                  按当前配置单价和成功发布的图片张数、视频秒数、对话条数回算；不含失败重试及供应商额外费用，实际以供应商账单为准。
                </p>
                {props.me.user.role === 'SUPER_ADMIN' && (
                  <Link to="/admin/settings" className="ops-link">
                    配置成本估算单价 →
                  </Link>
                )}
              </div>
              <div className="ops-finance-block">
                <h3>本期确认订单净额</h3>
                {d.order_amounts.length ? (
                  d.order_amounts.map((c) => (
                    <strong key={c.currency}>
                      {new Intl.NumberFormat('zh-CN', {
                        style: 'currency',
                        currency: c.currency,
                      }).format(c.amount_cents / 100)}
                    </strong>
                  ))
                ) : (
                  <>
                    <strong>—</strong>
                    <p>本期暂无确认到账的订单</p>
                  </>
                )}
                <p className="ops-finance-note">
                  按本期到账订单及当前退款状态计算，非支付渠道余额。待付款{' '}
                  {integer(d.pending_orders)} 笔。
                </p>
                <Link to="/admin/plans" className="ops-link">
                  查看订单 →
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
