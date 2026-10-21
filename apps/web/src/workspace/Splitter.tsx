import { useCallback, useRef, useState, type PointerEvent } from 'react';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** A size the user can drag, remembered in this browser. */
export function usePaneSize(key: string, initial: number, min: number, max: number) {
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(`izaro.pane.${key}`));
      return saved ? clamp(saved, min, max) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: number) => {
      const next = clamp(v, min, max);
      setSize(next);
      try {
        localStorage.setItem(`izaro.pane.${key}`, String(next));
      } catch {
        // Private windows can refuse storage; the size then lasts for this visit only.
      }
    },
    [key, min, max],
  );
  return { size, set, reset: () => set(initial) };
}

interface SplitterProps {
  /** 'x' sits between columns and drags sideways, 'y' sits between rows. */
  axis: 'x' | 'y';
  size: number;
  onSize: (size: number) => void;
  onReset?: () => void;
  /** -1 when dragging towards the start makes the pane bigger (a pane on the right or bottom). */
  direction?: 1 | -1;
  /** Converts dragged pixels into the size's unit, e.g. percent of the container. */
  unitsPerPixel?: () => number;
  label: string;
  className?: string;
}

/** A drag handle between two panes. Arrow keys move it too; double-click restores the default. */
export function Splitter({ axis, size, onSize, onReset, direction = 1, unitsPerPixel, label, className = '' }: SplitterProps) {
  const start = useRef<{ pos: number; size: number; scale: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pos = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      tabIndex={0}
      className={`splitter splitter-${axis} ${dragging ? 'dragging' : ''} ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: pos(e), size, scale: unitsPerPixel?.() ?? 1 };
        setDragging(true);
        document.body.classList.add(`resizing-${axis}`);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) onSize(s.size + (pos(e) - s.pos) * s.scale * direction);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        start.current = null;
        setDragging(false);
        document.body.classList.remove(`resizing-${axis}`);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        const step = 16 * (unitsPerPixel?.() ?? 1);
        onSize(size + (e.key === fwd ? step : -step) * direction);
      }}
    />
  );
}
