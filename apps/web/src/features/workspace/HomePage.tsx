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
          <button className="btn" disabled title="画布创作即将开放">
            <Plus size={16} />
            新建画布
          </button>
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
                {name !== '素材库' && (
                  <span className="feature-pending">即将开放</span>
                )}
              </div>
              <strong>
                {name}
                <ArrowRight size={16} />
              </strong>
              <p>{description}</p>
            </>
          );
          return name === '素材库' ? (
            <Link to="/assets" key={name}>
              {content}
            </Link>
          ) : (
            <article key={name}>{content}</article>
          );
        })}
      </div>
      <div className="section-head">
        <h2>最近的创作项目</h2>
        <span className="muted">你的灵感，即将在这里展开</span>
      </div>
      <div className="workspace-projects">
        <button className="project-card create-card" disabled>
          <Plus size={23} />
          <strong>创建新项目</strong>
          <small>画布功能开放后，从这里开始</small>
        </button>
        <div className="workspace-empty">
          <GalleryHorizontal size={30} strokeWidth={1.2} />
          <h3>留一片空间，给下一个好想法</h3>
          <p>画布创作正在准备中。你可以先生成图片与视频，或签到积累积分。</p>
        </div>
      </div>
      <div className="section-head">
        <h2>我的积分与每日签到</h2>
        <span className="muted">每天积累一点创作的可能</span>
      </div>
      <WalletPage {...props} home />
    </main>
  );
}
