'use client';

// Full-screen for an element that is already on the page (the architecture
// diagram), using the browser's own Fullscreen API. This replaced a link to a
// standalone page hosted elsewhere, which went away and left the button dead.
// Escape leaves full screen (the browser handles it); the element's scoped
// stylesheet gives it a background and scrolling while it is full screen.
import { useCallback, useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

export function FullscreenButton({ target, className }: { target: string; className?: string }) {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    setSupported(typeof document.documentElement.requestFullscreen === 'function');
    const onChange = () => setActive(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const el = document.querySelector<HTMLElement>(target);
    if (!el || typeof el.requestFullscreen !== 'function') return;
    void el.requestFullscreen().catch(() => setSupported(false));
  }, [target]);

  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      className={className}
      title={active ? 'Leave full screen (Esc)' : 'Show the diagram full screen'}
    >
      {active ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      {active ? 'Leave full screen' : 'Full screen'}
    </button>
  );
}
