import Select from '../../components/Select';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, RefreshCw, Sparkles } from 'lucide-react';
import type { AdminProps } from '../upstream/upstreamApi';
import { adminApi as api, integer, statuses } from './adminApi';
import { AdminFeedback } from './AdminUI';
import UsageVisuals, { qualityLabel } from './UsageVisuals';
import './UsagePage.css';

function Delta({ current, previous }: { current: number; previous?: number }) {
  if (!previous || current === previous) return null;
  const change = ((current - previous) / previous) * 100;
  return (
    <span
      tabIndex={0}
      className="usage-delta"
      data-tip="与上一个等长 UTC 时段比较"
    >
      {change > 0 ? '↑' : '↓'}{' '}
      {Math.abs(change).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%
    </span>
  );
}

export default function UsagePage(props: AdminProps) {
  const [days, setDays] = useState(7);
  const query = useQuery({
    queryKey: ['usage', props.me.user.id, days],
    queryFn: ({ signal }) => api.usage(days, signal),
  });
  const data = query.data;
  const jobs = data?.daily.reduce((sum, day) => sum + day.jobs, 0) ?? 0;
  const consumed = data?.daily.reduce((sum, day) => sum + day.consumed, 0) ?? 0;
  const succeeded =
    data?.daily.reduce((sum, day) => sum + day.succeeded, 0) ?? 0;
  const recent = data?.recent ?? [];
  const pending = query.isPending;
  const metrics = [
    {
      label: '本期生成任务',
      value: data ? integer(jobs) : '—',
      note: '包含图片与视频',
      previous: data?.previous?.jobs,
      current: jobs,
    },
    {
      label: '本期积分消费',
      value: data ? integer(consumed) : '—',
      note: '包含生成与已完成对话',
      previous: data?.previous?.consumed,
      current: consumed,
    },
    {
      label: '任务成功率',
      value: data && jobs ? `${((succeeded / jobs) * 100).toFixed(1)}%` : '—',
      note: !data
        ? '按本期提交的任务统计'
        : jobs
          ? `完成及部分完成 ${integer(succeeded)} / ${integer(jobs)} 个任务`
          : '所选时段暂无生成任务',
    },
    {
      label: '已退回积分',
      value:
        data?.released_credits == null ? '—' : integer(data.released_credits),
      note: '本期任务未产出部分解除预占',
    },
  ];
  return (
    <main
      className="usage-page"
      aria-label="用量分析"
      aria-busy={query.isFetching}
    >
      <header className="usage-heading">
        <div>
          <div className="usage-eyebrow">ATELIER / MANAGEMENT</div>
          <h1>用量分析</h1>
          <p>查看自己的生成任务与积分消费，按 UTC 自然日汇总。</p>
        </div>
        <div className="usage-controls">
          <label htmlFor="usage-period">统计时段</label>
          <Select
            id="usage-period"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            <option value={7}>最近 7 天</option>
            <option value={14}>最近 14 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </Select>
          <button
            className="usage-refresh"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={15} className={query.isFetching ? 'spin' : ''} />
            刷新数据
          </button>
        </div>
      </header>
      <AdminFeedback props={props} error={query.error} />
      <section className="usage-metrics" aria-label="用量概览">
        {metrics.map((metric, index) => (
          <article
            className={`usage-card usage-metric ${index === 1 ? 'usage-metric-highlight' : ''}`}
            key={metric.label}
          >
            <h2>{metric.label}</h2>
            {pending ? (
              <span className="usage-skeleton usage-metric-placeholder" />
            ) : (
              <div className="usage-metric-value">
                <strong aria-label={`${metric.label}数值`}>
                  {metric.value}
                </strong>
                {'current' in metric && (
                  <Delta current={metric.current!} previous={metric.previous} />
                )}
              </div>
            )}
            <p>{metric.note}</p>
          </article>
        ))}
      </section>
      {pending && (
        <span className="usage-sr-only" role="status">
          正在读取用量…
        </span>
      )}
      <UsageVisuals
        daily={data?.daily ?? []}
        qualities={data?.qualities ?? []}
        kinds={data?.kinds}
        pending={pending}
        unavailable={!pending && !data}
      />
      <section
        className="usage-card usage-recent"
        aria-labelledby="usage-recent-title"
      >
        <header className="usage-card-heading">
          <div>
            <h2 id="usage-recent-title">最近任务</h2>
            <p>所选时段最近 10 条可见生成记录，时间按 UTC 显示。</p>
          </div>
          <Link to="/generate" className="usage-link">
            查看全部 <ArrowRight size={14} />
          </Link>
        </header>
        {pending ? (
          <div className="usage-table-loading" aria-hidden="true">
            {[0, 1, 2].map((n) => (
              <div className="usage-skeleton" key={n} />
            ))}
          </div>
        ) : recent.length ? (
          <div
            className="usage-table-scroll"
            role="region"
            aria-label="最近生成任务"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">描述</th>
                  <th scope="col">模型</th>
                  <th scope="col">质量</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="usage-num">
                    积分
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <time dateTime={task.created_at}>
                        {new Date(task.created_at).toLocaleString('zh-CN', {
                          timeZone: 'UTC',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: false,
                        })}
                      </time>
                    </td>
                    <td className="usage-prompt">
                      <span tabIndex={0} data-tip={task.prompt}>
                        {task.prompt}
                      </span>
                    </td>
                    <td className="usage-model">
                      <span tabIndex={0} data-tip={task.display_name}>
                        {task.display_name}
                      </span>
                    </td>
                    <td>{qualityLabel(task.quality)}</td>
                    <td>
                      <span
                        className={`usage-status usage-status-${task.status.toLowerCase()}`}
                      >
                        {statuses[task.status] || task.status}
                      </span>
                    </td>
                    <td
                      tabIndex={0}
                      className="usage-num"
                      data-tip="已结算积分"
                    >
                      {integer(task.settled)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="usage-empty">
            {data ? (
              <Sparkles size={24} aria-hidden="true" />
            ) : (
              <BarChart3 size={24} aria-hidden="true" />
            )}
            <p>
              {!data
                ? '数据暂未读取'
                : data.recent == null
                  ? '最近任务统计暂不可用'
                  : '暂无记录，去生成第一张作品吧'}
            </p>
            {data ? (
              <Link className="usage-primary" to="/generate">
                开始创作 <ArrowRight size={14} />
              </Link>
            ) : (
              <button
                className="usage-primary"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                重新读取
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
