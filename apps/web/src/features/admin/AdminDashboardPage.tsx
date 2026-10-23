import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Coins, Users, Server, ArrowUpRight } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { adminApi as api, integer, statuses, when } from './adminApi';
import { AdminAccess, AdminFeedback, AdminFrame, Badge } from './AdminUI';
import UsageCharts from './UsageCharts';
export default function AdminDashboardPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Dashboard {...props} />
    </AdminAccess>
  );
}
function Dashboard(props: AdminProps) {
  const [days, setDays] = useState(7);
  const data = useQuery({
    queryKey: ['adminDashboard', days],
    queryFn: ({ signal }) => api.dashboard(days, signal),
  });
  const d = data.data;
  const tools = (
    <label className="admin-period">
      统计时段
      <select
        aria-label="统计时段"
        className="input"
        value={days}
        onChange={(e) => setDays(Number(e.target.value))}
      >
        <option value={7}>最近 7 天</option>
        <option value={30}>最近 30 天</option>
        <option value={90}>最近 90 天</option>
      </select>
    </label>
  );
  return (
    <AdminFrame
      title="运营总览"
      description="查看平台使用、积分流转与账号池状态。"
      loading={data.isFetching}
      onRefresh={() => void data.refetch()}
      tools={tools}
    >
      <AdminFeedback props={props} error={data.error} />
      {data.isPending && (
        <div
          className="admin-skeleton admin-dashboard-skeleton"
          role="status"
          aria-label="正在加载运营总览"
        >
          <span />
          <span />
          <span />
        </div>
      )}
      {d && (
        <>
          <div className="admin-metrics">
            {[
              {
                label: '平台注册用户',
                value: d.users_total,
                note: `本期新增 ${integer(d.new_users)}`,
                icon: Users,
              },
              {
                label: '今日活跃用户',
                value: d.active_users_today,
                note: '按 UTC 自然日统计',
                icon: Activity,
              },
              {
                label: '本期生成任务',
                value: d.jobs_total,
                note: `进行中 ${integer(d.active_jobs)} · 成功 ${integer(d.succeeded_jobs)} / 失败 ${integer(d.failed_jobs)}`,
                icon: Server,
              },
              {
                label: '本期积分消费',
                value: d.consumed_credits,
                note: `发放 ${integer(d.issued_credits)} · 补偿 ${integer(d.compensated_credits)}`,
                icon: Coins,
              },
            ].map((m) => (
              <section className="admin-metric" key={m.label}>
                <div>
                  <span>{m.label}</span>
                  <m.icon size={17} />
                </div>
                <strong>{integer(m.value)}</strong>
                <small>{m.note}</small>
              </section>
            ))}
          </div>
          <p className="admin-note">
            已结束任务成功率：
            {d.succeeded_jobs + d.failed_jobs > 0
              ? `${((d.succeeded_jobs / (d.succeeded_jobs + d.failed_jobs)) * 100).toFixed(1)}%`
              : '—'}
            （成功含部分完成；不计取消及进行中的任务）。
          </p>
          <section
            className={`admin-review ${d.pending_reviews ? 'has-reviews' : ''}`}
            aria-label="待复核通知"
          >
            <div>
              <h2>
                {d.pending_reviews
                  ? `${integer(d.pending_reviews)} 个账号需要复核`
                  : '暂无待复核账号'}
              </h2>
              <p>
                内容违规达到阈值后，账号会被限制；最后一个超级管理员保留处理权限并收到提醒。
              </p>
            </div>
            <Link className="btn btn-light" to="/admin/users">
              查看用户
              <ArrowUpRight size={15} />
            </Link>
            {d.notifications.length > 0 && (
              <ul>
                {d.notifications.map((n) => (
                  <li key={n.id}>
                    <Link
                      to={`/admin/users?user=${encodeURIComponent(n.user_id)}`}
                    >
                      {n.email}
                      <ArrowUpRight size={13} />
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
          <UsageCharts daily={d.daily} qualities={d.qualities} />
          <div className="admin-chart-grid">
            <section className="admin-panel">
              <header>
                <div>
                  <h2>账号池健康</h2>
                  <p>当前有效租约与可用额度。</p>
                </div>
                <Link to="/admin/accounts" className="text-action">
                  管理账号池 →
                </Link>
              </header>
              <div className="admin-table-scroll">
                <table className="admin-table">
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
                          <Badge bad={h.status !== 'ACTIVE'}>
                            {statuses[h.status] || h.status}
                          </Badge>
                        </td>
                        <td>{integer(h.accounts)}</td>
                        <td>
                          {integer(h.live_slots)} / {integer(h.capacity)}
                        </td>
                        <td>{integer(h.quota_remaining)}</td>
                      </tr>
                    ))}
                    {!d.health.length && (
                      <tr>
                        <td colSpan={4}>
                          <div className="admin-empty">还没有配置上游账号</div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="admin-panel">
              <header>
                <div>
                  <h2>成本与订单</h2>
                  <p>估算与人工确认的订单金额分开列示。</p>
                </div>
              </header>
              <div className="admin-costs">
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
                  <p>
                    {d.unpriced_units
                      ? '尚未配置对应模型的成本单价'
                      : '本期暂无可估算的成功结果'}
                  </p>
                )}
                {d.unpriced_units > 0 && (
                  <p>{integer(d.unpriced_units)} 个输出单位未计入估算。</p>
                )}
                <p className="admin-note">
                  按当前配置单价和成功发布的图片张数、视频秒数、对话条数回算；不含失败重试及供应商额外费用，实际以供应商账单为准。
                </p>
                {props.me.user.role === 'SUPER_ADMIN' && (
                  <Link to="/admin/settings" className="text-action">
                    配置成本估算单价 →
                  </Link>
                )}
                <hr />
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
                  <p>本期暂无确认到账的订单</p>
                )}
                <p className="admin-note">
                  按本期到账订单及当前退款状态计算，非支付渠道余额。待付款{' '}
                  {integer(d.pending_orders)} 笔。
                </p>
                <Link to="/admin/plans" className="text-action">
                  查看订单 →
                </Link>
              </div>
            </section>
          </div>
        </>
      )}
    </AdminFrame>
  );
}
