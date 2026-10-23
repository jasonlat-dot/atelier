import Feedback from '../../components/Feedback';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminProps } from '../upstream/upstreamApi';
import AdminDialog from '../upstream/AdminDialog';
import { SessionError } from '../auth/sessionApi';
import {
  adminApi as api,
  adminError,
  when,
  type Invite,
  type Rule,
} from './adminApi';
import {
  AdminAccess,
  AdminFeedback,
  AdminFrame,
  Badge,
  EmptyRow,
  PageNav,
  TableLoading,
  useAdminCursor,
} from './AdminUI';
import '../upstream/AdminUpstream.css';
export default function AdminPolicyPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Policy {...props} />
    </AdminAccess>
  );
}
function Policy(props: AdminProps) {
  const [tab, setTab] = useState('rules');
  return (
    <AdminFrame
      title="内容与邀请"
      description="管理本地拦截规则和注册邀请码，变更均保留处理说明。"
    >
      <div className="admin-tabs" role="tablist" aria-label="内容与邀请">
        <button
          role="tab"
          aria-selected={tab === 'rules'}
          onClick={() => setTab('rules')}
        >
          内容规则
        </button>
        <button
          role="tab"
          aria-selected={tab === 'invites'}
          onClick={() => setTab('invites')}
        >
          邀请码
        </button>
      </div>
      {tab === 'rules' ? <Rules {...props} /> : <Invites {...props} />}
    </AdminFrame>
  );
}
function Rules(props: AdminProps) {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const cursor = useAdminCursor<number>();
  const [selected, setSelected] = useState<{ rule?: Rule; remove?: boolean }>();
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['adminRules', q, cursor.before],
    queryFn: ({ signal }) => api.rules(q, cursor.before, signal),
  });
  return (
    <>
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          cursor.reset();
          setQ(draft.trim());
        }}
      >
        <input
          className="input admin-search"
          aria-label="搜索规则"
          placeholder="搜索关键字或表达式"
          maxLength={120}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-light">搜索</button>
        <button
          className="btn btn-dark"
          type="button"
          onClick={() => setSelected({})}
        >
          新增规则
        </button>
        <button
          className="btn btn-light"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新规则
        </button>
      </form>
      <AdminFeedback
        props={props}
        error={query.error}
        message={message}
        onDismissMessage={() => setMessage('')}
      />
      <p className="admin-note">
        启用的规则在请求提交时检查提示词和参考文本；命中规则或上游违规会计入 30
        天违规次数。正则使用服务端 Rust 语法。
      </p>
      <section className="admin-panel admin-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>匹配内容</th>
                <th>类型</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.isPending ? (
                <TableLoading columns={4} />
              ) : query.data?.items.length ? (
                query.data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <code className="admin-pattern">{r.pattern}</code>
                    </td>
                    <td>{r.is_regex ? '正则表达式' : '关键字'}</td>
                    <td>
                      <Badge bad={!r.enabled}>
                        {r.enabled ? '已启用' : '已停用'}
                      </Badge>
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          className="btn btn-light"
                          onClick={() => setSelected({ rule: r })}
                        >
                          编辑规则
                        </button>
                        <button
                          className="btn btn-light"
                          onClick={() => setSelected({ rule: r, remove: true })}
                        >
                          删除规则
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                !query.error && (
                  <EmptyRow columns={4}>暂无匹配的内容规则。</EmptyRow>
                )
              )}
            </tbody>
          </table>
        </div>
        <PageNav
          cursor={cursor}
          next={query.data?.next_cursor}
          loading={query.isFetching}
        />
      </section>
      {selected && (
        <RuleForm
          {...props}
          {...selected}
          onClose={() => setSelected(undefined)}
          onDone={async () => {
            setSelected(undefined);
            setMessage(selected.remove ? '规则已删除。' : '规则已保存。');
            await client.invalidateQueries({ queryKey: ['adminRules'] });
          }}
        />
      )}
    </>
  );
}
function RuleForm(
  props: AdminProps & {
    rule?: Rule;
    remove?: boolean;
    onClose: () => void;
    onDone: () => Promise<void>;
  },
) {
  const [pattern, setPattern] = useState(props.rule?.pattern || '');
  const [regex, setRegex] = useState(props.rule?.is_regex || false);
  const [enabled, setEnabled] = useState(props.rule?.enabled ?? true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      if (props.remove && props.rule)
        await api.deleteRule(
          props.rule.id,
          { revision: props.rule.revision, reason: reason.trim() },
          props.me.csrf_token,
        );
      else
        await api.saveRule(
          {
            pattern,
            is_regex: regex,
            enabled,
            revision: props.rule?.revision,
            reason: reason.trim(),
          },
          props.me.csrf_token,
          props.rule?.id,
        );
      await props.onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminDialog
      title={
        props.remove
          ? '删除内容规则'
          : props.rule
            ? '编辑内容规则'
            : '新增内容规则'
      }
      busy={busy}
      onClose={props.onClose}
    >
      <form
        className="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {props.remove ? (
          <div className="admin-confirm">
            <h3>停止使用这条规则？</h3>
            <p>{pattern}</p>
            <small>删除后不再拦截新请求，已有违规记录保留。</small>
          </div>
        ) : (
          <>
            <label>
              匹配内容
              <textarea
                className="input"
                data-initial-focus
                required
                maxLength={512}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
              <small>最长 512 字符，服务端检查表达式有效性与复杂度。</small>
            </label>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={regex}
                onChange={(e) => setRegex(e.target.checked)}
              />
              使用正则表达式
            </label>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              启用此规则
            </label>
          </>
        )}
        <label>
          处理说明
          <textarea
            className="input"
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <AdminFeedback props={props} error={error} />
        <footer className="admin-form-actions">
          <button
            type="button"
            className="btn btn-light"
            disabled={busy}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            className="btn btn-dark"
            disabled={busy || !reason.trim() || !pattern.trim()}
          >
            {busy ? '正在处理…' : props.remove ? '确认删除规则' : '保存规则'}
          </button>
        </footer>
      </form>
    </AdminDialog>
  );
}
function Invites(props: AdminProps) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const cursor = useAdminCursor<string>();
  const [selected, setSelected] = useState<{
    invite?: Invite;
    revoke?: boolean;
  }>();
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['adminInvites', q, cursor.before],
    queryFn: ({ signal }) => api.invites(q, cursor.before, signal),
  });
  return (
    <>
      <form
        className="admin-filters"
        onSubmit={(e) => {
          e.preventDefault();
          cursor.reset();
          setQ(draft.trim());
        }}
      >
        <input
          className="input admin-search"
          aria-label="搜索邀请码"
          placeholder="搜索备注或末四位"
          maxLength={120}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="btn btn-light">搜索</button>
        <button
          className="btn btn-dark"
          type="button"
          onClick={() => setSelected({})}
        >
          创建邀请码
        </button>
        <button
          className="btn btn-light"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新邀请码
        </button>
      </form>
      <p className="admin-note">
        邀请码只在「仅限邀请」注册模式使用。完整值仅创建后显示一次，列表仅保留备注和末四位。
      </p>
      <AdminFeedback
        props={props}
        error={query.error}
        message={message}
        onDismissMessage={() => setMessage('')}
      />
      <section className="admin-panel admin-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>备注 / 末四位</th>
                <th>已用 / 上限</th>
                <th>有效期</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.isPending ? (
                <TableLoading columns={5} />
              ) : query.data?.items.length ? (
                query.data.items.map((i) => {
                  const expired =
                    !!i.expires_at && Date.parse(i.expires_at) <= Date.now();
                  return (
                    <tr key={i.id}>
                      <td>
                        <strong>{i.label}</strong>
                        <small>
                          {i.last4 ? `•••• ${i.last4}` : '旧邀请码（无末四位）'}
                        </small>
                      </td>
                      <td>
                        {i.used_count} / {i.max_uses}
                      </td>
                      <td>{i.expires_at ? when(i.expires_at) : '长期有效'}</td>
                      <td>
                        <Badge
                          bad={
                            !!i.revoked_at ||
                            expired ||
                            i.used_count >= i.max_uses
                          }
                        >
                          {i.revoked_at
                            ? '已撤销'
                            : expired
                              ? '已过期'
                              : i.used_count >= i.max_uses
                                ? '已用尽'
                                : '可使用'}
                        </Badge>
                      </td>
                      <td>
                        <div className="admin-row-actions">
                          <button
                            className="btn btn-light"
                            disabled={!!i.revoked_at}
                            onClick={() => setSelected({ invite: i })}
                          >
                            编辑邀请
                          </button>
                          <button
                            className="btn btn-light"
                            disabled={!!i.revoked_at}
                            onClick={() =>
                              setSelected({ invite: i, revoke: true })
                            }
                          >
                            撤销邀请
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                !query.error && (
                  <EmptyRow columns={5}>暂无匹配的邀请码。</EmptyRow>
                )
              )}
            </tbody>
          </table>
        </div>
        <PageNav
          cursor={cursor}
          next={query.data?.next_cursor}
          loading={query.isFetching}
        />
      </section>
      {selected && (
        <InviteForm
          {...props}
          {...selected}
          onClose={() => setSelected(undefined)}
          onDone={async () => {
            setMessage('邀请码记录已更新。');
            await client.invalidateQueries({ queryKey: ['adminInvites'] });
          }}
        />
      )}
    </>
  );
}
function localDate(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function InviteForm(
  props: AdminProps & {
    invite?: Invite;
    revoke?: boolean;
    onClose: () => void;
    onDone: () => Promise<void>;
  },
) {
  const [label, setLabel] = useState(props.invite?.label || '');
  const [max, setMax] = useState(props.invite?.max_uses || 1);
  const [expiry, setExpiry] = useState(localDate(props.invite?.expires_at));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState('');
  const [uncertain, setUncertain] = useState(false);
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      if (props.revoke && props.invite) {
        await api.revokeInvite(
          props.invite.id,
          { revision: props.invite.revision, reason: reason.trim() },
          props.me.csrf_token,
        );
      } else {
        const details = {
          label: label.trim(),
          max_uses: max,
          expires_at: expiry ? new Date(expiry).toISOString() : null,
          reason: reason.trim(),
        };
        if (props.invite)
          await api.updateInvite(
            props.invite.id,
            { revision: props.invite.revision, details },
            props.me.csrf_token,
          );
        else {
          const result = await api.createInvite(details, props.me.csrf_token);
          setCode(result.code);
        }
      }
      await props.onDone();
      if (props.invite) props.onClose();
    } catch (e) {
      setError(e);
      if (!props.invite && (!(e instanceof SessionError) || e.status >= 500))
        setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AdminDialog
      title={
        code
          ? '保存完整邀请码'
          : props.revoke
            ? '撤销邀请码'
            : props.invite
              ? '编辑邀请码'
              : '创建邀请码'
      }
      busy={busy}
      onClose={props.onClose}
    >
      {code ? (
        <div className="admin-form">
          <p className="admin-note">
            完整邀请码只展示这一次。关闭前请复制到安全的位置，后续列表无法再次查看。
          </p>
          <label>
            完整邀请码
            <input
              className="input admin-id"
              aria-label="完整邀请码"
              readOnly
              value={code}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <button
            className="btn btn-dark"
            onClick={() =>
              void navigator.clipboard
                .writeText(code)
                .then(() => setCopied('已复制'))
                .catch(() => setCopied('复制失败，请选中上方内容手动复制。'))
            }
          >
            复制邀请码
          </button>
          <Feedback
            onDismiss={() => setCopied('')}
            variant={copied === '已复制' ? 'success' : 'error'}
          >
            {copied}
          </Feedback>
          <button className="btn btn-light" onClick={props.onClose}>
            已保存，关闭
          </button>
        </div>
      ) : (
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {props.revoke ? (
            <div className="admin-confirm">
              <h3>撤销「{label}」？</h3>
              <p>撤销后立即无法用于注册，已注册账号保留。这个操作不能恢复。</p>
            </div>
          ) : (
            <>
              <label>
                邀请备注
                <input
                  className="input"
                  data-initial-focus
                  required
                  maxLength={80}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={uncertain}
                />
              </label>
              <label>
                可使用次数
                <input
                  className="input"
                  type="number"
                  required
                  min={Math.max(1, props.invite?.used_count || 1)}
                  max={10000}
                  step={1}
                  value={max}
                  onChange={(e) => setMax(Number(e.target.value))}
                  disabled={uncertain}
                />
              </label>
              <label>
                过期时间（本地时间）
                <input
                  className="input"
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  disabled={uncertain}
                />
                <small>留空表示长期有效；设置时必须晚于当前时间。</small>
              </label>
            </>
          )}
          <label>
            处理说明
            <textarea
              className="input"
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={uncertain}
            />
          </label>
          {!!error && (
            <Feedback variant="error" eventKey={error}>
              {adminError(error)}
              {uncertain && (
                <p>
                  创建结果尚未确认，请关闭弹窗后刷新列表。如果出现本次备注的记录，先撤销该记录再创建新邀请码，避免产生无法取回的有效邀请码。
                </p>
              )}
            </Feedback>
          )}
          <footer className="admin-form-actions">
            <button
              type="button"
              className="btn btn-light"
              disabled={busy}
              onClick={props.onClose}
            >
              取消
            </button>
            <button
              className="btn btn-dark"
              disabled={busy || uncertain || !reason.trim()}
            >
              {busy
                ? '正在处理…'
                : props.revoke
                  ? '确认撤销邀请'
                  : props.invite
                    ? '保存邀请'
                    : '确认创建邀请'}
            </button>
          </footer>
        </form>
      )}
    </AdminDialog>
  );
}
