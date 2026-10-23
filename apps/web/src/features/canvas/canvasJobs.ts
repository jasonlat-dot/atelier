import { request } from '../auth/sessionApi';
import {
  generationApi,
  type Job,
  type Schema,
} from '../generation/generationApi';
import type { Graph, GraphNode } from './projectApi';
export async function projectJobs(
  id: string,
  graph: Graph,
  signal: AbortSignal,
) {
  const page = await request<Schema['JobPage']>(
    `/generation/jobs?limit=100&project_id=${id}`,
    'GET',
    undefined,
    undefined,
    signal,
  );
  const jobs = page.items,
    found = new Set(jobs.map((j) => j.id));
  const missing = graph.nodes.flatMap((n) =>
    n.type === 'generate' && n.data.jobId && !found.has(n.data.jobId)
      ? [n.data.jobId]
      : [],
  );
  for (let i = 0; i < missing.length; i += 8) {
    const more = await Promise.all(
      missing
        .slice(i, i + 8)
        .map((id) => generationApi.get(id, signal).catch(() => undefined)),
    );
    jobs.push(...more.filter((j): j is Job => !!j));
  }
  return jobs;
}
export function reconcileJobs(graph: Graph, jobs: Job[]): Graph {
  let nodes = graph.nodes,
    edges = graph.edges;
  const ids = new Set(nodes.map((n) => n.id));
  const latest = new Map<string, Job>();
  for (const job of [...jobs].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  ))
    if (job.node_id) latest.set(job.node_id, job);
  for (const job of latest.values()) {
    const source = nodes.find((n) => n.id === job.node_id);
    if (!source || source.type !== 'generate') continue;
    const done = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(
      job.status,
    );
    const alreadyApplied =
      source.data.jobId === job.id && source.data.status === job.status && done;
    if (
      source.data.jobId !== job.id ||
      source.data.status !== job.status ||
      source.data.error !== job.error_code
    )
      nodes = nodes.map((n) =>
        n.id === source.id
          ? {
              ...source,
              data: {
                ...source.data,
                jobId: job.id,
                status: job.status,
                error: job.error_code,
              },
            }
          : n,
      );
    if (alreadyApplied) continue;
    for (const output of job.outputs) {
      const id = `${job.id}_${output.idx}`,
        asset = output.asset;
      if (ids.has(id) || nodes.length >= 500 || edges.length >= 1000) continue;
      const gen = {
        jobId: job.id,
        modelId: job.model_id,
        prompt: job.prompt,
        quality: job.params.quality,
        ratio: job.params.ratio,
        resolution: job.params.resolution,
        size: job.size,
        n: job.n,
        references: job.params.references.map((r) => r.asset_id),
      };
      const base = {
        id,
        position: {
          x:
            source.position.x +
            source.size.width +
            100 +
            (output.idx % 2) * 330,
          y: source.position.y + Math.floor(output.idx / 2) * 320,
        },
        size: { width: 290, height: 260 },
        locked: false,
      };
      const data = {
        assetId: asset.id,
        naturalW: asset.width || 1,
        naturalH: asset.height || 1,
        label: asset.name.slice(0, 100),
        gen,
      };
      const node: GraphNode =
        asset.kind === 'video'
          ? {
              ...base,
              type: 'video',
              data: { ...data, durationMs: asset.duration_ms },
            }
          : { ...base, type: 'image', data };
      ids.add(id);
      nodes = [...nodes, node];
      edges = [
        ...edges,
        { id: `result_${id}`, source: source.id, target: id, role: 'result' },
      ];
    }
  }
  return nodes === graph.nodes && edges === graph.edges
    ? graph
    : { ...graph, nodes, edges };
}
