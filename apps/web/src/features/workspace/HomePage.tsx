import {
  FolderOpen,
  GalleryHorizontal,
  MessageSquare,
  Plus,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Me } from '../auth/sessionApi';
import { Link, useNavigate } from 'react-router-dom';
import WalletPage from '../wallet/WalletPage';
import { ProjectGrid } from '../canvas/ProjectsPage';
import './HomePage.css';

const shortcuts = [
  {
    name: '无限创作画布',
    description: '连接提示词、图片与视频，让创意在画布上延伸。',
    icon: GalleryHorizontal,
  },
  {
    name: 'AI 对话',
    description: '整理想法、获取视频脚本与创意建议。',
    icon: MessageSquare,
  },
  {
    name: '素材库',
    description: '组织你的参考图、生成结果和创作视频。',
    icon: FolderOpen,
  },
];
const examples = [
  '一支雨夜城市的 15 秒短片',
  '海边的人物写真，逆光',
  '二次元角色四视图设定',
];
export default function HomePage(props: {
  me: Me;
  onExpired: () => void;
  onReload: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const navigate = useNavigate();
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(input.current.scrollHeight, 140)}px`;
  }, [prompt]);
  return (
    <main className="page-padding dashboard-page workspace-home">
      <div className="page-title-row">
        <div>
          <div className="eyebrow">CREATIVE WORKSPACE</div>
          <h1>欢迎回来，{props.me.user.display_name}</h1>
          <p className="page-subtitle">
            从一个想法开始，连接图片、视频与文字，完成你的下一次创作。
          </p>
        </div>
      </div>
      <form
        className="home-composer"
        aria-label="开始创作"
        onSubmit={(event) => {
          event.preventDefault();
          if (!prompt.trim() || composing.current) return;
          navigate('/generate', { state: { workspacePrompt: prompt.trim() } });
        }}
      >
        <label className="home-prompt">
          <span className="home-visually-hidden">描述你想创作的内容</span>
          <textarea
            ref={input}
            rows={1}
            value={prompt}
            maxLength={4000}
            onChange={(event) => setPrompt(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !composing.current &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="描述你想创作的内容，例如：一支雨夜城市的 15 秒短片…"
            autoComplete="off"
          />
        </label>
        <div className="home-composer-actions">
          <Link className="btn" to="/canvas/new">
            <Plus size={16} />
            新建画布
          </Link>
          <button
            className="btn btn-dark"
            type="submit"
            disabled={!prompt.trim()}
          >
            开始生成
          </button>
        </div>
      </form>
      <div className="home-examples" role="group" aria-label="示例提示词">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setPrompt(example);
              input.current?.focus();
            }}
          >
            {example}
          </button>
        ))}
      </div>
      <div className="quick-cards">
        {shortcuts.map(({ name, description, icon: Icon }) => {
          const content = (
            <>
              <div className="quick-icon">
                <Icon size={20} aria-hidden="true" />
              </div>
              <div className="home-shortcut-copy">
                <strong>{name}</strong>
                <p>{description}</p>
              </div>
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
      <div className="home-columns">
        <section aria-labelledby="home-projects-heading">
          <div className="section-head">
            <h2 id="home-projects-heading">最近的创作项目</h2>
            <Link to="/canvas">查看全部画布 →</Link>
          </div>
          <ProjectGrid {...props} home />
        </section>
        <section aria-labelledby="home-wallet-heading">
          <div className="section-head">
            <h2 id="home-wallet-heading">积分与每日签到</h2>
          </div>
          <WalletPage {...props} home />
        </section>
      </div>
    </main>
  );
}
