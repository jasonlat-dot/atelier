import {
  ArrowRight,
  FolderOpen,
  GalleryHorizontal,
  MessageSquare,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { Me } from '../auth/sessionApi';
import { Link } from 'react-router-dom';
import WalletPage from '../wallet/WalletPage';
import { ProjectGrid } from '../canvas/ProjectsPage';

const shortcuts = [
  {
    name: '无限创作画布',
    description: '连接提示词、图片与视频，让创意在画布上延伸。',
    icon: GalleryHorizontal,
  },
  {
    name: 'AI 对话',
    description: '用自然语言整理想法、获取视频脚本与创意建议。',
    icon: MessageSquare,
  },
  {
    name: '素材库',
    description: '组织你的参考图、生成结果和创作视频。',
    icon: FolderOpen,
  },
];
export default function HomePage(props: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
}) {
  return (
    <main className="page-padding dashboard-page">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">CREATIVE WORKSPACE</div>
          <h1>欢迎回来，{props.me.user.display_name}</h1>
          <p className="page-subtitle">
            从一个想法开始，连接图片、视频与文字，完成你的下一次创作。
          </p>
        </div>
        <div className="gen-actions">
          <Link className="btn btn-dark" to="/generate">
            <Sparkles size={16} />
            开始生成
          </Link>
          <Link className="btn" to="/canvas/new">
            <Plus size={16} />
            新建画布
          </Link>
        </div>
      </div>
      <div className="quick-cards">
        {shortcuts.map(({ name, description, icon: Icon }) => {
          const content = (
            <>
              <div className="quick-card-top">
                <div className="quick-icon">
                  <Icon size={19} />
                </div>
              </div>
              <strong>
                {name}
                <ArrowRight size={16} />
              </strong>
              <p>{description}</p>
            </>
          );
          return (
            <Link
              to={
                name === '素材库'
                  ? '/assets'
                  : name === 'AI 对话'
                    ? '/chat'
                    : '/canvas'
              }
              key={name}
            >
              {content}
            </Link>
          );
        })}
      </div>
      <div className="section-head">
        <h2>最近的创作项目</h2>
        <span className="muted">
          <Link to="/canvas">查看全部画布</Link>
        </span>
      </div>
      <ProjectGrid {...props} home />
      <div className="section-head">
        <h2>我的积分与每日签到</h2>
        <span className="muted">每天积累一点创作的可能</span>
      </div>
      <WalletPage {...props} home />
    </main>
  );
}
