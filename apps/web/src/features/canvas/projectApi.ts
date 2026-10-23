import type { components } from '../../lib/generated/api';
import { request, SessionError } from '../auth/sessionApi';
type S = components['schemas'];
export type Graph = S['CanvasGraph'];
export type GraphNode = S['CanvasNode'];
export type Project = S['ProjectView'];
export type ProjectInfo = S['ProjectInfo'];
export type GenerateData = S['GenerateData'];
export const emptyGraph = (): Graph => ({
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  background: 'dots',
});
export const projectApi = {
  export: async (id: string) => {
    const response = await fetch(`/api/v1/projects/${id}/export`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new SessionError(
        response.status,
        data?.error?.code || 'UNKNOWN',
        '导出失败',
      );
    }
    return response.blob();
  },
  import: async (file: File, csrf: string, key: string) => {
    if (file.size > 256 * 1024 * 1024)
      throw new Error('项目 ZIP 不能超过 256 MB。');
    const response = await fetch('/api/v1/projects/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-CSRF-Token': csrf,
        'Idempotency-Key': key,
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: file,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new SessionError(
        response.status,
        data?.error?.code || 'UNKNOWN',
        '导入失败',
      );
    }
    return response.json() as Promise<Project>;
  },
  list: (before?: string, signal?: AbortSignal) =>
    request<S['ProjectPage']>(
      `/projects?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  get: (id: string, signal?: AbortSignal) =>
    request<Project>(`/projects/${id}`, 'GET', undefined, undefined, signal),
  create: (name: string, csrf: string, key: string, graph = emptyGraph()) =>
    request<Project>(
      '/projects',
      'POST',
      csrf,
      { name, graph },
      undefined,
      key,
    ),
  save: (id: string, graph: Graph, revision: number, csrf: string) =>
    request<Project>(
      `/projects/${id}/graph`,
      'PUT',
      csrf,
      graph,
      undefined,
      undefined,
      revision,
    ),
  rename: (id: string, name: string, revision: number, csrf: string) =>
    request<Project>(
      `/projects/${id}`,
      'PATCH',
      csrf,
      { name },
      undefined,
      undefined,
      revision,
    ),
  delete: (id: string, revision: number, csrf: string) =>
    request<void>(
      `/projects/${id}`,
      'DELETE',
      csrf,
      undefined,
      undefined,
      undefined,
      revision,
    ),
  duplicate: (id: string, csrf: string, key: string) =>
    request<Project>(
      `/projects/${id}/duplicate`,
      'POST',
      csrf,
      undefined,
      undefined,
      key,
    ),
  snapshots: (id: string, signal?: AbortSignal) =>
    request<S['ProjectSnapshot'][]>(
      `/projects/${id}/snapshots`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  restore: (id: string, snapshot: string, revision: number, csrf: string) =>
    request<Project>(
      `/projects/${id}/snapshots/${snapshot}/restore`,
      'POST',
      csrf,
      undefined,
      undefined,
      undefined,
      revision,
    ),
};
