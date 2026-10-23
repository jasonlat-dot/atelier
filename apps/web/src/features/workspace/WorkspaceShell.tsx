import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  ChartColumn,
  ChevronRight,
  CircleDollarSign,
  FolderOpen,
  GalleryHorizontal,
  LayoutDashboard,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { SessionError, type Me } from '../auth/sessionApi';
import { walletApi, type Summary } from '../wallet/walletApi';
import './WorkspaceShell.css';

const BalanceContext = createContext<(value: Summary) => void>(() => {});
export const useWalletSummaryUpdate = () => useContext(BalanceContext);
const creation = [
  { path: '/', label: '工作台', icon: LayoutDashboard, ready: true },
  { path: '/generate', label: '图片与视频生成', icon: Sparkles, ready: true },
  { path: '/chat', label: 'AI 智能对话', icon: MessageSquare, ready: true },
  {
    path: '/canvas',
    label: '无限创作画布',
    icon: GalleryHorizontal,
    ready: true,
  },
  { path: '/assets', label: '我的素材库', icon: FolderOpen, ready: true },
];
const personal = [
  { path: '/wallet', label: '积分与订阅', icon: CircleDollarSign, ready: true },
  { path: '/usage', label: '用量分析', icon: ChartColumn, ready: true },
  { path: '/settings', label: '账号设置', icon: Settings, ready: true },
];
const admin = [
  { path: '/admin', label: '运营总览', icon: ChartColumn, ready: true },
  { path: '/admin/users', label: '用户管理', icon: Users, ready: true },
  {
    path: '/admin/plans',
    label: '套餐与订单',
    icon: CircleDollarSign,
    ready: true,
  },
  { path: '/admin/jobs', label: '任务管理', icon: Sparkles, ready: true },
  {
    path: '/admin/policy',
    label: '内容与邀请',
    icon: ShieldCheck,
    ready: true,
  },
  { path: '/admin/settings', label: '平台设置', icon: Settings, ready: true },
  { path: '/admin/audit', label: '审计日志', icon: ShieldCheck, ready: true },
  {
    path: '/admin/credits',
    label: '积分管理',
    icon: CircleDollarSign,
    ready: true,
  },
  {
    path: '/admin/models',
    label: '模型与定价',
    icon: SlidersHorizontal,
    ready: true,
  },
  {
    path: '/admin/accounts',
    label: '上游账号池',
    icon: ShieldCheck,
    ready: true,
  },
];

export default function WorkspaceShell({
  me,
  onExpired,
  onReload,
  children,
}: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => window.innerWidth > 900);
  const [summary, setSummary] = useState<Summary>();
  const [failed, setFailed] = useState(false);
  const version = useRef(0);
  const location = useLocation();
  const adminMore = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (admin.slice(3).some((item) => item.path === location.pathname))
      adminMore.current?.setAttribute('open', '');
  }, [location.pathname]);
  const update = useCallback((value: Summary) => {
    ++version.current;
    setSummary(value);
    setFailed(false);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const current = version.current;
    void walletApi
      .summary(abort.signal)
      .then((value) => {
        if (!abort.signal.aborted && current === version.current) update(value);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || current !== version.current) return;
        if (
          error instanceof SessionError &&
          (error.status === 401 || error.code === 'ACCOUNT_DISABLED')
        )
          onExpired();
        else if (error instanceof SessionError && error.code === 'MFA_REQUIRED')
          onReload();
        else setFailed(true);
      });
    return () => abort.abort();
  }, [me.user.id, onExpired, onReload, update]);
  const closeOnMobile = () => {
    if (window.innerWidth <= 900) setOpen(false);
  };
  const groups = [
    ['创作空间', creation],
    ['账户与资产', personal],
    ...(me.user.role === 'USER'
      ? []
      : [
          [
            '运营管理',
            admin.filter(
              (item) =>
                me.user.role === 'SUPER_ADMIN' ||
                !['/admin/settings', '/admin/audit'].includes(item.path),
            ),
          ],
        ]),
  ] as [string, typeof creation][];
  const initial = me.user.display_name.trim().slice(0, 1).toUpperCase();
  return (
    <BalanceContext.Provider value={update}>
      <div
        className={`app-shell live-workspace ${location.pathname === '/chat' || location.pathname.startsWith('/chat/') ? 'chat-workspace' : ''}`}
      >
        {open && (
          <button
            className="workspace-scrim"
            aria-label="关闭导航"
            onClick={() => setOpen(false)}
          />
        )}
        <aside
          id="workspace-navigation"
          className={`app-sidebar ${open ? '' : 'sidebar-collapsed'}`}
          {...(!open ? { inert: '' } : {})}
        >
          <div className="brand">
            <div className="brand-mark">
              <img
                src="/assets/favicon.svg"
                width="36"
                height="36"
                alt=""
                aria-hidden="true"
              />
            </div>
            <div>
              <strong>Atelier</strong>
              <span>CREATIVE WORKSPACE</span>
            </div>
            <button
              className="icon-btn mobile-nav-close"
              aria-label="收起导航"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          <Link className="new-space" to="/canvas/new" onClick={closeOnMobile}>
            <Plus size={16} />
            新建创作空间
          </Link>
          <nav className="navigation" aria-label="主导航">
            {groups.map(([label, items]) => (
              <section key={label}>
                <div className="nav-group">{label}</div>
                {items
                  .slice(0, label === '运营管理' ? 3 : items.length)
                  .map((item) =>
                    item.ready ? (
                      <NavLink
                        key={item.path}
                        end
                        to={item.path}
                        className={({ isActive }) =>
                          `nav-link ${isActive ? 'active' : ''}`
                        }
                        onClick={closeOnMobile}
                      >
                        <item.icon size={16} />
                        <span>{item.label}</span>
                      </NavLink>
                    ) : (
                      <span
                        key={item.path}
                        className="nav-link nav-pending"
                        aria-disabled="true"
                      >
                        <item.icon size={16} />
                        <span>{item.label}</span>
                        <small>待开放</small>
                      </span>
                    ),
                  )}
                {label === '运营管理' && items.length > 3 && (
                  <details className="workspace-more" ref={adminMore}>
                    <summary aria-label="更多管理功能">
                      更多 {items.length - 3} 项<ChevronRight size={14} />
                    </summary>
                    <div>
                      {items.slice(3).map((item) => (
                        <NavLink
                          key={item.path}
                          end
                          to={item.path}
                          className={({ isActive }) =>
                            `nav-link ${isActive ? 'active' : ''}`
                          }
                          onClick={closeOnMobile}
                        >
                          <item.icon size={16} />
                          <span>{item.label}</span>
                        </NavLink>
                      ))}
                    </div>
                  </details>
                )}
              </section>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className="credits-box" aria-label="侧栏积分">
              <div>
                <span>我的可用积分</span>
                <CircleDollarSign size={15} />
              </div>
              <strong>
                {summary && Number.isSafeInteger(summary.available)
                  ? summary.available.toLocaleString('zh-CN')
                  : failed
                    ? '暂不可用'
                    : '—'}
              </strong>
              <Link to="/wallet" onClick={closeOnMobile}>
                查看积分明细
                <ArrowRight size={13} />
              </Link>
            </div>
            <Link
              className="identity-button"
              to="/settings"
              aria-label="个人资料与账号安全"
              onClick={closeOnMobile}
            >
              <span className="avatar">{initial}</span>
              <div>
                <strong>{me.user.display_name}</strong>
                <small>
                  {me.user.role === 'USER'
                    ? '普通用户'
                    : me.user.role === 'ADMIN'
                      ? '管理员'
                      : '超级管理员'}
                </small>
              </div>
              <ChevronRight size={15} />
            </Link>
          </div>
        </aside>
        <div className="app-body">
          <header className="app-topbar">
            <div className="topbar-left">
              <button
                className="icon-btn"
                aria-label="展开折叠边栏"
                aria-expanded={open}
                aria-controls="workspace-navigation"
                onClick={() => setOpen(!open)}
              >
                <PanelLeft size={17} />
              </button>
              <span className="topbar-divider" />
              <span className="topbar-breadcrumb">Workspace</span>
              <span>/</span>
              <strong>
                {[...creation, ...personal, ...admin].find(
                  (item) =>
                    item.path === location.pathname ||
                    (item.path === '/canvas' &&
                      location.pathname.startsWith('/canvas/')) ||
                    (item.path === '/chat' &&
                      location.pathname.startsWith('/chat/')),
                )?.label || '工作台'}
              </strong>
            </div>
            <div className="topbar-right">
              <div
                className="topbar-search"
                aria-disabled="true"
                title="搜索即将开放"
              >
                <Search size={15} />
                <span>搜索项目、素材与功能</span>
              </div>
              {me.user.role !== 'USER' ? (
                <Link
                  className="icon-btn"
                  to="/admin"
                  aria-label="查看管理通知"
                >
                  <Bell size={17} />
                </Link>
              ) : (
                <button
                  className="icon-btn"
                  disabled
                  aria-label="通知（即将开放）"
                >
                  <Bell size={17} />
                </button>
              )}
              <Link to="/settings" aria-label="当前账号资料">
                <span className="avatar tiny">{initial}</span>
              </Link>
            </div>
          </header>
          <div className="app-content">{children}</div>
        </div>
      </div>
    </BalanceContext.Provider>
  );
}
