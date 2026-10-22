import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function AssetDialog({
  title,
  children,
  onClose,
  preview = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  preview?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>('[data-initial-focus]')?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`asset-dialog ${preview ? 'asset-preview' : ''}`}
      aria-modal="true"
      aria-labelledby="asset-dialog-title"
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header>
        <h2 id="asset-dialog-title">{title}</h2>
        <button
          className="icon-btn"
          aria-label="关闭弹窗"
          onClick={onClose}
          disabled={busy}
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
