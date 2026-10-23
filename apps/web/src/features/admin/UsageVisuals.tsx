import { useState, type CSSProperties } from 'react';
import { BarChart3 } from 'lucide-react';
import { integer, type AdminSchema } from './adminApi';

const qualities: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  standard: '标准',
  message: '文字',
};
export const qualityLabel = (quality: string) => qualities[quality] || quality;

function Distribution({
  rows,
  empty,
}: {
  rows: { key: string; label: string; count: number }[];
  empty: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!total) return <p className="usage-distribution-empty">{empty}</p>;
  return (
    <div className="usage-distribution">
      {rows.map((row) => (
        <div className="usage-distribution-item" key={row.key}>
          <div>
            <span>{row.label}</span>
            <span>{integer(row.count)} 次</span>
          </div>
          <progress
            max={total}
            value={row.count}
            aria-label={`${row.label}占比`}
          />
          <small>{Math.round((row.count / total) * 100)}%</small>
        </div>
      ))}
    </div>
  );
}

export default function UsageVisuals({
  daily,
  qualities,
  kinds,
  pending,
  unavailable,
}: {
  daily: AdminSchema['AdminDay'][];
  qualities: AdminSchema['AdminQuality'][];
  kinds?: AdminSchema['UsageKind'][];
  pending: boolean;
  unavailable: boolean;
}) {
  const [metric, setMetric] = useState<'jobs' | 'consumed'>('jobs');
  const max = Math.max(1, ...daily.map((day) => day[metric]));
  const empty = !daily.some((day) => day[metric] > 0);
  return (
    <div className="usage-charts">
      <section
        className="usage-card usage-daily"
        aria-labelledby="usage-daily-title"
      >
        <header className="usage-card-heading">
          <div>
            <h2 id="usage-daily-title">每日用量</h2>
            <p>按 UTC 自然日统计，积分消费包含生成与对话。</p>
          </div>
          <div className="usage-segments" role="group" aria-label="图表指标">
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
        {pending ? (
          <div className="usage-chart-loading" aria-hidden="true">
            {[25, 45, 30, 65, 40, 80, 55].map((height, i) => (
              <span
                className="usage-skeleton"
                key={i}
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        ) : (
          <figure
            className="usage-chart"
            aria-label={metric === 'jobs' ? '每日生成任务量' : '每日积分消耗'}
          >
            <div
              className={`usage-bars ${daily.length > 14 ? 'usage-bars-dense' : ''}`}
              style={
                { '--usage-days': Math.max(1, daily.length) } as CSSProperties
              }
            >
              {daily.map((day) => (
                <div
                  className="usage-bar-column"
                  key={day.day}
                  tabIndex={0}
                  aria-label={`${day.day}：${integer(day[metric])} ${metric === 'jobs' ? '个任务' : '积分'}`}
                  style={
                    {
                      '--usage-bar-height': `${(day[metric] / max) * 100}%`,
                    } as CSSProperties
                  }
                >
                  <span className="usage-bar">
                    <b>{day[metric] > 0 ? integer(day[metric]) : ''}</b>
                  </span>
                  <span className="usage-bar-tooltip">
                    {day.day}
                    <br />
                    {integer(day[metric])}{' '}
                    {metric === 'jobs' ? '个任务' : '积分'}
                  </span>
                </div>
              ))}
              {(empty || unavailable) && (
                <div className="usage-chart-empty">
                  <BarChart3 size={25} aria-hidden="true" />
                  <span>
                    {unavailable ? '数据暂未读取' : '所选时段暂无用量'}
                  </span>
                </div>
              )}
            </div>
            <figcaption>
              <span>{daily[0]?.day.slice(5) || '—'}</span>
              <span>{daily.at(-1)?.day.slice(5) || '—'}</span>
            </figcaption>
          </figure>
        )}
      </section>
      <section
        className="usage-card usage-distributions"
        aria-labelledby="usage-quality-title"
      >
        <header className="usage-card-heading">
          <div>
            <h2 id="usage-quality-title">生成质量分布</h2>
            <p>按提交任务统计。</p>
          </div>
        </header>
        {pending ? (
          <div className="usage-distribution-loading" aria-hidden="true">
            {[0, 1, 2].map((n) => (
              <div className="usage-skeleton" key={n} />
            ))}
          </div>
        ) : (
          <Distribution
            rows={qualities.map((row) => ({
              key: row.quality,
              label: qualityLabel(row.quality),
              count: row.jobs,
            }))}
            empty={unavailable ? '数据暂未读取' : '暂无生成记录'}
          />
        )}
        <h3>类型占比</h3>
        {pending ? (
          <div
            className="usage-skeleton usage-type-placeholder"
            aria-hidden="true"
          />
        ) : (
          <Distribution
            rows={(kinds ?? []).map((row) => ({
              key: row.kind,
              label:
                row.kind === 'image'
                  ? '图片'
                  : row.kind === 'video'
                    ? '视频'
                    : row.kind,
              count: row.jobs,
            }))}
            empty={
              unavailable
                ? '数据暂未读取'
                : kinds == null
                  ? '类型统计暂不可用'
                  : '暂无生成记录'
            }
          />
        )}
      </section>
    </div>
  );
}
