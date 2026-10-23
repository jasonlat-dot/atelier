import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminProps } from '../upstream/upstreamApi';
import { adminApi as api, integer } from './adminApi';
import { AdminFeedback, AdminFrame } from './AdminUI';
import UsageCharts from './UsageCharts';
export default function UsagePage(props: AdminProps) {
  const [days, setDays] = useState(7);
  const query = useQuery({
    queryKey: ['usage', props.me.user.id, days],
    queryFn: ({ signal }) => api.usage(days, signal),
  });
  const data = query.data;
  return (
    <AdminFrame
      title="用量分析"
      description="查看自己的生成任务与积分消费，按 UTC 自然日汇总。"
      loading={query.isFetching}
      onRefresh={() => void query.refetch()}
      tools={
        <label className="admin-period">
          统计时段
          <select
            className="input"
            aria-label="统计时段"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </label>
      }
    >
      <AdminFeedback props={props} error={query.error} />
      {query.isPending && <p role="status">正在读取用量…</p>}
      {data && (
        <>
          <div className="admin-metrics">
            <section className="admin-metric">
              <span>本期生成任务</span>
              <strong>
                {integer(data.daily.reduce((a, d) => a + d.jobs, 0))}
              </strong>
              <small>包含图片与视频</small>
            </section>
            <section className="admin-metric">
              <span>本期积分消费</span>
              <strong>
                {integer(data.daily.reduce((a, d) => a + d.consumed, 0))}
              </strong>
              <small>包含生成与已完成对话</small>
            </section>
          </div>
          <UsageCharts daily={data.daily} qualities={data.qualities} />
        </>
      )}
    </AdminFrame>
  );
}
