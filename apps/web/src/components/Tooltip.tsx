import {
  Children,
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { tooltipPosition, type TooltipPlacement } from './tooltipPosition';
import './Tooltip.css';

type Props = {
  content?: string | null;
  title?: string;
  placement?: TooltipPlacement;
  delay?: number;
  children: ReactElement;
  wrapperClassName?: string;
};

/** Keep control identity stable across disabled/loading/hint changes. */
export default function Tooltip({
  content,
  title,
  placement = 'top',
  delay = 300,
  children,
  wrapperClassName,
}: Props) {
  const child = Children.only(children) as ReactElement<
    Record<string, unknown>
  >;
  const attributes = {
    'data-tip': content || undefined,
    'data-tip-title': content ? title : undefined,
    'data-tip-placement': placement,
    'data-tip-delay': delay,
  };
  const control =
    typeof child.type === 'string' &&
    ['button', 'input', 'textarea', 'select', 'a', 'summary'].includes(
      child.type,
    );
  if (control || child.props.disabled) {
    const disabledHint = !!child.props.disabled && !!content;
    return (
      <span
        {...(disabledHint ? attributes : {})}
        className={`tooltip-trigger${disabledHint ? ' tooltip-disabled-trigger' : ''} ${wrapperClassName || ''}`}
        tabIndex={disabledHint ? 0 : undefined}
        role={disabledHint ? 'group' : undefined}
        aria-label={
          !disabledHint
            ? undefined
            : typeof child.props['aria-label'] === 'string'
              ? child.props['aria-label']
              : content
        }
        aria-disabled={disabledHint || undefined}
        onClick={disabledHint ? (event) => event.stopPropagation() : undefined}
        onPointerDown={
          disabledHint ? (event) => event.stopPropagation() : undefined
        }
      >
        {cloneElement(child, disabledHint ? {} : attributes)}
      </span>
    );
  }
  if (!content) return child;
  const staticElement =
    typeof child.type === 'string' &&
    !['button', 'input', 'textarea', 'select', 'a', 'summary'].includes(
      child.type,
    );
  return cloneElement(child, {
    ...attributes,
    ...(staticElement && child.props.tabIndex == null ? { tabIndex: 0 } : {}),
    ...(wrapperClassName
      ? { className: `${child.props.className || ''} ${wrapperClassName}` }
      : {}),
  });
}

type Active = {
  target: Element;
  content: string;
  title: string;
  placement: TooltipPlacement;
};

/** Mount once at the application root. Works in native dialogs and SVG/canvas nodes too. */
export function TooltipHost() {
  const id = useId();
  const [active, setActive] = useState<Active | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: Element | null = null;
    let described: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scheduledContent = '';
    const restore = () => {
      if (!described) return;
      const remaining = (described.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((value) => value && value !== id);
      if (remaining.length)
        described.setAttribute('aria-describedby', remaining.join(' '));
      else described.removeAttribute('aria-describedby');
      described = null;
    };
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      target = null;
      restore();
      setActive(null);
    };
    const schedule = (element: Element) => {
      if (element === target || window.matchMedia('(hover: none)').matches)
        return;
      hide();
      const content = element.getAttribute('data-tip');
      if (!content) return;
      target = element;
      scheduledContent = content;
      const configured = Number(element.getAttribute('data-tip-delay') ?? 300);
      const delay = Number.isFinite(configured) ? Math.max(0, configured) : 300;
      timer = setTimeout(() => {
        if (!element.isConnected || !element.getClientRects().length) {
          hide();
          return;
        }
        described = element;
        const existing = (element.getAttribute('aria-describedby') || '')
          .split(/\s+/)
          .filter(Boolean);
        element.setAttribute(
          'aria-describedby',
          [...new Set([...existing, id])].join(' '),
        );
        setActive({
          target: element,
          content,
          title: element.getAttribute('data-tip-title') || '',
          placement:
            element.getAttribute('data-tip-placement') === 'bottom'
              ? 'bottom'
              : 'top',
        });
      }, delay);
    };
    const find = (event: Event) =>
      event.target instanceof Element
        ? event.target.closest('[data-tip]')
        : null;
    const over = (event: Event) => {
      const element = find(event);
      if (element) schedule(element);
    };
    const out = (event: Event) => {
      if (!target) return;
      if (!(event.target instanceof Node) || !target.contains(event.target))
        return;
      const related = (event as MouseEvent).relatedTarget;
      if (!(related instanceof Node) || !target.contains(related)) hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (target) {
          event.preventDefault();
          event.stopPropagation();
        }
        hide();
      }
    };
    const toggle = (event: Event) => {
      if (event.target instanceof HTMLDialogElement) hide();
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mouseout', out, true);
    document.addEventListener('focusin', over, true);
    document.addEventListener('focusout', out, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('click', hide, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('toggle', toggle, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    const observer = new MutationObserver(() => {
      if (
        target &&
        (!target.isConnected ||
          !target.getClientRects().length ||
          target.getAttribute('data-tip') !== scheduledContent)
      )
        hide();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-tip', 'hidden', 'open'],
    });
    return () => {
      hide();
      observer.disconnect();
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mouseout', out, true);
      document.removeEventListener('focusin', over, true);
      document.removeEventListener('focusout', out, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('click', hide, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('toggle', toggle, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (
      !active ||
      !bubble.current ||
      !active.target.isConnected ||
      !active.target.getClientRects().length
    )
      return;
    const element = bubble.current;
    // Native popover puts the bubble above modal dialogs without changing keyboard focus.
    element.setAttribute('popover', 'manual');
    element.showPopover?.();
    const box = element.getBoundingClientRect();
    const position = tooltipPosition(
      active.target.getBoundingClientRect(),
      box.width,
      box.height,
      window.innerWidth,
      window.innerHeight,
      active.placement,
    );
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    element.style.setProperty('--tooltip-arrow', `${position.arrow}px`);
    element.dataset.placement = position.placement;
    const frame = requestAnimationFrame(() => {
      element.dataset.ready = 'true';
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active) return null;
  return createPortal(
    <div
      ref={bubble}
      className="app-tooltip"
      role="tooltip"
      id={id}
      aria-label={
        active.title ? `${active.title}：${active.content}` : active.content
      }
    >
      <div className="app-tooltip-content">
        {active.title && <b>{active.title}</b>}
        <span>{active.content}</span>
      </div>
    </div>,
    active.target.closest('dialog[open]') || document.body,
  );
}
