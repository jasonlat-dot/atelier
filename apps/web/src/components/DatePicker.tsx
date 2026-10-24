import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import Tooltip from './Tooltip';
import {
  calendarGrid,
  calendarValue,
  clampCalendar,
  dateAllowed,
  datePickerPosition,
  dayKey,
  formatCalendar,
  monthAllowed,
  normalizedMinuteStep,
  parseCalendar,
  serializeCalendar,
  shiftDays,
  shiftMonths,
  type CalendarValue,
  type DatePickerMode,
} from './datePickerBehavior';
import './DatePicker.css';

export type DatePickerProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  | 'type'
  | 'value'
  | 'defaultValue'
  | 'min'
  | 'max'
  | 'size'
  | 'title'
  | 'onFocus'
  | 'onBlur'
  | 'onKeyDown'
> & {
  mode?: DatePickerMode;
  value?: string;
  defaultValue?: string;
  min?: string;
  max?: string;
  minuteStep?: number;
  invalid?: boolean;
  onValueChange?: (value: string) => void;
  'data-tip'?: string;
  'data-tip-title'?: string;
  'data-tip-placement'?: 'top' | 'bottom';
  'data-tip-delay'?: number;
};
let closeActiveDate: (() => void) | undefined;
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

/** Local date/time values only. UTC conversion belongs to the submitting business form. */
export default function DatePicker({
  mode = 'datetime',
  value,
  defaultValue = '',
  min,
  max,
  minuteStep = 1,
  invalid = false,
  onChange,
  onValueChange,
  className = '',
  style,
  id: suppliedId,
  disabled = false,
  readOnly,
  required,
  placeholder,
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
}: DatePickerProps) {
  const generated = useId(),
    id = suppliedId || `date-${generated}`,
    panelId = `${id}-calendar`;
  const root = useRef<HTMLSpanElement>(null),
    input = useRef<HTMLInputElement>(null),
    native = useRef<HTMLInputElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const [localValue, setLocalValue] = useState(defaultValue);
  const canonical = value ?? localValue,
    selected = parseCalendar(canonical, mode);
  const formatted = formatCalendar(selected, mode);
  const [text, setText] = useState(formatted),
    [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false),
    [view, setView] = useState<'days' | 'months'>('days');
  const [cursor, setCursor] = useState(() => selected || calendarValue());
  const [display, setDisplay] = useState(() => ({
    year: cursor.year,
    month: cursor.month,
  }));
  const [keyboard, setKeyboard] = useState(false),
    [badInput, setBadInput] = useState(false);
  const [position, setPosition] =
    useState<ReturnType<typeof datePickerPosition>>();
  const [labelText, setLabelText] = useState('');
  const accessibleLabel =
    ariaLabel || (!labelledBy ? labelText || undefined : undefined);
  const step = normalizedMinuteStep(minuteStep),
    timeMode = mode === 'datetime';
  const disabledNow = () =>
    disabled || readOnly || !!input.current?.matches(':disabled');
  const close = useCallback((restore = false) => {
    setOpen(false);
    setPosition(undefined);
    setKeyboard(false);
    if (restore && input.current?.isConnected)
      input.current.focus({ preventScroll: true });
  }, []);
  const signalInvalid = () => {
    setBadInput(true);
    setEditing(false);
  };
  useLayoutEffect(() => {
    setEditing(false);
  }, [canonical, mode]);
  useEffect(() => {
    if (!badInput) return;
    const timer = setTimeout(() => setBadInput(false), 1200);
    return () => clearTimeout(timer);
  }, [badInput]);
  useLayoutEffect(() => {
    if (ariaLabel || labelledBy) return;
    setLabelText(
      Array.from(input.current?.labels || [])
        .map((label) => {
          const copy = label.cloneNode(true) as HTMLLabelElement;
          copy
            .querySelectorAll(
              '.app-date, input, button, textarea, select, small',
            )
            .forEach((node) => node.remove());
          return copy.textContent?.replace(/\s+/g, ' ').trim() || '';
        })
        .filter(Boolean)
        .join(' '),
    );
  }, [ariaLabel, labelledBy]);
  const commit = (next: CalendarValue | null) => {
    if (disabledNow() || (next && !dateAllowed(next, min, max))) return;
    const serialized = serializeCalendar(next, mode),
      field = native.current;
    if (field && serialized !== canonical) {
      // Bypass React's input value tracker, then emit a genuine bubbling input/change pair.
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(field, serialized);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setBadInput(false);
    setEditing(false);
    if (next) {
      setCursor(next);
      setDisplay({ year: next.year, month: next.month });
    }
  };
  const applyText = () => {
    if (!editing || text === formatted || disabledNow()) return selected;
    if (!text.trim()) {
      commit(null);
      return null;
    }
    const next = parseCalendar(text, mode);
    if (!next || !dateAllowed(next, min, max)) {
      signalInvalid();
      return selected;
    }
    commit(next);
    return next;
  };
  const show = () => {
    if (disabledNow() || open) return;
    const manual = applyText();
    closeActiveDate?.();
    const base = clampCalendar(manual || calendarValue(), min, max);
    setCursor(base);
    setDisplay({ year: base.year, month: base.month });
    setView('days');
    setKeyboard(false);
    setOpen(true);
  };
  const pick = (day: CalendarValue) => {
    if (!dateAllowed(day, min, max)) return;
    commit({
      ...day,
      hour: selected?.hour || 0,
      minute: selected?.minute || 0,
    });
    if (!timeMode) close(true);
  };
  const changeTime = (unit: 'hour' | 'minute', amount: number) => {
    const base = selected || {
      ...clampCalendar(calendarValue(), min, max),
      hour: 0,
      minute: 0,
    };
    commit({ ...base, [unit]: amount });
  };
  useEffect(() => {
    if (disabled || readOnly) close();
  }, [disabled, readOnly, close]);
  useEffect(() => {
    const form = native.current?.form;
    let timeout: ReturnType<typeof setTimeout>;
    const reset = () => {
      timeout = setTimeout(() => {
        if (value === undefined) setLocalValue(defaultValue);
        close();
        setEditing(false);
        setBadInput(false);
      }, 0);
    };
    form?.addEventListener('reset', reset);
    return () => {
      clearTimeout(timeout);
      form?.removeEventListener('reset', reset);
    };
  }, [value, defaultValue, close]);
  useEffect(() => {
    if (!open) return;
    const anchor = input.current?.getBoundingClientRect();
    const dismiss = () => close();
    closeActiveDate = dismiss;
    const contains = (target: EventTarget | null) =>
      target instanceof Node &&
      (root.current?.contains(target) || popup.current?.contains(target));
    const outside = (event: Event) => {
      if (!contains(event.target)) close();
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !popup.current?.contains(event.target)
      )
        close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      close(true);
    };
    const observer = new MutationObserver(() => {
      const field = input.current,
        bounds = field?.getBoundingClientRect();
      if (
        !field?.isConnected ||
        field.matches(':disabled') ||
        !field.getClientRects().length ||
        field.closest(
          '[hidden], [inert], [aria-hidden="true"], dialog:not([open])',
        ) ||
        (anchor &&
          bounds &&
          (anchor.x !== bounds.x ||
            anchor.y !== bounds.y ||
            anchor.width !== bounds.width ||
            anchor.height !== bounds.height))
      )
        close();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'hidden',
        'inert',
        'aria-hidden',
        'open',
        'disabled',
        'class',
        'style',
      ],
    });
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      if (closeActiveDate === dismiss) closeActiveDate = undefined;
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [open, close]);
  useLayoutEffect(() => {
    if (!open || !popup.current || !input.current) return;
    const panel = popup.current;
    panel.setAttribute('popover', 'manual');
    if (!panel.matches(':popover-open')) panel.showPopover();
    setPosition(
      datePickerPosition(
        input.current.getBoundingClientRect(),
        panel.offsetWidth,
        panel.scrollHeight + 2,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [open, display.year, display.month, view, timeMode, step]);
  useLayoutEffect(() => {
    if (!open || !timeMode) return;
    popup.current
      ?.querySelectorAll<HTMLElement>('.app-date-time-list')
      .forEach((list) => {
        const active = list.querySelector<HTMLElement>('[aria-pressed="true"]');
        if (active)
          list.scrollTop =
            active.offsetTop -
            list.offsetTop -
            list.clientHeight / 2 +
            active.offsetHeight / 2;
      });
  }, [open, timeMode]);

  const moveCursor = (amount: number, months = false) => {
    const moved = months
      ? shiftMonths(cursor, amount)
      : shiftDays(cursor, amount);
    const bounded = clampCalendar(moved, min, max);
    if (!dateAllowed(bounded, min, max)) return;
    setCursor(bounded);
    setDisplay({ year: bounded.year, month: bounded.month });
    setView('days');
    setKeyboard(true);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (event.key === 'Escape' && editing && text !== formatted) {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      close();
      return;
    }
    if (event.key === 'Tab') {
      applyText();
      if (open) close();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (open && keyboard) pick(cursor);
      else {
        applyText();
        close();
      }
      return;
    }
    if (!open && event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      show();
      return;
    }
    if (!open) return;
    const dayMove =
      event.key === 'ArrowUp'
        ? -7
        : event.key === 'ArrowDown'
          ? 7
          : (keyboard || event.altKey) && event.key === 'ArrowLeft'
            ? -1
            : (keyboard || event.altKey) && event.key === 'ArrowRight'
              ? 1
              : 0;
    if (dayMove) {
      event.preventDefault();
      event.stopPropagation();
      moveCursor(dayMove);
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      event.stopPropagation();
      moveCursor(
        (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
        true,
      );
    }
  };
  const navigate = (amount: number) => {
    const next = shiftMonths(
      { ...cursor, year: display.year, month: display.month },
      amount,
    );
    setCursor(next);
    setKeyboard(false);
    setDisplay({ year: next.year, month: next.month });
  };
  const today = calendarValue();
  const grid = calendarGrid(display.year, display.month);
  const prev = shiftMonths(
    { ...cursor, year: display.year, month: display.month, day: 1 },
    view === 'months' ? -12 : -1,
  );
  const next = shiftMonths(
    { ...cursor, year: display.year, month: display.month, day: 1 },
    view === 'months' ? 12 : 1,
  );
  const canNavigate = (target: CalendarValue) => {
    const samePeriod =
      target.year === display.year &&
      (view === 'months' || target.month === display.month);
    if (samePeriod) return false;
    return view === 'months'
      ? Array.from({ length: 12 }, (_, index) =>
          monthAllowed(target.year, index + 1, min, max),
        ).some(Boolean)
      : monthAllowed(target.year, target.month, min, max);
  };
  const bound = (raw: string | undefined, end = false) => {
    const parsed = raw ? parseCalendar(raw) : null;
    return parsed
      ? `${serializeCalendar(parsed, 'date')}${timeMode ? (end ? 'T23:59' : 'T00:00') : ''}`
      : undefined;
  };
  const portalRoot = open
    ? input.current?.closest('dialog[open]') || document.body
    : null;
  const invalidState =
    invalid || badInput || ariaInvalid === true || ariaInvalid === 'true';
  return (
    <span
      ref={root}
      className={`app-date ${className}`}
      style={style}
      data-open={open}
      data-invalid={invalidState}
      data-disabled={disabled}
    >
      <Tooltip
        content={tip}
        title={tipTitle}
        placement={tipPlacement}
        delay={tipDelay}
      >
        <input
          ref={input}
          id={id}
          type="text"
          className="app-date-input"
          autoComplete="off"
          maxLength={nativeProps.maxLength ?? 32}
          role="combobox"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-activedescendant={
            open && keyboard
              ? `${panelId}-${serializeCalendar(cursor, 'date')}`
              : undefined
          }
          aria-label={accessibleLabel}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalidState || undefined}
          aria-required={required || undefined}
          placeholder={
            placeholder || (timeMode ? '年/月/日 --:--' : '年/月/日')
          }
          value={editing ? text : formatted}
          disabled={disabled}
          readOnly={readOnly}
          tabIndex={tabIndex}
          onFocus={() => {
            setText(formatted);
            setEditing(true);
          }}
          onChange={(event) => {
            setText(event.target.value);
            setEditing(true);
            setKeyboard(false);
          }}
          onBlur={() => {
            applyText();
            setEditing(false);
          }}
          onClick={show}
          onKeyDown={keyDown}
        />
      </Tooltip>
      <button
        type="button"
        className="app-date-icon"
        tabIndex={-1}
        aria-label={`打开${accessibleLabel || '日期'}日历`}
        disabled={disabled || readOnly}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            applyText();
            close(true);
          } else {
            show();
            input.current?.focus({ preventScroll: true });
          }
        }}
      >
        <CalendarDays size={16} aria-hidden="true" />
      </button>
      <input
        {...nativeProps}
        ref={native}
        type={timeMode ? 'datetime-local' : 'date'}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="app-date-native"
        value={canonical}
        min={bound(min)}
        max={bound(max, true)}
        step={timeMode ? 60 : undefined}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        onInvalid={(event) => {
          event.preventDefault();
          signalInvalid();
          input.current?.focus();
          nativeProps.onInvalid?.(event);
        }}
        onChange={(event) => {
          setLocalValue(event.target.value);
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
      />
      {open &&
        portalRoot &&
        createPortal(
          <div
            ref={popup}
            id={panelId}
            role="dialog"
            aria-label={`选择${accessibleLabel || '日期'}`}
            className="app-date-panel"
            data-mode={mode}
            data-ready={!!position}
            data-placement={position?.placement}
            style={{
              left: position?.left,
              top: position?.top,
              width: position?.width,
              maxHeight: position?.maxHeight,
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              event.stopPropagation();
              if ((event.target as Element).closest('button'))
                event.preventDefault();
            }}
          >
            <div className="app-date-calendar">
              <header className="app-date-heading">
                <button
                  type="button"
                  tabIndex={-1}
                  className="app-date-month-toggle"
                  aria-label={view === 'days' ? '选择月份' : '返回日期'}
                  aria-expanded={view === 'months'}
                  onClick={() => {
                    setKeyboard(false);
                    setView(view === 'days' ? 'months' : 'days');
                  }}
                >
                  {display.year}年{view === 'days' ? `${display.month}月` : ''}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                <div className="app-date-nav">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={view === 'months' ? '上一年' : '上个月'}
                    disabled={!canNavigate(prev)}
                    onClick={() => navigate(view === 'months' ? -12 : -1)}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={view === 'months' ? '下一年' : '下个月'}
                    disabled={!canNavigate(next)}
                    onClick={() => navigate(view === 'months' ? 12 : 1)}
                  >
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              </header>
              {view === 'months' ? (
                <div
                  className="app-date-month-grid"
                  role="group"
                  aria-label={`${display.year}年月份`}
                >
                  {Array.from({ length: 12 }, (_, index) => (
                    <button
                      type="button"
                      tabIndex={-1}
                      key={index}
                      aria-pressed={
                        selected?.year === display.year &&
                        selected.month === index + 1
                      }
                      disabled={
                        !monthAllowed(display.year, index + 1, min, max)
                      }
                      onClick={() => {
                        setCursor(
                          shiftMonths(
                            cursor,
                            (display.year - cursor.year) * 12 +
                              index +
                              1 -
                              cursor.month,
                          ),
                        );
                        setKeyboard(false);
                        setDisplay({ ...display, month: index + 1 });
                        setView('days');
                      }}
                    >
                      {index + 1}月
                    </button>
                  ))}
                </div>
              ) : (
                <div
                  className="app-date-grid"
                  role="grid"
                  aria-label={`${display.year}年${display.month}月`}
                >
                  <div className="app-date-week" role="row">
                    {weekdays.map((day) => (
                      <span key={day} role="columnheader">
                        {day}
                      </span>
                    ))}
                  </div>
                  {Array.from({ length: 6 }, (_, week) => (
                    <div className="app-date-week" role="row" key={week}>
                      {grid.slice(week * 7, week * 7 + 7).map((day) => {
                        const key = serializeCalendar(day, 'date'),
                          isToday = dayKey(day) === dayKey(today);
                        return (
                          <button
                            type="button"
                            role="gridcell"
                            tabIndex={-1}
                            key={key}
                            id={`${panelId}-${key}`}
                            aria-label={`${day.year}年${day.month}月${day.day}日`}
                            aria-selected={
                              !!selected && dayKey(selected) === dayKey(day)
                            }
                            aria-current={isToday ? 'date' : undefined}
                            data-outside={day.month !== display.month}
                            data-today={isToday}
                            data-cursor={
                              keyboard && dayKey(day) === dayKey(cursor)
                            }
                            disabled={!dateAllowed(day, min, max)}
                            onClick={() => pick(day)}
                          >
                            {day.day}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              <footer className="app-date-footer">
                <button
                  type="button"
                  tabIndex={-1}
                  className="app-date-clear"
                  onClick={() => {
                    commit(null);
                    close(true);
                  }}
                >
                  清除
                </button>
                <div>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="app-date-now"
                    disabled={!dateAllowed(today, min, max)}
                    onClick={() => {
                      commit({
                        ...today,
                        hour: timeMode ? today.hour : 0,
                        minute: timeMode
                          ? Math.floor(today.minute / step) * step
                          : 0,
                      });
                      if (!timeMode) close(true);
                    }}
                  >
                    {timeMode ? '此刻' : '今天'}
                  </button>
                  {timeMode && (
                    <button
                      type="button"
                      tabIndex={-1}
                      className="app-date-confirm"
                      onClick={() => {
                        applyText();
                        close(true);
                      }}
                    >
                      确定
                    </button>
                  )}
                </div>
              </footer>
            </div>
            {timeMode && (
              <div className="app-date-time" role="group" aria-label="选择时间">
                {(['hour', 'minute'] as const).map((unit) => (
                  <div className="app-date-time-column" key={unit}>
                    <span>{unit === 'hour' ? '时' : '分'}</span>
                    <div
                      className="app-date-time-list"
                      role="group"
                      aria-label={unit === 'hour' ? '小时' : '分钟'}
                    >
                      {Array.from(
                        { length: unit === 'hour' ? 24 : Math.ceil(60 / step) },
                        (_, index) => (unit === 'hour' ? index : index * step),
                      ).map((amount) => (
                        <button
                          type="button"
                          tabIndex={-1}
                          key={amount}
                          aria-label={`选择${String(amount).padStart(2, '0')}${unit === 'hour' ? '时' : '分'}`}
                          aria-pressed={selected?.[unit] === amount}
                          onClick={() => changeTime(unit, amount)}
                        >
                          {String(amount).padStart(2, '0')}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>,
          portalRoot,
        )}
    </span>
  );
}
