export type CalendarValue = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};
export type DatePickerMode = 'date' | 'datetime';
const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function localDate(value: CalendarValue) {
  // setFullYear avoids Date's special handling of years 00–99. Never parse a date-only string as UTC.
  const date = new Date(0);
  date.setFullYear(value.year, value.month - 1, value.day);
  date.setHours(value.hour, value.minute, 0, 0);
  return date;
}
export function calendarValue(date = new Date()): CalendarValue {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}
export function parseCalendar(
  text: string,
  mode: DatePickerMode = 'datetime',
): CalendarValue | null {
  const match =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(
      text.trim(),
    );
  if (!match) return null;
  const value = {
    year: +match[1],
    month: +match[2],
    day: +match[3],
    hour: +(match[4] || 0),
    minute: +(match[5] || 0),
  };
  if (
    value.year < 1 ||
    value.year > 9999 ||
    value.month < 1 ||
    value.month > 12 ||
    value.day < 1 ||
    value.day > 31 ||
    value.hour > 23 ||
    value.minute > 59
  )
    return null;
  const date = localDate(value);
  if (
    date.getFullYear() !== value.year ||
    date.getMonth() + 1 !== value.month ||
    date.getDate() !== value.day ||
    date.getHours() !== value.hour ||
    date.getMinutes() !== value.minute
  )
    return null;
  return mode === 'date' ? { ...value, hour: 0, minute: 0 } : value;
}
export function serializeCalendar(
  value: CalendarValue | null,
  mode: DatePickerMode = 'datetime',
) {
  return value
    ? `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}${mode === 'datetime' ? `T${pad(value.hour)}:${pad(value.minute)}` : ''}`
    : '';
}
export function formatCalendar(
  value: CalendarValue | null,
  mode: DatePickerMode = 'datetime',
) {
  return serializeCalendar(value, mode).replaceAll('-', '/').replace('T', ' ');
}
export const dayKey = (value: CalendarValue) =>
  value.year * 10000 + value.month * 100 + value.day;
export function dateAllowed(value: CalendarValue, min?: string, max?: string) {
  const start = min ? parseCalendar(min) : null,
    end = max ? parseCalendar(max) : null;
  const key = dayKey(value);
  return (
    value.year >= 1 &&
    value.year <= 9999 &&
    (!start || key >= dayKey(start)) &&
    (!end || key <= dayKey(end))
  );
}
export function clampCalendar(
  value: CalendarValue,
  min?: string,
  max?: string,
) {
  const start = min ? parseCalendar(min) : null,
    end = max ? parseCalendar(max) : null;
  if (start && dayKey(value) < dayKey(start))
    return { ...start, hour: value.hour, minute: value.minute };
  if (end && dayKey(value) > dayKey(end))
    return { ...end, hour: value.hour, minute: value.minute };
  return value;
}
export function calendarGrid(year: number, month: number) {
  const first = localDate({ year, month, day: 1, hour: 12, minute: 0 });
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setDate(1 - offset + index);
    return { ...calendarValue(date), hour: 0, minute: 0 };
  });
}
export function shiftDays(value: CalendarValue, offset: number) {
  const date = localDate({ ...value, hour: 12 });
  date.setDate(date.getDate() + offset);
  return { ...calendarValue(date), hour: value.hour, minute: value.minute };
}
export function shiftMonths(value: CalendarValue, offset: number) {
  const month = localDate({ ...value, day: 1, hour: 12 });
  month.setMonth(month.getMonth() + offset);
  if (month.getFullYear() < 1) return { ...value, year: 1, month: 1, day: 1 };
  if (month.getFullYear() > 9999)
    return { ...value, year: 9999, month: 12, day: 31 };
  const last = new Date(month);
  last.setMonth(last.getMonth() + 1, 0);
  return {
    ...calendarValue(month),
    day: Math.min(value.day, last.getDate()),
    hour: value.hour,
    minute: value.minute,
  };
}
export function monthAllowed(
  year: number,
  month: number,
  min?: string,
  max?: string,
) {
  if (year < 1 || year > 9999) return false;
  const start = localDate({ year, month, day: 1, hour: 12, minute: 0 });
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1, 0);
  const lower = min ? parseCalendar(min) : null,
    upper = max ? parseCalendar(max) : null;
  return (
    (!lower || dayKey(calendarValue(end)) >= dayKey(lower)) &&
    (!upper || dayKey(calendarValue(start)) <= dayKey(upper))
  );
}
export const normalizedMinuteStep = (step: number) =>
  Number.isInteger(step) && step >= 1 && step <= 60 ? step : 1;
export function datePickerPosition(
  anchor: { left: number; top: number; bottom: number },
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const edge = 8,
    gap = 6;
  const below = Math.max(0, viewportHeight - anchor.bottom - gap - edge),
    above = Math.max(0, anchor.top - gap - edge);
  const up = below < height && above > below;
  const maxHeight = Math.min(height, up ? above : below),
    actualWidth = Math.min(width, Math.max(0, viewportWidth - edge * 2));
  return {
    left: Math.max(
      edge,
      Math.min(anchor.left, viewportWidth - actualWidth - edge),
    ),
    top: Math.max(
      edge,
      Math.min(
        up ? anchor.top - gap - maxHeight : anchor.bottom + gap,
        viewportHeight - maxHeight - edge,
      ),
    ),
    width: actualWidth,
    maxHeight,
    placement: up ? 'top' : 'bottom',
  };
}
