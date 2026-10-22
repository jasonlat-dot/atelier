import * as api from '../../lib/api';
import { useState } from 'react';
import {
  Activity,
  Coins,
  LockKeyhole,
  Server,
  Shield,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { useDemoDB } from '../../lib/store';
import * as mock from '../../lib/mockDb';
export default function AdminPage({
  tab,
}: {
  tab: 'overview' | 'users' | 'models' | 'providers';
}) {
  const db = useDemoDB();
  const [filter, setFilter] = useState('');
  const counts = {
    users: db.users.length,
    models: db.models.length,
    jobs: db.jobs.length,
    credits: db.users.reduce((n, u) => n + u.credits, 0),
  };
  const admin = db.users.find((u) => u.id === db.currentUserId)!;
  if (admin.role === 'USER')
    return (
      <div className="page-padding">
        <h2>无权访问</h2>
        <p>管理界面需要服务器侧验证管理员权限。</p>
      </div>
    );
  return (
    <main className="page-padding">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">MANAGEMENT / {tab.toUpperCase()}</div>
          <h1>
            {tab === 'overview'
              ? '运营总览'
              : tab === 'users'
                ? '用户管理'
                : tab === 'models'
                  ? '模型配置'
                  : '上游账号池'}
          </h1>
          <p className="page-subtitle">
            统一 Web 应用中的管理功能 · 服务端管理写接口尚未对接，HTTP
            模式下编辑已禁用
          </p>
        </div>
        <span className="neutral-status">
          <Shield size={14} /> ADMIN ACCESS
        </span>
      </div>
      {tab === 'overview' && (
        <>
          <div className="metric-grid">
            {[
              [Users, '平台用户', counts.users, '个账号'],
              [Coins, '用户积分', counts.credits.toLocaleString(), '总余额'],
              [Activity, '生成任务', counts.jobs, '本地模拟'],
              [
                Server,
                '已开放模型',
                db.models.filter((m) => m.enabled).length,
                '已启用',
              ],
            ].map(([Icon, label, val, unit], i) => {
              const I = Icon as typeof Users;
              return (
                <div className="metric" key={i}>
                  <div>
                    <span>{String(label)}</span>
                    <I size={17} />
                  </div>
                  <strong>{val as React.ReactNode}</strong>
                  <small>{String(unit)}</small>
                </div>
              );
            })}
          </div>
          <div className="two-col">
            <section className="surface-block">
              <div className="surface-title">
                <strong>最近任务</strong>
                <span>只读预览</span>
              </div>
              {db.jobs.length === 0 ? (
                <div className="soft-empty">
                  暂无任务；在画布生成内容后将出现在此处。
                </div>
              ) : (
                db.jobs.slice(0, 6).map((j) => (
                  <div key={j.id} className="table-line">
                    <span>
                      {j.kind === 'video' ? '视频' : '图片'} ·{' '}
                      {j.prompt.slice(0, 23)}
                    </span>
                    <small>{j.status}</small>
                  </div>
                ))
              )}
            </section>
            <section className="surface-block">
              <div className="surface-title">
                <strong>基础安全提示</strong>
                <LockKeyhole size={17} />
              </div>
              <div className="security-notes">
                <p>Google 登录、权限与角色只由后端判定。</p>
                <p>生产环境应禁用所有演示身份切换入口。</p>
                <p>积分余额以不可篡改的服务端账本为准。</p>
                <p>上游密钥永远不能返回浏览器。</p>
              </div>
            </section>
          </div>
        </>
      )}
      {tab === 'users' && (
        <section className="surface-block">
          <div className="surface-title">
            <strong>用户列表</strong>
            <input
              className="input search-input"
              placeholder="搜索昵称或邮箱"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>可用积分</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {db.users
                .filter((u) =>
                  (u.name + u.email)
                    .toLowerCase()
                    .includes(filter.toLowerCase()),
                )
                .map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="user-cell">
                        <span className="avatar tiny">{u.avatar}</span>
                        <span>
                          <strong>{u.name}</strong>
                          <small>{u.email}</small>
                        </span>
                      </div>
                    </td>
                    <td>{u.role}</td>
                    <td>{u.credits.toLocaleString()}</td>
                    <td>
                      <span
                        className={u.disabled ? 'status-locked' : 'status-good'}
                      >
                        {u.disabled ? '已禁用' : '正常'}
                      </span>
                    </td>
                    <td>
                      <div className="inline-actions">
                        <button
                          disabled={api.BACKEND_MODE}
                          onClick={() => {
                            const v = window.prompt(
                              '请输入调整积分（可为负数，最多 ±100000）',
                              '100',
                            );
                            if (v !== null) {
                              try {
                                mock.addCredits(u.id, Number(v));
                              } catch (e) {
                                alert(String(e));
                              }
                            }
                          }}
                        >
                          调整积分
                        </button>
                        <button
                          disabled={api.BACKEND_MODE}
                          onClick={() => {
                            try {
                              mock.toggleUser(u.id);
                            } catch (e) {
                              alert(String(e));
                            }
                          }}
                        >
                          {u.disabled ? '启用' : '禁用'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
      {tab === 'models' && (
        <section className="surface-block">
          <div className="surface-title">
            <strong>公开模型目录</strong>
            <span>模型可用状态影响用户端的生成入口</span>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>模型</th>
                <th>类型</th>
                <th>供应商</th>
                <th>基准费率</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {db.models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.label}</strong>
                    <small className="muted-block">{m.id}</small>
                  </td>
                  <td>{m.kind === 'image' ? '图像' : '视频'}</td>
                  <td>{m.provider}</td>
                  <td>{m.cost} 积分起</td>
                  <td>
                    <button
                      className={
                        m.enabled
                          ? 'status-good toggle-badge'
                          : 'status-locked toggle-badge'
                      }
                      disabled={api.BACKEND_MODE}
                      onClick={() => mock.toggleModel(m.id)}
                    >
                      {m.enabled ? '已开放' : '已停用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {tab === 'providers' && (
        <div className="two-col">
          <section className="surface-block">
            <div className="surface-title">
              <strong>路由池概况</strong>
              <SlidersHorizontal size={16} />
            </div>
            <div className="provider-row">
              <div className="provider-icon">
                <Server size={18} />
              </div>
              <div>
                <strong>image-pool-primary</strong>
                <small>图片模型路由池 · 演示</small>
              </div>
              <span className="status-good">Healthy</span>
            </div>
            <div className="provider-row">
              <div className="provider-icon">
                <Server size={18} />
              </div>
              <div>
                <strong>video-pool-01</strong>
                <small>视频生成池 · 演示</small>
              </div>
              <span className="status-good">Healthy</span>
            </div>
            <div className="soft-empty">
              正式账号池需要在 Rust
              后端接入供应商授权凭据、配额监控、故障熔断及公平调度。
            </div>
          </section>
          <section className="surface-block">
            <div className="surface-title">
              <strong>安全与计费</strong>
              <LockKeyhole size={16} />
            </div>
            <div className="security-notes">
              <p>不支持在前端直接录入可供用户查看的供应商密钥。</p>
              <p>图片、视频任务应采用积分预占 → 成功结算 / 失败返还。</p>
              <p>只能使用合同和接口授权允许的凭据池。</p>
              <p>所有运营操作要记录操作人、时间与变更前后状态。</p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
