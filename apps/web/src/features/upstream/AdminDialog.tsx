import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export default function AdminDialog({
  title,
  children,
  onClose,
  busy = false,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    el?.showModal();
    el?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      el?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`up-dialog ${drawer ? 'up-drawer' : ''}`}
      aria-labelledby={titleId}
      aria-modal="true"
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (busy || e.target !== e.currentTarget) return;
        const b = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < b.left ||
          e.clientX > b.right ||
          e.clientY < b.top ||
          e.clientY > b.bottom
        )
          onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭弹窗"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
