/** Development-only adapter. The production entry never imports this module. */
import type { CanvasGraph, Job, MediaKind } from './types';
import * as mock from './mockDb';
export const BACKEND_MODE = false;
export async function createProject(name: string) {
  return mock.createProject(name);
}
export async function saveGraph(
  id: string,
  graph: CanvasGraph,
  revision: number,
) {
  return mock.saveGraph(id, graph, revision);
}
export async function createJob(
  params: Pick<
    Job,
    | 'projectId'
    | 'nodeId'
    | 'kind'
    | 'prompt'
    | 'quality'
    | 'ratio'
    | 'model'
    | 'duration'
    | 'count'
    | 'referenceAssetIds'
  >,
  key: string,
) {
  return mock.createJob(params, key);
}
export async function cancelJob(id: string) {
  return mock.cancelJob(id);
}
export async function quote(
  kind: MediaKind,
  quality: string,
  count: number,
  duration: number,
) {
  return { credits: mock.quote(kind, quality, count, duration) };
}
