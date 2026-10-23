import { createStore } from 'zustand/vanilla';
import type { Graph, GraphNode } from './projectApi';
export type EditorState = {
  graph: Graph;
  sequence: number;
  selected: string[];
  past: Graph[];
  future: Graph[];
  checkpoint?: Graph;
  change: (fn: (graph: Graph) => Graph, history?: boolean) => void;
  preview: (fn: (graph: Graph) => Graph) => void;
  begin: () => void;
  end: () => void;
  select: (ids: string[]) => void;
  reset: (graph: Graph) => void;
  undo: () => void;
  redo: () => void;
};
export const createEditorStore = (graph: Graph) =>
  createStore<EditorState>((set) => ({
    graph,
    sequence: 0,
    selected: [],
    past: [],
    future: [],
    change: (fn, history = true) =>
      set((s) => {
        const graph = fn(s.graph);
        if (
          graph === s.graph ||
          JSON.stringify(graph) === JSON.stringify(s.graph)
        )
          return s;
        if (
          graph.nodes.length > 500 ||
          graph.edges.length > 1000 ||
          new TextEncoder().encode(JSON.stringify(graph)).length >
            2 * 1024 * 1024
        )
          throw new Error(
            '画布已达到容量上限（500 个节点、1000 条连线、2 MB），请拆分为多个项目。',
          );
        return {
          graph,
          sequence: s.sequence + 1,
          past:
            history && !s.checkpoint ? [...s.past, s.graph].slice(-50) : s.past,
          future: history ? [] : s.future,
        };
      }),
    // Pointer frames update positions only. Serialize/save once when the gesture ends.
    preview: (fn) => set((s) => ({ graph: fn(s.graph) })),
    begin: () => set((s) => ({ checkpoint: s.checkpoint || s.graph })),
    end: () =>
      set((s) => ({
        past:
          s.checkpoint && s.checkpoint !== s.graph
            ? [...s.past, s.checkpoint].slice(-50)
            : s.past,
        checkpoint: undefined,
        sequence:
          s.checkpoint && s.checkpoint !== s.graph
            ? s.sequence + 1
            : s.sequence,
        future: s.checkpoint && s.checkpoint !== s.graph ? [] : s.future,
      })),
    select: (selected) =>
      set((s) =>
        s.selected.length === selected.length &&
        s.selected.every((id, i) => id === selected[i])
          ? s
          : { selected },
      ),
    reset: (graph) =>
      set((s) => ({
        graph,
        selected: [],
        past: [],
        future: [],
        checkpoint: undefined,
        sequence: s.sequence + 1,
      })),
    undo: () =>
      set((s) =>
        s.past.length
          ? {
              graph: s.past[s.past.length - 1],
              past: s.past.slice(0, -1),
              future: [s.graph, ...s.future].slice(0, 50),
              selected: [],
              sequence: s.sequence + 1,
            }
          : s,
      ),
    redo: () =>
      set((s) =>
        s.future.length
          ? {
              graph: s.future[0],
              past: [...s.past, s.graph].slice(-50),
              future: s.future.slice(1),
              selected: [],
              sequence: s.sequence + 1,
            }
          : s,
      ),
  }));
export type EditorStore = ReturnType<typeof createEditorStore>;
export function nodeLabel(node: GraphNode): string {
  return node.type === 'text'
    ? node.data.text.slice(0, 20) || '文字节点'
    : node.type === 'generate'
      ? '生成节点'
      : node.data.label || (node.type === 'image' ? '图片' : '视频');
}
export function connectionIssue(
  graph: Graph,
  source: string,
  target: string,
): string | undefined {
  const a = graph.nodes.find((n) => n.id === source),
    b = graph.nodes.find((n) => n.id === target);
  if (!a || !b) return '连接的节点已经不存在。';
  if (source === target) return '节点不能连接自己。';
  if (graph.edges.some((e) => e.source === source && e.target === target))
    return '这两个节点已经连接。';
  if (!(
    (['text', 'image'].includes(a.type) && b.type === 'generate') ||
    (a.type === 'generate' && ['image', 'video'].includes(b.type))
  ))
    return '把文字或图片的输出端连接到生成节点左侧的输入端。';
  const seen = new Set<string>(),
    stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === source) return '这条连线会形成循环，请调整连接方向。';
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(
      ...graph.edges.filter((e) => e.source === id).map((e) => e.target),
    );
  }
}
export function connect(
  graph: Graph,
  source: string,
  target: string,
  role?: Graph['edges'][number]['role'],
): Graph {
  const issue = connectionIssue(graph, source, target);
  if (issue) throw new Error(issue);
  const sourceNode = graph.nodes.find((n) => n.id === source)!;
  const inferred =
    sourceNode.type === 'text'
      ? 'prompt'
      : sourceNode.type === 'image'
        ? 'reference'
        : 'result';
  return {
    ...graph,
    edges: [
      ...graph.edges,
      { id: crypto.randomUUID(), source, target, role: role || inferred },
    ],
  };
}
export function pasteNodes(
  graph: Graph,
  nodes: GraphNode[],
  edges: Graph['edges'],
): Graph {
  const ids = new Map(nodes.map((n) => [n.id, crypto.randomUUID()]));
  const copies = nodes.map(
    (n): GraphNode =>
      ({
        ...structuredClone(n),
        id: ids.get(n.id)!,
        locked: false,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        ...(n.type === 'generate'
          ? { data: { ...n.data, jobId: null, status: 'IDLE', error: null } }
          : {}),
      }) as GraphNode,
  );
  return {
    ...graph,
    nodes: [...graph.nodes, ...copies],
    edges: [
      ...graph.edges,
      ...edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          ...e,
          id: crypto.randomUUID(),
          source: ids.get(e.source)!,
          target: ids.get(e.target)!,
        })),
    ],
  };
}
