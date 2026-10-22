import { useState, useCallback } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleDollarSign,
  Coins,
  Command,
  FolderOpen,
  GalleryHorizontal,
  Home,
  Image as ImageIcon,
  LayoutDashboard,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  Users,
  Video,
  Wallet,
} from 'lucide-react';
import CanvasPage from './features/canvas/CanvasPage';
import ChatPage from './features/chat/ChatPage';
import AdminPage from './features/admin/AdminPage';
import { useDemoDB } from './lib/store';
import { hasPermission } from './lib/types';
import * as mock from './lib/mockDb';
import * as api from './lib/api';
const mainMenu = [
  { label: '工作台', path: '/', icon: Home },
  { label: 'AI 智能对话', path: '/chat', icon: MessageSquare },
  { label: '无限创作画布', path: '/canvas', icon: GalleryHorizontal },
  { label: '我的素材库', path: '/assets', icon: ImageIcon },
];
const personal = [
  { label: '积分与订阅', path: '/wallet', icon: Coins },
  { label: '用量分析', path: '/usage', icon: Activity },
];
const adminMenu = [
  { label: '运营总览', path: '/admin', icon: LayoutDashboard },
  { label: '用户管理', path: '/admin/users', icon: Users },
  { label: '模型配置', path: '/admin/models', icon: Settings2 },
  { label: '账号与供应商', path: '/admin/providers', icon: SlidersHorizontal },
];
export default function App() {
  const db = useDemoDB();
  const user = db.users.find((u) => u.id === db.currentUserId)!;
  const location = useLocation(),
    navigate = useNavigate();
  const [selectedProject, setSelectedProject] = useState<string | undefined>(
    undefined,
  );
  const projects = db.projects.filter((p) => p.ownerId === user.id);
  const activeProject =
    selectedProject && projects.some((p) => p.id === selectedProject)
      ? selectedProject
      : projects[0]?.id;
  const [showIdentity, setShowIdentity] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const gotoProject = useCallback(
    (id: string) => {
      setSelectedProject(id);
      navigate('/canvas');
    },
    [navigate],
  );
  const createBoard = async () => {
    const p = await api.createProject('新的创作画布');
    gotoProject(p.id);
  };
  const menus = [
    ['创作空间', mainMenu],
    ['账户与资产', personal],
    ...(hasPermission(user.role, 'admin:read')
      ? [['运营管理', adminMenu]]
      : []),
  ] as [string, typeof mainMenu][];
  return (
    <div className="app-shell">
      <aside className={`app-sidebar ${sidebar ? '' : 'sidebar-collapsed'}`}>
        <div className="brand">
          <div className="brand-mark">
            <Command size={19} />
          </div>
          <div>
            <strong>Atelier</strong>
            <span>CREATIVE WORKSPACE</span>
          </div>
        </div>
        <button className="new-space" onClick={() => void createBoard()}>
          <Plus size={16} /> 新建创作空间
        </button>
        <nav className="navigation">
          {menus.map(([group, items]) => (
            <section key={group}>
              <div className="nav-group">{group}</div>
              {items.map((item) => (
                <Link
                  key={item.path}
                  className={`nav-link ${location.pathname === item.path ? 'active' : ''}`}
                  to={item.path}
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="credits-box">
            <div>
              <span>我的可用积分</span>
              <CircleDollarSign size={15} />
            </div>
            <strong>{user.credits.toLocaleString()}</strong>
            <div className="credits-bar">
              <i />
            </div>
            <Link to="/wallet">
              查看积分明细 <ArrowRight size={13} />
            </Link>
          </div>
          <div className="identity-wrap">
            <button
              className="identity-button"
              onClick={() => !api.BACKEND_MODE && setShowIdentity((v) => !v)}
            >
              <div className="avatar">{user.avatar}</div>
              <div>
                <strong>{user.name}</strong>
                <small>
                  {user.role === 'USER'
                    ? '普通用户'
                    : user.role === 'ADMIN'
                      ? '管理员'
                      : '超级管理员'}
                </small>
              </div>
              <ChevronDown size={15} />
            </button>
            {showIdentity && !api.BACKEND_MODE && (
              <div className="identity-popover">
                <div className="popover-heading">切换演示账号</div>
                {db.users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => {
                      mock.switchUser(u.id);
                      setSelectedProject(undefined);
                      setShowIdentity(false);
                      navigate('/');
                    }}
                  >
                    <span className="avatar tiny">{u.avatar}</span>
                    <span>
                      {u.name}
                      <small>{u.role}</small>
                    </span>
                    {u.id === user.id && <Check size={15} />}
                  </button>
                ))}
                <p>仅限 Mock 演示。正式环境不允许用户自行修改角色。</p>
              </div>
            )}
          </div>
        </div>
      </aside>
      <div className="app-body">
        <header className="app-topbar">
          <div className="topbar-left">
            <button
              className="icon-btn"
              onClick={() => setSidebar((v) => !v)}
              aria-label="展开折叠边栏"
            >
              <LayoutDashboard size={17} />
            </button>
            <span className="topbar-divider" />
            <span className="topbar-breadcrumb">Workspace</span>
            <span>/</span>
            <strong>
              {[...mainMenu, ...personal, ...adminMenu].find(
                (m) => m.path === location.pathname,
              )?.label || '工作台'}
            </strong>
          </div>
          <div className="topbar-right">
            <div className="topbar-search">
              <Search size={15} /> <span>搜索项目、素材与功能</span>
              <kbd>⌘ K</kbd>
            </div>
            <span className="demo-label">MOCK DEMO</span>
            <button className="icon-btn" title="主题切换将在下一阶段接入">
              <Sun size={16} />
            </button>
            <button className="icon-btn" title="通知">
              <Bell size={17} />
            </button>
            <span className="avatar tiny">{user.avatar}</span>
          </div>
        </header>
        <div className="app-content">
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard
                  onCreate={() => void createBoard()}
                  onProject={gotoProject}
                />
              }
            />
            <Route path="/chat" element={<ChatPage />} />
            <Route
              path="/canvas"
              element={
                <CanvasPage
                  projectId={activeProject}
                  onSelectProject={gotoProject}
                />
              }
            />
            <Route
              path="/assets"
              element={<AssetsPage onProject={gotoProject} />}
            />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route
              path="/admin"
              element={
                hasPermission(user.role, 'admin:read') ? (
                  <AdminPage tab="overview" />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route
              path="/admin/users"
              element={
                hasPermission(user.role, 'admin:users:write') ? (
                  <AdminPage tab="users" />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route
              path="/admin/models"
              element={
                hasPermission(user.role, 'admin:models:write') ? (
                  <AdminPage tab="models" />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route
              path="/admin/providers"
              element={
                hasPermission(user.role, 'admin:read') ? (
                  <AdminPage tab="providers" />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
function Dashboard({
  onCreate,
  onProject,
}: {
  onCreate: () => void;
  onProject: (id: string) => void;
}) {
  const db = useDemoDB(),
    user = db.users.find((u) => u.id === db.currentUserId)!,
    projects = db.projects.filter((p) => p.ownerId === user.id),
    jobs = db.jobs.filter((j) => j.ownerId === user.id),
    assets = db.assets.filter((a) => a.ownerId === user.id);
  return (
    <main className="page-padding dashboard-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">CREATIVE WORKSPACE</div>
          <h1>欢迎回来，{user.name.split(' ')[0]}</h1>
          <p className="page-subtitle">
            从一个想法开始，连接图片、视频与文字，完成你的下一次创作。
          </p>
        </div>
        <button className="btn btn-dark" onClick={onCreate}>
          <Plus size={16} /> 新建画布
        </button>
      </div>
      <div className="quick-cards">
        <Link to="/canvas">
          <div className="quick-icon">
            <GalleryHorizontal size={19} />
          </div>
          <strong>
            无限创作画布 <ArrowRight size={16} />
          </strong>
          <p>连接提示词、图片与视频，让创意在画布上延伸。</p>
        </Link>
        <Link to="/chat">
          <div className="quick-icon">
            <MessageSquare size={19} />
          </div>
          <strong>
            AI 对话 <ArrowRight size={16} />
          </strong>
          <p>用自然语言整理想法、获取视频脚本与创意建议。</p>
        </Link>
        <Link to="/assets">
          <div className="quick-icon">
            <FolderOpen size={19} />
          </div>
          <strong>
            素材库 <ArrowRight size={16} />
          </strong>
          <p>组织你的参考图、生成结果和创作视频。</p>
        </Link>
      </div>
      <div className="section-head">
        <h2>最近的创作项目</h2>
        <button className="text-action" onClick={onCreate}>
          新建 <Plus size={14} />
        </button>
      </div>
      <div className="project-grid">
        {projects.map((p) => (
          <button
            key={p.id}
            className="project-card"
            onClick={() => onProject(p.id)}
          >
            <div className="project-cover">
              <img src="/assets/art-future.svg" alt="画布封面" />
              <span>{p.graph.nodes.length} 个节点</span>
            </div>
            <div className="project-detail">
              <strong>{p.name}</strong>
              <small>
                更新于 {new Date(p.updatedAt).toLocaleDateString('zh-CN')}
              </small>
            </div>
          </button>
        ))}
        <button className="project-card create-card" onClick={onCreate}>
          <Plus size={23} />
          <strong>创建新项目</strong>
          <small>从空白画布开始</small>
        </button>
      </div>
      <div className="section-head">
        <h2>工作空间概览</h2>
      </div>
      <div className="overview-pills">
        <div>
          <ImageIcon size={18} />
          <span>素材资源</span>
          <strong>{assets.length}</strong>
        </div>
        <div>
          <Video size={18} />
          <span>生成任务</span>
          <strong>{jobs.length}</strong>
        </div>
        <div>
          <Wallet size={18} />
          <span>可用积分</span>
          <strong>{user.credits.toLocaleString()}</strong>
        </div>
      </div>
    </main>
  );
}
function AssetsPage({ onProject }: { onProject: (id: string) => void }) {
  const db = useDemoDB();
  const user = db.users.find((u) => u.id === db.currentUserId)!,
    assets = db.assets.filter((a) => a.ownerId === user.id);
  const [filter, setFilter] = useState<'all' | 'image' | 'video'>('all');
  const list = assets.filter((a) => filter === 'all' || a.kind === filter);
  const project = db.projects.find((p) => p.ownerId === user.id);
  return (
    <main className="page-padding">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">LIBRARY</div>
          <h1>我的素材库</h1>
          <p className="page-subtitle">
            在同一空间里管理图片、视频和生成结果。
          </p>
        </div>
        <button
          className="btn btn-light"
          onClick={() => project && onProject(project.id)}
        >
          <Plus size={15} /> 前往画布导入
        </button>
      </div>
      <div className="filter-tabs">
        {[
          ['all', '全部素材'],
          ['image', '图片'],
          ['video', '视频'],
        ].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v as typeof filter)}
            className={filter === v ? 'on' : ''}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="asset-grid">
        {list.map((a) => (
          <div className="asset-card" key={a.id}>
            <div className="asset-cover">
              {a.kind === 'video' ? (
                <video
                  src={a.src}
                  poster={a.poster}
                  controls
                  preload="metadata"
                  playsInline
                />
              ) : (
                <img src={a.src} alt={a.name} />
              )}
            </div>
            <div className="asset-info">
              <strong>{a.name}</strong>
              <span>{a.kind === 'video' ? '视频' : '图片'}</span>
            </div>
          </div>
        ))}
      </div>
      {list.length === 0 && (
        <div className="soft-empty">这里还没有素材，先到无限画布添加内容。</div>
      )}
    </main>
  );
}
function WalletPage() {
  const db = useDemoDB(),
    user = db.users.find((u) => u.id === db.currentUserId)!,
    ledger = db.ledger.filter((l) => l.userId === user.id);
  const today = new Date().toISOString().slice(0, 10),
    claimed = db.checkin[user.id] === today;
  return (
    <main className="page-padding">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">CREDITS & BILLING</div>
          <h1>积分与订阅</h1>
          <p className="page-subtitle">
            查看积分余额、每日签到与用量流水。支付将在正式后端完成。
          </p>
        </div>
      </div>
      <div className="wallet-hero">
        <div>
          <span>当前可用积分</span>
          <strong>{user.credits.toLocaleString()}</strong>
          <p>任务提交时预占积分；取消或失败时按策略释放。</p>
        </div>
        <button
          className="btn btn-white"
          disabled={claimed || api.BACKEND_MODE}
          onClick={() => mock.checkIn()}
        >
          {claimed ? (
            <>
              <Check size={16} /> 今日已签到
            </>
          ) : (
            <>
              <Coins size={16} /> 每日签到 +20
            </>
          )}
        </button>
      </div>
      <div className="section-head">
        <h2>积分套餐</h2>
        <small>仅演示套餐 UI，不会向你收款</small>
      </div>
      <div className="plan-grid">
        {[
          [500, '体验包', '小型图片创作'],
          [1500, '创作者', '图片与短视频工作流'],
          [5000, '工作室', '高频创作与多项目协作'],
        ].map(([n, t, d]) => (
          <div className="plan-card" key={n}>
            <small>{t}</small>
            <strong>
              {Number(n).toLocaleString()} <span>积分</span>
            </strong>
            <p>{d}</p>
            <button
              className="btn btn-light"
              onClick={() =>
                alert(
                  '这是演示套餐。正式版需由支付回调确认后在 Rust 账本中入账。',
                )
              }
            >
              查看方案 <ArrowRight size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="section-head">
        <h2>最近积分流水</h2>
      </div>
      <section className="surface-block">
        {ledger.length === 0 ? (
          <div className="soft-empty">
            暂无流水，提交一个生成任务或签到后即可查看。
          </div>
        ) : (
          ledger.map((l) => (
            <div className="table-line" key={l.id}>
              <span>
                {l.reason}
                <small className="muted-block">
                  {new Date(l.at).toLocaleString('zh-CN')}
                </small>
              </span>
              <strong className={l.amount > 0 ? 'good-number' : ''}>
                {l.amount > 0 ? '+' : ''}
                {l.amount}
              </strong>
            </div>
          ))
        )}
      </section>
    </main>
  );
}
function UsagePage() {
  const db = useDemoDB(),
    user = db.users.find((u) => u.id === db.currentUserId)!,
    jobs = db.jobs.filter((j) => j.ownerId === user.id);
  const total = jobs.reduce((s, j) => s + j.cost, 0);
  return (
    <main className="page-padding">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">INSIGHTS</div>
          <h1>用量分析</h1>
          <p className="page-subtitle">
            查看图片、视频生成任务及积分使用情况。
          </p>
        </div>
      </div>
      <div className="metric-grid">
        <div className="metric">
          <span>总生成任务</span>
          <strong>{jobs.length}</strong>
          <small>本地演示</small>
        </div>
        <div className="metric">
          <span>视频任务</span>
          <strong>{jobs.filter((j) => j.kind === 'video').length}</strong>
          <small>Video generation</small>
        </div>
        <div className="metric">
          <span>图片任务</span>
          <strong>{jobs.filter((j) => j.kind === 'image').length}</strong>
          <small>Image generation</small>
        </div>
        <div className="metric">
          <span>预占积分累计</span>
          <strong>{total}</strong>
          <small>非实际消费</small>
        </div>
      </div>
    </main>
  );
}
