export type SelectChoice = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
};

export function menuChoices(
  choices: SelectChoice[],
  placeholder?: string,
  clearable = false,
) {
  const values =
    placeholder && clearable && !choices.some((choice) => choice.value === '')
      ? [{ value: '', label: placeholder }, ...choices]
      : choices;
  return values.filter(
    (choice) => choice.value !== '' || !placeholder || clearable,
  );
}

export function filterChoices(choices: SelectChoice[], search: string) {
  const query = search.trim().toLocaleLowerCase();
  return choices.filter((choice) =>
    `${choice.label} ${choice.description || ''} ${choice.group || ''}`
      .toLocaleLowerCase()
      .includes(query),
  );
}

export function moveChoice(
  choices: SelectChoice[],
  current: number,
  direction: 'next' | 'previous' | 'first' | 'last',
) {
  const enabled = choices.flatMap((choice, i) => (choice.disabled ? [] : [i]));
  if (!enabled.length) return -1;
  if (direction === 'first') return enabled[0];
  if (direction === 'last') return enabled[enabled.length - 1];
  return direction === 'next'
    ? (enabled.find((i) => i > current) ?? enabled[enabled.length - 1])
    : ([...enabled].reverse().find((i) => i < current) ?? enabled[0]);
}

export function typeaheadChoice(
  choices: SelectChoice[],
  search: string,
  current: number,
) {
  const query = search.toLocaleLowerCase();
  for (let step = 1; step <= choices.length; step++) {
    const index = (Math.max(-1, current) + step) % choices.length;
    if (
      !choices[index].disabled &&
      choices[index].label.toLocaleLowerCase().startsWith(query)
    )
      return index;
  }
  return -1;
}

/** All dimensions are viewport coordinates; top-layer popovers escape transformed ancestors. */
export function selectPosition(
  anchor: { left: number; top: number; bottom: number; width: number },
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const edge = 8,
    gap = 6;
  const below = Math.max(0, viewportHeight - anchor.bottom - gap - edge);
  const above = Math.max(0, anchor.top - gap - edge);
  const up = below < Math.min(naturalHeight, 220) && above > below;
  const maxHeight = Math.max(0, Math.min(naturalHeight, up ? above : below));
  const width = Math.min(
    Math.max(anchor.width, naturalWidth),
    Math.max(0, viewportWidth - edge * 2),
  );
  const left = Math.max(
    edge,
    Math.min(anchor.left, viewportWidth - width - edge),
  );
  const top = Math.max(
    edge,
    Math.min(
      up ? anchor.top - gap - maxHeight : anchor.bottom + gap,
      viewportHeight - maxHeight - edge,
    ),
  );
  return { left, top, width, maxHeight, placement: up ? 'top' : 'bottom' };
}
