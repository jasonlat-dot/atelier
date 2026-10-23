import { useId, type ButtonHTMLAttributes } from 'react';

/** Screen-sized hints remain legible at every canvas zoom level. */
export default function CanvasToolButton({
  hint,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { hint: string }) {
  const id = useId();
  return (
    <button
      {...props}
      className={`${props.className || ''} canvas-hint-button`}
      aria-describedby={id}
    >
      {children}
      <span id={id} role="tooltip" className="canvas-tool-hint">
        {hint}
      </span>
    </button>
  );
}
