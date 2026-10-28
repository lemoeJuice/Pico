import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export function SettingsNavigation({ currentPageLabel, children }: { currentPageLabel: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigationId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<'first' | 'last' | null>(null);

  useLayoutEffect(() => {
    if (!open || !initialFocusRef.current) return;
    const candidates = navigationRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!candidates?.length) return;
    (initialFocusRef.current === 'last' ? candidates[candidates.length - 1] : candidates[0])?.focus();
    initialFocusRef.current = null;
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    initialFocusRef.current = null;
    if (restoreFocus && triggerRef.current?.getClientRects().length) triggerRef.current.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  return (
    <div className="settings-navigation" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-navigation__trigger"
        aria-label={`Settings page: ${currentPageLabel}`}
        aria-expanded={open}
        aria-controls={navigationId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            initialFocusRef.current = event.key === 'ArrowDown' ? 'first' : 'last';
            setOpen(true);
          }
        }}
      >
        <span className="settings-navigation__current">{currentPageLabel}</span>
        <span className="settings-navigation__chevron" aria-hidden="true" />
      </button>
      <nav
        ref={navigationRef}
        id={navigationId}
        className={`plugin-settings-pages settings-navigation__menu${open ? ' is-open' : ''}`}
        aria-label="Settings pages"
        onClick={(event) => {
          if (!(event.target instanceof Element) || !event.target.closest('button, a[href], [role="menuitem"]')) return;
          close(true);
        }}
      >
        {children}
      </nav>
    </div>
  );
}
