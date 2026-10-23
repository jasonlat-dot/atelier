import Feedback from '../../components/Feedback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useBlocker,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MarkerType,
  SelectionMode,
  useViewport,
  MiniMap,
  Panel,
  useReactFlow,
  type Connection,
  type NodeChange,
} from '@xyflow/react';
import {
  Check,
  Copy,
  Download,
  Hand,
  History,
  Image as ImageIcon,
  Layers,
  Lock,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  HelpCircle,
  Minus,
} from 'lucide-react';
import { SessionError } from '../auth/sessionApi';
import { assetsApi, type Asset } from '../assets/assetsApi';
import AssetDialog from '../assets/AssetDialog';
import ReferencePicker from '../generation/ReferencePicker';
import {
  active,
  failures,
  generationApi,
  statuses,
  type Draft,
  type Job,
  type Schema,
} from '../generation/generationApi';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import {
  createEditorStore,
  connect,
  connectionIssue,
  nodeLabel,
  pasteNodes,
} from './editorStore';
import {
  projectApi,
  type Graph,
  type GraphNode,
  type Project,
  type GenerateData,
} from './projectApi';
import { ProjectSaver, type SaveStatus } from './projectSaver';
import { CanvasActions, liveNodeTypes, type FlowNode } from './LiveCanvasNodes';
import CanvasCreator, { blankGenerator } from './CanvasCreator';
import CanvasToolButton from './CanvasToolButton';
import CanvasContextMenu, { type CanvasMenu } from './CanvasContextMenu';
import { projectJobs, reconcileJobs } from './canvasJobs';
import type { CanvasProps } from './LiveCanvasPage';
const statusText: Record<SaveStatus, string> = {
  saved: '已保存',
  dirty: '未保存',
  saving: '保存中…',
  error: '保存失败',
  conflict: '版本冲突',
};
const editableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (!!target.closest('input,textarea,select,[contenteditable=true]') ||
    !!target.closest('dialog,[role=dialog],[role=menu]'));
export default function LiveCanvasEditor({
  initial,
  me,
  onExpired,
  onReload,
}: CanvasProps & { initial: Project }) {
  const navigate = useNavigate(),
    queries = useQueryClient(),
    flow = useReactFlow<FlowNode>();
  const [search] = useSearchParams();
  const draftRead = useRef(false);
  const [store] = useState(() => createEditorStore(initial.graph));
  const graph = useStore(store, (s) => s.graph),
    selected = useStore(store, (s) => s.selected),
    sequence = useStore(store, (s) => s.sequence);
  const past = useStore(store, (s) => s.past.length),
    future = useStore(store, (s) => s.future.length);
  const [info, setInfo] = useState(initial.project),
    [assets, setAssets] = useState(
      () => new Map(initial.assets.map((a) => [a.id, a])),
    );
  const [status, setStatus] = useState<SaveStatus>('saved'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [readonly, setReadonly] = useState(window.innerWidth < 1024),
    [pan, setPan] = useState(true),
    [space, setSpace] = useState(false);
  const [tab, setTab] = useState<'properties' | 'layers' | 'tasks'>(
      'properties',
    ),
    [inspector, setInspector] = useState(false);
  const viewport = useViewport();
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [layerSearch, setLayerSearch] = useState('');
  const [edgeSelection, setEdgeSelection] = useState<string[]>([]);
  const [menu, setMenu] = useState<CanvasMenu>();
  const connectStart = useRef<{ x: number; y: number }>();
  const [surfaceSize, setSurfaceSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const surface = canvasSurface.current;
    if (!surface) return;
    const observer = new ResizeObserver(() =>
      setSurfaceSize({
        width: surface.clientWidth,
        height: surface.clientHeight,
      }),
    );
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  const canvasSurface = useRef<HTMLDivElement>(null);
  const [quick, setQuick] = useState<GenerateData>(blankGenerator),
    [quickRefs, setQuickRefs] = useState<Asset[]>([]);
  useEffect(() => {
    if (draftRead.current) return;
    draftRead.current = true;
    const raw = search.get('draft');
    if (!raw) return;
    try {
      setCreatorOpen(true);
      if (raw.length > 16000) throw new Error();
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.prompt !== 'string' || data.prompt.length > 4000)
        throw new Error();
      const choose = (key: string, fallback: string) =>
        typeof data[key] === 'string' && (data[key] as string).length <= 20
          ? (data[key] as string)
          : fallback;
      setQuick({
        ...blankGenerator(),
        prompt: data.prompt,
        quality: choose('quality', 'low'),
        ratio: choose('ratio', '1:1'),
        resolution: choose('resolution', '1K'),
        n:
          typeof data.n === 'number' &&
          Number.isInteger(data.n) &&
          data.n >= 1 &&
          data.n <= 4
            ? data.n
            : 1,
      });
      setNotice('已填入对话草稿，请核对参数后点击生成。');
    } catch {
      setError('对话草稿格式无效，请重新输入描述。');
    }
  }, [search]);
  const [busy, setBusy] = useState(false),
    [picker, setPicker] = useState(false),
    [preview, setPreview] = useState<Asset>();
  const [history, setHistory] = useState<Schema['ProjectSnapshot'][]>(),
    [rename, setRename] = useState<string>(),
    [exitFailed, setExitFailed] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    replacement = useRef<string>(),
    root = useRef<HTMLDivElement>(null),
    clipboard = useRef<{ nodes: GraphNode[]; edges: Graph['edges'] }>();
  const running = useRef(false),
    pending = useRef(new Map<string, { key: string; body: Draft }>()),
    saverRef = useRef<ProjectSaver>();
  const errorText = useCallback(
    (e: unknown) => {
      if (e instanceof SessionError) {
        if (e.status === 401 || e.code === 'ACCOUNT_DISABLED') onExpired();
        if (e.code === 'MFA_REQUIRED') onReload();
        if (e.code === 'PROJECT_QUOTA_EXCEEDED')
          return '画布数量已达上限，请先删除不需要的项目。';
        if (e.code === 'TOO_MANY_ACTIVE_JOBS')
          return '已有任务正在进行，请等待完成或取消后重试。';
        if (e.status === 402) return '可用积分不足，请前往积分页面查看。';
        if (e.status === 409)
          return '画布已在其他页面更新，请重新加载或另存副本。';
        if (e.status === 404) return '项目、任务或素材已删除、过期或不可访问。';
        if (e.status === 422)
          return '当前节点、连线或模型参数无效，请检查后重试。';
        if (e.status === 429) return '操作过于频繁，请稍后重试。';
        if (failures[e.code]) return failures[e.code];
        return '操作未完成，请检查连接后重试。';
      }
      return e instanceof Error ? e.message : '操作未完成，请重试。';
    },
    [onExpired, onReload],
  );
  const mergeAssets = useCallback(
    (items: Asset[]) =>
      setAssets(
        (old) =>
          new Map([...old, ...items.map((a): [string, Asset] => [a.id, a])]),
      ),
    [],
  );
  const received = useCallback(
    (project: Project) => {
      setInfo(project.project);
      mergeAssets(project.assets);
    },
    [mergeAssets],
  );
  useEffect(() => {
    const saver = new ProjectSaver(
      initial.project.id,
      me.csrf_token,
      store,
      (status, e) => {
        setStatus(status);
        if (e) setError(errorText(e));
      },
      received,
    );
    saver.initialize(initial.project.revision);
    saverRef.current = saver;
    return () => {
      saver.close();
      if (saverRef.current === saver) saverRef.current = undefined;
    };
  }, [
    initial.project.id,
    initial.project.revision,
    me.csrf_token,
    store,
    received,
    errorText,
  ]);
  useEffect(() => {
    const saver = saverRef.current;
    if (!saver?.dirty()) return;
    setStatus((s) => (s === 'conflict' || s === 'error' ? s : 'dirty'));
    const timer = setTimeout(() => {
      if (store.getState().checkpoint) return;
      if (status !== 'conflict' && status !== 'error')
        void saver.flush().catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [sequence, status]);
  useEffect(() => {
    const resize = () => setReadonly(window.innerWidth < 1024);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (saverRef.current?.dirty()) {
        e.preventDefault();
      }
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden')
        void saverRef.current?.flush().catch(() => {});
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  const blocker = useBlocker(
    () => !!saverRef.current?.dirty() || running.current,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (running.current) {
      setExitFailed(true);
      return;
    }
    let live = true;
    void saverRef.current
      ?.flush()
      .then(() => {
        if (live) blocker.proceed();
      })
      .catch(() => {
        if (live) setExitFailed(true);
      });
    return () => {
      live = false;
    };
  }, [blocker]);
  const safeChange = useCallback(
    (fn: (g: Graph) => Graph, history = true) => {
      if (readonly) return;
      try {
        store.getState().change(fn, history);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [readonly, store, errorText],
  );
  const action = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError('');
      try {
        await fn();
      } catch (e) {
        setError(errorText(e));
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [errorText],
  );
  const jobsQuery = useQuery({
    queryKey: ['canvas-jobs', me.user.id, info.id],
    queryFn: ({ signal }) =>
      projectJobs(info.id, store.getState().graph, signal),
    refetchInterval: 5000,
  });
  const projectList = useQuery({
    queryKey: ['projects', me.user.id, undefined],
    queryFn: ({ signal }) => projectApi.list(undefined, signal),
    staleTime: 30000,
  });
  const jobs = jobsQuery.data || [],
    jobMap = useMemo(
      () => new Map(jobs.map((j) => [j.id, j])),
      [jobsQuery.data],
    );
  const updateWallet = useWalletSummaryUpdate();
  useEffect(() => {
    if (!jobsQuery.data) return;
    mergeAssets(jobsQuery.data.flatMap((j) => j.outputs.map((o) => o.asset)));
    if (!readonly) safeChange((g) => reconcileJobs(g, jobsQuery.data!), false);
    void walletApi
      .summary()
      .then(updateWallet)
      .catch(() => {});
  }, [jobsQuery.data, mergeAssets, safeChange, readonly, updateWallet]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new EventSource('/api/v1/events');
    const refresh = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void queries.invalidateQueries({
            queryKey: ['canvas-jobs', me.user.id, info.id],
          });
        }, 200);
    };
    stream.addEventListener('job.updated', refresh);
    stream.onopen = refresh;
    return () => {
      stream.close();
      clearTimeout(timer);
    };
  }, [info.id, me.user.id, queries]);
  useEffect(() => {
    const refresh = () =>
      void projectApi
        .get(info.id)
        .then((p) => mergeAssets(p.assets))
        .catch(() => {});
    const timer = setInterval(
      refresh,
      [...assets.values()].some((a) => a.state === 'PROCESSING')
        ? 3000
        : 120000,
    );
    return () => clearInterval(timer);
  }, [info.id, assets, mergeAssets]);
  const refreshAsset = useCallback(
    (id: string) => {
      void assetsApi
        .get(id)
        .then((a) => mergeAssets([a]))
        .catch((e) => setError(errorText(e)));
    },
    [mergeAssets, errorText],
  );
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest('[role=menu]'))
        setMenu(undefined);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  const selectedNode = graph.nodes.find((n) => n.id === selected[0]);
  const generator =
    selectedNode?.type === 'generate' ? selectedNode : undefined;
  const generatorData = generator?.data || quick;
  const incoming = generator
    ? graph.edges.filter((e) => e.target === generator.id)
    : [];
  const linkedPrompt = incoming
    .filter((e) => e.role === 'prompt')
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .flatMap((n) => (n?.type === 'text' ? [n.data.text] : []))
    .join('\n');
  const linkedRefs = generator
    ? Array.from(
        new Map(
          incoming
            .filter((e) => ['reference', 'first', 'last'].includes(e.role))
            .map((e) => graph.nodes.find((n) => n.id === e.source))
            .flatMap((n) =>
              n?.type === 'image' ? [assets.get(n.data.assetId)] : [],
            )
            .filter((a): a is Asset => !!a)
            .map((a) => [a.id, a]),
        ).values(),
      )
    : quickRefs;
  const center = () => {
    const bounds = canvasSurface.current?.getBoundingClientRect();
    const point = flow.screenToFlowPosition({
      x: (bounds?.left || 0) + (bounds?.width || 900) / 2,
      y: (bounds?.top || 0) + (bounds?.height || 700) / 2,
    });
    point.x -= 150;
    point.y -= 110;
    const nodes = store.getState().graph.nodes;
    const clear = (p: { x: number; y: number }) =>
      !nodes.some(
        (n) =>
          p.x < n.position.x + n.size.width + 24 &&
          p.x + 300 > n.position.x &&
          p.y < n.position.y + n.size.height + 24 &&
          p.y + 240 > n.position.y,
      );
    for (let ring = 0; ring < 24; ring++) {
      for (let dy = -ring; dy <= ring; dy++)
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const candidate = { x: point.x + dx * 340, y: point.y + dy * 280 };
          if (clear(candidate)) return candidate;
        }
    }
    return point;
  };
  const addMediaToGraph = (
    g: Graph,
    media: Asset[],
    position = center(),
  ): { graph: Graph; nodes: GraphNode[] } => {
    const nodes: GraphNode[] = media.map((a, i) => {
      const width = 280,
        height = Math.min(
          400,
          Math.max(180, (width * (a.height || 1)) / (a.width || 1) + 70),
        );
      const base = {
        id: crypto.randomUUID(),
        position: {
          x: position.x + (i % 3) * 320,
          y: position.y + Math.floor(i / 3) * 350,
        },
        size: { width, height },
        locked: false,
      };
      const data = {
        assetId: a.id,
        naturalW: a.width || 1,
        naturalH: a.height || 1,
        label: a.name.slice(0, 100),
        gen: null,
      };
      return a.kind === 'video'
        ? {
            ...base,
            type: 'video',
            data: { ...data, durationMs: a.duration_ms },
          }
        : { ...base, type: 'image', data };
    });
    return { graph: { ...g, nodes: [...g.nodes, ...nodes] }, nodes };
  };
  const addMedia = (items: Asset[], position?: { x: number; y: number }) => {
    mergeAssets(items);
    safeChange((g) => addMediaToGraph(g, items, position).graph);
  };
  const addGenerator = (value = quick, refs = quickRefs) => {
    const id = crypto.randomUUID(),
      position = center();
    let g = store.getState().graph;
    const generated: GraphNode = {
      id,
      type: 'generate',
      position,
      size: { width: 280, height: 290 },
      locked: false,
      data: { ...value, jobId: null, status: 'IDLE', error: null },
    };
    g = { ...g, nodes: [...g.nodes, generated] };
    const media = addMediaToGraph(g, refs, {
      x: position.x - 380,
      y: position.y,
    });
    g = media.graph;
    for (const node of media.nodes) g = connect(g, node.id, id);
    safeChange(() => g);
    store.getState().select([id]);
    setCreatorOpen(true);
    setMenu(undefined);
    return id;
  };
  const changeGenerator = (value: GenerateData) => {
    if (generator)
      safeChange((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.id === generator.id ? { ...generator, data: value } : n,
        ),
      }));
    else setQuick(value);
  };
  const changeReferences = (refs: Asset[]) => {
    if (!generator) {
      setQuickRefs(refs);
      mergeAssets(refs);
      return;
    }
    mergeAssets(refs);
    safeChange((g) => {
      const old = g.edges.filter(
        (e) =>
          e.target === generator.id &&
          ['reference', 'first', 'last'].includes(e.role),
      );
      const keep = old.filter((e) => {
        const n = g.nodes.find((n) => n.id === e.source);
        return n?.type === 'image' && refs.some((a) => a.id === n.data.assetId);
      });
      let next = {
        ...g,
        edges: g.edges.filter((e) => !old.includes(e) || keep.includes(e)),
      };
      const added = refs.filter(
        (a) =>
          !keep.some((e) => {
            const n = g.nodes.find((n) => n.id === e.source);
            return n?.type === 'image' && n.data.assetId === a.id;
          }),
      );
      const media = addMediaToGraph(next, added, {
        x: generator.position.x - 370,
        y: generator.position.y,
      });
      next = media.graph;
      for (const node of media.nodes)
        next = connect(next, node.id, generator.id);
      return next;
    });
  };
  const derive = (
    ids: string[],
    position?: { x: number; y: number },
    kind?: 'image' | 'video',
  ) => {
    const g = store.getState().graph;
    const inputs = g.nodes.filter(
      (n) => ids.includes(n.id) && (n.type === 'text' || n.type === 'image'),
    );
    if (!inputs.length) {
      setNotice('选择文字或图片，再创建关联的生成节点。');
      return;
    }
    const catalog = queries.getQueryData<Schema['Catalog']>(['canvas-catalog']);
    const model = kind
      ? catalog?.models.find((m) => m.kind === kind)
      : undefined;
    const defaults = kind
      ? { ...blankGenerator(), seconds: kind === 'video' ? 4 : null }
      : quick;
    const data: GenerateData = model
      ? {
          ...defaults,
          modelId: model.id,
          quality: model.capabilities.qualities?.[0] || 'low',
          ratio: model.capabilities.ratios?.[0] || '1:1',
          resolution: model.capabilities.resolutions?.[0] || '1K',
          seconds:
            kind === 'video' ? model.capabilities.seconds?.[0] || 4 : null,
        }
      : defaults;
    const id = crypto.randomUUID();
    const right =
      Math.max(...inputs.map((n) => n.position.x + n.size.width)) + 160;
    const top = Math.min(...inputs.map((n) => n.position.y));
    const node: GraphNode = {
      id,
      type: 'generate',
      position: position || { x: Math.min(1e6, right), y: top },
      size: { width: 300, height: 300 },
      locked: false,
      data: { ...data, prompt: '', jobId: null, status: 'IDLE', error: null },
    };
    let next = { ...g, nodes: [...g.nodes, node] };
    for (const input of inputs) next = connect(next, input.id, id);
    safeChange(() => next);
    store.getState().select([id]);
    setCreatorOpen(true);
    setMenu(undefined);
    setNotice(
      kind && !model
        ? `已连接节点；请先在模型管理中配置${kind === 'video' ? '视频' : '图片'}模型。`
        : '已连接所选提示词与参考图。核对参数和积分后点击生成。',
    );
    void flow.fitView({
      nodes: inputs.map((n) => ({ id: n.id })).concat({ id }),
      padding: 0.22,
      maxZoom: viewport.zoom,
      duration: 240,
    });
  };
  const run = (nodeId?: string) =>
    void action(async () => {
      if (readonly) return;
      const id = nodeId || addGenerator();
      store.getState().select([id]);
      setCreatorOpen(true);
      const g = store.getState().graph;
      const node = g.nodes.find((n) => n.id === id);
      if (!node || node.type !== 'generate')
        throw new Error('请选择生成节点。');
      if (
        g.nodes.length + node.data.n > 500 ||
        g.edges.length + node.data.n > 1000
      )
        throw new Error('请先为生成结果预留节点和连线空间，再开始生成。');
      const linked = g.edges.filter((e) => e.target === id);
      if (linked.some((e) => e.role === 'last'))
        throw new Error('当前模型尚不支持尾帧输入，请移除尾帧连线。');
      const referenceIds = new Set<string>();
      const refs = linked.flatMap((e) => {
        const n = g.nodes.find((n) => n.id === e.source);
        if (n?.type !== 'image' || referenceIds.has(n.data.assetId)) return [];
        referenceIds.add(n.data.assetId);
        return [{ asset_id: n.data.assetId, role: 'reference' }];
      });
      const text = linked.flatMap((e) => {
        const n = g.nodes.find((n) => n.id === e.source);
        return n?.type === 'text' ? [n.data.text] : [];
      });
      const body: Draft = pending.current.get(id)?.body || {
        model_id: node.data.modelId,
        prompt: [...text, node.data.prompt || ''].filter(Boolean).join('\n'),
        quality: node.data.quality,
        ratio: node.data.ratio,
        resolution: node.data.resolution,
        n: node.data.n,
        seconds: node.data.seconds,
        references: refs,
        project_id: info.id,
        node_id: id,
      };
      if (!pending.current.has(id)) {
        const catalog = queries.getQueryData<
          Awaited<ReturnType<typeof generationApi.catalog>>
        >(['canvas-catalog']);
        const model = catalog?.models.find((m) => m.id === body.model_id);
        if (!model)
          throw new Error('先在创作参数里选择当前可用的图片或视频模型。');
        if (
          model.kind === 'image' &&
          (body.references || []).length &&
          !model.capabilities.supports_edit
        )
          throw new Error(
            `「${model.display_name}」尚未开启图片编辑。请更换支持参考图的模型，或由管理员在模型与定价中开启“支持图片编辑”。`,
          );
        const maximum = Math.min(
          model.capabilities.max_refs || 0,
          model.kind === 'video' ? 1 : 4,
        );
        if ((body.references || []).length > maximum)
          throw new Error(
            `「${model.display_name}」最多支持 ${maximum} 张参考图，当前连接了 ${(body.references || []).length} 张。请移除多余参考图或切换模型。`,
          );
        if (!body.prompt.trim())
          throw new Error('请连接文字提示词，或在创作参数里填写创意描述。');
        if (body.prompt.length > 4000)
          throw new Error('合并后的提示词超过 4000 字，请精简后再生成。');
        await generationApi.quote(
          {
            model_id: body.model_id,
            quality: body.quality,
            ratio: body.ratio,
            resolution: body.resolution,
            n: body.n,
            seconds: body.seconds,
            ref_count: (body.references || []).length,
          },
          me.csrf_token,
        );
      }
      await saverRef.current?.flush();
      let submission = pending.current.get(id);
      if (!submission) {
        submission = { key: crypto.randomUUID(), body };
        pending.current.set(id, submission);
      }
      try {
        const receipt = await generationApi.create(
          submission.body,
          me.csrf_token,
          submission.key,
        );
        pending.current.delete(id);
        mergeAssets(receipt.job.outputs.map((o) => o.asset));
        safeChange((g) => reconcileJobs(g, [receipt.job]), false);
        void queries.invalidateQueries({
          queryKey: ['canvas-jobs', me.user.id, info.id],
        });
        setCreatorOpen(false);
        setNotice('生成任务已提交，结果会自动连回画布。');
      } catch (e) {
        if (e instanceof SessionError && e.status < 500)
          pending.current.delete(id);
        else
          setNotice(
            '提交结果尚未确认。请在原节点重试，将使用同一请求核对任务，避免重复扣款。',
          );
        throw e;
      }
    });
  const upload = (files: File[], position?: { x: number; y: number }) =>
    void action(async () => {
      if (readonly) return;
      for (const item of files) {
        const asset = await assetsApi.upload(item, me.csrf_token);
        mergeAssets([asset]);
        const id = replacement.current;
        if (id) {
          safeChange((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id !== id) return n;
              const fresh = addMediaToGraph(
                { ...g, nodes: [] },
                [asset],
                n.position,
              ).nodes[0];
              return { ...fresh, id: n.id, size: n.size, locked: n.locked };
            }),
          }));
          replacement.current = undefined;
        } else addMedia([asset], position);
      }
      setNotice('素材已上传并加入画布。');
    });
  const remove = useCallback(
    () =>
      safeChange((g) => {
        const ids = new Set(
          store
            .getState()
            .selected.filter((id) => !g.nodes.find((n) => n.id === id)?.locked),
        );
        return {
          ...g,
          nodes: g.nodes.filter((n) => !ids.has(n.id)),
          edges: g.edges.filter(
            (e) =>
              !ids.has(e.source) &&
              !ids.has(e.target) &&
              !edgeSelection.includes(e.id),
          ),
        };
      }),
    [safeChange, store, edgeSelection],
  );
  const copy = useCallback(
    (cut = false) => {
      const s = store.getState();
      clipboard.current = {
        nodes: s.graph.nodes.filter((n) => s.selected.includes(n.id)),
        edges: s.graph.edges,
      };
      if (cut) remove();
    },
    [store, remove],
  );
  const paste = useCallback(() => {
    if (clipboard.current)
      safeChange((g) =>
        pasteNodes(g, clipboard.current!.nodes, clipboard.current!.edges),
      );
  }, [safeChange]);
  const duplicate = () => {
    copy();
    paste();
  };
  const add = (
    type: 'text' | 'generate' | 'upload' | 'library',
    position?: { x: number; y: number },
  ) => {
    setMenu(undefined);
    if (readonly) return;
    if (type === 'upload') {
      replacement.current = undefined;
      file.current?.click();
      return;
    }
    if (type === 'library') {
      setPicker(true);
      return;
    }
    if (type === 'generate') {
      addGenerator();
      return;
    }
    const node: GraphNode = {
      id: crypto.randomUUID(),
      type: 'text',
      position: position || center(),
      size: { width: 300, height: 210 },
      locked: false,
      data: { text: '' },
    };
    safeChange((g) => ({ ...g, nodes: [...g.nodes, node] }));
    store.getState().select([node.id]);
    setEditingNode(node.id);
  };
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (editableTarget(e.target)) return;
      if (
        e.target instanceof HTMLElement &&
        e.target !== document.body &&
        !root.current?.contains(e.target)
      )
        return;
      if (e.key === 'Escape') {
        setMenu(undefined);
        setHelpOpen(false);
        setCreatorOpen(false);
        setInspector(false);
        setEditingNode(undefined);
        setEdgeSelection([]);
        store.getState().select([]);
        return;
      }
      const current = store.getState();
      const focusSelected = () =>
        void flow.fitView({
          nodes: current.selected.map((id) => ({ id })),
          padding: 0.3,
          maxZoom: 1.2,
          duration: 200,
        });
      if (!e.ctrlKey && !e.metaKey && e.shiftKey && e.key === '!') {
        e.preventDefault();
        setCreatorOpen(false);
        void flow.fitView({ padding: 0.2, duration: 200 });
        return;
      }
      if (e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit0')) {
        e.preventDefault();
        if (e.code === 'Digit1') {
          setCreatorOpen(false);
          void flow.fitView({ padding: 0.2, duration: 200 });
        } else void flow.zoomTo(1, { duration: 160 });
        return;
      }
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusSelected();
        return;
      }
      if (['+', '=', '-'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '-') void flow.zoomOut({ duration: 100 });
        else void flow.zoomIn({ duration: 100 });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpace(true);
      }
      if (e.key.toLowerCase() === 'h' && !mod) setPan(true);
      if (e.key.toLowerCase() === 'v' && !mod) setPan(false);
      if (readonly) return;
      if (!mod && !e.repeat && !e.altKey) {
        if (e.key.toLowerCase() === 't') {
          e.preventDefault();
          add('text');
        }
        if (e.key.toLowerCase() === 'g') {
          e.preventDefault();
          add('generate');
        }
        if (e.key.toLowerCase() === 'i') {
          e.preventDefault();
          add('upload');
        }
      }
      if (mod && e.key === 'Enter' && current.selected.length === 1) {
        e.preventDefault();
        const node = current.graph.nodes.find(
          (n) => n.id === current.selected[0],
        );
        if (node?.type === 'generate') run(node.id);
      }
      if (
        mod &&
        ['a', 'c', 'x', 'v', 'd', 'z', 'y', 's'].includes(e.key.toLowerCase())
      )
        e.preventDefault();
      if (mod && e.key.toLowerCase() === 'a')
        store.getState().select(store.getState().graph.nodes.map((n) => n.id));
      if (mod && e.key.toLowerCase() === 'c') copy();
      if (mod && e.key.toLowerCase() === 'x') copy(true);
      if (mod && e.key.toLowerCase() === 'v') paste();
      if (mod && e.key.toLowerCase() === 'd') {
        copy();
        paste();
      }
      if (mod && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) store.getState().redo();
        else store.getState().undo();
      }
      if (mod && e.key.toLowerCase() === 'y') store.getState().redo();
      if (mod && e.key.toLowerCase() === 's')
        void saverRef.current?.flush().catch(() => {});
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove();
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false);
    };
    const blur = () => setSpace(false);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  }, [store, readonly, copy, paste, remove, flow, quick, quickRefs]);
  const nodeCache = useRef(new Map<string, FlowNode>());
  const nodes = useMemo(
    (): FlowNode[] =>
      graph.nodes.map((node) => {
        const cached = nodeCache.current.get(node.id);
        const isSelected = selected.includes(node.id);
        if (
          cached?.data.node === node &&
          cached.selected === isSelected &&
          cached.draggable === (!readonly && !space && !node.locked)
        )
          return cached;
        const next: FlowNode = {
          id: node.id,
          type: 'canvas',
          position: node.position,
          data: { node },
          width: node.size.width,
          height: node.size.height,
          style: { width: node.size.width, height: node.size.height },
          selected: isSelected,
          draggable: !readonly && !space && !node.locked,
          connectable: !readonly && !node.locked,
        };
        nodeCache.current.set(node.id, next);
        return next;
      }),
    [graph.nodes, selected, readonly, space],
  );
  const edges = useMemo(
    () =>
      graph.edges.map((e) => ({
        ...e,
        label: {
          prompt: '提示词',
          reference: '参考',
          first: '首帧',
          last: '尾帧',
          result: '结果',
        }[e.role],
        type: 'default',
        selected: edgeSelection.includes(e.id),
        interactionWidth: 24,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: e.role === 'result' ? '#8c9b95' : '#759c8e',
        },
        style: {
          stroke: e.role === 'result' ? '#9ca9a2' : '#759c8e',
          strokeWidth: edgeSelection.includes(e.id) ? 3 : 1.8,
        },
        selectable: !readonly,
      })),
    [graph.edges, readonly, edgeSelection],
  );
  useEffect(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of nodeCache.current.keys())
      if (!ids.has(id)) nodeCache.current.delete(id);
  }, [graph.nodes]);
  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const selectedChanges = changes.filter((c) => c.type === 'select');
    if (selectedChanges.length) {
      let next = store.getState().selected;
      for (const c of selectedChanges)
        if (c.type === 'select')
          next = c.selected
            ? [...new Set([...next, c.id])]
            : next.filter((id) => id !== c.id);
      store.getState().select(next);
    }
    if (readonly) return;
    const changed = changes.filter(
      (c) => c.type === 'position' || (c.type === 'dimensions' && c.resizing),
    );
    if (changed.length) {
      const update = (g: Graph) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          if (n.locked) return n;
          let next = n;
          for (const c of changed) {
            if (!('id' in c) || c.id !== n.id) continue;
            if (c.type === 'position' && c.position)
              next = {
                ...next,
                position: {
                  x: Math.max(-1e6, Math.min(1e6, c.position.x)),
                  y: Math.max(-1e6, Math.min(1e6, c.position.y)),
                },
              };
            if (c.type === 'dimensions' && c.dimensions)
              next = {
                ...next,
                size: {
                  width: c.dimensions.width,
                  height: c.dimensions.height,
                },
              };
          }
          return next;
        }),
      });
      if (store.getState().checkpoint) store.getState().preview(update);
      else safeChange(update, false);
    }
  };
  const onConnect = (c: Connection) =>
    safeChange((g) => connect(g, c.source, c.target));
  const openPreview = (id: string) =>
    void action(async () => {
      const asset = await assetsApi.get(id);
      mergeAssets([asset]);
      setPreview(asset);
    });
  const actions = useMemo(
    () => ({
      assets,
      jobs: jobMap,
      readonly,
      busy,
      editing: editingNode,
      selectedCount: selected.length,
      edit: setEditingNode,
      derive: (id: string) => derive([id]),
      info: (id: string) => {
        setCreatorOpen(false);
        store.getState().select([id]);
        setTab('properties');
        setInspector(true);
      },
      configure: (id: string) => {
        store.getState().select([id]);
        setCreatorOpen(true);
      },
      duplicate: (id: string) => {
        store.getState().select([id]);
        duplicate();
      },
      remove: (id: string) => {
        store.getState().select([id]);
        remove();
      },
      text: (id: string, text: string) =>
        safeChange((g) => ({
          ...g,
          nodes: g.nodes.map((n) =>
            n.id === id && n.type === 'text' ? { ...n, data: { text } } : n,
          ),
        })),
      preview: openPreview,
      run,
      cancel: (id: string) =>
        void action(async () => {
          await generationApi.cancel(id, me.csrf_token);
          await jobsQuery.refetch();
        }),
      refresh: refreshAsset,
      begin: () => store.getState().begin(),
      end: () => store.getState().end(),
    }),
    [
      assets,
      jobMap,
      readonly,
      safeChange,
      action,
      me.csrf_token,
      refreshAsset,
      editingNode,
      busy,
      selected,
      quick,
      quickRefs,
      remove,
      copy,
      paste,
    ],
  );
  const viewportChanged = useRef(false);
  const reloadLatest = () =>
    void action(async () => {
      const result = await projectApi.get(info.id);
      saverRef.current?.accept(result);
      setError('');
    });
  const exportProject = () =>
    void action(async () => {
      await saverRef.current?.flush();
      const blob = await projectApi.export(info.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${info.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('项目 ZIP 已导出，包含图数据与可用素材原文件。');
    });
  const saveCopy = () =>
    void action(async () => {
      const copy = await projectApi.create(
        `${info.name.slice(0, 95)} 副本`,
        me.csrf_token,
        crypto.randomUUID(),
        store.getState().graph,
      );
      saverRef.current?.initialize(saverRef.current.revision);
      navigate(`/canvas/${copy.project.id}`);
    });
  const nodeLeft = generator
    ? viewport.x + generator.position.x * viewport.zoom
    : 0;
  const panelRight = generator
    ? nodeLeft + generator.size.width * viewport.zoom + 24
    : 0;
  const panelLeft =
    panelRight + 330 <= surfaceSize.width - 12
      ? panelRight
      : nodeLeft >= 366
        ? nodeLeft - 354
        : Math.max(12, surfaceSize.width - 342);
  const panelTop = generator
    ? Math.max(
        70,
        Math.min(
          viewport.y + generator.position.y * viewport.zoom + 54,
          surfaceSize.height + 38 - Math.min(620, surfaceSize.height - 32),
        ),
      )
    : 70;
  return (
    <div
      className={`canvas-shell live-canvas ${creatorOpen ? 'creator-open' : 'creator-closed'} ${generator ? 'creator-local' : ''} ${inspector ? 'inspector-open' : 'inspector-closed'} ${pan || space ? 'is-panning' : ''} ${readonly ? 'readonly' : ''}`}
      ref={root}
      tabIndex={-1}
      onPaste={(e) => {
        if (readonly || editableTarget(e.target)) return;
        const images = Array.from(e.clipboardData.files).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (images.length) {
          e.preventDefault();
          upload(images);
        }
      }}
    >
      <CanvasCreator
        onClose={() => {
          setCreatorOpen(false);
          root.current?.focus({ preventScroll: true });
        }}
        floating={!!generator}
        style={
          generator
            ? {
                left: `min(${panelLeft}px, calc(100% - 342px))`,
                top: panelTop,
                maxHeight: `min(620px, calc(100% - ${panelTop + 16}px))`,
              }
            : undefined
        }
        value={generatorData}
        onChange={changeGenerator}
        references={linkedRefs}
        onReferences={changeReferences}
        linkedPrompt={linkedPrompt}
        tail={incoming.some((e) => e.role === 'last')}
        selected={!!generator}
        busy={
          busy ||
          !!(
            generator?.data.jobId &&
            active(jobMap.get(generator.data.jobId) || ({ status: '' } as Job))
          )
        }
        readonly={readonly || !!generator?.locked}
        csrf={me.csrf_token}
        onRun={() => run(generator?.id)}
        onAdd={add}
        errorText={errorText}
      />
      <div className="canvas-main">
        <div className="canvas-head">
          <button
            className={`tool-button canvas-creator-toggle ${creatorOpen ? 'active' : ''}`}
            aria-label="切换创作参数"
            aria-expanded={creatorOpen}
            onClick={() => setCreatorOpen((v) => !v)}
          >
            {creatorOpen ? (
              <PanelLeftClose size={16} />
            ) : (
              <PanelLeftOpen size={16} />
            )}
            <span>创作参数</span>
          </button>
          <div className="canvas-breadcrumb">
            <Link to="/canvas" className="crumb-muted">
              无限画布
            </Link>
            <span className="slash">/</span>
            <select
              aria-label="切换画布"
              className="live-project-switch"
              value={info.id}
              onChange={(e) => navigate(`/canvas/${e.target.value}`)}
            >
              <option value={info.id}>{info.name}</option>
              {projectList.data?.items
                .filter((p) => p.id !== info.id)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <button
              aria-label="重命名当前画布"
              onClick={() => setRename(info.name)}
              disabled={readonly || busy}
            >
              ✎
            </button>
          </div>
          <div className="canvas-head-actions">
            <button
              className="tool-button"
              aria-label="导出项目 ZIP"
              disabled={busy}
              onClick={exportProject}
            >
              <Download size={14} />
            </button>
            <span role="status" className="save-status">
              {status === 'saved' && <Check size={12} />}
              {statusText[status]}
            </span>
            {status === 'error' && (
              <button
                className="tool-button"
                onClick={() => void saverRef.current?.flush().catch(() => {})}
              >
                重试保存
              </button>
            )}
            <button
              className="tool-button"
              aria-label="历史版本"
              onClick={() =>
                void action(async () =>
                  setHistory(await projectApi.snapshots(info.id)),
                )
              }
            >
              <History size={14} />
            </button>
            <button
              className="tool-button"
              aria-label="打开属性面板"
              aria-expanded={inspector}
              onClick={() => setInspector(!inspector)}
            >
              <Settings2 size={14} />
            </button>
          </div>
        </div>
        {readonly && (
          <div className="live-readonly" role="status">
            当前屏幕仅支持查看画布，请使用电脑（宽度至少 1024 像素）编辑。
          </div>
        )}
        {error && status !== 'conflict' && (
          <Feedback
            onDismiss={() => setError('')}
            className="live-canvas-alert"
            variant="error"
          >
            {error}
            <button
              className="icon-btn"
              aria-label="关闭错误提示"
              onClick={() => setError('')}
            >
              <X size={14} />
            </button>
          </Feedback>
        )}
        {notice && !error && (
          <Feedback
            onDismiss={() => setNotice('')}
            className="live-canvas-notice"
            variant="success"
          >
            {notice}
            <button
              className="icon-btn"
              aria-label="关闭提示"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </Feedback>
        )}
        <div
          ref={canvasSurface}
          className="react-canvas-wrap"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (readonly) return;
            const point = flow.screenToFlowPosition({
              x: e.clientX,
              y: e.clientY,
            });
            if (e.dataTransfer.files.length)
              upload(Array.from(e.dataTransfer.files), point);
            else {
              const asset = e.dataTransfer.getData('application/atelier-asset');
              if (asset)
                void action(async () =>
                  addMedia([await assetsApi.get(asset)], point),
                );
            }
          }}
        >
          <CanvasActions.Provider value={actions}>
            <ReactFlow<FlowNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={liveNodeTypes}
              defaultViewport={initial.graph.viewport}
              minZoom={0.1}
              maxZoom={4}
              onlyRenderVisibleElements
              nodesDraggable={!readonly && !space}
              nodesConnectable={!readonly}
              elementsSelectable={!space}
              selectionOnDrag={!pan && !space}
              selectionMode={SelectionMode.Partial}
              nodeDragThreshold={4}
              connectionRadius={36}
              connectOnClick
              zoomOnDoubleClick={false}
              panOnDrag={space ? true : pan ? [0, 1] : [1]}
              panActivationKeyCode="Space"
              multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
              selectionKeyCode="Shift"
              deleteKeyCode={null}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => {
                for (const c of changes)
                  if (c.type === 'select')
                    setEdgeSelection((old) =>
                      c.selected
                        ? Array.from(new Set([...old, c.id]))
                        : old.filter((id) => id !== c.id),
                    );
                if (readonly) return;
                const remove = changes
                  .filter((c) => c.type === 'remove')
                  .map((c) => c.id);
                if (remove.length)
                  safeChange((g) => ({
                    ...g,
                    edges: g.edges.filter((e) => !remove.includes(e.id)),
                  }));
              }}
              onNodeDragStart={() => store.getState().begin()}
              onNodeDragStop={() => store.getState().end()}
              onConnect={onConnect}
              onEdgeClick={() => store.getState().select([])}
              onClickConnectStart={() => setCreatorOpen(false)}
              onConnectStart={(event) => {
                setCreatorOpen(false);
                const p = 'touches' in event ? event.touches[0] : event;
                if (p) connectStart.current = { x: p.clientX, y: p.clientY };
              }}
              onConnectEnd={(event, state) => {
                if (readonly || state.isValid || !state.fromNode) return;
                if (state.toNode) {
                  const source =
                    state.fromHandle?.type === 'target'
                      ? state.toNode.id
                      : state.fromNode.id;
                  const target =
                    state.fromHandle?.type === 'target'
                      ? state.fromNode.id
                      : state.toNode.id;
                  setNotice(
                    connectionIssue(store.getState().graph, source, target) ||
                      '请连接对应的输入和输出端口。',
                  );
                  return;
                }
                const origin = store
                  .getState()
                  .graph.nodes.find((n) => n.id === state.fromNode!.id);
                if (
                  state.fromHandle?.type !== 'source' ||
                  !origin ||
                  !['text', 'image'].includes(origin.type)
                )
                  return;
                const point =
                  'changedTouches' in event ? event.changedTouches[0] : event;
                if (
                  !point ||
                  !connectStart.current ||
                  Math.hypot(
                    point.clientX - connectStart.current.x,
                    point.clientY - connectStart.current.y,
                  ) < 8
                )
                  return;
                const bounds = canvasSurface.current?.getBoundingClientRect();
                setMenu({
                  x: point.clientX - (bounds?.left || 0),
                  y: point.clientY - (bounds?.top || 0),
                  point: flow.screenToFlowPosition({
                    x: point.clientX,
                    y: point.clientY,
                  }),
                  source: origin.id,
                });
              }}
              onPaneContextMenu={(event) => {
                event.preventDefault();
                if (readonly) return;
                const b = canvasSurface.current?.getBoundingClientRect();
                setMenu({
                  x: event.clientX - (b?.left || 0),
                  y: event.clientY - (b?.top || 0),
                  point: flow.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                });
              }}
              onDoubleClick={(event) => {
                if (
                  (event.target as HTMLElement).closest(
                    '.react-flow__node,.react-flow__edge,.react-flow__panel',
                  ) ||
                  readonly
                )
                  return;
                const b = canvasSurface.current?.getBoundingClientRect();
                setMenu({
                  x: event.clientX - (b?.left || 0),
                  y: event.clientY - (b?.top || 0),
                  point: flow.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                });
              }}
              onNodeContextMenu={(event, node) => {
                event.preventDefault();
                if (readonly) return;
                store.getState().select([node.id]);
                const b = canvasSurface.current?.getBoundingClientRect();
                setMenu({
                  x: event.clientX - (b?.left || 0),
                  y: event.clientY - (b?.top || 0),
                  point: node.position,
                  node: node.id,
                });
              }}
              onEdgeContextMenu={(event, edge) => {
                event.preventDefault();
                if (readonly) return;
                setEdgeSelection([edge.id]);
                const b = canvasSurface.current?.getBoundingClientRect();
                setMenu({
                  x: event.clientX - (b?.left || 0),
                  y: event.clientY - (b?.top || 0),
                  point: flow.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                  edge: edge.id,
                });
              }}
              onMoveStart={() => {
                viewportChanged.current = true;
              }}
              onMoveEnd={(_, viewport) => {
                if (viewportChanged.current && !readonly)
                  safeChange((g) => ({ ...g, viewport }), false);
                viewportChanged.current = false;
              }}
              onNodeClick={(event, node) => {
                if (
                  (event.target as HTMLElement).closest('.react-flow__handle')
                )
                  return;
                setCreatorOpen(node.data.node.type === 'generate');
              }}
              onPaneClick={() => {
                setCreatorOpen(false);
                store.getState().select([]);
                setEdgeSelection([]);
                setMenu(undefined);
                setEditingNode(undefined);
              }}
              isValidConnection={(c) =>
                !connectionIssue(store.getState().graph, c.source, c.target)
              }
              onNodeDoubleClick={(_, n) => {
                if (
                  n.data.node.type === 'text' &&
                  !readonly &&
                  !n.data.node.locked
                )
                  setEditingNode(n.id);
                if (n.data.node.type === 'generate') {
                  store.getState().select([n.id]);
                  setCreatorOpen(true);
                }
                if (
                  n.data.node.type === 'image' ||
                  n.data.node.type === 'video'
                )
                  openPreview(n.data.node.data.assetId);
              }}
            >
              {graph.background !== 'none' && (
                <Background
                  variant={
                    graph.background === 'lines'
                      ? BackgroundVariant.Lines
                      : BackgroundVariant.Dots
                  }
                  color="#d8dddc"
                  gap={24}
                  size={1}
                />
              )}
              <Panel position="bottom-center" className="floating-tools">
                <CanvasToolButton
                  hint="选择 · V / Shift 框选"
                  className={`tool-button ${!pan ? 'active' : ''}`}
                  aria-label="选择工具"
                  onClick={() => setPan(false)}
                >
                  <MousePointer2 size={15} />
                </CanvasToolButton>
                <CanvasToolButton
                  hint="平移 · H / 按住空格"
                  className={`tool-button ${pan ? 'active' : ''}`}
                  aria-label="平移工具"
                  onClick={() => setPan(true)}
                >
                  <Hand size={15} />
                </CanvasToolButton>
                <span className="separator" />
                <CanvasToolButton
                  hint="文字 · T"
                  className="tool-button"
                  aria-label="添加文字节点"
                  disabled={readonly}
                  onClick={() => add('text')}
                >
                  <Type size={15} />
                </CanvasToolButton>
                <CanvasToolButton
                  hint="图片 / 视频 · I"
                  className="tool-button"
                  aria-label="上传素材到画布"
                  disabled={readonly || busy}
                  onClick={() => add('upload')}
                >
                  <ImageIcon size={15} />
                </CanvasToolButton>
                <CanvasToolButton
                  hint="生成节点 · G"
                  className="tool-button"
                  aria-label="添加生成节点"
                  disabled={readonly}
                  onClick={() => add('generate')}
                >
                  <Sparkles size={15} />
                </CanvasToolButton>
                <span className="separator" />
                <CanvasToolButton
                  hint="撤销 · Ctrl Z"
                  className="tool-button"
                  aria-label="撤销"
                  disabled={!past || readonly}
                  onClick={() => store.getState().undo()}
                >
                  <Undo2 size={15} />
                </CanvasToolButton>
                <CanvasToolButton
                  hint="重做 · Ctrl Shift Z"
                  className="tool-button"
                  aria-label="重做"
                  disabled={!future || readonly}
                  onClick={() => store.getState().redo()}
                >
                  <Redo2 size={15} />
                </CanvasToolButton>
              </Panel>

              {miniMapOpen && (
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  nodeColor={(n) =>
                    n.type === 'generate' ? '#acc6bd' : '#d8dfdf'
                  }
                />
              )}
              <Panel position="bottom-left" className="canvas-bottom-hint">
                <button
                  className="icon-btn"
                  aria-label="适应画布"
                  onClick={() => {
                    setCreatorOpen(false);
                    void flow.fitView({ padding: 0.2 });
                  }}
                >
                  <Maximize2 size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="100%"
                  title="回到 100%（Shift+0）"
                  onClick={() => void flow.zoomTo(1)}
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="缩小画布"
                  onClick={() => void flow.zoomOut({ duration: 120 })}
                >
                  <Minus size={14} />
                </button>
                <input
                  aria-label="画布缩放"
                  type="range"
                  min="10"
                  max="400"
                  step="5"
                  value={Math.round(viewport.zoom * 100)}
                  onChange={(e) =>
                    void flow.zoomTo(Number(e.target.value) / 100)
                  }
                />
                <output aria-label="当前缩放">
                  {Math.round(viewport.zoom * 100)}%
                </output>
                <button
                  className="icon-btn"
                  aria-label="放大画布"
                  onClick={() => void flow.zoomIn({ duration: 120 })}
                >
                  <Plus size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="切换小地图"
                  aria-pressed={miniMapOpen}
                  onClick={() => setMiniMapOpen((v) => !v)}
                >
                  <Layers size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="画布快捷键"
                  onClick={() => setHelpOpen(true)}
                >
                  <HelpCircle size={14} />
                </button>
              </Panel>
              {!graph.nodes.length && (
                <Panel position="top-center" className="live-canvas-empty">
                  <Layers size={32} strokeWidth={1} />
                  <strong>给灵感一个起点</strong>
                  <p>拖入图片或视频，添加文字，连接生成节点。</p>
                  {!readonly && (
                    <button className="btn" onClick={() => add('library')}>
                      <Plus size={14} />
                      从素材开始
                    </button>
                  )}
                </Panel>
              )}
              {selected.length > 1 && !readonly && (
                <Panel position="top-right" className="live-selection-actions">
                  <strong>已选 {selected.length} 项</strong>
                  <button
                    className="btn"
                    onClick={() => derive(store.getState().selected)}
                  >
                    <Sparkles size={14} />
                    用所选继续创作
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="聚焦选中节点"
                    onClick={() =>
                      void flow.fitView({
                        nodes: store.getState().selected.map((id) => ({ id })),
                        padding: 0.3,
                        maxZoom: 1.2,
                        duration: 200,
                      })
                    }
                  >
                    <Maximize2 size={14} />
                  </button>
                </Panel>
              )}
              {edgeSelection.length > 0 && !readonly && (
                <Panel position="top-right" className="live-selection-actions">
                  <span>已选 {edgeSelection.length} 条连线</span>
                  <button
                    className="btn"
                    onClick={() => {
                      safeChange((g) => ({
                        ...g,
                        edges: g.edges.filter(
                          (e) => !edgeSelection.includes(e.id),
                        ),
                      }));
                      setEdgeSelection([]);
                    }}
                  >
                    断开连线
                  </button>
                </Panel>
              )}
            </ReactFlow>
          </CanvasActions.Provider>
          {menu && (
            <CanvasContextMenu
              menu={menu}
              width={surfaceSize.width}
              height={surfaceSize.height}
              source={graph.nodes.find((n) => n.id === menu.source)}
              node={graph.nodes.find((n) => n.id === menu.node)}
              viewport={viewport}
              onClose={() => {
                setMenu(undefined);
                root.current?.focus({ preventScroll: true });
              }}
              onDerive={(id, point, kind) => derive([id], point, kind)}
              onAdd={(type, point) => {
                if (type !== 'generate') {
                  add(type, point);
                  return;
                }
                const id = addGenerator();
                safeChange(
                  (g) => ({
                    ...g,
                    nodes: g.nodes.map((n) =>
                      n.id === id ? { ...n, position: point } : n,
                    ),
                  }),
                  false,
                );
              }}
              onDuplicate={() => {
                duplicate();
                setMenu(undefined);
              }}
              onRemove={() => {
                remove();
                setMenu(undefined);
              }}
              onDisconnect={(id) => {
                safeChange((g) => ({
                  ...g,
                  edges: g.edges.filter((e) => e.id !== id),
                }));
                setEdgeSelection([]);
                setMenu(undefined);
              }}
            />
          )}
        </div>
      </div>
      <aside
        className={`live-inspector ${inspector ? 'open' : ''}`}
        aria-label="画布检查器"
      >
        <div className="segmented">
          {(['properties', 'layers', 'tasks'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'on' : ''}
              onClick={() => setTab(t)}
            >
              {{ properties: '属性', layers: '图层', tasks: '任务' }[t]}
              {t === 'tasks' ? ` ${jobs.filter(active).length}` : ''}
            </button>
          ))}
        </div>
        <button
          className="live-inspector-close icon-btn"
          aria-label="关闭属性面板"
          onClick={() => setInspector(false)}
        >
          <X size={16} />
        </button>
        <div className="panel-scroll">
          {tab === 'layers' ? (
            <div className="layer-list">
              <input
                className="input"
                aria-label="搜索画布节点"
                placeholder="搜索节点名称或文字…"
                value={layerSearch}
                onChange={(e) => setLayerSearch(e.target.value)}
              />
              <p className="canvas-layer-count">
                共 {graph.nodes.length} 个节点
              </p>
              {layerSearch &&
                !graph.nodes.some((n) =>
                  `${nodeLabel(n)} ${n.type === 'text' ? n.data.text : ''}`
                    .toLocaleLowerCase()
                    .includes(layerSearch.toLocaleLowerCase()),
                ) && (
                  <p className="subtle-hint">
                    没有匹配的节点，试试其他关键词。
                  </p>
                )}
              {graph.nodes
                .filter((n) =>
                  `${nodeLabel(n)} ${n.type === 'text' ? n.data.text : ''}`
                    .toLocaleLowerCase()
                    .includes(layerSearch.toLocaleLowerCase()),
                )
                .map((n) => (
                  <button
                    key={n.id}
                    className={selected.includes(n.id) ? 'selected' : ''}
                    onClick={(event) => {
                      const current = store.getState().selected;
                      store
                        .getState()
                        .select(
                          event.shiftKey
                            ? current.includes(n.id)
                              ? current.filter((id) => id !== n.id)
                              : [...current, n.id]
                            : [n.id],
                        );
                      setCreatorOpen(n.type === 'generate');
                      void flow.setCenter(
                        n.position.x + n.size.width / 2,
                        n.position.y + n.size.height / 2,
                        { zoom: 1, duration: 200 },
                      );
                    }}
                  >
                    <Layers size={14} />
                    <span>{nodeLabel(n)}</span>
                    {n.locked && <Lock size={12} />}
                  </button>
                ))}
            </div>
          ) : tab === 'tasks' ? (
            <>
              {jobsQuery.isError && (
                <Feedback variant="error">
                  任务列表暂不可用。
                  <button
                    className="text-action"
                    onClick={() => void jobsQuery.refetch()}
                  >
                    重试
                  </button>
                </Feedback>
              )}
              {jobs.length === 0 && (
                <p className="subtle-hint">
                  还没有生成任务。选择模型和描述后开始创作。
                </p>
              )}
              {jobs.map((job) => (
                <div className="live-task" key={job.id}>
                  <strong>
                    {job.display_name}
                    <span>{statuses[job.status]}</span>
                  </strong>
                  <p>{job.prompt}</p>
                  <small>
                    {job.progress}% · {job.cost} 积分
                    {job.released ? ` · 已退回 ${job.released}` : ''}
                  </small>
                  <div className="gen-actions">
                    {job.node_id && (
                      <button
                        className="text-action"
                        onClick={() => store.getState().select([job.node_id!])}
                      >
                        查看节点
                      </button>
                    )}
                    {active(job) && !readonly && (
                      <button
                        className="text-action"
                        disabled={busy}
                        onClick={() => actions.cancel(job.id)}
                      >
                        取消任务
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <h4>
                {selected.length > 1
                  ? `已选择 ${selected.length} 个节点`
                  : selectedNode
                    ? nodeLabel(selectedNode)
                    : '画布属性'}
              </h4>
              {selectedNode ? (
                <>
                  <p className="subtle-hint">
                    {selectedNode.type.toUpperCase()} ·{' '}
                    {Math.round(selectedNode.size.width)} ×{' '}
                    {Math.round(selectedNode.size.height)}
                  </p>
                  {!readonly && (
                    <div className="gen-actions">
                      <button className="tool-button" onClick={duplicate}>
                        <Copy size={13} />
                        复制
                      </button>
                      <button
                        className="tool-button"
                        onClick={() =>
                          safeChange((g) => ({
                            ...g,
                            nodes: g.nodes.map((n) =>
                              selected.includes(n.id)
                                ? { ...n, locked: !selectedNode.locked }
                                : n,
                            ),
                          }))
                        }
                      >
                        {selectedNode.locked ? (
                          <Unlock size={13} />
                        ) : (
                          <Lock size={13} />
                        )}
                        {selectedNode.locked ? '解锁' : '锁定'}
                      </button>
                      <button
                        className="tool-button"
                        onClick={remove}
                        disabled={selectedNode.locked}
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
                    </div>
                  )}
                  {(selectedNode.type === 'image' ||
                    selectedNode.type === 'video') && (
                    <>
                      <button
                        className="btn full"
                        onClick={() => openPreview(selectedNode.data.assetId)}
                      >
                        预览与下载
                      </button>
                      {!readonly && (
                        <>
                          <button
                            className="btn full"
                            disabled={selectedNode.locked || busy}
                            onClick={() => {
                              replacement.current = selectedNode.id;
                              file.current?.click();
                            }}
                          >
                            替换素材
                          </button>
                          {selectedNode.type === 'image' && (
                            <button
                              className="btn btn-dark full"
                              onClick={() => {
                                const asset = assets.get(
                                  selectedNode.data.assetId,
                                );
                                if (asset) {
                                  addGenerator(quick, [asset]);
                                  setNotice(
                                    '参考图已连接到新的生成节点，请选择参数后生成。',
                                  );
                                }
                              }}
                            >
                              作为参考继续生成
                            </button>
                          )}
                          <Link className="text-action" to="/assets">
                            已保存至素材库
                          </Link>
                        </>
                      )}
                      {selectedNode.data.gen && (
                        <div className="live-generation-meta">
                          <h4>生成参数</h4>
                          <p>{selectedNode.data.gen.prompt}</p>
                          <dl>
                            {Object.entries({
                              模型: selectedNode.data.gen.modelId,
                              画质: selectedNode.data.gen.quality,
                              比例: selectedNode.data.gen.ratio,
                              分辨率: selectedNode.data.gen.resolution,
                              尺寸: selectedNode.data.gen.size,
                              数量: selectedNode.data.gen.n,
                            }).map(([k, v]) => (
                              <div key={k}>
                                <dt>{k}</dt>
                                <dd>{v}</dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )}
                    </>
                  )}
                  {generator && (
                    <p className="subtle-hint">
                      在左侧修改生成参数。拖动节点端口连接文字与参考图片。
                    </p>
                  )}
                </>
              ) : (
                <p className="subtle-hint">
                  选择节点查看与编辑属性。可通过文字 → 生成节点传入提示词，图片
                  → 生成节点传入参考图。
                </p>
              )}
              <div className="section-divider" />
              <label className="field-label" htmlFor="canvas-background">
                画布背景
              </label>
              <select
                id="canvas-background"
                className="select"
                value={graph.background}
                disabled={readonly}
                onChange={(e) =>
                  safeChange((g) => ({
                    ...g,
                    background: e.target.value as Graph['background'],
                  }))
                }
              >
                <option value="dots">点阵</option>
                <option value="lines">网格</option>
                <option value="none">无背景</option>
              </select>
              {selectedNode &&
                graph.edges.some(
                  (e) =>
                    e.source === selectedNode.id ||
                    e.target === selectedNode.id,
                ) && (
                  <>
                    <div className="section-divider" />
                    <h4>节点连线</h4>
                    {graph.edges
                      .filter(
                        (e) =>
                          e.source === selectedNode.id ||
                          e.target === selectedNode.id,
                      )
                      .map((e) => (
                        <div className="live-edge-row" key={e.id}>
                          <span>
                            {nodeLabel(
                              graph.nodes.find((n) => n.id === e.source)!,
                            )}{' '}
                            →{' '}
                            {nodeLabel(
                              graph.nodes.find((n) => n.id === e.target)!,
                            )}
                          </span>
                          {['reference', 'first', 'last'].includes(e.role) && (
                            <select
                              aria-label="参考帧用途"
                              className="select"
                              value={e.role}
                              disabled={readonly}
                              onChange={(ev) =>
                                safeChange((g) => ({
                                  ...g,
                                  edges: g.edges.map((edge) =>
                                    edge.id === e.id
                                      ? {
                                          ...edge,
                                          role: ev.target
                                            .value as Graph['edges'][number]['role'],
                                        }
                                      : edge,
                                  ),
                                }))
                              }
                            >
                              <option value="reference">参考图</option>
                              <option value="first">首帧</option>
                              <option value="last">尾帧（暂不可用）</option>
                            </select>
                          )}
                          <button
                            className="icon-btn"
                            aria-label="删除连线"
                            disabled={readonly}
                            onClick={() =>
                              safeChange((g) => ({
                                ...g,
                                edges: g.edges.filter(
                                  (edge) => edge.id !== e.id,
                                ),
                              }))
                            }
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                  </>
                )}
            </>
          )}
        </div>
        <div className="live-inspector-footer">
          <span>
            {graph.nodes.length} / 500 节点 · {graph.edges.length} 条连线
          </span>
          <small>⌘ / Ctrl + Z 撤销 · D 复制 · S 保存</small>
        </div>
      </aside>
      <input
        ref={file}
        type="file"
        multiple={!replacement.current}
        hidden
        aria-label="画布上传文件"
        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
        onChange={(e) => {
          upload(Array.from(e.target.files || []));
          e.target.value = '';
        }}
      />
      {picker && (
        <ReferencePicker
          media
          selected={[]}
          max={500 - graph.nodes.length}
          onSelect={(items) => {
            addMedia(items);
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
          onError={errorText}
        />
      )}
      {preview && (
        <AssetDialog
          title={preview.name}
          preview
          onClose={() => setPreview(undefined)}
        >
          {preview.kind === 'video' ? (
            <video
              src={preview.media_url || ''}
              poster={preview.thumbnail_url || ''}
              controls
              autoPlay
              playsInline
            />
          ) : (
            <img src={preview.media_url || ''} alt={preview.name} />
          )}
          <div className="gen-actions">
            {preview.media_url && (
              <a
                className="btn btn-dark"
                href={preview.media_url}
                download={preview.name}
              >
                <Download size={14} />
                下载原文件
              </a>
            )}
          </div>
        </AssetDialog>
      )}
      {helpOpen && (
        <AssetDialog
          title="画布操作与快捷键"
          onClose={() => setHelpOpen(false)}
        >
          <div className="canvas-shortcuts">
            <p>
              拖空白处平移，拖节点移动；按住 Shift
              框选，或切换选择工具框选。空格临时平移，滚轮围绕鼠标缩放。
            </p>
            {[
              ['V / H', '选择 / 平移'],
              ['T / G / I', '文字 / 生成节点 / 上传'],
              ['双击文字', '进入编辑，Esc 结束'],
              ['双击空白 / 右键', '就地添加节点'],
              ['F / Shift+1 / Shift+0', '聚焦所选 / 全部适应 / 100%'],
              ['Shift+点击', '追加选择'],
              ['Ctrl+C / V / D', '复制 / 粘贴 / 重复'],
              ['Delete', '删除选中节点或连线'],
              ['Ctrl+Z / Shift+Z', '撤销 / 重做'],
              ['Ctrl+Enter', '运行所选生成节点'],
              ['Ctrl+S', '立即保存'],
            ].map(([key, text]) => (
              <div key={key}>
                <span>{text}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
            <p>
              文字和图片的右侧为输出；生成节点左侧为输入。可拖动端口连线，或点“继续创作”自动连接；生成仍需确认参数和积分。
            </p>
          </div>
        </AssetDialog>
      )}
      {history && (
        <AssetDialog
          title="历史版本"
          busy={busy}
          onClose={() => setHistory(undefined)}
        >
          <p>恢复会生成新的保存版本，当前未保存内容会先保存。</p>
          {history.map((h) => (
            <div className="live-history-row" key={h.id}>
              <span>
                v{h.revision} · {new Date(h.created_at).toLocaleString('zh-CN')}
              </span>
              <button
                className="btn"
                disabled={readonly || busy || h.revision === info.revision}
                onClick={() =>
                  void action(async () => {
                    await saverRef.current?.flush();
                    const result = await projectApi.restore(
                      info.id,
                      h.id,
                      saverRef.current!.revision,
                      me.csrf_token,
                    );
                    saverRef.current?.accept(result);
                    void flow.setViewport(result.graph.viewport);
                    setHistory(undefined);
                  })
                }
              >
                恢复此版本
              </button>
            </div>
          ))}
        </AssetDialog>
      )}
      {rename !== undefined && (
        <AssetDialog
          title="重命名画布"
          busy={busy}
          onClose={() => setRename(undefined)}
        >
          <input
            className="input"
            aria-label="画布名称"
            maxLength={100}
            value={rename}
            onChange={(e) => setRename(e.target.value)}
          />
          <div className="gen-actions">
            <button
              className="btn btn-dark"
              disabled={busy || !rename.trim()}
              onClick={() =>
                void action(async () => {
                  await saverRef.current?.flush();
                  const result = await projectApi.rename(
                    info.id,
                    rename,
                    saverRef.current!.revision,
                    me.csrf_token,
                  );
                  saverRef.current?.advance(result);
                  setRename(undefined);
                })
              }
            >
              保存名称
            </button>
          </div>
        </AssetDialog>
      )}
      {status === 'conflict' && (
        <AssetDialog
          title="画布已在其他页面更新"
          busy={busy}
          onClose={() => {
            setError('请先处理版本冲突，当前编辑仍保留在页面中。');
          }}
        >
          <p>
            为避免覆盖其他页面的内容，自动保存已暂停。你可以载入最新版本，或把当前编辑另存为新画布。
          </p>
          <div className="gen-actions">
            <button className="btn" disabled={busy} onClick={reloadLatest}>
              载入最新版本
            </button>
            <button className="btn btn-dark" disabled={busy} onClick={saveCopy}>
              另存副本
            </button>
          </div>
        </AssetDialog>
      )}
      {exitFailed && blocker.state === 'blocked' && (
        <AssetDialog
          title="画布尚未保存"
          busy={busy}
          onClose={() => {
            setExitFailed(false);
            blocker.reset();
          }}
        >
          <p>
            {busy
              ? '当前操作尚未完成，请稍后再离开。'
              : '保存未成功，当前内容仍保留在此页面。请重试保存后再离开。'}
          </p>
          <div className="gen-actions">
            <button
              className="btn"
              onClick={() => {
                setExitFailed(false);
                blocker.reset();
              }}
            >
              留在画布
            </button>
            <button
              className="btn btn-dark"
              disabled={busy || status === 'conflict'}
              onClick={() =>
                void saverRef.current
                  ?.flush()
                  .then(() => {
                    setExitFailed(false);
                    blocker.proceed();
                  })
                  .catch(() => {})
              }
            >
              重试保存并离开
            </button>
          </div>
        </AssetDialog>
      )}
    </div>
  );
}
