import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import {
  filterChoices,
  menuChoices,
  moveChoice,
  selectPosition,
  typeaheadChoice,
  type SelectChoice,
} from './selectBehavior';
import './Select.css';
import Tooltip from './Tooltip';

export type SelectOption = Omit<SelectChoice, 'value'> & {
  value: string | number;
};
export type SelectProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'size' | 'multiple' | 'value' | 'defaultValue' | 'title'
> & {
  value?: string | number;
  defaultValue?: string | number;
  options?: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  searchable?: boolean;
  clearable?: boolean;
  invalid?: boolean;
  onValueChange?: (value: string) => void;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyMessage?: string;
  'data-tip'?: string;
  'data-tip-title'?: string;
  'data-tip-placement'?: 'top' | 'bottom';
  'data-tip-delay'?: number;
};

function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number')
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? textOf(child.props.children)
        : '';
    })
    .join('');
}

/** Compatibility for existing dynamic option/optgroup children; new controls may use options. */
function choicesOf(
  children: ReactNode,
  group?: string,
  disabled = false,
): SelectChoice[] {
  return Children.toArray(children).flatMap((child): SelectChoice[] => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        label?: string;
        disabled?: boolean;
        'data-desc'?: string;
      }>(child)
    )
      return [];
    if (child.type === Fragment)
      return choicesOf(child.props.children, group, disabled);
    if (child.type === 'optgroup')
      return choicesOf(
        child.props.children,
        child.props.label,
        disabled || !!child.props.disabled,
      );
    if (child.type !== 'option') return [];
    const label =
      child.props.label ??
      textOf(child.props.children).replace(/\s+/g, ' ').trim();
    return [
      {
        value: String(child.props.value ?? label),
        label,
        description: child.props['data-desc'],
        disabled: disabled || child.props.disabled,
        group,
      },
    ];
  });
}

let closeActive: (() => void) | undefined;

/** A single-select combobox. The hidden native field preserves form data and change handlers. */
export default function Select({
  children,
  options,
  value,
  defaultValue,
  onChange,
  onValueChange,
  onSearchChange,
  searchPlaceholder,
  emptyMessage,
  placeholder,
  searchable,
  clearable = false,
  size = 'md',
  invalid = false,
  className = '',
  style,
  id: suppliedId,
  disabled = false,
  required,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  'data-tip': tip,
  'data-tip-title': tipTitle,
  'data-tip-placement': tipPlacement,
  'data-tip-delay': tipDelay,
  tabIndex,
  ...nativeProps
}: SelectProps) {
  const generated = useId();
  const id = suppliedId || `select-${generated}`;
  const listId = `${id}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(String(defaultValue ?? ''));
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [position, setPosition] = useState<ReturnType<typeof selectPosition>>();
  const [reportedInvalid, setReportedInvalid] = useState(false);
  const [labelText, setLabelText] = useState('');
  const accessibleLabel =
    ariaLabel || (!labelledBy ? labelText || undefined : undefined);
  const buffer = useRef({ text: '', time: 0 });
  const all = useMemo(
    () =>
      options
        ? options.map((option) => ({ ...option, value: String(option.value) }))
        : choicesOf(children),
    [options, children],
  );
  const empty = all.find((option) => option.value === '');
  const placeholderLabel =
    placeholder ??
    (empty && /^(请选择|选择模型)/.test(empty.label)
      ? empty.label
      : clearable && !empty
        ? '请选择'
        : undefined);
  const selectedValue = value === undefined ? localValue : String(value);
  const selected =
    all.find((option) => option.value === selectedValue) ??
    (!placeholderLabel ? all.find((option) => !option.disabled) : undefined);
  const displayed = selected?.label || placeholderLabel || '请选择';
  const choices = useMemo(
    () => menuChoices(all, placeholderLabel, clearable),
    [all, placeholderLabel, clearable],
  );
  const filtered = useMemo(
    () => (onSearchChange ? choices : filterChoices(choices, search)),
    [choices, search, onSearchChange],
  );
  const hasSearch = searchable ?? choices.length > 8;
  const activeIndex =
    filtered[highlight] && !filtered[highlight].disabled ? highlight : -1;
  const activeId = activeIndex < 0 ? undefined : `${listId}-${activeIndex}`;
  const isInvalid =
    invalid ||
    ariaInvalid === true ||
    ariaInvalid === 'true' ||
    reportedInvalid;
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setPosition(undefined);
    if (restoreFocus && trigger.current?.isConnected)
      trigger.current.focus({ preventScroll: true });
  }, []);
  const placeMenu = useCallback(() => {
    if (!menu.current || !trigger.current || !list.current) return;
    const popup = menu.current;
    const bounds = trigger.current.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) {
      close();
      return;
    }
    popup.setAttribute('popover', 'manual');
    if (!popup.matches(':popover-open')) popup.showPopover();
    const naturalHeight =
      Math.min(list.current.scrollHeight, 280) + 14 + (hasSearch ? 44 : 0);
    const next = selectPosition(
      bounds,
      popup.scrollWidth + 2,
      naturalHeight,
      window.innerWidth,
      window.innerHeight,
    );
    setPosition((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.maxHeight === next.maxHeight &&
      current.placement === next.placement
        ? current
        : next,
    );
  }, [close, hasSearch]);
  const show = (edge?: 'first' | 'last') => {
    if (disabled || trigger.current?.matches(':disabled')) return;
    closeActive?.();
    setSearch('');
    onSearchChange?.('');
    const index = choices.findIndex(
      (option) => option.value === selectedValue && !option.disabled,
    );
    setHighlight(index >= 0 ? index : moveChoice(choices, -1, edge || 'first'));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = filtered[index];
    if (
      !option ||
      option.disabled ||
      disabled ||
      trigger.current?.matches(':disabled')
    )
      return;
    if (
      native.current &&
      (value === undefined ? native.current.value : selectedValue) !==
        option.value
    ) {
      native.current.value = option.value;
      native.current.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close(true);
  };

  useLayoutEffect(() => {
    if (ariaLabel || labelledBy) return;
    const labels = Array.from(trigger.current?.labels || []);
    setLabelText(
      labels
        .map((label) => {
          const copy = label.cloneNode(true) as HTMLLabelElement;
          copy
            .querySelectorAll(
              '.app-select, input, button, textarea, select, small',
            )
            .forEach((node) => node.remove());
          return copy.textContent?.replace(/\s+/g, ' ').trim() || '';
        })
        .filter(Boolean)
        .join(' '),
    );
  }, [ariaLabel, labelledBy, children]);

  useEffect(() => {
    const field = native.current;
    const form = field?.form;
    let timeout: ReturnType<typeof setTimeout>;
    const reset = () => {
      timeout = setTimeout(() => {
        if (value === undefined && field) setLocalValue(field.value);
        setReportedInvalid(false);
        close();
      }, 0);
    };
    form?.addEventListener('reset', reset);
    return () => {
      clearTimeout(timeout);
      form?.removeEventListener('reset', reset);
    };
  }, [value, close]);

  useEffect(() => {
    if (!open) return;
    let anchorBounds = trigger.current?.getBoundingClientRect();
    const anchorMoved = (bounds: DOMRect | undefined) =>
      !!bounds &&
      !!anchorBounds &&
      (Math.abs(bounds.x - anchorBounds.x) > 0.5 ||
        Math.abs(bounds.y - anchorBounds.y) > 0.5 ||
        Math.abs(bounds.width - anchorBounds.width) > 0.5 ||
        Math.abs(bounds.height - anchorBounds.height) > 0.5);
    const dismiss = () => close();
    closeActive = dismiss;
    const contains = (node: EventTarget | null) =>
      node instanceof Node &&
      (trigger.current?.contains(node) || menu.current?.contains(node));
    const outside = (event: Event) => {
      if (!contains(event.target)) close();
    };
    const scroll = (event: Event) => {
      if (
        (!(event.target instanceof Node) ||
          !menu.current?.contains(event.target)) &&
        anchorMoved(trigger.current?.getBoundingClientRect())
      )
        followAnchor();
    };
    const followAnchor = () => {
      placeMenu();
      anchorBounds = trigger.current?.getBoundingClientRect();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const observer = new MutationObserver(() => {
      const button = trigger.current;
      const bounds = button?.getBoundingClientRect();
      if (
        !button?.isConnected ||
        button.matches(':disabled') ||
        !button.getClientRects().length ||
        button.closest(
          '[hidden], [inert], [aria-hidden="true"], dialog:not([open])',
        )
      )
        close();
      else if (anchorMoved(bounds)) followAnchor();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'hidden',
        'open',
        'inert',
        'aria-hidden',
        'class',
        'style',
        'disabled',
      ],
    });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      if (closeActive === dismiss) closeActive = undefined;
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [open, close, placeMenu]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  useLayoutEffect(() => {
    if (open) placeMenu();
  }, [open, filtered, placeMenu]);
  useLayoutEffect(() => {
    if (!open || !position) return;
    const option = activeId ? document.getElementById(activeId) : null;
    const viewport = list.current;
    if (option && viewport) {
      const top = option.offsetTop - viewport.offsetTop;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (
        top + option.offsetHeight >
        viewport.scrollTop + viewport.clientHeight
      )
        viewport.scrollTop = top + option.offsetHeight - viewport.clientHeight;
    }
  }, [open, position, activeId]);
  useEffect(() => {
    if (open && hasSearch) searchInput.current?.focus({ preventScroll: true });
  }, [open, hasSearch]);

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    const key = event.key;
    const searching = event.target === searchInput.current;
    if (key === 'Tab') {
      if (open) close(true);
      return;
    }
    if (
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      (!searching && (key === 'Home' || key === 'End'))
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) show(key === 'ArrowUp' || key === 'End' ? 'last' : 'first');
      else
        setHighlight(
          moveChoice(
            filtered,
            highlight,
            key === 'Home'
              ? 'first'
              : key === 'End'
                ? 'last'
                : key === 'ArrowDown'
                  ? 'next'
                  : 'previous',
          ),
        );
    } else if (key === 'Enter' || (!searching && key === ' ')) {
      event.preventDefault();
      event.stopPropagation();
      if (open) choose(activeIndex);
      else show();
    } else if (
      !searching &&
      key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const text =
        (now - buffer.current.time < 600 ? buffer.current.text : '') + key;
      buffer.current = { text, time: now };
      if (!open) show();
      const result = typeaheadChoice(
        open ? filtered : choices,
        text,
        text.length === 1 ? highlight : -1,
      );
      if (result >= 0) setHighlight(result);
    }
  };

  const portalRoot = open
    ? trigger.current?.closest('dialog[open]') || document.body
    : null;
  return (
    <span
      className={`app-select ${className}`}
      style={style}
      data-size={size}
      data-open={open}
      data-invalid={isInvalid}
      data-disabled={disabled}
      data-select-label={ariaLabel}
    >
      <Tooltip
        content={tip}
        title={tipTitle}
        placement={tipPlacement}
        delay={tipDelay}
      >
        <button
          type="button"
          ref={trigger}
          id={id}
          className="app-select-trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? activeId : undefined}
          aria-label={accessibleLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={isInvalid || undefined}
          aria-required={required || undefined}
          disabled={disabled}
          tabIndex={tabIndex}
          onClick={() => (open ? close() : show())}
          onKeyDown={keyDown}
        >
          <span
            className="app-select-value"
            data-placeholder={
              !selected || (selected.value === '' && !!placeholderLabel)
            }
          >
            {displayed}
          </span>
          <ChevronDown
            className="app-select-arrow"
            size={16}
            aria-hidden="true"
          />
        </button>
      </Tooltip>
      <select
        {...nativeProps}
        ref={native}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="app-select-native"
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        required={required}
        onInvalid={(event) => {
          event.preventDefault();
          setReportedInvalid(true);
          trigger.current?.focus();
          nativeProps.onInvalid?.(event);
        }}
        onChange={(event) => {
          setLocalValue(event.target.value);
          setReportedInvalid(false);
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
      >
        {placeholderLabel && !empty && (
          <option value="">{placeholderLabel}</option>
        )}
        {options ? (
          <>
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </>
        ) : (
          children
        )}
      </select>
      {open &&
        portalRoot &&
        createPortal(
          <div
            ref={menu}
            className="app-select-menu"
            data-placement={position?.placement}
            data-ready={!!position}
            style={{
              left: position?.left,
              top: position?.top,
              width: position?.width,
              maxHeight: position?.maxHeight,
              minWidth: Math.min(
                trigger.current?.getBoundingClientRect().width || 160,
                window.innerWidth - 16,
              ),
            }}
            onKeyDown={keyDown}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!(event.target instanceof HTMLInputElement))
                event.preventDefault();
            }}
          >
            {hasSearch && (
              <div className="app-select-search-wrap">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchInput}
                  type="search"
                  role="combobox"
                  className="app-select-search"
                  placeholder={searchPlaceholder || '搜索选项…'}
                  aria-label={`搜索${accessibleLabel || '选项'}`}
                  value={search}
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  autoComplete="off"
                  onChange={(event) => {
                    const query = event.target.value;
                    setSearch(query);
                    onSearchChange?.(query);
                    setHighlight(
                      moveChoice(
                        onSearchChange ? [] : filterChoices(choices, query),
                        -1,
                        'first',
                      ),
                    );
                  }}
                />
              </div>
            )}
            <div
              ref={list}
              className="app-select-list"
              id={listId}
              role="listbox"
              aria-label={accessibleLabel}
              aria-labelledby={
                labelledBy || (!accessibleLabel ? id : undefined)
              }
            >
              {filtered.map((option, index) => (
                <Fragment key={option.value}>
                  {option.group &&
                    option.group !== filtered[index - 1]?.group && (
                      <div className="app-select-group" role="presentation">
                        {option.group}
                      </div>
                    )}
                  <div
                    className="app-select-option"
                    id={`${listId}-${index}`}
                    role="option"
                    data-value={option.value}
                    aria-selected={option.value === selected?.value}
                    aria-disabled={option.disabled || undefined}
                    data-active={activeIndex === index}
                    onPointerMove={() => {
                      if (!option.disabled) setHighlight(index);
                    }}
                    onClick={() => choose(index)}
                  >
                    <span className="app-select-option-label">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="app-select-description">
                        {option.description}
                      </span>
                    )}
                    <Check
                      size={16}
                      aria-hidden="true"
                      className="app-select-check"
                    />
                  </div>
                </Fragment>
              ))}
              {!filtered.length && (
                <div className="app-select-empty" role="status">
                  {emptyMessage || (search ? '无匹配项' : '暂无可选项')}
                </div>
              )}
            </div>
          </div>,
          portalRoot,
        )}
    </span>
  );
}
