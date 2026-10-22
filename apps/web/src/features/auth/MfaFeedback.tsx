import { useEffect, useRef } from 'react';
import { CircleX, Hourglass } from 'lucide-react';

export type MfaNotice = {
  kind: 'invalid' | 'expired' | 'error';
  title: string;
  message: string;
};

export default function MfaFeedback({
  notice,
  onDismiss,
  onPrimary,
}: {
  notice: MfaNotice;
  onDismiss: () => void;
  onPrimary: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    primary.current?.focus();
    return () => element?.close();
  }, [notice]);
  const close = (action: () => void) => {
    dialog.current?.close();
    action();
  };
  return (
    <dialog
      ref={dialog}
      className="mfa-confirm mfa-feedback"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="mfa-feedback-title"
      aria-describedby="mfa-feedback-description"
      onCancel={(event) => {
        event.preventDefault();
        close(onDismiss);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)',
        );
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first || !last) return;
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close(onDismiss);
      }}
    >
      <div
        className={
          notice.kind === 'expired'
            ? 'mfa-feedback-icon mfa-feedback-warning'
            : 'mfa-feedback-icon'
        }
        aria-hidden="true"
      >
        {notice.kind === 'expired' ? (
          <Hourglass size={30} strokeWidth={1.6} />
        ) : (
          <CircleX size={30} strokeWidth={1.6} />
        )}
      </div>
      <h2 id="mfa-feedback-title">{notice.title}</h2>
      <p id="mfa-feedback-description">{notice.message}</p>
      <div className="mfa-feedback-actions">
        {notice.kind === 'expired' && (
          <button
            className="btn btn-light"
            type="button"
            onClick={() => close(onDismiss)}
          >
            取消
          </button>
        )}
        <button
          ref={primary}
          className="btn btn-dark"
          type="button"
          onClick={() => close(onPrimary)}
        >
          {notice.kind === 'expired'
            ? '重新绑定'
            : notice.kind === 'invalid'
              ? '重新输入'
              : '知道了'}
        </button>
      </div>
    </dialog>
  );
}
