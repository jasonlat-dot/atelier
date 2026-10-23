import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleX, Info, TriangleAlert } from 'lucide-react';
import './Feedback.css';

type Variant = 'success' | 'error' | 'warning' | 'info';
type Notice = {
  id: string;
  owner?: string;
  variant: Variant;
  title: string;
  content: () => ReactNode;
  confirm?: { label: string; resolve: (accepted: boolean) => void };
  dismiss?: () => void;
};
let queue: Notice[] = [];
let lastFocusOutside: HTMLElement | null = null;
const listeners = new Set<() => void>();
const snapshot = () => queue;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function publish(next: Notice[]) {
  queue = next;
  listeners.forEach((listener) => listener());
}
function remove(id: string) {
  if (queue.some((item) => item.id === id))
    publish(queue.filter((item) => item.id !== id));
}
function push(notice: Notice) {
  publish([...queue.filter((item) => item.id !== notice.id), notice]);
}
const titles: Record<Variant, string> = {
  success: '操作成功',
  error: '操作未完成',
  warning: '请注意',
  info: '提示',
};
function textContent(children: ReactNode): string {
  return Children.toArray(children)
    .map((node) => {
      if (typeof node === 'string' || typeof node === 'number')
        return String(node);
      if (isValidElement<{ children?: ReactNode }>(node)) {
        if (node.type === 'button' || node.type === 'a') return '';
        return textContent(node.props.children);
      }
      return '';
    })
    .join('');
}

/** Declarative results never render a page banner; the host serializes dialogs. */
export default function Feedback({
  children,
  variant = 'error',
  title,
  eventKey,
  onDismiss,
  ...attributes
}: HTMLAttributes<HTMLDivElement> & {
  variant?: Variant;
  title?: string;
  eventKey?: unknown;
  onDismiss?: () => void;
}) {
  const id = useId();
  const latest = useRef({ children, onDismiss, onClick: attributes.onClick });
  latest.current = { children, onDismiss, onClick: attributes.onClick };
  const text = textContent(children).trim();
  useEffect(() => {
    if (!text) return;
    push({
      id,
      variant,
      title: title || titles[variant],
      content: () => (
        <div onClick={latest.current.onClick}>{latest.current.children}</div>
      ),
      dismiss: () => latest.current.onDismiss?.(),
    });
    return () => remove(id);
  }, [id, text, variant, title, eventKey]);
  useEffect(() => {
    // Refresh action states without registering another result notification.
    if (queue.some((item) => item.id === id)) publish([...queue]);
  });
  return null;
}

export function showNotice(message: ReactNode, variant: Variant = 'info') {
  push({
    id: crypto.randomUUID(),
    variant,
    title: titles[variant],
    content: () => message,
  });
}

export function useConfirmNotice() {
  const owner = useId();
  useEffect(
    () => () => {
      const removed = queue.filter((item) => item.owner === owner);
      if (removed.length) publish(queue.filter((item) => item.owner !== owner));
      removed.forEach((item) => item.confirm?.resolve(false));
    },
    [owner],
  );
  return useCallback(
    (message: ReactNode, options?: { title?: string; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => {
        push({
          id: crypto.randomUUID(),
          owner,
          variant: 'warning',
          title: options?.title || '确认此操作？',
          content: () => message,
          confirm: { label: options?.confirmLabel || '确认继续', resolve },
        });
      }),
    [owner],
  );
}

function NoticeDialog({ notice }: { notice: Notice }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const element = dialog.current;
    const active = document.activeElement as HTMLElement | null;
    const previous =
      active && active !== document.body ? active : lastFocusOutside;
    element?.showModal();
    primary.current?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected && !previous.closest('[inert]')) {
        if (!previous.matches(':disabled')) previous.focus();
        else
          previous
            .closest('form, main, section')
            ?.querySelector<HTMLElement>(
              'input:not(:disabled), button:not(:disabled), a[href]',
            )
            ?.focus();
      }
    };
  }, []);
  const close = (accepted = false) => {
    dialog.current?.close();
    remove(notice.id);
    notice.confirm?.resolve(accepted);
    notice.dismiss?.();
  };
  const Icon =
    notice.variant === 'success'
      ? Check
      : notice.variant === 'error'
        ? CircleX
        : notice.variant === 'warning'
          ? TriangleAlert
          : Info;
  return createPortal(
    <dialog
      ref={dialog}
      className={`app-feedback app-feedback-${notice.variant}`}
      role={notice.confirm ? 'dialog' : 'alertdialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-feedback-dialog="true"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
          ),
        ).filter((el) => el.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
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
          close();
      }}
    >
      <div className="app-feedback-symbol" aria-hidden="true">
        <Icon size={32} strokeWidth={1.7} />
      </div>
      <h2 id={titleId}>{notice.title}</h2>
      <div
        id={bodyId}
        className="app-feedback-content"
        role={
          notice.variant === 'error' || notice.variant === 'warning'
            ? 'alert'
            : 'status'
        }
        onClick={(event) => {
          const action = (event.target as Element).closest('button, a[href]');
          if (action && !action.hasAttribute('disabled')) close();
        }}
      >
        {notice.content()}
      </div>
      <div className="app-feedback-actions">
        {notice.confirm && (
          <button
            type="button"
            className="app-feedback-secondary"
            onClick={() => close()}
          >
            取消
          </button>
        )}
        <button
          type="button"
          className="app-feedback-primary"
          ref={primary}
          onClick={() => close(true)}
        >
          {notice.confirm?.label || '知道了'}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}

export function FeedbackHost() {
  useEffect(() => {
    const remember = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.closest?.('[data-feedback-dialog]')) return;
      const control = target.closest?.<HTMLElement>(
        'button, a[href], input, textarea, select, summary, [tabindex="0"]',
      );
      if (control) lastFocusOutside = control;
    };
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('focusin', remember, true);
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('focusin', remember, true);
      lastFocusOutside = null;
    };
  }, []);
  const notices = useSyncExternalStore(subscribe, snapshot);
  const notice = notices[0];
  return notice ? <NoticeDialog key={notice.id} notice={notice} /> : null;
}
