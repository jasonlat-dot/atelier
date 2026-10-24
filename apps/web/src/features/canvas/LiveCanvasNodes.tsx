import { createContext, memo, useContext, useEffect, useRef } from 'react';
import {
  Handle,
  NodeResizer,
  NodeToolbar,
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
  Copy,
  Trash2,
  Pencil,
  Settings2,
  Info,
} from 'lucide-react';
import type { Asset } from '../assets/assetsApi';
import { active, statuses, type Job } from '../generation/generationApi';
import { nodeLabel } from './editorStore';
import CanvasToolButton from './CanvasToolButton';
import type { GraphNode } from './projectApi';
export type FlowNode = Node<{ node: GraphNode }, 'canvas'>;
export const CanvasActions = createContext<{
  assets: Map<string, Asset>;
  jobs: Map<string, Job>;
  readonly: boolean;
  busy: boolean;
  editing?: string;
  selectedCount: number;
  edit: (id?: string) => void;
  derive: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  configure: (id: string) => void;
  info: (id: string) => void;
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
  busy: false,
  selectedCount: 0,
  edit: () => {},
  derive: () => {},
  duplicate: () => {},
  remove: () => {},
  configure: () => {},
  info: () => {},
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
  const textInput = useRef<HTMLTextAreaElement>(null);
  const editing =
    actions.editing === node.id && !node.locked && !actions.readonly;
  useEffect(() => {
    if (editing) textInput.current?.focus({ preventScroll: true });
  }, [editing]);
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
      <NodeToolbar
        isVisible={selected && actions.selectedCount === 1 && !actions.readonly}
        position={Position.Top}
        offset={14}
      >
        <div
          className="live-node-toolbar nodrag nopan"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => actions.info(node.id)}>
            <Info size={14} />
            信息
          </button>
          {node.type === 'text' && (
            <button
              onClick={() => actions.edit(node.id)}
              data-tip="双击文字也可编辑"
            >
              <Pencil size={14} />
              编辑文字
            </button>
          )}
          {['text', 'image'].includes(node.type) && (
            <button onClick={() => actions.derive(node.id)}>
              <Sparkles size={14} />
              继续创作
            </button>
          )}
          {node.type === 'generate' && (
            <button onClick={() => actions.configure(node.id)}>
              <Settings2 size={14} />
              参数
            </button>
          )}
          {(node.type === 'image' || node.type === 'video') && (
            <button onClick={() => actions.preview(node.data.assetId)}>
              <Play size={14} />
              预览
            </button>
          )}
          <CanvasToolButton
            hint="复制节点 · Ctrl D"
            aria-label="复制此节点"
            onClick={() => actions.duplicate(node.id)}
          >
            <Copy size={14} />
          </CanvasToolButton>
          <CanvasToolButton
            hint="删除节点 · Delete"
            aria-label="删除此节点"
            disabled={node.locked}
            onClick={() => actions.remove(node.id)}
          >
            <Trash2 size={14} />
          </CanvasToolButton>
        </div>
      </NodeToolbar>
      <NodeResizer
        onResizeStart={actions.begin}
        onResizeEnd={actions.end}
        minWidth={180}
        minHeight={140}
        maxWidth={4096}
        maxHeight={4096}
        keepAspectRatio={node.type === 'image' || node.type === 'video'}
        isVisible={selected && !node.locked && !actions.readonly && !editing}
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
            <span className="graph-tag">
              {
                {
                  text: '文字',
                  image: '图片',
                  video: '视频',
                  generate: '生成',
                }[node.type]
              }
            </span>
          )}
        </div>
        {node.type === 'text' && (
          <textarea
            ref={textInput}
            className={`node-note ${editing ? 'nodrag nowheel editing' : 'text-preview'}`}
            aria-label="节点文字"
            maxLength={20000}
            value={node.data.text}
            readOnly={!editing}
            onBlur={() => {
              if (editing) actions.edit();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                actions.edit();
                event.currentTarget.blur();
              }
            }}
            onChange={(e) => actions.text(node.id, e.target.value)}
            placeholder="在这里写下提示词或灵感…"
          />
        )}
        {missing &&
          (asset?.thumbnail_url ? (
            <button
              className="live-node-media"
              aria-label={`预览${nodeLabel(node)}`}
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
            <p tabIndex={0} data-tip={node.data.prompt || ''}>
              {node.data.prompt || '连接文字与参考图，或打开参数填写描述'}
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
                  {(
                    { low: '低', medium: '中', high: '高' } as Record<
                      string,
                      string
                    >
                  )[node.data.quality] || node.data.quality}{' '}
                  · {node.data.ratio} · {node.data.resolution} · {node.data.n}{' '}
                  份
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
                disabled={node.locked || actions.busy}
                onClick={() =>
                  job && active(job)
                    ? actions.cancel(job.id)
                    : actions.run(node.id)
                }
              >
                {actions.busy && selected
                  ? '提交中…'
                  : job && active(job)
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
      {node.type !== 'text' && (
        <Handle
          tabIndex={0}
          className="node-port"
          type="target"
          aria-label="输入端口"
          data-port-label="输入"
          data-tip={
            node.type === 'generate'
              ? '输入：连接文字提示词或参考图'
              : '输入：连接生成结果'
          }
          position={Position.Left}
          isConnectable={!actions.readonly && !node.locked}
        />
      )}
      {node.type !== 'video' && (
        <Handle
          tabIndex={0}
          className="node-port"
          type="source"
          aria-label="输出端口"
          data-port-label={
            node.type === 'text'
              ? '提示词'
              : node.type === 'image'
                ? '参考图'
                : '结果'
          }
          data-tip={
            node.type === 'generate'
              ? '输出：生成结果'
              : node.type === 'text'
                ? '输出：提示词，拖到生成节点'
                : '输出：参考图，拖到生成节点'
          }
          position={Position.Right}
          isConnectable={!actions.readonly && !node.locked}
        />
      )}
    </>
  );
});
export const liveNodeTypes = { canvas: CanvasNodeView };
