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
  Controls,
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
  Settings2,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlock,
  X,
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
    !!target.closest('dialog'));
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
    [pan, setPan] = useState(false),
    [space, setSpace] = useState(false);
  const [tab, setTab] = useState<'properties' | 'layers' | 'tasks'>(
      'properties',
    ),
    [inspector, setInspector] = useState(false);
  const [quick, setQuick] = useState<GenerateData>(blankGenerator),
    [quickRefs, setQuickRefs] = useState<Asset[]>([]);
  useEffect(() => {
    if (draftRead.current) return;
    draftRead.current = true;
    const raw = search.get('draft');
    if (!raw) return;
    try {
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
    ? incoming
        .filter((e) => ['reference', 'first', 'last'].includes(e.role))
        .map((e) => graph.nodes.find((n) => n.id === e.source))
        .flatMap((n) =>
          n?.type === 'image' ? [assets.get(n.data.assetId)] : [],
        )
        .filter((a): a is Asset => !!a)
    : quickRefs;
  const center = () => {
    const bounds = root.current?.getBoundingClientRect();
    const point = flow.screenToFlowPosition({
      x: (bounds?.left || 0) + (bounds?.width || 900) / 2,
      y: (bounds?.top || 0) + (bounds?.height || 700) / 2,
    });
    const nodes = store.getState().graph.nodes;
    for (
      let i = 0;
      i < 500 &&
      nodes.some(
        (n) =>
          point.x < n.position.x + n.size.width + 30 &&
          point.x + 300 > n.position.x &&
          point.y < n.position.y + n.size.height + 30 &&
          point.y + 240 > n.position.y,
      );
      i++
    )
      point.x += 340;
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
  const run = (nodeId?: string) =>
    void action(async () => {
      if (readonly) return;
      const id = nodeId || addGenerator();
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
      const refs = linked.flatMap((e) => {
        const n = g.nodes.find((n) => n.id === e.source);
        return n?.type === 'image'
          ? [{ asset_id: n.data.assetId, role: 'reference' }]
          : [];
      });
      const text = linked.flatMap((e) => {
        const n = g.nodes.find((n) => n.id === e.source);
        return n?.type === 'text' ? [n.data.text] : [];
      });
      const body: Draft = {
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
            (e) => !ids.has(e.source) && !ids.has(e.target),
          ),
        };
      }),
    [safeChange, store],
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
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (editableTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpace(true);
      }
      if (e.key.toLowerCase() === 'h' && !mod) setPan(true);
      if (e.key.toLowerCase() === 'v' && !mod) setPan(false);
      if (readonly) return;
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
  }, [store, readonly, copy, paste, remove]);
  const add = (type: 'text' | 'generate' | 'upload' | 'library') => {
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
      position: center(),
      size: { width: 260, height: 210 },
      locked: false,
      data: { text: '' },
    };
    safeChange((g) => ({ ...g, nodes: [...g.nodes, node] }));
    store.getState().select([node.id]);
  };
  const nodes = useMemo(
    (): FlowNode[] =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'canvas',
        position: node.position,
        data: { node },
        width: node.size.width,
        height: node.size.height,
        style: { width: node.size.width, height: node.size.height },
        selected: selected.includes(node.id),
        draggable: !readonly && !node.locked,
        connectable: !readonly && !node.locked,
      })),
    [graph.nodes, selected, readonly],
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
        type: 'smoothstep',
        selectable: !readonly,
      })),
    [graph.edges, readonly],
  );
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
    if (changed.length)
      safeChange(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            if (n.locked) return n;
            let next = n;
            for (const c of changed) {
              if (!('id' in c) || c.id !== n.id) continue;
              if (c.type === 'position' && c.position)
                next = { ...next, position: c.position };
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
        }),
        false,
      );
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
    [assets, jobMap, readonly, safeChange, action, me.csrf_token, refreshAsset],
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
  return (
    <div
      className={`canvas-shell live-canvas ${readonly ? 'readonly' : ''}`}
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
        {error && (
          <div className="live-canvas-alert" role="alert">
            {error}
            <button
              className="icon-btn"
              aria-label="关闭错误提示"
              onClick={() => setError('')}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="live-canvas-notice" role="status">
            {notice}
            <button
              className="icon-btn"
              aria-label="关闭提示"
              onClick={() => setNotice('')}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div
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
              nodesDraggable={!readonly && !pan && !space}
              nodesConnectable={!readonly}
              elementsSelectable={!pan && !space}
              selectionOnDrag={!pan && !space}
              panOnDrag={pan || space ? true : [1, 2]}
              panActivationKeyCode="Space"
              multiSelectionKeyCode="Shift"
              selectionKeyCode="Shift"
              deleteKeyCode={null}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes) => {
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
              onMoveStart={() => {
                viewportChanged.current = true;
              }}
              onMoveEnd={(_, viewport) => {
                if (viewportChanged.current && !readonly)
                  safeChange((g) => ({ ...g, viewport }), false);
                viewportChanged.current = false;
              }}
              onPaneClick={() => store.getState().select([])}
              onNodeDoubleClick={(_, n) => {
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
              <Panel position="top-left" className="floating-tools">
                <button
                  className={`tool-button ${!pan ? 'active' : ''}`}
                  aria-label="选择工具"
                  onClick={() => setPan(false)}
                >
                  <MousePointer2 size={15} />
                </button>
                <button
                  className={`tool-button ${pan ? 'active' : ''}`}
                  aria-label="平移工具"
                  onClick={() => setPan(true)}
                >
                  <Hand size={15} />
                </button>
                <span className="separator" />
                <button
                  className="tool-button"
                  aria-label="添加文字节点"
                  disabled={readonly}
                  onClick={() => add('text')}
                >
                  <Type size={15} />
                </button>
                <button
                  className="tool-button"
                  aria-label="上传素材到画布"
                  disabled={readonly || busy}
                  onClick={() => add('upload')}
                >
                  <ImageIcon size={15} />
                </button>
                <button
                  className="tool-button"
                  aria-label="添加生成节点"
                  disabled={readonly}
                  onClick={() => add('generate')}
                >
                  <Sparkles size={15} />
                </button>
                <span className="separator" />
                <button
                  className="tool-button"
                  aria-label="撤销"
                  disabled={!past || readonly}
                  onClick={() => store.getState().undo()}
                >
                  <Undo2 size={15} />
                </button>
                <button
                  className="tool-button"
                  aria-label="重做"
                  disabled={!future || readonly}
                  onClick={() => store.getState().redo()}
                >
                  <Redo2 size={15} />
                </button>
              </Panel>
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={(n) =>
                  n.type === 'generate' ? '#acc6bd' : '#d8dfdf'
                }
              />
              <Panel position="bottom-center" className="canvas-bottom-hint">
                <button
                  className="icon-btn"
                  aria-label="适应画布"
                  onClick={() => void flow.fitView({ padding: 0.2 })}
                >
                  <Maximize2 size={14} />
                </button>
                <button
                  className="text-action"
                  onClick={() => void flow.zoomTo(1)}
                >
                  100%
                </button>
                <span>Space 拖动画布 · 滚轮缩放 · Shift 多选</span>
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
            </ReactFlow>
          </CanvasActions.Provider>
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
              {graph.nodes.map((n) => (
                <button
                  key={n.id}
                  className={selected.includes(n.id) ? 'selected' : ''}
                  onClick={() => {
                    store.getState().select([n.id]);
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
                <p role="alert">
                  任务列表暂不可用。
                  <button
                    className="text-action"
                    onClick={() => void jobsQuery.refetch()}
                  >
                    重试
                  </button>
                </p>
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
