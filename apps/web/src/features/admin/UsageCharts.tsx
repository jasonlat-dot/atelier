import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { AdminSchema } from './adminApi';
import { integer } from './adminApi';
const qualityLabels: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  standard: '标准',
  message: '文字',
};
export default function UsageCharts({
  daily,
}: {
  daily: AdminSchema['AdminDay'][];
}) {
  const [metric, setMetric] = useState<'jobs' | 'consumed'>('jobs');
  const max = Math.max(1, ...daily.map((d) => d[metric]));
  const empty = daily.every((d) => d[metric] === 0);
  return (
    <section className="ops-card ops-trend" aria-labelledby="ops-trend-title">
      <header className="ops-card-heading">
        <div>
          <h2 id="ops-trend-title">每日趋势</h2>
          <p>按 UTC 自然日统计，积分消费包含生成与对话。</p>
        </div>
        <div className="ops-segments" role="group" aria-label="趋势指标">
          <button
            aria-pressed={metric === 'jobs'}
            onClick={() => setMetric('jobs')}
          >
            任务量
          </button>
          <button
            aria-pressed={metric === 'consumed'}
            onClick={() => setMetric('consumed')}
          >
            积分消耗
          </button>
        </div>
      </header>
      <figure
        className="ops-chart"
        aria-label={metric === 'jobs' ? '每日生成任务量' : '每日积分消耗'}
      >
        <div
          className={`ops-bars${daily.length > 14 ? ' ops-bars-dense' : ''}`}
          style={{ '--ops-days': Math.max(1, daily.length) } as CSSProperties}
        >
          {daily.map((d) => (
            <div
              className="ops-bar-column"
              key={d.day}
              tabIndex={0}
              aria-label={`${d.day}：${integer(d[metric])} ${metric === 'jobs' ? '个任务' : '积分'}`}
              data-tip={`${d.day}：${integer(d[metric])} ${metric === 'jobs' ? '个任务' : '积分'}`}
              style={
                {
                  '--ops-bar-height': `${(d[metric] / max) * 100}%`,
                } as CSSProperties
              }
            >
              <span className="ops-bar">
                <b>{d[metric] > 0 ? integer(d[metric]) : ''}</b>
              </span>
            </div>
          ))}
          {empty && <div className="ops-chart-empty">所选时段暂无数据</div>}
        </div>
        <figcaption>
          <span>{daily[0]?.day.slice(5) || '—'}</span>
          <span>{daily.at(-1)?.day.slice(5) || '—'}</span>
        </figcaption>
      </figure>
    </section>
  );
}

export function GenerationDistribution({
  qualities,
}: {
  qualities: AdminSchema['AdminQuality'][];
}) {
  const sum = qualities.reduce((n, d) => n + d.jobs, 0);
  return (
    <section
      className="ops-card ops-distribution"
      aria-labelledby="ops-distribution-title"
    >
      <header className="ops-card-heading">
        <div>
          <h2 id="ops-distribution-title">生成分布</h2>
          <p>按提交任务的质量统计</p>
        </div>
      </header>
      {!sum ? (
        <div className="ops-empty">暂无生成记录</div>
      ) : (
        <div className="ops-qualities">
          {qualities.map((q) => (
            <div className="ops-quality" key={q.quality}>
              <div>
                <span>{qualityLabels[q.quality] || q.quality}</span>
                <strong>
                  {integer(q.jobs)} 次 ·{' '}
                  {sum ? Math.round((q.jobs / sum) * 100) : 0}%
                </strong>
              </div>
              <progress
                max={sum || 1}
                value={q.jobs}
                aria-label={`${qualityLabels[q.quality] || q.quality}质量占比`}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
