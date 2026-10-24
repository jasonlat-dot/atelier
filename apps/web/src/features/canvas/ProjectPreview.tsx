import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { projectApi, type ProjectInfo } from './projectApi';

export default function ProjectPreview({
  project,
  userId,
  compact = false,
}: {
  project: ProjectInfo;
  userId: string;
  compact?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const preview = useQuery({
    queryKey: ['project-preview', userId, project.id, project.revision],
    queryFn: async ({ signal }) =>
      (await projectApi.get(project.id, signal)).graph,
    enabled: visible,
    staleTime: 60000,
    gcTime: 60000,
    retry: false,
  });
  const nodes = preview.data?.nodes.slice(0, 60) || [];
  const left = Math.min(...nodes.map((node) => node.position.x)) - 40;
  const top = Math.min(...nodes.map((node) => node.position.y)) - 40;
  const right =
    Math.max(...nodes.map((node) => node.position.x + node.size.width)) + 40;
  const bottom =
    Math.max(...nodes.map((node) => node.position.y + node.size.height)) + 40;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (
    <>
      <div
        className="canvas-library-preview"
        ref={root}
        data-loading={!preview.data && !preview.isError}
      >
        {nodes.length > 0 ? (
          <>
            <svg
              viewBox={`${left} ${top} ${right - left} ${bottom - top}`}
              role="img"
              aria-label={`画布节点预览，共 ${preview.data!.nodes.length} 个节点`}
            >
              {preview.data?.edges.map((edge) => {
                const source = byId.get(edge.source),
                  target = byId.get(edge.target);
                return source && target ? (
                  <line
                    key={edge.id}
                    x1={source.position.x + source.size.width}
                    y1={source.position.y + source.size.height / 2}
                    x2={target.position.x}
                    y2={target.position.y + target.size.height / 2}
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null;
              })}
              {nodes.map((node) => (
                <rect
                  key={node.id}
                  className={`preview-node-${node.type}`}
                  x={node.position.x}
                  y={node.position.y}
                  width={node.size.width}
                  height={node.size.height}
                  rx={12}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {!compact && (
              <span className="canvas-library-node-count">
                {preview.data!.nodes.length} 个节点
                {preview.data!.nodes.length > 60 ? ' · 预览前 60 个' : ''}
              </span>
            )}
          </>
        ) : (
          <span className="canvas-library-preview-caption">
            {preview.isError
              ? '预览暂不可用'
              : preview.data
                ? '空画布'
                : '正在读取预览…'}
          </span>
        )}
      </div>
      {compact && (
        <div className="home-project-caption">
          <div>
            <strong tabIndex={0} data-tip={project.name}>
              {project.name}
            </strong>
            <small>
              <time
                dateTime={project.updated_at}
                tabIndex={0}
                data-tip={new Date(project.updated_at).toLocaleString('zh-CN')}
              >
                更新于{' '}
                {new Date(project.updated_at).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
              <span>
                {preview.data
                  ? `${preview.data.nodes.length} 个节点`
                  : preview.isError
                    ? '节点数未读取'
                    : '正在读取节点…'}
              </span>
            </small>
          </div>
          <span
            className="home-project-version"
            tabIndex={0}
            data-tip={`第 ${project.revision} 个保存版本`}
          >
            v{project.revision}
          </span>
        </div>
      )}
    </>
  );
}
