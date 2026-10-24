type Box = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
};
export type TooltipPlacement = 'top' | 'bottom';
const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max));

export function tooltipPosition(
  anchor: Box,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  preferred: TooltipPlacement = 'top',
) {
  const edge = 8,
    gap = 10;
  const above = anchor.top - gap - edge;
  const below = viewportHeight - anchor.bottom - gap - edge;
  const placement =
    preferred === 'top'
      ? above >= height || above >= below
        ? 'top'
        : 'bottom'
      : below >= height || below >= above
        ? 'bottom'
        : 'top';
  const center = (anchor.left + anchor.right) / 2;
  const left = clamp(center - width / 2, edge, viewportWidth - width - edge);
  const top = clamp(
    placement === 'top' ? anchor.top - height - gap : anchor.bottom + gap,
    edge,
    viewportHeight - height - edge,
  );
  const inset = Math.min(14, width / 2);
  return {
    left,
    top,
    placement,
    arrow: clamp(center - left, inset, width - inset),
  };
}
