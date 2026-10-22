/** All privileged calls must be enforced again by the Rust service. Mock mode is NEVER a security boundary. */
import type {CanvasGraph,Project,User,Job,MediaKind} from './types';
import * as mock from './mockDb';
export const BACKEND_MODE=import.meta.env.VITE_API_MODE==='http';
const BASE=import.meta.env.VITE_API_BASE||'/api/v1';
async function request<T>(path:string,options:RequestInit={}){const res=await fetch(`${BASE}${path}`,{credentials:'include',headers:{'Content-Type':'application/json',...options.headers},...options});if(!res.ok){const body=await res.text();throw Error(`${res.status}: ${body.slice(0,240)}`);}return res.json() as Promise<T>;}
export async function getMe(){return BACKEND_MODE?request<User>('/me'):mock.getUser();}
export async function listProjects(){return BACKEND_MODE?request<Project[]>('/projects'):mock.userProjects();}
export async function createProject(name:string){if(!BACKEND_MODE)return mock.createProject(name);const p=await request<Project>('/projects',{method:'POST',body:JSON.stringify({name})});mock.cacheRemoteProject(p);return p;}
export async function saveGraph(projectId:string,graph:CanvasGraph,revision:number){if(!BACKEND_MODE)return mock.saveGraph(projectId,graph,revision);const p=await request<Project>(`/projects/${projectId}/graph`,{method:'PUT',headers:{'If-Match':String(revision)},body:JSON.stringify({graph,revision})});mock.cacheRemoteProject(p);return p;}
export async function createJob(params:Pick<Job,'projectId'|'nodeId'|'kind'|'prompt'|'quality'|'ratio'|'model'|'duration'|'count'|'referenceAssetIds'>,key:string){if(!BACKEND_MODE)return mock.createJob(params,key);const j=await request<Job>('/generation/jobs',{method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(params)});mock.cacheRemoteJob(j);return j;}
export async function cancelJob(id:string){return BACKEND_MODE?request(`/generation/jobs/${id}/cancel`,{method:'POST'}):mock.cancelJob(id);}
export async function quote(kind:MediaKind,quality:string,count:number,duration:number){return BACKEND_MODE?request<{credits:number}>('/generation/quotes',{method:'POST',body:JSON.stringify({kind,quality,count,duration})}):{credits:mock.quote(kind,quality,count,duration)};}
export async function devLogin(userId:string){return request('/dev/login',{method:'POST',body:JSON.stringify({userId})});}

export async function refreshServerView(){
 if(!BACKEND_MODE)return;
 const [me,projects,jobs,assets,models,wallet]=await Promise.all([
  getMe(),listProjects(),request<Job[]>('/generation/jobs'),request<import('./types').Asset[]>('/assets'),request<import('./types').CatalogModel[]>('/model-catalog'),request<{available:number}>('/wallet')
 ]);
 mock.hydrateRemote({me,projects,jobs,assets,models,wallet});
}
