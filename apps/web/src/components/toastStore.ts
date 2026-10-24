export const toastPositions = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export type ToastPosition = (typeof toastPositions)[number];
export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'loading';
export type ToastOptions = {
  title: string;
  description?: string | null;
  type?: ToastType;
  duration?: number;
  position?: ToastPosition;
  id?: string;
  closable?: boolean;
  action?: { label: string; onClick: () => void | Promise<void> } | null;
  onClose?: () => void;
};
export type ToastPatch = Partial<ToastOptions>;
export type ToastNotice = Omit<
  ToastOptions,
  'id' | 'type' | 'duration' | 'position' | 'closable'
> & {
  id: string;
  owner: string;
  type: ToastType;
  duration: number;
  position: ToastPosition;
  closable: boolean;
  revision: number;
  leaving: boolean;
};
export type ToastConfig = {
  position: ToastPosition;
  duration: number;
  errorDuration: number;
  max: number;
};
export type ToastPromiseMessages<T> = {
  loading: string;
  success: string | ((value: T) => string);
  error: string | ((error: unknown) => string);
};
let config: ToastConfig = {
  position: 'top-center',
  duration: 3000,
  errorDuration: 5000,
  max: 3,
};
let notices: ToastNotice[] = [];
const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const key = (owner: string, id: string) => `${owner}/${id}`;
export const getToasts = () => notices;
export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(next: ToastNotice[]) {
  notices = next;
  listeners.forEach((listener) => listener());
}
function cancelExit(item: ToastNotice) {
  const token = key(item.owner, item.id);
  clearTimeout(exitTimers.get(token));
  exitTimers.delete(token);
}
function duration(
  value: number | undefined,
  type: ToastType,
  action: ToastOptions['action'],
) {
  const fallback =
    type === 'loading'
      ? 0
      : type === 'error'
        ? config.errorDuration
        : config.duration;
  if (value !== undefined && Number.isFinite(value) && value >= 0)
    return Math.min(Math.round(value), 2147483647);
  return action && fallback > 0 ? Math.max(6000, fallback) : fallback;
}
function trimRegions() {
  const counts = new Map<ToastPosition, number>();
  const removed: ToastNotice[] = [];
  const kept = notices.filter((item) => {
    const count = (counts.get(item.position) || 0) + 1;
    counts.set(item.position, count);
    if (count <= config.max) return true;
    cancelExit(item);
    removed.push(item);
    return false;
  });
  if (removed.length) publish(kept);
  removed.forEach((item) => item.onClose?.());
}
export function configureToasts(patch: Partial<ToastConfig>) {
  config = {
    position:
      patch.position && toastPositions.includes(patch.position)
        ? patch.position
        : config.position,
    duration:
      patch.duration !== undefined &&
      Number.isFinite(patch.duration) &&
      patch.duration >= 0
        ? Math.min(patch.duration, 2147483647)
        : config.duration,
    errorDuration:
      patch.errorDuration !== undefined &&
      Number.isFinite(patch.errorDuration) &&
      patch.errorDuration >= 0
        ? Math.min(patch.errorDuration, 2147483647)
        : config.errorDuration,
    max:
      patch.max !== undefined && Number.isInteger(patch.max) && patch.max > 0
        ? patch.max
        : config.max,
  };
  trimRegions();
}
export function showToast(owner: string, options: ToastOptions): string {
  if (!options.title.trim()) return '';
  const existing = notices.find(
    (item) =>
      item.owner === owner &&
      (options.id
        ? item.id === options.id
        : item.title === options.title &&
          item.type === (options.type || 'info') &&
          item.description === options.description),
  );
  if (existing) {
    updateToast(owner, existing.id, options);
    return existing.id;
  }
  const type = options.type || 'info';
  const notice: ToastNotice = {
    ...options,
    id: options.id || crypto.randomUUID(),
    owner,
    type,
    duration: duration(options.duration, type, options.action),
    position: options.position || config.position,
    closable: options.closable ?? true,
    revision: 0,
    leaving: false,
  };
  publish([notice, ...notices]);
  trimRegions();
  return notice.id;
}
export function updateToast(owner: string, id: string, patch: ToastPatch) {
  const item = notices.find((item) => item.owner === owner && item.id === id);
  if (!item) return;
  cancelExit(item);
  const type = patch.type || item.type;
  publish(
    notices.map((current) =>
      current !== item
        ? current
        : {
            ...item,
            ...patch,
            id: item.id,
            owner: item.owner,
            title: patch.title?.trim() ? patch.title : item.title,
            type,
            duration: duration(
              patch.duration ?? (patch.type ? undefined : item.duration),
              type,
              patch.action === undefined ? item.action : patch.action,
            ),
            position: patch.position || item.position,
            closable: patch.closable ?? item.closable,
            revision: item.revision + 1,
            leaving: false,
          },
    ),
  );
  trimRegions();
}
export function dismissToast(owner: string, id: string) {
  const item = notices.find((item) => item.owner === owner && item.id === id);
  if (!item || item.leaving) return;
  publish(
    notices.map((current) =>
      current === item ? { ...item, leaving: true } : current,
    ),
  );
  exitTimers.set(
    key(owner, id),
    setTimeout(() => {
      const current = notices.find(
        (notice) => notice.owner === owner && notice.id === id,
      );
      exitTimers.delete(key(owner, id));
      if (!current?.leaving) return;
      publish(notices.filter((notice) => notice !== current));
      current.onClose?.();
    }, 180),
  );
}
export function dismissOwnerToasts(owner: string) {
  notices
    .filter((item) => item.owner === owner)
    .forEach((item) => dismissToast(owner, item.id));
}
/** Unmount cleanup must not invoke callbacks belonging to a departed page. */
export function clearOwnerToasts(owner: string) {
  const removed = notices.filter((item) => item.owner === owner);
  if (!removed.length) return;
  removed.forEach(cancelExit);
  publish(notices.filter((item) => item.owner !== owner));
}
export function clearToasts() {
  notices.forEach(cancelExit);
  publish([]);
}

export function createToastTimer(duration: number, onElapsed: () => void) {
  let remaining = duration;
  let completed = false;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - started));
  };
  return {
    pause,
    resume: () => {
      if (duration === 0 || completed || timer !== undefined) return;
      started = Date.now();
      timer = setTimeout(() => {
        timer = undefined;
        remaining = 0;
        completed = true;
        onElapsed();
      }, remaining);
    },
  };
}

export function trackToastPromise<T>(
  owner: string,
  promise: Promise<T>,
  messages: ToastPromiseMessages<T>,
): Promise<T> {
  const id = showToast(owner, {
    id: crypto.randomUUID(),
    title: messages.loading,
    type: 'loading',
  });
  const update = (type: 'success' | 'error', title: () => string) => {
    if (
      !notices.some(
        (item) => item.owner === owner && item.id === id && !item.leaving,
      )
    )
      return;
    updateToast(owner, id, { type, title: title() });
  };
  void promise.then(
    (value) =>
      update('success', () =>
        typeof messages.success === 'function'
          ? messages.success(value)
          : messages.success,
      ),
    (error: unknown) =>
      update('error', () =>
        typeof messages.error === 'function'
          ? messages.error(error)
          : messages.error,
      ),
  );
  return promise;
}
