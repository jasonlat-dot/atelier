import { useEffect, useRef } from 'react';
import {
  Copy,
  Film,
  Image as ImageIcon,
  Layers,
  Settings2,
  Sparkles,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type { GraphNode } from './projectApi';

export type CanvasMenu = {
  x: number;
  y: number;
  point: { x: number; y: number };
  source?: string;
  node?: string;
  edge?: string;
};
export default function CanvasContextMenu({
  menu,
  width,
  height,
  source,
  node,
  viewport,
  onClose,
  onDerive,
  onAdd,
  onDuplicate,
  onRemove,
  onDisconnect,
}: {
  menu: CanvasMenu;
  width: number;
  height: number;
  source?: GraphNode;
  node?: GraphNode;
  viewport: { x: number; y: number; zoom: number };
  onClose: () => void;
  onDerive: (
    id: string,
    point?: CanvasMenu['point'],
    kind?: 'image' | 'video',
  ) => void;
  onAdd: (
    type: 'text' | 'generate' | 'upload' | 'library',
    point: CanvasMenu['point'],
  ) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onDisconnect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const left = Math.max(8, Math.min(menu.x + (source ? 16 : 0), width - 276));
  const top = Math.max(8, Math.min(menu.y, height - (source ? 308 : 260)));
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLButtonElement>('button[role=menuitem]')
      ?.focus({ preventScroll: true });
  }, []);
  const from = source && {
    x: viewport.x + (source.position.x + source.size.width) * viewport.zoom,
    y:
      viewport.y + (source.position.y + source.size.height / 2) * viewport.zoom,
  };
  return (
    <>
      {from && (
        <svg className="canvas-pending-link" aria-hidden="true">
          <path
            d={`M ${from.x} ${from.y} C ${from.x + 80} ${from.y}, ${left - 80} ${top + 32}, ${left} ${top + 32}`}
          />
        </svg>
      )}
      <div
        ref={ref}
        className="canvas-context-menu nodrag nopan"
        role="menu"
        aria-label={source ? '引用该节点生成' : '画布操作'}
        style={{ left, top }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(
              ref.current!.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ),
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            buttons[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index +
                      (event.key === 'ArrowDown' ? 1 : -1) +
                      buttons.length) %
                    buttons.length
            ]?.focus();
          }
        }}
      >
        <div className="canvas-menu-heading">
          {source
            ? '引用该节点生成'
            : node
              ? '节点操作'
              : menu.edge
                ? '连线操作'
                : '在这里添加'}
          <button aria-label="关闭创建菜单" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {source ? (
          <>
            <button
              role="menuitem"
              onClick={() => onDerive(source.id, menu.point, 'image')}
            >
              <span className="canvas-menu-icon">
                <ImageIcon size={19} />
              </span>
              <span>
                <strong>图片生成</strong>
                <small>以此为提示词或参考图</small>
              </span>
            </button>
            <button
              role="menuitem"
              onClick={() => onDerive(source.id, menu.point, 'video')}
            >
              <span className="canvas-menu-icon">
                <Film size={19} />
              </span>
              <span>
                <strong>视频生成</strong>
                <small>连接描述或首帧参考</small>
              </span>
            </button>
            <button
              role="menuitem"
              onClick={() => onDerive(source.id, menu.point)}
            >
              <span className="canvas-menu-icon">
                <Settings2 size={19} />
              </span>
              <span>
                <strong>配置生成节点</strong>
                <small>先连接，再选择模型与参数</small>
              </span>
            </button>
            <p className="canvas-menu-note">
              只创建节点；点击生成后才会提交任务。
            </p>
          </>
        ) : menu.edge ? (
          <button role="menuitem" onClick={() => onDisconnect(menu.edge!)}>
            <Trash2 size={15} />
            断开这条连线
          </button>
        ) : node ? (
          <>
            {['image', 'text'].includes(node.type) && (
              <button role="menuitem" onClick={() => onDerive(node.id)}>
                <Sparkles size={15} />
                继续创作
              </button>
            )}
            <button role="menuitem" onClick={onDuplicate}>
              <Copy size={15} />
              复制节点 <kbd>Ctrl D</kbd>
            </button>
            <button role="menuitem" disabled={!!node.locked} onClick={onRemove}>
              <Trash2 size={15} />
              删除 <kbd>Delete</kbd>
            </button>
          </>
        ) : (
          <>
            <button role="menuitem" onClick={() => onAdd('text', menu.point)}>
              <Type size={15} />
              文字节点 <kbd>T</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => onAdd('generate', menu.point)}
            >
              <Sparkles size={15} />
              生成节点 <kbd>G</kbd>
            </button>
            <button role="menuitem" onClick={() => onAdd('upload', menu.point)}>
              <ImageIcon size={15} />
              上传图片或视频 <kbd>I</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => onAdd('library', menu.point)}
            >
              <Layers size={15} />
              从素材库添加
            </button>
          </>
        )}
      </div>
    </>
  );
}
