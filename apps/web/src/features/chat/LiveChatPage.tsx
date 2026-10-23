import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useNavigate, useBlocker } from 'react-router-dom';
import {
  ArrowUp,
  Plus,
  MessageSquare,
  Sparkles,
  Copy,
  RefreshCw,
  Square,
  PanelRightClose,
  PanelLeft,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { SessionError, type Me } from '../auth/sessionApi';
import AssetDialog from '../assets/AssetDialog';
import { walletApi } from '../wallet/walletApi';
import { useWalletSummaryUpdate } from '../workspace/WorkspaceShell';
import {
  chatApi,
  StreamFailure,
  type S,
  type Turn,
  type ChatEvent,
} from './chatApi';
import SafeMarkdown from './SafeMarkdown';
import './LiveChat.css';
type Props = { me: Me; onExpired: () => void; onReload: () => void };
type Streaming = {
  id?: string;
  content: string;
  reply: string;
  intent?: S['Intent'];
  action?: S['CanvasAction'];
};
const names: Record<string, string> = {
  CHAT: '创作讨论',
  IMAGE_GENERATE: '图像创作',
  IMAGE_EDIT: '图像编辑',
  PROMPT_REFINE: '提示词润色',
  CANVAS_ASSIST: '画布规划',
  UNSAFE: '内容不支持',
};
export default function LiveChatPage({ me, onExpired, onReload }: Props) {
  const { id } = useParams(),
    navigate = useNavigate(),
    queries = useQueryClient(),
    updateWallet = useWalletSummaryUpdate();
  const [created, setCreated] = useState<string>(),
    [input, setInput] = useState(''),
    [model, setModel] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [streaming, setStreaming] = useState<Streaming>(),
    [contextOpen, setContextOpen] = useState(window.innerWidth >= 1280),
    [historyOpen, setHistoryOpen] = useState(false);
  const [before, setBefore] = useState<string>(),
    [older, setOlder] = useState<Turn[]>([]),
    [dialog, setDialog] = useState<'rename' | 'delete'>(),
    [title, setTitle] = useState('');
  const effective = id || created,
    controller = useRef<AbortController>(),
    submission = useRef<{ id: string; key: string; body: S['SendMessage'] }>(),
    lock = useRef(false),
    streamId = useRef<string>(),
    bottom = useRef<HTMLDivElement>(null),
    pendingCreate = useRef<{ key: string; title: string }>();
  const list = useQuery({
    queryKey: ['chat-list', me.user.id, before],
    queryFn: ({ signal }) => chatApi.list(before, signal),
    staleTime: 0,
  });
  const config = useQuery({
    queryKey: ['chat-config', me.user.id],
    queryFn: ({ signal }) => chatApi.config(signal),
    staleTime: 30000,
  });
  const view = useQuery({
    queryKey: ['chat-view', me.user.id, effective],
    queryFn: ({ signal }) => chatApi.get(effective!, undefined, signal),
    enabled: !!effective,
    refetchInterval: (query) =>
      query.state.data?.turns.some((t) => t.status === 'RUNNING')
        ? 3000
        : false,
  });
  const failed = useCallback(
    (e: unknown) => {
      if (e instanceof SessionError) {
        if (e.status === 401 || e.code === 'ACCOUNT_DISABLED') onExpired();
        if (e.code === 'MFA_REQUIRED') onReload();
        if (e.status === 402) return '可用积分不足，请查看积分余额。';
        if (e.code === 'CHAT_MODEL_UNAVAILABLE')
          return '还没有可用对话模型，请管理员配置 chat 模型并绑定账号。';
        if (e.code === 'CHAT_BUSY')
          return '上一条回复仍在处理中，请稍后核对或停止该回复。';
        if (e.code === 'CONTENT_POLICY')
          return '内容不支持，请调整描述后再试。';
        if (e.code === 'CONTEXT_LIMIT')
          return '上下文已达到当前模型预算，请新建会话继续。';
        if (e.status === 404) return '会话已删除或不可访问。';
        if (e.status === 429) return '请求过于频繁，请稍后重试。';
      }
      if (e instanceof StreamFailure)
        return e.code === 'CONTEXT_LIMIT'
          ? '上下文整理未完成，未扣积分；可重试或新建会话。'
          : e.code === 'CANCELLED'
            ? '回复已停止，未扣积分。'
            : '回复未完成，未扣积分，请稍后重试。';
      return e instanceof Error ? e.message : '连接暂时异常，请重试。';
    },
    [onExpired, onReload],
  );
  useEffect(() => {
    if (config.data?.models.length && !model)
      setModel(config.data.models[0].id);
  }, [config.data, model]);
  useEffect(() => {
    for (const e of [view.error, list.error, config.error])
      if (e instanceof SessionError && [401, 403].includes(e.status)) failed(e);
  }, [view.error, list.error, config.error, failed]);
  useEffect(() => {
    setCreated(undefined);
    setOlder([]);
    setHistoryOpen(false);
    setError('');
    setUncertain(false);
    submission.current = undefined;
    pendingCreate.current = undefined;
    setStreaming(undefined);
  }, [id]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [streaming?.reply, view.data?.turns.length]);
  const refresh = useCallback(
    async (conversation?: string) => {
      await queries.invalidateQueries({ queryKey: ['chat-list', me.user.id] });
      if (conversation) {
        const result = await chatApi.get(conversation);
        queries.setQueryData(['chat-view', me.user.id, conversation], result);
      }
      updateWallet(await walletApi.summary());
    },
    [queries, me.user.id, updateWallet],
  );
  const send = async (content = input, retry = false) => {
    if (
      lock.current ||
      (!content.trim() && !retry) ||
      (retry && !submission.current)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let conversation = effective;
    const abort = new AbortController();
    controller.current = abort;
    try {
      let request = retry ? submission.current : undefined;
      if (!request) {
        if (!conversation) {
          if (!pendingCreate.current)
            pendingCreate.current = {
              key: crypto.randomUUID(),
              title: content.trim().slice(0, 80) || '新对话',
            };
          const next = await chatApi.create(
            pendingCreate.current.title,
            me.csrf_token,
            pendingCreate.current.key,
          );
          conversation = next.id;
          setCreated(next.id);
          pendingCreate.current = undefined;
        }
        request = {
          id: conversation,
          key: crypto.randomUUID(),
          body: { model_id: model, content: content.trim() },
        };
        submission.current = request;
      }
      conversation = request.id;
      setUncertain(false);
      setStreaming({ content: request.body.content, reply: '' });
      streamId.current = undefined;
      if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const event = (event: ChatEvent) => {
        if (event.event === 'delta') {
          streamId.current = event.data.turn_id;
          setStreaming((old) =>
            old
              ? {
                  ...old,
                  id: event.data.turn_id,
                  reply: old.reply + event.data.text,
                }
              : old,
          );
        }
        if (event.event === 'intent')
          setStreaming((old) => (old ? { ...old, intent: event.data } : old));
        if (event.event === 'action')
          setStreaming((old) => (old ? { ...old, action: event.data } : old));
      };
      const result = await chatApi.send(
        request.id,
        request.body,
        me.csrf_token,
        request.key,
        abort.signal,
        event,
      );
      submission.current = undefined;
      setInput('');
      setStreaming(undefined);
      setNotice(
        `回复已保存${result.charged ? `，本次 ${result.charged} 积分` : '，本次免费'}。`,
      );
      await refresh(request.id).catch(() =>
        setNotice('回复已完成并保存，列表暂未刷新，可重新加载查看。'),
      );
      controller.current = undefined;
      if (!id) navigate(`/chat/${request.id}`, { replace: true });
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      const definitive =
        e instanceof StreamFailure ||
        (e instanceof SessionError && e.status < 500 && e.code !== 'CHAT_BUSY');
      if (aborted || definitive) {
        submission.current = undefined;
        setUncertain(false);
        setStreaming(undefined);
        if (aborted) setNotice('回复已停止，未完成部分不会扣积分。');
        else setError(failed(e));
      } else {
        setUncertain(true);
        setError(
          '连接中断，提交结果尚未确认。请先核对上次请求，避免重复发送。',
        );
      }
      if (conversation) await refresh(conversation).catch(() => {});
    } finally {
      controller.current = undefined;
      lock.current = false;
      setBusy(false);
    }
  };
  const stop = () => {
    if (streamId.current)
      void chatApi.cancel(streamId.current, me.csrf_token).catch(() => {});
    controller.current?.abort();
  };
  const blocker = useBlocker(() => !!controller.current);
  const busyTurn = view.data?.turns.find((t) => t.status === 'RUNNING');
  const act = async (fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      setDialog(undefined);
    } catch (e) {
      setError(failed(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => setNotice('已复制回复。'))
      .catch(() => setError('复制未完成，请选择文字手动复制。'));
  const card = (action: S['CanvasAction']) =>
    action.type === 'open_canvas' && (
      <div className="live-chat-action">
        <Sparkles size={18} />
        <div>
          <strong>把想法带到画布</strong>
          <p>仅填入创作草稿，生成前还需确认模型、参数与积分。</p>
          <Link
            className="btn btn-dark"
            to={`/canvas/new?draft=${encodeURIComponent(JSON.stringify(action.draft))}`}
          >
            在画布中生成
          </Link>
        </div>
      </div>
    );
  const turns = [...older, ...(view.data?.turns || [])].filter(
    (t, i, array) =>
      array.findIndex((a) => a.id === t.id) === i && t.id !== streaming?.id,
  );
  return (
    <div className="chat-layout live-chat">
      <aside
        className={`thread-sidebar ${historyOpen ? 'open' : ''}`}
        aria-label="历史对话"
      >
        <div className="mini-head">
          <strong>历史对话</strong>
          <button
            className="icon-btn"
            aria-label="新建对话"
            disabled={busy}
            onClick={() => {
              navigate('/chat');
              setCreated(undefined);
              setInput('');
              setStreaming(undefined);
              setUncertain(false);
              submission.current = undefined;
              setError('');
            }}
          >
            <Plus size={17} />
          </button>
          <button
            className="icon-btn chat-history-close"
            aria-label="关闭对话列表"
            onClick={() => setHistoryOpen(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="thread-list">
          {list.isPending && <p role="status">正在加载对话…</p>}
          {list.isError && (
            <p role="alert">
              列表加载失败。
              <button
                className="text-action"
                onClick={() => void list.refetch()}
              >
                重新加载对话
              </button>
            </p>
          )}
          {list.data?.items.map((c) => (
            <Link
              className={effective === c.id ? 'selected' : ''}
              key={c.id}
              to={`/chat/${c.id}`}
            >
              <MessageSquare size={15} />
              <span>{c.title}</span>
            </Link>
          ))}
          {list.data?.items.length === 0 && (
            <p className="empty-caption">从一个想法开始，保存你的创作讨论。</p>
          )}
        </div>
        <div className="gen-actions">
          <button
            className="text-action"
            disabled={!before}
            onClick={() => setBefore(undefined)}
          >
            首批
          </button>
          <button
            className="text-action"
            disabled={!list.data?.next_cursor}
            onClick={() => setBefore(list.data?.next_cursor || undefined)}
          >
            更早对话
          </button>
        </div>
      </aside>
      <section className="conversation">
        <div className="chat-header">
          <button
            className="icon-btn chat-history-toggle"
            aria-label="展开对话列表"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <PanelLeft size={17} />
          </button>
          <div>
            <strong>{view.data?.conversation.title || '新的创作讨论'}</strong>
            <p>真实流式对话 · 仅本人可见</p>
          </div>
          <div className="gen-actions">
            {effective && (
              <>
                <button
                  className="icon-btn"
                  aria-label="重命名对话"
                  disabled={busy}
                  onClick={() => {
                    setTitle(view.data?.conversation.title || '新对话');
                    setDialog('rename');
                  }}
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="icon-btn"
                  aria-label="删除当前对话"
                  disabled={busy}
                  onClick={() => setDialog('delete')}
                >
                  <Trash2 size={15} />
                </button>
              </>
            )}
            <button
              className="btn btn-light"
              onClick={() => setContextOpen(!contextOpen)}
              aria-expanded={contextOpen}
            >
              <PanelRightClose size={15} />
              智能上下文
            </button>
          </div>
        </div>
        <div className="chat-messages" aria-label="对话消息" aria-live="polite">
          {view.isError && (
            <p role="alert">
              {failed(view.error)}
              <button
                className="text-action"
                onClick={() => void view.refetch()}
              >
                重新加载消息
              </button>
            </p>
          )}
          {!effective && !busy && (
            <div className="live-chat-empty">
              <div className="live-chat-mark">
                <Sparkles size={27} />
              </div>
              <span className="eyebrow">A LITTLE SPACE FOR YOUR NEXT IDEA</span>
              <h1>从一个想法，聊到下一件作品</h1>
              <p>梳理创作思路、打磨提示词，或把灵感带到画布。</p>
              <div>
                {[
                  '帮我规划一个咖啡品牌的视觉风格',
                  '优化我的海报提示词',
                  '生成一张安静海岸的图片',
                ].map((text) => (
                  <button key={text} onClick={() => setInput(text)}>
                    {text}
                    <ArrowUp size={13} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {view.data?.next_cursor && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const page = await chatApi.get(
                    effective!,
                    view.data!.next_cursor!,
                  );
                  setOlder((old) => [...page.turns, ...old]);
                  queries.setQueryData(['chat-view', me.user.id, effective], {
                    ...view.data!,
                    next_cursor: page.next_cursor,
                  });
                })
              }
            >
              加载更早消息
            </button>
          )}
          {turns.map((t) => (
            <div className="live-chat-turn" key={t.id}>
              <div className="chat-msg user">
                <div className="message-avatar">我</div>
                <div>
                  <div className="message-bubble">{t.content}</div>
                  <small>
                    你 ·{' '}
                    {new Date(t.created_at).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </div>
              </div>
              <div className="chat-msg assistant">
                <div className="message-avatar">
                  <Sparkles size={16} />
                </div>
                <div>
                  <div className="message-bubble">
                    <SafeMarkdown
                      text={
                        t.reply ||
                        (t.status === 'RUNNING'
                          ? '正在整理创作建议…'
                          : '这条回复未完成。')
                      }
                    />
                  </div>
                  {t.intent && (
                    <span className="live-intent">{names[t.intent]}</span>
                  )}
                  {t.status === 'SUCCEEDED' && t.action && card(t.action)}
                  <div className="live-message-meta">
                    <small>
                      {t.status === 'SUCCEEDED'
                        ? `Atelier AI · ${t.charged ? `${t.charged} 积分` : '免费回复'}`
                        : t.status === 'RUNNING'
                          ? '回复进行中'
                          : `${t.status === 'CANCELLED' ? '已停止' : '未完成'} · 未扣积分`}
                    </small>
                    {t.status !== 'RUNNING' && (
                      <>
                        <button
                          className="icon-btn"
                          aria-label="复制回复"
                          onClick={() => copy(t.reply)}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          className="text-action"
                          disabled={
                            busy ||
                            uncertain ||
                            !!busyTurn ||
                            !config.data?.models.some((m) => m.id === model)
                          }
                          onClick={() => void send(t.content)}
                        >
                          <RefreshCw size={12} />
                          重新生成
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {streaming && (
            <div className="live-chat-turn">
              <div className="chat-msg user">
                <div className="message-avatar">我</div>
                <div className="message-bubble">{streaming.content}</div>
              </div>
              <div className="chat-msg assistant">
                <div className="message-avatar">
                  <Sparkles size={16} />
                </div>
                <div className="message-bubble">
                  <SafeMarkdown text={streaming.reply || '正在整理创作建议…'} />
                  {streaming.intent && (
                    <span className="live-intent">
                      {names[streaming.intent]}
                    </span>
                  )}
                  {streaming.action && card(streaming.action)}
                </div>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
        <div className="composer">
          {error && (
            <p role="alert">
              {error}
              {error.includes('积分') && (
                <Link className="text-action" to="/wallet">
                  查看积分
                </Link>
              )}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {config.isError && (
            <p role="alert">
              模型配置加载失败。
              <button
                className="text-action"
                onClick={() => void config.refetch()}
              >
                重试模型
              </button>
            </p>
          )}
          {config.data?.models.length === 0 && (
            <p role="status">
              还没有可用对话模型，请管理员在模型与定价中配置 chat
              模型并绑定账号。
            </p>
          )}
          <textarea
            aria-label="对话内容"
            maxLength={4000}
            placeholder="描述你的创意，或让 AI 帮你整理工作流…"
            value={input}
            disabled={busy || uncertain || !!busyTurn}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            <div>
              <select
                aria-label="对话模型"
                value={model}
                disabled={busy || uncertain}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">选择模型</option>
                {config.data?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
              <span>
                {config.data
                  ? `完整回复 ${config.data.credits_per_message} 积分 · 失败/中断不扣`
                  : '正在读取模型…'}{' '}
                · Ctrl + Enter
              </span>
            </div>
            {busy ? (
              <button
                className="btn"
                onClick={(event) => {
                  if (event.detail <= 1) stop();
                }}
              >
                <Square size={13} />
                停止回复
              </button>
            ) : uncertain ? (
              <button
                className="btn btn-dark"
                onClick={() => void send('', true)}
              >
                核对上次回复
              </button>
            ) : busyTurn ? (
              <button
                className="btn"
                onClick={() =>
                  void act(async () => {
                    await chatApi.cancel(busyTurn.id, me.csrf_token);
                    await refresh(effective);
                  })
                }
              >
                <Square size={13} />
                停止进行中的回复
              </button>
            ) : (
              <button
                className="btn btn-dark"
                disabled={
                  !input.trim() ||
                  !config.data?.models.some((m) => m.id === model)
                }
                onClick={() => void send()}
              >
                <ArrowUp size={15} />
                发送
              </button>
            )}
          </div>
        </div>
      </section>
      {contextOpen && (
        <aside
          className="context-sidebar live-chat-context"
          aria-label="智能上下文"
        >
          <div className="mini-head">
            <strong>智能上下文</strong>
            <button
              className="icon-btn"
              aria-label="关闭智能上下文"
              onClick={() => setContextOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
          <div className="context-card">
            <strong>意图识别</strong>
            <p>根据创作目标提供建议；图像动作只准备草稿，由你确认生成。</p>
            <span>
              {streaming?.intent
                ? names[streaming.intent]
                : names[view.data?.turns.at(-1)?.intent || 'CHAT']}
            </span>
          </div>
          <div className="context-card">
            <strong>上下文用量（估算）</strong>
            <p>
              {view.data?.estimated_tokens || 0} /{' '}
              {config.data?.context_window || '—'} tokens
            </p>
            <div className="meter">
              <i
                style={{
                  width: `${Math.min(100, ((view.data?.estimated_tokens || 0) / (config.data?.context_window || 8192)) * 100)}%`,
                }}
              />
            </div>
            <small>超过窗口 70% 时整理早期内容，保留近期原文与关键事实。</small>
          </div>
          <div className="context-card">
            <strong>会话摘要</strong>
            <p>
              {view.data?.summary || '当前上下文尚未需要压缩，消息按原文保留。'}
            </p>
          </div>
          <p className="empty-caption">
            历史、摘要与回复只对本人开放。当前会话提供创作讨论，不执行终端或文件操作。
          </p>
        </aside>
      )}
      {dialog && (
        <AssetDialog
          title={dialog === 'rename' ? '重命名对话' : '删除这段对话？'}
          busy={busy}
          onClose={() => setDialog(undefined)}
        >
          {dialog === 'rename' ? (
            <label>
              对话名称
              <input
                className="input"
                aria-label="对话名称"
                maxLength={100}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          ) : (
            <p>
              删除后将不再显示这段会话；正在进行的回复会停止，未完成的预留积分会释放。
            </p>
          )}
          <div className="gen-actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() => setDialog(undefined)}
            >
              取消
            </button>
            <button
              className="btn btn-dark"
              disabled={busy || (dialog === 'rename' && !title.trim())}
              onClick={() =>
                void act(async () => {
                  if (dialog === 'rename') {
                    await chatApi.rename(effective!, title, me.csrf_token);
                    await refresh(effective);
                  } else {
                    await chatApi.delete(effective!, me.csrf_token);
                    navigate('/chat');
                    setCreated(undefined);
                    await queries.invalidateQueries({
                      queryKey: ['chat-list', me.user.id],
                    });
                  }
                })
              }
            >
              {dialog === 'rename' ? '保存名称' : '删除对话'}
            </button>
          </div>
        </AssetDialog>
      )}
      {blocker.state === 'blocked' && (
        <AssetDialog title="停止回复并离开？" onClose={() => blocker.reset()}>
          <p>回复仍在进行。停止后会保存已收到的部分，未完成的回复不扣积分。</p>
          <div className="gen-actions">
            <button className="btn" onClick={() => blocker.reset()}>
              继续对话
            </button>
            <button
              className="btn btn-dark"
              onClick={() => {
                stop();
                blocker.proceed();
              }}
            >
              停止并离开
            </button>
          </div>
        </AssetDialog>
      )}
    </div>
  );
}
