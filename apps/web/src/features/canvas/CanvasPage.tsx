import Feedback from '../../components/Feedback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Connection, Edge, Viewport } from '@xyflow/react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clapperboard,
  Download,
  FilePlus2,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Plus,
  SquarePen,
  Trash2,
  Upload,
  Video,
} from 'lucide-react';
import type { Asset, CanvasNode, MediaKind, Project } from '../../lib/types';
import { useDemoDB } from '../../lib/store';
import * as mock from '../../lib/mockDb';
import * as api from '../../lib/api';
import { nodeTypes, SecureNote } from './CanvasNodes';
const uid = () => crypto.randomUUID();
const A = (node: CanvasNode) => ({ ...node, data: { ...node.data } });
const initialNode = (
  type: CanvasNode['type'],
  pos: { x: number; y: number },
  data: CanvasNode['data'],
): CanvasNode => ({
  id: uid(),
  type,
  position: pos,
  data,
  style: { width: type === 'video' ? 300 : type === 'image' ? 275 : 260 },
});
const Button = ({
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) => (
  <button
    disabled={disabled}
    onClick={onClick}
    className={`tool-button ${active ? 'active' : ''}`}
  >
    {children}
  </button>
);
export default function CanvasPage({
  projectId,
  onSelectProject,
}: {
  projectId?: string;
  onSelectProject: (id: string) => void;
}) {
  const db = useDemoDB();
  const projects = db.projects.filter((p) => p.ownerId === db.currentUserId);
  const selected = projects.find((p) => p.id === projectId) || projects[0];
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!selected) {
      void api
        .createProject('我的第一个画布')
        .then((p) => onSelectProject(p.id));
    }
  }, [selected, onSelectProject]);
  if (!selected)
    return (
      <main className="page centered">
        <LoaderCircle className="spin" /> 正在创建画布…
      </main>
    );
  return (
    <ReactFlowProvider key={selected.id}>
      <CanvasEditor
        project={selected}
        onSelectProject={onSelectProject}
        refresh={refresh}
        onRefresh={() => setRefresh((x) => x + 1)}
      />
    </ReactFlowProvider>
  );
}
function CanvasEditor({
  project,
  onSelectProject: _onSelectProject,
}: {
  project: Project;
  onSelectProject: (id: string) => void;
  refresh: number;
  onRefresh: () => void;
}) {
  const db = useDemoDB();
  const user = db.users.find((u) => u.id === db.currentUserId)!;
  const assets = db.assets.filter((a) => a.ownerId === user.id);
  const jobs = db.jobs.filter(
    (j) => j.ownerId === user.id && j.projectId === project.id,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(
    project.graph.nodes.map(A),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    project.graph.edges,
  );
  const [viewport, setViewport] = useState<Viewport>(project.graph.viewport);
  const revision = useRef(project.revision);
  const flow = useReactFlow<CanvasNode, Edge>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kind, setKind] = useState<MediaKind>('image');
  const [quality, setQuality] = useState('medium');
  const [ratio, setRatio] = useState('16:9');
  const [duration, setDuration] = useState(6);
  const [count, setCount] = useState(1);
  const [prompt, setPrompt] = useState(
    '黄昏时分的海边公路，电影感构图，柔和自然光',
  );
  const [reference, setReference] = useState('none');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [leftTab, setLeftTab] = useState<'generate' | 'layers'>('generate');
  const [history, setHistory] = useState<
    { nodes: CanvasNode[]; edges: Edge[] }[]
  >([]);
  const [future, setFuture] = useState<
    { nodes: CanvasNode[]; edges: Edge[] }[]
  >([]);
  const mounted = useRef(false);
  const initializedProject = useRef(project.id);
  const pendingSave = useRef<import('../../lib/types').CanvasGraph | null>(
    null,
  );
  const saveInFlight = useRef(false);
  const activeNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.type !== 'task') return n;
        const j = jobs.find((j) => j.nodeId === n.id);
        return j
          ? {
              ...n,
              data: { ...n.data, status: j.status, progress: j.progress },
            }
          : n;
      }),
    [nodes, jobs],
  );
  const selected = nodes.find((n) => n.id === selectedId);
  const imageCount = nodes.filter((n) => n.type === 'image').length;
  const videoCount = nodes.filter((n) => n.type === 'video').length;
  const remember = useCallback(() => {
    setHistory((h) => [
      ...h.slice(-29),
      { nodes: nodes.map(A), edges: [...edges] },
    ]);
    setFuture([]);
  }, [nodes, edges]);
  const addNode = useCallback(
    (type: CanvasNode['type'], data: CanvasNode['data']) => {
      remember();
      const center = flow.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      const n = initialNode(
        type,
        {
          x: center.x - 110 + Math.random() * 40,
          y: center.y - 90 + Math.random() * 40,
        },
        data,
      );
      setNodes((ns) => [...ns, n]);
      setSelectedId(n.id);
      return n.id;
    },
    [flow, remember, setNodes],
  );
  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source === connection.target) return;
      remember();
      setEdges((es) => addEdge({ ...connection, type: 'smoothstep' }, es));
    },
    [remember, setEdges],
  );
  useEffect(() => {
    if (initializedProject.current !== project.id) {
      initializedProject.current = project.id;
      revision.current = project.revision;
      setNodes(project.graph.nodes.map(A));
      setEdges(project.graph.edges);
      setViewport(project.graph.viewport);
      mounted.current = false;
    }
  }, [project.id, project.graph, project.revision, setEdges, setNodes]);
  const flushSaves = useCallback(async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    while (pendingSave.current) {
      const graph = pendingSave.current;
      pendingSave.current = null;
      setSaving('saving');
      try {
        const saved = await api.saveGraph(project.id, graph, revision.current);
        revision.current = saved.revision;
      } catch (e) {
        setSaving('error');
        setMessage(`保存失败：${String((e as Error).message || e)}`);
        pendingSave.current = null;
        saveInFlight.current = false;
        return;
      }
    }
    saveInFlight.current = false;
    setSaving('saved');
  }, [project.id]);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setSaving('saving');
    const t = setTimeout(() => {
      pendingSave.current = { nodes, edges, viewport };
      void flushSaves();
    }, 850);
    return () => clearTimeout(t);
  }, [nodes, edges, viewport, flushSaves]);
  useEffect(() => {
    if (api.BACKEND_MODE) return;
    const t = setInterval(() => mock.advanceJobs(), 700);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const complete = jobs.filter(
      (j) =>
        j.status === 'completed' &&
        !nodes.some((n) => n.id === `result-${j.id}`),
    );
    if (!complete.length) return;
    setNodes((old) => [
      ...old,
      ...complete.map((j, i) => {
        const asset = db.assets.find((a) => a.id === j.resultAssetIds[0]);
        return {
          id: `result-${j.id}`,
          type: j.kind,
          position: { x: 870 + i * 330, y: 300 + i * 30 },
          style: { width: j.kind === 'video' ? 300 : 270 },
          data: {
            title: asset?.name || '生成完成',
            assetId: asset?.id,
            src: asset?.src,
            poster: asset?.poster,
          },
        } as CanvasNode;
      }),
    ]);
    setEdges((old) => [
      ...old,
      ...complete.map((j) => ({
        id: `edge-result-${j.id}`,
        source: j.nodeId,
        target: `result-${j.id}`,
        type: 'smoothstep',
      })),
    ]);
  }, [jobs, db.assets, nodes, setNodes, setEdges]);
  const saveExport = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { name: project.name, graph: { nodes, edges, viewport } },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atelier-${project.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setFuture((f) => [...f, { nodes, edges }]);
    setHistory((h) => h.slice(0, -1));
    setNodes(prev.nodes);
    setEdges(prev.edges);
  };
  const redo = () => {
    if (!future.length) return;
    const next = future[future.length - 1];
    setHistory((h) => [...h, { nodes, edges }]);
    setFuture((f) => f.slice(0, -1));
    setNodes(next.nodes);
    setEdges(next.edges);
  };
  const remove = () => {
    if (!selectedId) return;
    remember();
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) =>
      es.filter((e) => e.source !== selectedId && e.target !== selectedId),
    );
    setSelectedId(null);
  };
  const cost = mock.quote(kind, quality, count, duration);
  const startGeneration = async () => {
    if (!prompt.trim()) {
      setMessage('请先填写生成描述');
      return;
    }
    if (user.credits < cost) {
      setMessage('积分不足，请到积分中心充值');
      return;
    }
    try {
      const chosenRef = assets.find((a) => a.id === reference);
      const nodeId = addNode('task', {
        title: kind === 'video' ? '视频生成任务' : '图片生成任务',
        kind,
        prompt,
        status: 'queued',
        progress: 0,
        referenceAssetIds: chosenRef ? [chosenRef.id] : [],
      });
      if (chosenRef) {
        const source = nodes.find((n) => n.data.assetId === chosenRef.id);
        if (source)
          setEdges((es) => [
            ...es,
            {
              id: uid(),
              source: source.id,
              target: nodeId,
              type: 'smoothstep',
            },
          ]);
      }
      const key = uid();
      const model = db.models.find((m) => m.kind === kind && m.enabled)?.id;
      if (!model) throw Error('没有可用的模型');
      await api.createJob(
        {
          projectId: project.id,
          nodeId,
          kind,
          prompt,
          quality,
          ratio,
          model,
          duration,
          count,
          referenceAssetIds: chosenRef ? [chosenRef.id] : [],
        },
        key,
      );
      setMessage(`任务已提交 · 预占 ${cost} 积分`);
    } catch (e) {
      setMessage(`无法提交：${String((e as Error).message || e)}`);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files) return;
    if (api.BACKEND_MODE) {
      setMessage('HTTP 模式的文件上传将在接入 S3 预签名上传接口后开放。');
      return;
    }
    for (const file of Array.from(files)) {
      const fileKind = file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('image/')
          ? 'image'
          : null;
      if (!fileKind) continue;
      if (file.size > 20 * 1024 * 1024) {
        setMessage('演示版仅支持 20MB 以下文件；正式版使用分片直传对象存储。');
        continue;
      }
      const src = URL.createObjectURL(file);
      const asset = mock.addAsset(fileKind, file.name, src);
      addNode(fileKind, {
        title: file.name,
        src: asset.src,
        poster: asset.poster,
        assetId: asset.id,
      });
    }
    setMessage(
      '已导入画布。演示版 Blob URL 刷新可能失效，正式版将持久化到 S3。',
    );
  };
  const insertAsset = (asset: Asset) =>
    addNode(asset.kind, {
      title: asset.name,
      src: asset.src,
      poster: asset.poster,
      assetId: asset.id,
    });
  const shortcuts = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      remove();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  };
  return (
    <div className="canvas-shell" onKeyDown={shortcuts} tabIndex={0}>
      <section className="canvas-tool-panel">
        <div className="panel-overline">创作工具</div>
        <div className="segmented">
          <button
            className={leftTab === 'generate' ? 'on' : ''}
            onClick={() => setLeftTab('generate')}
          >
            生成工具
          </button>
          <button
            className={leftTab === 'layers' ? 'on' : ''}
            onClick={() => setLeftTab('layers')}
          >
            图层管理
          </button>
        </div>
        {leftTab === 'generate' ? (
          <div className="panel-scroll">
            <div className="field-label">创作类型</div>
            <div className="media-switch">
              <button
                className={kind === 'image' ? 'on' : ''}
                onClick={() => {
                  setKind('image');
                  setQuality('medium');
                }}
              >
                <ImageIcon size={16} /> 图像
              </button>
              <button
                className={kind === 'video' ? 'on' : ''}
                onClick={() => {
                  setKind('video');
                  setQuality('720p');
                }}
              >
                <Clapperboard size={16} /> 视频
              </button>
            </div>
            <label className="field-label" htmlFor="prompt">
              创意描述
            </label>
            <textarea
              id="prompt"
              className="textarea prompt-field"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder="描述要生成的画面、镜头和风格…"
            />
            <label className="field-label" htmlFor="quality">
              画质与分辨率
            </label>
            <select
              id="quality"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              className="select"
            >
              {(kind === 'image'
                ? ['low', 'medium', 'high']
                : ['480p', '720p', '1080p']
              ).map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <label className="field-label" htmlFor="ratio">
              画幅比例
            </label>
            <div className="ratio-options">
              {['16:9', '9:16', '1:1', '4:3'].map((r) => (
                <button
                  key={r}
                  className={ratio === r ? 'on' : ''}
                  onClick={() => setRatio(r)}
                >
                  {r}
                </button>
              ))}
            </div>
            {kind === 'video' ? (
              <>
                <label className="field-label" htmlFor="duration">
                  视频时长
                </label>
                <select
                  id="duration"
                  className="select"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                >
                  {[4, 6, 8, 10, 12, 16].map((v) => (
                    <option value={v} key={v}>
                      {v} 秒
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="count">
                  生成数量
                </label>
                <select
                  id="count"
                  className="select"
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                >
                  {[1, 2, 3, 4].map((v) => (
                    <option value={v} key={v}>
                      {v} 张
                    </option>
                  ))}
                </select>
              </>
            )}
            <label className="field-label" htmlFor="reference">
              参考素材
            </label>
            <select
              id="reference"
              className="select"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            >
              <option value="none">不使用参考素材</option>
              {assets.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.kind === 'video' ? '🎬' : '▧'} {a.name}
                </option>
              ))}
            </select>
            <div className="subtle-hint">
              选择画布素材后，正式版将以资产 ID 作为参考。视频支持首帧 /
              尾帧输入。
            </div>
            <SecureNote />
            <div className="generation-summary">
              <span>本次预计消耗</span>
              <strong>
                {cost} <small>积分</small>
              </strong>
            </div>
            <button
              className="btn btn-dark full"
              onClick={() => void startGeneration()}
            >
              <ArrowRight size={15} /> 开始
              {kind === 'video' ? '生成视频' : '生成图片'}
            </button>
            <div className="section-divider" />
            <h4>添加节点</h4>
            <div className="add-tiles">
              <button
                onClick={() =>
                  addNode('text', {
                    title: '创意便签',
                    text: '在这里输入你的灵感…',
                  })
                }
              >
                <SquarePen size={17} /> 文字说明
              </button>
              <button
                onClick={() =>
                  addNode('config', {
                    title: '生成配置',
                    kind,
                    quality,
                    ratio,
                    duration,
                    model: db.models.find((m) => m.kind === kind)?.id,
                  })
                }
              >
                <LayoutGrid size={17} /> 生成配置
              </button>
              <button onClick={() => fileInput.current?.click()}>
                <Upload size={17} /> 上传媒体
              </button>
              <button
                onClick={() =>
                  addNode('image', {
                    title: '示例图片',
                    src: '/assets/art-bloom.svg',
                  })
                }
              >
                <ImageIcon size={17} /> 示例图片
              </button>
            </div>
          </div>
        ) : (
          <div className="panel-scroll layer-list">
            {nodes.map((n) => (
              <button
                key={n.id}
                className={selectedId === n.id ? 'selected' : ''}
                onClick={() => {
                  setSelectedId(n.id);
                  flow.setCenter(n.position.x + 140, n.position.y + 100, {
                    zoom: 1,
                    duration: 320,
                  });
                }}
              >
                {n.type === 'video' ? (
                  <Video size={15} />
                ) : n.type === 'image' ? (
                  <ImageIcon size={15} />
                ) : (
                  <SquarePen size={15} />
                )}
                <span>{String(n.data.title || n.type)}</span>
                <small>{n.type}</small>
              </button>
            ))}
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept="image/*,video/*"
          onChange={(e) => {
            void upload(e.target.files);
            e.currentTarget.value = '';
          }}
        />
      </section>
      <div className="canvas-main">
        <div className="canvas-head">
          <div className="canvas-breadcrumb">
            <span className="crumb-muted">无限画布</span>
            <span className="slash">/</span>
            <button
              onClick={() => {
                if (api.BACKEND_MODE) {
                  setMessage('服务器端重命名接口尚未接入。');
                  return;
                }
                const p = window.prompt('画布项目名称', project.name);
                if (p) mock.renameProject(project.id, p);
              }}
            >
              {project.name}
              <ChevronDown size={14} />
            </button>
          </div>
          <div className="canvas-head-actions">
            <span className="save-status">
              {saving === 'saving' ? (
                <LoaderCircle size={13} className="spin" />
              ) : saving === 'saved' ? (
                <Check size={13} />
              ) : (
                <span>!</span>
              )}
              {saving === 'saved'
                ? '已自动保存'
                : saving === 'saving'
                  ? '保存中…'
                  : '保存失败'}
            </span>
            <Button onClick={saveExport}>
              <Download size={14} /> 导出 JSON
            </Button>
            <Button
              onClick={() => flow.fitView({ padding: 0.2, duration: 300 })}
            >
              <Maximize2 size={14} /> 适配画布
            </Button>
          </div>
        </div>
        <div className="react-canvas-wrap">
          <ReactFlow
            nodes={activeNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={() => remember()}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            defaultViewport={viewport}
            onMoveEnd={(_, v) => setViewport(v)}
            minZoom={0.14}
            maxZoom={2.3}
            fitViewOptions={{ padding: 0.15 }}
            snapToGrid
            snapGrid={[10, 10]}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            connectionLineStyle={{ stroke: '#8491a0', strokeWidth: 1.7 }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: '#a3acb8', strokeWidth: 1.7 },
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#d8dbdf"
            />
            <MiniMap
              pannable
              zoomable
              nodeColor="#c8ced4"
              maskColor="rgba(251,251,250,.78)"
            />
            <Controls showInteractive={false} />
            <Panel position="top-left" className="floating-tools">
              <Button
                onClick={() =>
                  addNode('text', { title: '新便签', text: '新想法…' })
                }
              >
                <Plus size={15} /> 新建节点
              </Button>
              <span className="separator" />
              <Button onClick={undo} disabled={!history.length}>
                ↶ 撤销
              </Button>
              <Button onClick={redo} disabled={!future.length}>
                ↷ 重做
              </Button>
              <span className="separator" />
              <Button onClick={remove} disabled={!selectedId}>
                <Trash2 size={14} />
              </Button>
            </Panel>
            <Panel position="bottom-center" className="canvas-bottom-hint">
              <MousePointer2 size={13} /> 拖动节点 · 滚轮缩放 · 拖动空白平移 ·
              从端点连接节点
            </Panel>
          </ReactFlow>
        </div>
      </div>
      <aside className="canvas-inspector">
        <div className="inspector-heading">
          属性与任务 <span className="soft-pill">LIVE MOCK</span>
        </div>
        {selected ? (
          <div className="inspector-section">
            <div className="overline">当前选择</div>
            <strong className="selected-title">
              {String(selected.data.title || '未命名节点')}
            </strong>
            <p className="subtle-hint">
              类型：{selected.type} · 节点 ID：{selected.id.slice(0, 8)}
            </p>
            <label className="field-label">节点名称</label>
            <input
              className="input"
              value={String(selected.data.title || '')}
              onChange={(e) =>
                setNodes((ns) =>
                  ns.map((n) =>
                    n.id === selected.id
                      ? { ...n, data: { ...n.data, title: e.target.value } }
                      : n,
                  ),
                )
              }
            />
            <div className="inspector-actions">
              <button
                className="btn btn-light"
                onClick={() => {
                  remember();
                  setNodes((ns) => [
                    ...ns,
                    {
                      ...selected,
                      id: uid(),
                      position: {
                        x: selected.position.x + 45,
                        y: selected.position.y + 45,
                      },
                    },
                  ]);
                }}
              >
                <FilePlus2 size={14} /> 复制
              </button>
              <button className="btn btn-light" onClick={remove}>
                <Trash2 size={14} /> 删除
              </button>
            </div>
          </div>
        ) : (
          <div className="inspector-empty">
            <LayoutGrid size={21} />
            <strong>选择一个画布节点</strong>
            <p>可查看信息、修改名称或进行下一步创作。</p>
          </div>
        )}
        <div className="inspector-section">
          <div className="section-title">画布概况</div>
          <div className="stat-grid">
            <div>
              <span>节点</span>
              <strong>{nodes.length}</strong>
            </div>
            <div>
              <span>连线</span>
              <strong>{edges.length}</strong>
            </div>
            <div>
              <span>图片</span>
              <strong>{imageCount}</strong>
            </div>
            <div>
              <span>视频</span>
              <strong>{videoCount}</strong>
            </div>
          </div>
        </div>
        <div className="inspector-section">
          <div className="section-title">
            任务进度 <span className="counter">{jobs.length}</span>
          </div>
          {jobs.length === 0 ? (
            <p className="empty-caption">
              提交图像或视频任务后在这里查看进度。
            </p>
          ) : (
            <div className="task-list">
              {jobs.slice(0, 5).map((j) => (
                <div key={j.id} className="task-row">
                  <div className="task-row-top">
                    <span>
                      {j.kind === 'video' ? (
                        <Film size={14} />
                      ) : (
                        <ImageIcon size={14} />
                      )}{' '}
                      {j.kind === 'video' ? '视频' : '图片'}生成
                    </span>
                    <small>
                      {j.status === 'completed'
                        ? '已完成'
                        : j.status === 'cancelled'
                          ? '已取消'
                          : `${j.progress}%`}
                    </small>
                  </div>
                  <p>{j.prompt}</p>
                  <div className="meter">
                    <i style={{ width: `${j.progress}%` }} />
                  </div>
                  {!['completed', 'cancelled', 'failed'].includes(j.status) && (
                    <button
                      className="text-action"
                      onClick={() => void api.cancelJob(j.id)}
                    >
                      取消任务并返还积分
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="inspector-section">
          <div className="section-title">
            可用素材 <span className="counter">{assets.length}</span>
          </div>
          <div className="inspector-assets">
            {assets.slice(0, 5).map((a) => (
              <button
                key={a.id}
                title={`添加到画布：${a.name}`}
                onClick={() => insertAsset(a)}
              >
                {a.kind === 'video' ? (
                  <img
                    src={a.poster || '/assets/video-frame.png'}
                    alt={a.name}
                  />
                ) : (
                  <img src={a.src} alt={a.name} />
                )}
                <span>{a.name}</span>
                <Plus size={14} />
              </button>
            ))}
          </div>
        </div>
        {message && (
          <Feedback
            onDismiss={() => setMessage('')}
            variant={message.startsWith('任务已提交') ? 'success' : 'info'}
            className="toast-message"
            onClick={() => setMessage('')}
          >
            {message}
          </Feedback>
        )}
      </aside>
    </div>
  );
}
