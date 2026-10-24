import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  clearOwnerToasts,
  clearToasts,
  configureToasts,
  createToastTimer,
  dismissOwnerToasts,
  dismissToast,
  getToasts,
  showToast,
  subscribeToasts,
  toastPositions,
  updateToast,
  trackToastPromise,
  type ToastConfig,
  type ToastNotice,
  type ToastOptions,
  type ToastPatch,
  type ToastType,
  type ToastPromiseMessages,
} from './toastStore';
import './Toast.css';

export type {
  ToastOptions,
  ToastPatch,
  ToastPosition,
  ToastType,
  ToastConfig,
  ToastPromiseMessages,
} from './toastStore';
export type ToastHandle = {
  id: string;
  update: (patch: ToastPatch) => void;
  dismiss: () => void;
};
type TypeOptions = Omit<ToastOptions, 'title' | 'type'>;

/** Lightweight feedback only; financial results and confirmations still use Feedback. */
export function useToast() {
  const owner = useId();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearOwnerToasts(owner);
    };
  }, [owner]);
  const show = useCallback(
    (
      input: string | ToastOptions,
      type: ToastType = 'success',
    ): ToastHandle => {
      const id = mounted.current
        ? showToast(
            owner,
            typeof input === 'string' ? { title: input, type } : input,
          )
        : '';
      return {
        id,
        update: (patch) => {
          if (mounted.current) updateToast(owner, id, patch);
        },
        dismiss: () => {
          if (mounted.current) dismissToast(owner, id);
        },
      };
    },
    [owner],
  );
  return useMemo(() => {
    const typed = (type: ToastType) => (title: string, options?: TypeOptions) =>
      show({ ...options, title, type });
    return Object.assign(show, {
      show,
      success: typed('success'),
      error: typed('error'),
      warning: typed('warning'),
      info: typed('info'),
      loading: typed('loading'),
      update: (id: string, patch: ToastPatch) => {
        if (mounted.current) updateToast(owner, id, patch);
      },
      dismiss: (id: string) => {
        if (mounted.current) dismissToast(owner, id);
      },
      dismissAll: () => {
        if (mounted.current) dismissOwnerToasts(owner);
      },
      config: (patch: Partial<ToastConfig>) => {
        if (mounted.current) configureToasts(patch);
      },
      promise: <T,>(promise: Promise<T>, messages: ToastPromiseMessages<T>) =>
        mounted.current ? trackToastPromise(owner, promise, messages) : promise,
    });
  }, [owner, show]);
}

const paths: Record<ToastType, string> = {
  success: 'M5 12.5l4.5 4.5L19 7.5',
  error: 'M12 7v6M12 17h.01',
  warning: 'M12 4l9 16H3z M12 10v4M12 17.5h.01',
  info: 'M12 11v6M12 7.5h.01',
  loading: 'M12 4a8 8 0 1 0 8 8',
};
function ToastItem({ item }: { item: ToastNotice }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const paused = hovered || focused || actionBusy;
  const clock = useMemo(
    () =>
      createToastTimer(item.duration, () => dismissToast(item.owner, item.id)),
    [item.owner, item.id, item.revision, item.duration],
  );
  useEffect(() => {
    if (paused || item.leaving) clock.pause();
    else clock.resume();
    return clock.pause;
  }, [clock, item.leaving, paused]);
  return (
    <div
      className={`app-toast${item.leaving ? ' is-leaving' : ''}${paused ? ' is-paused' : ''}`}
      data-variant={item.type}
      style={{ '--tt-dur': `${item.duration}ms` } as CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <span className="app-toast-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={paths[item.type]} />
        </svg>
      </span>
      <div className="app-toast-body">
        <div
          role={item.type === 'error' ? 'alert' : 'status'}
          aria-live={item.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <div className="app-toast-title">{item.title}</div>
          {item.description && (
            <div className="app-toast-description">{item.description}</div>
          )}
        </div>
        {item.action && (
          <div className="app-toast-actions">
            <button
              type="button"
              className="app-toast-action"
              disabled={actionBusy || item.leaving}
              aria-busy={actionBusy}
              onClick={async () => {
                setActionBusy(true);
                try {
                  await item.action!.onClick();
                  dismissToast(item.owner, item.id);
                } catch {
                  updateToast(item.owner, item.id, {
                    type: 'error',
                    title: '操作未完成',
                    description: '请返回页面核对后重试。',
                    action: null,
                  });
                } finally {
                  setActionBusy(false);
                }
              }}
            >
              {item.action.label}
            </button>
          </div>
        )}
      </div>
      {item.closable && (
        <button
          type="button"
          className="app-toast-close"
          aria-label="关闭提示"
          disabled={item.leaving}
          onClick={() => dismissToast(item.owner, item.id)}
        >
          <X size={15} />
        </button>
      )}
      {item.duration > 0 && (
        <span
          key={item.revision}
          className="app-toast-progress"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
function ToastRegion({ items }: { items: ToastNotice[] }) {
  const layer = useRef<HTMLDivElement>(null);
  const position = items[0].position;
  useEffect(() => {
    const element = layer.current;
    if (!element || typeof element.showPopover !== 'function') return;
    element.setAttribute('popover', 'manual');
    element.showPopover();
    return () => {
      element.hidePopover?.();
    };
  }, []);
  return (
    <div
      className="app-toast-viewport"
      ref={layer}
      data-position={position}
      aria-label="轻量操作提示"
    >
      {items.map((item) => (
        <ToastItem key={`${item.owner}/${item.id}`} item={item} />
      ))}
    </div>
  );
}
export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, getToasts);
  const [modal, setModal] = useState<Element | null>(null);
  useEffect(() => {
    // Modal-local portals remain accessible and appear above the existing backdrop.
    const update = () =>
      setModal(
        document.activeElement?.closest('dialog[open]') ||
          Array.from(document.querySelectorAll('dialog[open]')).at(-1) ||
          null,
      );
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => {
      observer.disconnect();
      clearToasts();
    };
  }, []);
  return items.length
    ? createPortal(
        <>
          {toastPositions.map((position) => {
            const group = items.filter((item) => item.position === position);
            return group.length ? (
              <ToastRegion key={position} items={group} />
            ) : null;
          })}
        </>,
        modal?.isConnected ? modal : document.body,
      )
    : null;
}
