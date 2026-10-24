import { useToast } from '../../components/Toast';
import Feedback from '../../components/Feedback';
import DatePicker from '../../components/DatePicker';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Copy,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
} from 'lucide-react';
import Tooltip from '../../components/Tooltip';
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
  EmptyRow,
  PageNav,
  TableLoading,
  useAdminCursor,
} from './AdminUI';
import '../upstream/AdminUpstream.css';
import './AdminPolicyPage.css';
export default function AdminPolicyPage(props: AdminProps) {
  return (
    <AdminAccess props={props}>
      <Policy {...props} />
    </AdminAccess>
  );
}
type PolicyTab = 'rules' | 'invites';
type PolicyListProps = AdminProps & {
  active: boolean;
  onCount: (count: number) => void;
};
function Policy(props: AdminProps) {
  const [tab, setTab] = useState<PolicyTab>('rules');
  const [visitedInvites, setVisitedInvites] = useState(false);
  const [rulesCount, setRulesCount] = useState<number>();
  const [invitesCount, setInvitesCount] = useState<number>();
  const selectTab = (next: PolicyTab) => {
    if (next === 'invites') setVisitedInvites(true);
    setTab(next);
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'rules'
        : event.key === 'End'
          ? 'invites'
          : tab === 'rules'
            ? 'invites'
            : 'rules';
    selectTab(next);
    document.getElementById(`policy-tab-${next}`)?.focus();
  };
  return (
    <AdminFrame
      className="policy-page"
      title="内容与邀请"
      description="管理本地拦截规则和注册邀请码，变更均保留处理说明。"
    >
      <div className="policy-tabs" role="tablist" aria-label="内容与邀请">
        {(
          [
            { key: 'rules', label: '内容规则', count: rulesCount },
            { key: 'invites', label: '邀请码', count: invitesCount },
          ] as const
        ).map(({ key, label, count }) => (
          <button
            key={key}
            id={`policy-tab-${key}`}
            role="tab"
            aria-label={label}
            data-tip={
              count !== undefined
                ? '数量为当前搜索已读取的本页记录，不代表全部记录'
                : undefined
            }
            aria-controls={`policy-panel-${key}`}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={tabKey}
            onClick={() => selectTab(key)}
          >
            {label}
            {count !== undefined && (
              <span className="policy-count">{count}</span>
            )}
          </button>
        ))}
      </div>
      <section
        id="policy-panel-rules"
        role="tabpanel"
        aria-labelledby="policy-tab-rules"
        hidden={tab !== 'rules'}
      >
        <Rules {...props} active={tab === 'rules'} onCount={setRulesCount} />
      </section>
      {visitedInvites && (
        <section
          id="policy-panel-invites"
          role="tabpanel"
          aria-labelledby="policy-tab-invites"
          hidden={tab !== 'invites'}
        >
          <Invites
            {...props}
            active={tab === 'invites'}
            onCount={setInvitesCount}
          />
        </section>
      )}
    </AdminFrame>
  );
}
function Rules(props: PolicyListProps) {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [type, setType] = useState('all');
  const cursor = useAdminCursor<number>();
  const [selected, setSelected] = useState<{
    rule?: Rule;
    remove?: boolean;
    toggle?: boolean;
  }>();
  const [message, setMessage] = useState('');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['adminRules', props.me.user.id, q, cursor.before],
    queryFn: ({ signal }) => api.rules(q, cursor.before, signal),
    enabled: props.active,
    retry: false,
  });
  useEffect(() => {
    if (query.data) props.onCount(query.data.items.length);
  }, [query.data, props.onCount]);
  const rows =
    query.data?.items.filter(
      (rule) => type === 'all' || rule.is_regex === (type === 'regex'),
    ) || [];
  const clear = () => {
    setDraft('');
    setQ('');
    setType('all');
    cursor.reset();
  };
  return (
    <>
      <form
        className="policy-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          cursor.reset();
          setQ(draft.trim());
        }}
      >
        <label className="policy-search">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索规则"
            placeholder="搜索关键字或表达式"
            maxLength={120}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <div className="policy-types" role="group" aria-label="本页规则类型">
          {[
            ['all', '全部'],
            ['keyword', '关键词'],
            ['regex', '正则'],
          ].map(([key, label]) => (
            <button
              type="button"
              key={key}
              aria-pressed={type === key}
              onClick={() => setType(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="btn btn-light">搜索</button>
        <div className="policy-toolbar-actions">
          <button
            className="btn btn-dark"
            type="button"
            onClick={() => setSelected({})}
          >
            <Plus size={15} />
            新增规则
          </button>
          <Tooltip content="重新读取当前规则页">
            <button
              className="btn btn-light policy-refresh"
              type="button"
              aria-label="刷新规则"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={16} />
            </button>
          </Tooltip>
        </div>
      </form>
      <p className="policy-notice">
        <Info size={17} aria-hidden="true" />
        <span>
          启用的规则在请求提交时检查提示词和参考文本；命中规则或上游违规会计入
          30 天违规次数。正则使用服务端 Rust 语法。
        </span>
      </p>
      {props.active && (
        <AdminFeedback
          props={props}
          error={query.error}
          message={message}
          onDismissMessage={() => setMessage('')}
        />
      )}
      <section className="admin-panel admin-table-panel policy-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table policy-rule-table">
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
              ) : rows.length ? (
                rows.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <code className="policy-pattern">{rule.pattern}</code>
                      <small>
                        {rule.is_regex
                          ? '按 Rust 正则表达式匹配'
                          : '按关键字匹配提示词与参考文本'}
                      </small>
                    </td>
                    <td>
                      <span
                        className="policy-badge"
                        data-tone={rule.is_regex ? 'info' : 'neutral'}
                      >
                        {rule.is_regex ? '正则表达式' : '关键字'}
                      </span>
                    </td>
                    <td>
                      <div className="policy-rule-state">
                        <Tooltip content="变更前需填写处理说明">
                          <button
                            type="button"
                            role="switch"
                            className="policy-switch"
                            aria-label={`${rule.enabled ? '停用' : '启用'}规则 ${rule.id}`}
                            aria-checked={rule.enabled}
                            onClick={() => setSelected({ rule, toggle: true })}
                          >
                            <span />
                          </button>
                        </Tooltip>
                        <span>{rule.enabled ? '已启用' : '已停用'}</span>
                      </div>
                    </td>
                    <td>
                      <div className="policy-row-actions">
                        <button
                          className="btn policy-row-action"
                          onClick={() => setSelected({ rule })}
                        >
                          <Pencil size={14} />
                          编辑规则
                        </button>
                        <button
                          className="btn policy-row-action policy-danger"
                          onClick={() => setSelected({ rule, remove: true })}
                        >
                          <Trash2 size={14} />
                          删除规则
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                !query.error && (
                  <EmptyRow columns={4}>
                    <div className="policy-empty">
                      <ShieldCheck size={26} />
                      <strong>暂无匹配的内容规则。</strong>
                      <p>
                        {q || type !== 'all'
                          ? '试试其他条件，或清除搜索后查看。'
                          : '添加规则，管理提示词与参考文本的拦截范围。'}
                      </p>
                      {(q || type !== 'all') && (
                        <button
                          type="button"
                          className="btn btn-light"
                          onClick={clear}
                        >
                          清除搜索
                        </button>
                      )}
                    </div>
                  </EmptyRow>
                )
              )}
            </tbody>
          </table>
        </div>
        <div className="policy-table-foot">
          <span>
            {query.data
              ? `本页 ${rows.length} 条规则 · 类型筛选仅作用于本页`
              : '正在读取规则…'}
          </span>
          <PageNav
            cursor={cursor}
            next={query.data?.next_cursor}
            loading={query.isFetching}
          />
        </div>
      </section>
      {props.active && selected && (
        <RuleForm
          {...props}
          {...selected}
          onClose={() => setSelected(undefined)}
          onDone={async () => {
            setSelected(undefined);
            setMessage(
              selected.remove
                ? '规则已删除。'
                : selected.toggle
                  ? `规则已${selected.rule?.enabled ? '停用' : '启用'}。`
                  : '规则已保存。',
            );
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
    toggle?: boolean;
    onClose: () => void;
    onDone: () => Promise<void>;
  },
) {
  const [pattern, setPattern] = useState(props.rule?.pattern || '');
  const [regex, setRegex] = useState(props.rule?.is_regex || false);
  const [enabled, setEnabled] = useState(
    props.toggle ? !props.rule?.enabled : (props.rule?.enabled ?? true),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const lock = useRef(false);
  async function save() {
    if (lock.current || !reason.trim() || !pattern.trim()) return;
    lock.current = true;
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
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <AdminDialog
      title={
        props.remove
          ? '删除内容规则'
          : props.toggle
            ? `${enabled ? '启用' : '停用'}内容规则`
            : props.rule
              ? '编辑内容规则'
              : '新增内容规则'
      }
      busy={busy}
      onClose={props.onClose}
      className="policy-dialog"
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
        ) : props.toggle ? (
          <div className="admin-confirm policy-confirm">
            <span
              className="policy-badge"
              data-tone={enabled ? 'success' : 'neutral'}
            >
              {enabled ? '启用规则' : '停用规则'}
            </span>
            <code className="policy-pattern">{pattern}</code>
            <p>
              {enabled
                ? '启用后，新提交的提示词和参考文本会按此规则检查。'
                : '停用后，不再按此规则拦截新请求；已有违规记录保留。'}
            </p>
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
            <fieldset className="policy-rule-kind" disabled={busy}>
              <legend>匹配类型</legend>
              <label>
                <input
                  type="radio"
                  name="rule-kind"
                  checked={!regex}
                  onChange={() => setRegex(false)}
                />
                关键字
              </label>
              <label>
                <input
                  type="radio"
                  name="rule-kind"
                  checked={regex}
                  onChange={() => setRegex(true)}
                />
                正则表达式
              </label>
            </fieldset>
            <label className="admin-toggle policy-enable">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              启用此规则
            </label>
            <p className="policy-form-hint">
              {regex
                ? '按服务端 Rust 正则语法校验与匹配，保存时检查表达式有效性。'
                : '按关键字匹配提示词与参考文本。'}
            </p>
          </>
        )}
        <label>
          处理说明
          <textarea
            className="input"
            required
            data-initial-focus={props.remove || props.toggle || undefined}
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
            {busy
              ? '正在处理…'
              : props.remove
                ? '确认删除规则'
                : props.toggle
                  ? `确认${enabled ? '启用' : '停用'}规则`
                  : '保存规则'}
          </button>
        </footer>
      </form>
    </AdminDialog>
  );
}
function Invites(props: PolicyListProps) {
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
    queryKey: ['adminInvites', props.me.user.id, q, cursor.before],
    queryFn: ({ signal }) => api.invites(q, cursor.before, signal),
    enabled: props.active,
    retry: false,
  });
  useEffect(() => {
    if (query.data) props.onCount(query.data.items.length);
  }, [query.data, props.onCount]);
  return (
    <>
      <form
        className="policy-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          cursor.reset();
          setQ(draft.trim());
        }}
      >
        <label className="policy-search">
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索邀请码"
            placeholder="搜索备注或末四位"
            maxLength={120}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button className="btn btn-light">搜索</button>
        <div className="policy-toolbar-actions">
          <button
            className="btn btn-dark"
            type="button"
            onClick={() => setSelected({})}
          >
            <Plus size={15} />
            创建邀请码
          </button>
          <Tooltip content="重新读取当前邀请码页">
            <button
              className="btn btn-light policy-refresh"
              type="button"
              aria-label="刷新邀请码"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={16} />
            </button>
          </Tooltip>
        </div>
      </form>
      <p className="policy-notice">
        <Info size={17} aria-hidden="true" />
        <span>
          邀请码只在「仅限邀请」注册模式使用。完整值仅创建后显示一次，列表仅保留备注和末四位。
        </span>
      </p>
      {props.active && (
        <AdminFeedback
          props={props}
          error={query.error}
          message={message}
          onDismissMessage={() => setMessage('')}
        />
      )}
      <section className="admin-panel admin-table-panel policy-table-panel">
        <div className="admin-table-scroll">
          <table className="admin-table policy-invite-table">
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
                query.data.items.map((invite) => {
                  const expired =
                    !!invite.expires_at &&
                    Date.parse(invite.expires_at) <= Date.now();
                  const exhausted = invite.used_count >= invite.max_uses;
                  const state = invite.revoked_at
                    ? 'revoked'
                    : expired
                      ? 'expired'
                      : exhausted
                        ? 'exhausted'
                        : 'available';
                  return (
                    <tr key={invite.id}>
                      <td>
                        <strong className="policy-invite-label">
                          {invite.label}
                        </strong>
                        <small>
                          <code className="policy-code-tail">
                            {invite.last4
                              ? `•••• ${invite.last4}`
                              : '未记录末四位'}
                          </code>
                        </small>
                      </td>
                      <td>
                        <span className="policy-usage">
                          <strong>{invite.used_count}</strong> /{' '}
                          {invite.max_uses}
                        </span>
                        <progress
                          className="policy-progress"
                          value={invite.used_count}
                          max={Math.max(1, invite.max_uses)}
                          aria-label={`${invite.label} 已用 ${invite.used_count} / ${invite.max_uses}`}
                        />
                      </td>
                      <td>
                        <span className="policy-expiry">
                          {invite.expires_at
                            ? when(invite.expires_at)
                            : '长期有效'}
                        </span>
                        <small>
                          创建于{' '}
                          {new Date(invite.created_at).toLocaleDateString(
                            'zh-CN',
                          )}
                        </small>
                      </td>
                      <td>
                        <span
                          className="policy-badge"
                          data-tone={
                            state === 'available'
                              ? 'success'
                              : state === 'expired'
                                ? 'danger'
                                : state === 'exhausted'
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {state === 'revoked'
                            ? '已撤销'
                            : state === 'expired'
                              ? '已过期'
                              : state === 'exhausted'
                                ? '已用尽'
                                : '可使用'}
                        </span>
                      </td>
                      <td>
                        <div className="policy-row-actions">
                          <Tooltip
                            content={
                              invite.revoked_at
                                ? '邀请码已撤销，不能恢复或编辑'
                                : '调整备注、使用次数或有效期'
                            }
                          >
                            <button
                              className="btn policy-row-action"
                              disabled={!!invite.revoked_at}
                              onClick={() => setSelected({ invite })}
                            >
                              <Pencil size={14} />
                              编辑邀请
                            </button>
                          </Tooltip>
                          <Tooltip
                            content={
                              invite.revoked_at
                                ? '邀请码已撤销'
                                : '永久停止此码注册，已注册账号保留'
                            }
                          >
                            <button
                              className="btn policy-row-action policy-danger"
                              disabled={!!invite.revoked_at}
                              onClick={() =>
                                setSelected({ invite, revoke: true })
                              }
                            >
                              <Trash2 size={14} />
                              撤销邀请
                            </button>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                !query.error && (
                  <EmptyRow columns={5}>
                    <div className="policy-empty">
                      <Ticket size={26} />
                      <strong>暂无匹配的邀请码。</strong>
                      <p>
                        {q
                          ? '试试其他备注或末四位，或清除搜索。'
                          : '创建邀请码，向受邀用户开放注册。'}
                      </p>
                      {q && (
                        <button
                          type="button"
                          className="btn btn-light"
                          onClick={() => {
                            setDraft('');
                            setQ('');
                            cursor.reset();
                          }}
                        >
                          清除搜索
                        </button>
                      )}
                    </div>
                  </EmptyRow>
                )
              )}
            </tbody>
          </table>
        </div>
        <div className="policy-table-foot">
          <span>
            {query.data
              ? `本页 ${query.data.items.length} 个邀请码`
              : '正在读取邀请码…'}
          </span>
          <PageNav
            cursor={cursor}
            next={query.data?.next_cursor}
            loading={query.isFetching}
          />
        </div>
      </section>
      {props.active && selected && (
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
  const toast = useToast();
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  async function save() {
    if (lock.current || uncertain || !reason.trim()) return;
    lock.current = true;
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
      lock.current = false;
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
      className="policy-dialog"
    >
      {code ? (
        <div className="admin-form policy-invite-result">
          <span className="policy-reveal-icon">
            <Ticket size={26} aria-hidden="true" />
          </span>
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
          <div className="policy-reveal-actions">
            <button
              className="btn btn-dark"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code);
                  toast('邀请码已复制');
                } catch {
                  toast.error('复制失败', {
                    description: '请选中邀请码手动复制。',
                  });
                }
              }}
            >
              <Copy size={15} />
              复制邀请码
            </button>

            <button className="btn btn-light" onClick={props.onClose}>
              已保存，关闭
            </button>
          </div>
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
              <div className="policy-form-grid">
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
                  <DatePicker
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    disabled={uncertain}
                  />
                  <small>
                    按本地时间选择，保存为
                    UTC；留空长期有效，设置时必须晚于当前时间。
                  </small>
                </label>
              </div>
              <div
                className="policy-expiry-shortcuts"
                role="group"
                aria-label="邀请码有效期快捷设置"
              >
                {[7, 30, 90].map((days) => (
                  <button
                    key={days}
                    type="button"
                    disabled={uncertain || busy}
                    onClick={() => {
                      const date = new Date();
                      date.setDate(date.getDate() + days);
                      setExpiry(localDate(date.toISOString()));
                    }}
                  >
                    {days} 天
                  </button>
                ))}
                <button
                  type="button"
                  disabled={uncertain || busy}
                  onClick={() => setExpiry('')}
                >
                  长期有效
                </button>
              </div>
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
