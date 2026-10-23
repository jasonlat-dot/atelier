import type { components } from '../../lib/generated/api';
import { request } from '../auth/sessionApi';
export type Schema = components['schemas'];
export type Job = Schema['JobView'];
export type Draft = Schema['JobInput'];
export const generationApi = {
  catalog: (signal?: AbortSignal) =>
    request<Schema['Catalog']>('/models', 'GET', undefined, undefined, signal),
  limits: (signal?: AbortSignal) =>
    request<Schema['GenerationLimits']>(
      '/generation/limits',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  quote: (body: Schema['QuoteInput'], csrf: string, signal?: AbortSignal) =>
    request<Schema['Quote']>('/generation/quote', 'POST', csrf, body, signal),
  create: (body: Draft, csrf: string, key: string) =>
    request<Schema['JobReceipt']>(
      '/generation/jobs',
      'POST',
      csrf,
      body,
      undefined,
      key,
    ),
  list: (before?: string, signal?: AbortSignal) =>
    request<Schema['JobPage']>(
      `/generation/jobs?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  get: (id: string, signal?: AbortSignal) =>
    request<Schema['JobReceipt']>(
      `/generation/jobs/${encodeURIComponent(id)}`,
      'GET',
      undefined,
      undefined,
      signal,
    ).then((receipt) => receipt.job),
  cancel: (id: string, csrf: string) =>
    request<Schema['JobReceipt']>(
      `/generation/jobs/${encodeURIComponent(id)}/cancel`,
      'POST',
      csrf,
    ),
  deleteHistory: (id: string, csrf: string) =>
    request<void>(
      `/generation/jobs/${encodeURIComponent(id)}/history`,
      'DELETE',
      csrf,
    ),
};
export const active = (job: Job) =>
  ['QUEUED', 'ROUTING', 'RUNNING', 'STORING'].includes(job.status);
export const statuses: Record<string, string> = {
  QUEUED: '排队中',
  ROUTING: '等待可用账号',
  RUNNING: '生成中',
  STORING: '保存结果中',
  SUCCEEDED: '生成完成',
  PARTIAL: '部分完成',
  FAILED: '生成失败',
  CANCELLED: '已取消',
};
export const failures: Record<string, string> = {
  CONTENT_POLICY: '内容未通过审核，请修改描述后重新生成。',
  NO_CAPACITY: '暂时没有可用账号，请稍后再试。',
  TIMEOUT: '生成超时，未产出的积分已退回。',
  WORKER_LOST: '任务执行中断，未产出的积分已退回。',
  STORAGE_FAILED: '结果保存失败，未产出的积分已退回。',
  ACCOUNT_INVALID: '生成服务暂不可用，请稍后再试。',
  UPSTREAM_ERROR: '生成服务暂时异常，未产出的积分已退回。',
  RATE_LIMITED: '生成服务繁忙，请稍后再试。',
  MODEL_UNAVAILABLE: '模型配置已变更或暂不可用，请重新选择模型。',
  ASSET_UNAVAILABLE: '参考图片已删除或过期，请重新选择。',
  LOCAL_ERROR: '生成处理暂时失败，未产出的积分已退回。',
  MODEL_CHANGED: '模型配置已更新，请重新选择模型。',
  BAD_REQUEST: '模型不支持当前参数，请调整后重试。',
};
