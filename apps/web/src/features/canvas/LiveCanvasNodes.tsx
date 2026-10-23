import { createContext, memo, useContext } from 'react';
import {
  Handle,
  NodeResizer,
  Position,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Image as ImageIcon,
  Film,
  Type,
  Sparkles,
  Lock,
  Play,
  Download,
  RefreshCw,
} from 'lucide-react';
import type { Asset } from '../assets/assetsApi';
import { active, statuses, type Job } from '../generation/generationApi';
import { nodeLabel } from './editorStore';
import type { GraphNode } from './projectApi';
export type FlowNode = Node<{ node: GraphNode }, 'canvas'>;
export const CanvasActions = createContext<{
  assets: Map<string, Asset>;
  jobs: Map<string, Job>;
  readonly: boolean;
  text: (id: string, text: string) => void;
  preview: (id: string) => void;
  run: (id: string) => void;
  cancel: (job: string) => void;
  refresh: (asset: string) => void;
  begin: () => void;
  end: () => void;
}>({
  assets: new Map(),
  jobs: new Map(),
  readonly: false,
  text: () => {},
  preview: () => {},
  run: () => {},
  cancel: () => {},
  refresh: () => {},
  begin: () => {},
  end: () => {},
});
const icons = { text: Type, image: ImageIcon, video: Film, generate: Sparkles };
const CanvasNodeView = memo(function CanvasNodeView({
  data,
  selected,
}: NodeProps<FlowNode>) {
  const { node } = data;
  const actions = useContext(CanvasActions),
    Icon = icons[node.type];
  const asset =
    node.type === 'image' || node.type === 'video'
      ? actions.assets.get(node.data.assetId)
      : undefined;
  const job =
    node.type === 'generate' && node.data.jobId
      ? actions.jobs.get(node.data.jobId)
      : undefined;
  const missing = node.type === 'image' || node.type === 'video';
  return (
    <>
      <NodeResizer
        onResizeStart={actions.begin}
        onResizeEnd={actions.end}
        minWidth={180}
        minHeight={140}
        maxWidth={4096}
        maxHeight={4096}
        isVisible={selected && !node.locked && !actions.readonly}
      />
      <div
        className={`graph-card live-node ${selected ? 'selected' : ''} ${job?.status === 'FAILED' ? 'failed' : ''}`}
      >
        <div className="graph-head">
          <span>
            <Icon size={14} />
            {nodeLabel(node)}
          </span>
          {node.locked ? (
            <Lock size={13} />
          ) : (
            <span className="graph-tag">{node.type.toUpperCase()}</span>
          )}
        </div>
        {node.type === 'text' && (
          <textarea
            className="node-note nodrag nowheel"
            aria-label="节点文字"
            maxLength={20000}
            value={node.data.text}
            readOnly={node.locked || actions.readonly}
            onChange={(e) => actions.text(node.id, e.target.value)}
            placeholder="在这里写下提示词或灵感…"
          />
        )}
        {missing &&
          (asset?.thumbnail_url ? (
            <button
              className="live-node-media nodrag"
              aria-label={`预览${nodeLabel(node)}`}
              onDoubleClick={() => actions.preview(asset.id)}
              onClick={() => {
                if (node.type === 'video') actions.preview(asset.id);
              }}
            >
              <img
                src={asset.thumbnail_url}
                alt={asset.name}
                loading="lazy"
                draggable={false}
                onError={() => actions.refresh(asset.id)}
              />
              {node.type === 'video' && (
                <span className="live-play">
                  <Play size={24} />
                </span>
              )}
            </button>
          ) : (
            <div className="live-node-missing">
              <ImageIcon size={25} />
              <span>
                {asset?.state === 'PROCESSING'
                  ? '视频处理中…'
                  : asset?.state === 'FAILED'
                    ? '素材处理失败，请替换'
                    : '素材已删除或过期'}
              </span>
            </div>
          ))}
        {node.type === 'generate' && (
          <div className="task-node-body">
            <div className="task-node-status">
              <Sparkles size={14} />
              {job ? statuses[job.status] : '准备生成'}
            </div>
            <p title={node.data.prompt || ''}>
              {node.data.prompt || '连接文字与参考图，或在左侧填写描述'}
            </p>
            <div className="config-summary">
              <span>
                模型
                <strong>
                  {job?.display_name || node.data.modelId || '请选择模型'}
                </strong>
              </span>
              <span>
                参数
                <strong>
                  {node.data.ratio} · {node.data.resolution} · {node.data.n} 份
                </strong>
              </span>
            </div>
            {job && (
              <>
                <div className="meter">
                  <i style={{ width: `${job.progress}%` }} />
                </div>
                <p>
                  {job.status === 'FAILED'
                    ? '本次未产出的积分已退回，可调整后重试。'
                    : `${job.progress}% · ${job.cost} 积分`}
                </p>
              </>
            )}
            {!actions.readonly && (
              <button
                className="btn btn-dark full nodrag"
                disabled={node.locked}
                onClick={() =>
                  job && active(job)
                    ? actions.cancel(job.id)
                    : actions.run(node.id)
                }
              >
                {job && active(job)
                  ? '取消任务'
                  : job?.status === 'FAILED'
                    ? '重试生成'
                    : '生成'}
              </button>
            )}
          </div>
        )}
        {asset && (
          <div className="node-footer">
            <span>
              {asset.width} × {asset.height}
              {asset.duration_ms
                ? ` · ${(asset.duration_ms / 1000).toFixed(1)}s`
                : ''}
            </span>
            <button
              className="icon-btn nodrag"
              aria-label="预览素材"
              onClick={() => actions.preview(asset.id)}
            >
              <Play size={13} />
            </button>
            {asset.media_url && (
              <a
                className="icon-btn nodrag"
                href={asset.media_url}
                download={asset.name}
                aria-label="下载素材"
              >
                <Download size={13} />
              </a>
            )}
            <button
              className="icon-btn nodrag"
              aria-label="刷新素材"
              onClick={() => actions.refresh(asset.id)}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        )}
      </div>
      <Handle
        className="node-port"
        type="target"
        position={Position.Left}
        isConnectable={!actions.readonly && !node.locked}
      />
      <Handle
        className="node-port"
        type="source"
        position={Position.Right}
        isConnectable={!actions.readonly && !node.locked}
      />
    </>
  );
});
export const liveNodeTypes = { canvas: CanvasNodeView };
