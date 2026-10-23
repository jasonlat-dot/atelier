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
  qualities,
}: {
  daily: AdminSchema['AdminDay'][];
  qualities: AdminSchema['AdminQuality'][];
}) {
  const [metric, setMetric] = useState<'jobs' | 'consumed'>('jobs');
  const max = Math.max(1, ...daily.map((d) => d[metric]));
  const sum = qualities.reduce((n, d) => n + d.jobs, 0);
  return (
    <div className="admin-chart-grid">
      <section className="admin-panel">
        <header>
          <div>
            <h2>每日用量</h2>
            <p>按 UTC 自然日统计，积分消费包含生成与对话。</p>
          </div>
          <div className="admin-segments">
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
          className="admin-chart"
          aria-label={metric === 'jobs' ? '每日生成任务量' : '每日积分消耗'}
        >
          <div className="admin-bars">
            {daily.map((d) => (
              <div
                className="admin-bar-column"
                key={d.day}
                tabIndex={0}
                title={`${d.day}：${integer(d[metric])} ${metric === 'jobs' ? '个任务' : '积分'}`}
                style={
                  {
                    '--bar-height': `${(d[metric] / max) * 100}%`,
                  } as CSSProperties
                }
              >
                <span className="admin-bar" />
                <span className="admin-bar-tooltip">
                  {d.day}
                  <br />
                  {integer(d[metric])}
                </span>
              </div>
            ))}
          </div>
          <figcaption>
            <span>{daily[0]?.day || '—'}</span>
            <span>{daily.at(-1)?.day || '—'}</span>
          </figcaption>
        </figure>
        {daily.every((d) => d[metric] === 0) && (
          <p className="admin-note">
            这个时段还没有{metric === 'jobs' ? '生成任务' : '积分消费'}。
          </p>
        )}
      </section>
      <section className="admin-panel">
        <header>
          <div>
            <h2>生成质量分布</h2>
            <p>按提交任务统计。</p>
          </div>
        </header>
        {qualities.length === 0 ? (
          <div className="admin-empty">暂无生成记录</div>
        ) : (
          <div className="admin-qualities">
            {qualities.map((q) => (
              <div className="admin-quality" key={q.quality}>
                <div>
                  <span>{qualityLabels[q.quality] || q.quality}</span>
                  <strong>
                    {integer(q.jobs)} <small>次</small>
                  </strong>
                </div>
                <progress max={sum || 1} value={q.jobs} />
                <small>{sum ? Math.round((q.jobs / sum) * 100) : 0}%</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
