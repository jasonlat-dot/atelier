import { request, SessionError } from '../auth/sessionApi';
import type { components } from '../../lib/generated/api';
export type S = components['schemas'];
export type Turn = S['ChatTurn'];
export type ChatEvent = S['ChatEvent'];
export class StreamFailure extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const chatApi = {
  config: (signal?: AbortSignal) =>
    request<S['ChatConfig']>(
      '/chat/config',
      'GET',
      undefined,
      undefined,
      signal,
    ),
  list: (before?: string, signal?: AbortSignal) =>
    request<S['ConversationPage']>(
      `/chat/conversations${before ? `?before=${before}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  get: (id: string, before?: string, signal?: AbortSignal) =>
    request<S['ConversationView']>(
      `/chat/conversations/${id}${before ? `?before=${before}` : ''}`,
      'GET',
      undefined,
      undefined,
      signal,
    ),
  create: (title: string, csrf: string, key: string) =>
    request<S['Conversation']>(
      '/chat/conversations',
      'POST',
      csrf,
      { title },
      undefined,
      key,
    ),
  rename: (id: string, title: string, csrf: string) =>
    request<S['Conversation']>(`/chat/conversations/${id}`, 'PATCH', csrf, {
      title,
    }),
  delete: (id: string, csrf: string) =>
    request<void>(`/chat/conversations/${id}`, 'DELETE', csrf),
  cancel: (id: string, csrf: string) =>
    request<void>(`/chat/turns/${id}/cancel`, 'POST', csrf),
  send: async (
    id: string,
    input: S['SendMessage'],
    csrf: string,
    key: string,
    signal: AbortSignal,
    onEvent: (event: ChatEvent) => void,
  ): Promise<Turn> => {
    const response = await fetch(`/api/v1/chat/conversations/${id}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-CSRF-Token': csrf,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(input),
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new SessionError(
        response.status,
        data?.error?.code || 'UNKNOWN',
        '发送未成功',
      );
    }
    if (
      !response.body ||
      !response.headers.get('content-type')?.startsWith('text/event-stream')
    )
      throw new Error('回复流格式异常，请核对上次请求。');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '',
      total = 0,
      done: Turn | undefined;
    try {
      while (true) {
        const { value, done: ended } = await reader.read();
        if (ended) {
          buffer += decoder.decode();
          break;
        }
        total += value.length;
        if (total > 2 * 1024 * 1024) throw new Error('回复超过大小限制。');
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          '\n',
        );
        if (buffer.length > 131072) throw new Error('回复事件超过大小限制。');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:'))
              data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          if (!['delta', 'intent', 'action', 'done', 'error'].includes(event))
            continue;
          const item = {
            event,
            data: JSON.parse(data.join('\n')),
          } as ChatEvent;
          onEvent(item);
          if (item.event === 'error') throw new StreamFailure(item.data.code);
          if (item.event === 'done') {
            done = item.data;
            await reader.cancel();
            return done;
          }
        }
      }
      throw new Error('回复连接已中断，请核对上次请求后继续。');
    } finally {
      reader.releaseLock();
    }
  },
};
