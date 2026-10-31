import { createPortal } from 'react-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';

export function PluginUiSelect({
  label,
  value,
  options,
  disabled = false,
  compact,
  popoverOwner,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
  compact: boolean;
  popoverOwner?: string;
  onChange(value: string): void;
}): ReactElement {
  const id = `plugin-ui-select-${useId().replaceAll(':', '')}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex));
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(
    null,
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const positionMenu = (): void => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const margin = 12;
      const maxWidth = Math.max(0, window.innerWidth - margin * 2);
      const width = Math.min(Math.max(anchor.width, compact ? 156 : 180), maxWidth);
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
      const desiredHeight = Math.min(280, Math.max(44, options.length * 36 + 8));
      const below = Math.max(0, window.innerHeight - anchor.bottom - margin);
      const above = Math.max(0, anchor.top - margin);
      const openAbove = below < Math.min(desiredHeight, 160) && above > below;
      const available = openAbove ? above : below;
      const maxHeight = Math.min(280, available);
      const visibleHeight = Math.min(desiredHeight, maxHeight);
      const top = openAbove
        ? Math.max(margin, anchor.top - visibleHeight - 4)
        : Math.min(anchor.bottom + 4, window.innerHeight - margin);
      setPlacement({ left, top, width, maxHeight });
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [compact, open, options.length]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || trigger.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
      setPlacement(null);
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    return () => document.removeEventListener('pointerdown', dismissOutside, true);
  }, [open]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menu.current
      ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const show = (initialIndex = selectedIndex >= 0 ? selectedIndex : 0): void => {
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(0, options.length - 1)));
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setPlacement(null);
  };
  const commitActive = (): void => {
    const option = options[activeIndex];
    if (!option) return;
    onChange(option.value);
    close();
  };
  const moveActive = (direction: -1 | 1): void => {
    if (options.length === 0) return;
    if (!open) {
      show(
        direction > 0
          ? selectedIndex >= 0
            ? selectedIndex
            : 0
          : selectedIndex >= 0
            ? selectedIndex
            : options.length - 1,
      );
      return;
    }
    setActiveIndex((current) => (current + direction + options.length) % options.length);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open && options[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled || options.length === 0}
        className={`plugin-ui-control plugin-ui-select-trigger${compact ? ' plugin-ui-select-trigger--compact' : ''}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Home' && open && options.length > 0) {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === 'End' && open && options.length > 0) {
            event.preventDefault();
            setActiveIndex(options.length - 1);
          } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault();
            commitActive();
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className="plugin-ui-select-value">{selected?.label ?? (options[0]?.label || 'Choose…')}</span>
        <span className={`plugin-ui-select-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
      </button>
      {open && placement
        ? createPortal(
            <div
              ref={menu}
              id={id}
              role="listbox"
              aria-label={label}
              className="plugin-ui-select-menu"
              data-plugin-ui-popover-owner={popoverOwner}
              style={placement}
            >
              {options.map((option, index) => (
                <div
                  id={`${id}-option-${index}`}
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  data-option-index={index}
                  className={`plugin-ui-select-option${option.value === value ? ' is-selected' : ''}${index === activeIndex ? ' is-active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option.value);
                    close();
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? (
                    <span className="plugin-ui-select-check" aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
