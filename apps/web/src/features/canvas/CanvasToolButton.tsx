import type { ButtonHTMLAttributes } from 'react';
import Tooltip from '../../components/Tooltip';

/** Screen-sized hints remain legible at every canvas zoom level. */
export default function CanvasToolButton({
  hint,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { hint: string }) {
  return (
    <Tooltip content={hint}>
      <button
        {...props}
        className={`${props.className || ''} canvas-hint-button`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
