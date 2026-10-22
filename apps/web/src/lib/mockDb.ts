import { seedDb } from './seed';
import type {
  DB,
  Job,
  Project,
  CanvasGraph,
  User,
  Asset,
  MediaKind,
  CatalogModel,
} from './types';
const KEY = 'atelier-react-v1';
const stamp = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
let db: DB = load();
const subscribers = new Set<() => void>();
function load(): DB {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value = JSON.parse(raw) as DB;
      if (value.users?.length && value.projects) return value;
    }
  } catch {
    /* reset demo */
  }
  return seedDb();
}
function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('画布本地存储已满，请导出 JSON 后清理媒体数据。', e);
  }
  subscribers.forEach((fn) => fn());
}
export const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};
export const snapshot = () => db;
export const currentUser = () =>
  db.users.find((u) => u.id === db.currentUserId)!;
export const switchUser = (id: string) => {
  if (!db.users.some((u) => u.id === id)) throw Error('Unknown demo user');
  db = { ...db, currentUserId: id };
  commit();
};
export const userProjects = () =>
  db.projects.filter((p) => p.ownerId === db.currentUserId);
export const userAssets = () =>
  db.assets.filter((a) => a.ownerId === db.currentUserId);
export const userJobs = () =>
  db.jobs.filter((j) => j.ownerId === db.currentUserId);
export function createProject(name = '未命名画布'): Project {
  const p: Project = {
    id: uuid(),
    ownerId: db.currentUserId,
    name,
    revision: 0,
    updatedAt: stamp(),
    graph: { nodes: [], edges: [], viewport: { x: 100, y: 80, zoom: 1 } },
  };
  db = { ...db, projects: [p, ...db.projects] };
  commit();
  return p;
}
export function saveGraph(
  projectId: string,
  graph: CanvasGraph,
  expectedRevision: number,
): Project {
  const project = db.projects.find(
    (p) => p.id === projectId && p.ownerId === db.currentUserId,
  );
  if (!project) throw Error('无权限或项目不存在');
  if (project.revision !== expectedRevision) throw Error('REVISION_CONFLICT');
  if (graph.nodes.length > 800 || graph.edges.length > 1600)
    throw Error('画布规模超过演示限制');
  const updated = {
    ...project,
    revision: project.revision + 1,
    graph,
    updatedAt: stamp(),
  };
  db = {
    ...db,
    projects: db.projects.map((p) => (p.id === projectId ? updated : p)),
  };
  commit();
  return updated;
}
export function renameProject(projectId: string, name: string) {
  db = {
    ...db,
    projects: db.projects.map((p) =>
      p.id === projectId && p.ownerId === db.currentUserId
        ? { ...p, name, updatedAt: stamp() }
        : p,
    ),
  };
  commit();
}
export function addAsset(
  kind: MediaKind,
  name: string,
  src: string,
  poster?: string,
) {
  const asset: Asset = {
    id: uuid(),
    ownerId: db.currentUserId,
    kind,
    name,
    src,
    poster,
    createdAt: stamp(),
  };
  db = { ...db, assets: [asset, ...db.assets] };
  commit();
  return asset;
}
export function quote(
  kind: MediaKind,
  quality: string,
  count: number,
  duration: number,
) {
  const rate = kind === 'video' ? 18 : 12;
  const q =
    quality === 'high' || quality === '1080p'
      ? 2
      : quality === 'medium' || quality === '720p'
        ? 1.5
        : 1;
  return Math.ceil(rate * q * count * (kind === 'video' ? duration : 1));
}
export function createJob(
  payload: Pick<
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
  const dupe = db.jobs.find(
    (j) => j.ownerId === db.currentUserId && j.idempotencyKey === key,
  );
  if (dupe) {
    if (
      dupe.projectId !== payload.projectId ||
      dupe.model !== payload.model ||
      dupe.prompt !== payload.prompt
    )
      throw Error('幂等键已被用于其他请求');
    return dupe;
  }
  const user = currentUser();
  if (
    payload.referenceAssetIds?.some(
      (id) => !db.assets.some((a) => a.id === id && a.ownerId === user.id),
    )
  )
    throw Error('无权使用该参考素材');
  if (user.disabled) throw Error('账号已禁用');
  const project = db.projects.find(
    (p) => p.id === payload.projectId && p.ownerId === user.id,
  );
  if (!project) throw Error('项目不存在或无权限');
  const model = db.models.find(
    (m) => m.id === payload.model && m.enabled && m.kind === payload.kind,
  );
  if (!model) throw Error('模型不可用');
  const cost = quote(
    payload.kind,
    payload.quality,
    payload.count,
    payload.duration ?? 6,
  );
  if (user.credits < cost) throw Error('积分不足');
  const job: Job = {
    ...payload,
    id: uuid(),
    ownerId: user.id,
    cost,
    status: 'queued',
    progress: 0,
    charged: false,
    createdAt: stamp(),
    updatedAt: stamp(),
    resultAssetIds: [],
    idempotencyKey: key,
  };
  db = {
    ...db,
    users: db.users.map((u) =>
      u.id === user.id ? { ...u, credits: u.credits - cost } : u,
    ),
    jobs: [job, ...db.jobs],
    ledger: [
      {
        id: uuid(),
        userId: user.id,
        amount: -cost,
        reason: '任务积分预占',
        at: stamp(),
        jobId: job.id,
      },
      ...db.ledger,
    ],
  };
  commit();
  return job;
}
export function cancelJob(jobId: string) {
  const job = db.jobs.find(
    (j) => j.id === jobId && j.ownerId === db.currentUserId,
  );
  if (!job || ['cancelled', 'completed', 'failed'].includes(job.status)) return;
  db = {
    ...db,
    jobs: db.jobs.map((j) =>
      j.id === jobId ? { ...j, status: 'cancelled', updatedAt: stamp() } : j,
    ),
    users: db.users.map((u) =>
      u.id === job.ownerId ? { ...u, credits: u.credits + job.cost } : u,
    ),
    ledger: [
      {
        id: uuid(),
        userId: job.ownerId,
        amount: job.cost,
        reason: '任务取消·积分释放',
        jobId: job.id,
        at: stamp(),
      },
      ...db.ledger,
    ],
  };
  commit();
}
export function advanceJobs() {
  let changed = false;
  const added: Asset[] = [];
  const jobs = db.jobs.map((j) => {
    if (['completed', 'failed', 'cancelled'].includes(j.status)) return j;
    changed = true;
    const progress = Math.min(100, j.progress + (j.kind === 'video' ? 6 : 12));
    const status: Job['status'] =
      progress >= 100
        ? 'completed'
        : progress >= 25
          ? 'generating'
          : progress >= 12
            ? 'routing'
            : 'queued';
    let resultAssetIds = j.resultAssetIds;
    if (status === 'completed') {
      const name = `${j.kind === 'video' ? '视频' : '图片'} · ${j.prompt.slice(0, 16) || '未命名'}`;
      const asset: Asset = {
        id: uuid(),
        ownerId: j.ownerId,
        kind: j.kind,
        src:
          j.kind === 'video'
            ? '/assets/sample-motion.mp4'
            : '/assets/art-dusk.svg',
        poster: j.kind === 'video' ? '/assets/video-frame.png' : undefined,
        name,
        createdAt: stamp(),
      };
      added.push(asset);
      resultAssetIds = [asset.id];
    }
    return {
      ...j,
      progress,
      status,
      resultAssetIds,
      charged: status === 'completed',
      updatedAt: stamp(),
    };
  });
  if (changed) {
    db = { ...db, jobs, assets: [...added, ...db.assets] };
    commit();
  }
}
export function checkIn() {
  const user = currentUser();
  const d = new Date().toISOString().slice(0, 10);
  if (db.checkin[user.id] === d) return false;
  db = {
    ...db,
    checkin: { ...db.checkin, [user.id]: d },
    users: db.users.map((u) =>
      u.id === user.id ? { ...u, credits: u.credits + 20 } : u,
    ),
    ledger: [
      {
        id: uuid(),
        userId: user.id,
        amount: 20,
        reason: '每日签到',
        at: stamp(),
      },
      ...db.ledger,
    ],
  };
  commit();
  return true;
}
export function addCredits(userId: string, amount: number) {
  const actor = currentUser();
  if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) throw Error('Forbidden');
  if (!Number.isInteger(amount) || Math.abs(amount) > 100000)
    throw Error('Invalid amount');
  db = {
    ...db,
    users: db.users.map((u) =>
      u.id === userId ? { ...u, credits: Math.max(0, u.credits + amount) } : u,
    ),
    ledger: [
      { id: uuid(), userId, amount, reason: '管理员调整（演示）', at: stamp() },
      ...db.ledger,
    ],
  };
  commit();
}
export function toggleUser(userId: string) {
  if (!['ADMIN', 'SUPER_ADMIN'].includes(currentUser().role))
    throw Error('Forbidden');
  if (userId === db.currentUserId) throw Error('Cannot disable self');
  db = {
    ...db,
    users: db.users.map((u) =>
      u.id === userId ? { ...u, disabled: !u.disabled } : u,
    ),
  };
  commit();
}
export function toggleModel(modelId: string) {
  if (!['ADMIN', 'SUPER_ADMIN'].includes(currentUser().role))
    throw Error('Forbidden');
  db = {
    ...db,
    models: db.models.map((m) =>
      m.id === modelId ? { ...m, enabled: !m.enabled } : m,
    ),
  };
  commit();
}
export function resetDemo() {
  db = seedDb();
  commit();
}
export function getModels(): CatalogModel[] {
  return db.models;
}
export function getUser(): User {
  return currentUser();
}
