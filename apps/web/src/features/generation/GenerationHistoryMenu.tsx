import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, RefreshCw, Trash2 } from 'lucide-react';
import { active, type Job } from './generationApi';

export type HistoryMenu = {
  job: Job;
  x: number;
  y: number;
  trigger: HTMLElement;
};
export default function GenerationHistoryMenu({
  menu,
  onClose,
  onView,
  onReuse,
  onDelete,
  reuseDisabled,
}: {
  menu: HistoryMenu;
  onClose: () => void;
  onView: () => void;
  onReuse: () => void;
  onDelete: () => void;
  reuseDisabled: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const bounds = root.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(
        8,
        Math.min(menu.y, window.innerHeight - bounds.height - 8),
      ),
    });
    root.current
      ?.querySelector<HTMLButtonElement>('[role=menuitem]')
      ?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close.current();
    };
    const dismiss = () => close.current();
    const scroll = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', scroll, true);
    };
  }, []);
  return createPortal(
    <div
      ref={root}
      className="gen-history-menu"
      role="menu"
      aria-label="生成记录操作"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose();
          menu.trigger.focus({ preventScroll: true });
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...root.current!.querySelectorAll<HTMLButtonElement>(
              '[role=menuitem]:not(:disabled)',
            ),
          ];
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
      <div
        tabIndex={0}
        className="gen-history-menu-heading"
        data-tip={menu.job.prompt}
      >
        {menu.job.prompt}
      </div>
      <button role="menuitem" onClick={onView}>
        <Eye size={16} />
        查看结果
      </button>
      <button role="menuitem" disabled={reuseDisabled} onClick={onReuse}>
        <RefreshCw size={16} />
        复用参数
      </button>
      <div className="gen-history-menu-divider" role="separator" />
      <button
        role="menuitem"
        className="gen-history-menu-delete"
        disabled={active(menu.job)}
        onClick={onDelete}
      >
        <Trash2 size={16} />
        删除记录
      </button>
      <p>
        {active(menu.job)
          ? '任务进行中，结束后可删除记录'
          : '仅移除记录，生成素材仍会保留'}
      </p>
    </div>,
    document.body,
  );
}
