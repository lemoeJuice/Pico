import { createPortal } from 'react-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PluginUiNode } from '../plugins/ui-protocol.js';

export function PluginUiTreeView({
  nodes,
  onAction,
  compactComposerControls = false,
}: {
  nodes: PluginUiNode[];
  onAction(actionId: string, value?: string, event?: 'submit', externalAuth?: boolean): void;
  compactComposerControls?: boolean;
}): ReactElement {
  const render = (node: PluginUiNode, key: string): ReactElement => {
    switch (node.type) {
      case 'text':
        return <span key={key}>{node.text}</span>;
      case 'heading': {
        const Tag = `h${node.level ?? 3}` as 'h2' | 'h3' | 'h4';
        return <Tag key={key}>{node.text}</Tag>;
      }
      case 'paragraph':
        return <p key={key}>{node.text}</p>;
      case 'status':
        return (
          <span className={`plugin-ui-status plugin-ui-status--${node.tone ?? 'neutral'}`} key={key}>
            {node.text}
          </span>
        );
      case 'group':
        return (
          <div className={`plugin-ui-group${node.layout ? ` plugin-ui-group--${node.layout}` : ''}`} key={key}>
            {node.children.map((child, index) => render(child, `${key}.${index}`))}
          </div>
        );
      case 'card':
        return (
          <section className="plugin-ui-card" key={key}>
            {node.children.map((child, index) => render(child, `${key}.${index}`))}
          </section>
        );
      case 'list': {
        const Tag = node.ordered ? 'ol' : 'ul';
        return (
          <Tag className="plugin-ui-list" key={key}>
            {node.items.map((child, index) => (
              <li key={`${key}.${index}`}>{render(child, `${key}.${index}`)}</li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div className="plugin-ui-table-scroll" key={key}>
            <table className="plugin-ui-table">
              <thead>
                <tr>
                  {node.columns.map((column, index) => (
                    <th key={index}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, index) => (
                      <td key={index}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'disclosure':
        return <Disclosure key={key} node={node} onAction={onAction} render={render} path={key} />;
      case 'actions':
        return (
          <div className="plugin-ui-actions" key={key}>
            {node.children.map((child, index) => render(child, `${key}.${index}`))}
          </div>
        );
      case 'button':
        return (
          <button
            key={key}
            type="button"
            className={`plugin-ui-button${node.tone ? ` plugin-ui-button--${node.tone}` : ''}`}
            disabled={node.disabled}
            onClick={() => onAction(node.actionId, undefined, undefined, node.externalAuth === true)}
          >
            {node.label}
          </button>
        );
      case 'checkbox':
        return (
          <label className="plugin-ui-checkbox" key={key}>
            <input
              type="checkbox"
              checked={node.checked}
              disabled={node.disabled}
              onChange={(event) => onAction(node.actionId, String(event.currentTarget.checked))}
            />
            {node.label}
          </label>
        );
      case 'switch':
        return (
          <div className={`plugin-ui-switch${compactComposerControls ? ' plugin-ui-switch--compact' : ''}`} key={key}>
            <span className={node.visuallyHidden ? 'plugin-ui-sr-only' : undefined}>{node.label}</span>
            <button
              type="button"
              role="switch"
              aria-label={node.label}
              aria-checked={node.checked}
              disabled={node.disabled}
              className={`plugin-ui-switch-control${node.checked ? ' is-checked' : ''}`}
              onClick={() => onAction(node.actionId, String(!node.checked))}
            >
              <span className="plugin-ui-switch-thumb" aria-hidden="true" />
            </button>
          </div>
        );
      case 'range':
        return (
          <label className="plugin-ui-range" key={key}>
            <span>{node.label}</span>
            <output className="plugin-ui-range-value">{node.valueLabel ?? node.value}</output>
            <input
              className="plugin-ui-range-control"
              type="range"
              aria-label={node.label}
              min={node.min}
              max={node.max}
              step={node.step}
              value={node.value}
              disabled={node.disabled}
              onChange={(event) => onAction(node.actionId, event.currentTarget.value)}
            />
          </label>
        );
      case 'textInput':
        return (
          <label className="plugin-ui-field" key={key}>
            <span
              className={compactComposerControls ? 'plugin-ui-field-label plugin-ui-sr-only' : 'plugin-ui-field-label'}
            >
              {node.label}
            </span>
            <input
              className={
                node.inputType === 'date'
                  ? 'plugin-ui-control plugin-ui-text-input plugin-ui-date-input'
                  : 'plugin-ui-control plugin-ui-text-input'
              }
              type={node.inputType ?? 'text'}
              aria-label={node.label}
              value={node.value ?? ''}
              placeholder={node.placeholder}
              min={node.min}
              step={node.step}
              maxLength={node.maxLength}
              disabled={node.disabled}
              onChange={(event) => onAction(node.actionId, event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onAction(node.actionId, event.currentTarget.value, 'submit');
              }}
            />
          </label>
        );
      case 'textArea':
        return <AutoTextArea key={key} node={node} onAction={onAction} />;
      case 'select':
        return (
          <div
            className={`plugin-ui-field plugin-ui-select-field${compactComposerControls ? ' plugin-ui-select-field--compact' : ''}`}
            key={key}
          >
            <span
              className={compactComposerControls ? 'plugin-ui-field-label plugin-ui-sr-only' : 'plugin-ui-field-label'}
            >
              {node.label}
            </span>
            <PluginUiSelect
              label={node.label}
              value={node.value ?? ''}
              options={node.options}
              disabled={node.disabled ?? false}
              compact={compactComposerControls}
              onChange={(value) => onAction(node.actionId, value)}
            />
          </div>
        );
    }
  };
  const children = nodes.map((node, index) => render(node, String(index)));
  return (
    <div className={`plugin-ui-tree${compactComposerControls ? ' plugin-ui-tree--composer-scroll' : ''}`}>
      {compactComposerControls ? <div className="plugin-ui-tree--composer-content">{children}</div> : children}
    </div>
  );
}

export function PluginUiSelect({
  label,
  value,
  options,
  disabled = false,
  compact,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
  compact: boolean;
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

function Disclosure({
  node,
  onAction,
  render,
  path,
}: {
  node: Extract<PluginUiNode, { type: 'disclosure' }>;
  onAction(actionId: string, value?: string, event?: 'submit'): void;
  render(node: PluginUiNode, key: string): ReactElement;
  path: string;
}): ReactElement {
  const [open, setOpen] = useState(node.open);
  useEffect(() => setOpen(node.open), [node.open]);
  return (
    <details
      className="plugin-ui-disclosure"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) {
          setOpen(next);
          onAction(node.actionId, String(next));
        }
      }}
    >
      <summary>{node.label}</summary>
      {node.children.map((child, index) => render(child, `${path}.${index}`))}
    </details>
  );
}

function AutoTextArea({
  node,
  onAction,
}: {
  node: Extract<PluginUiNode, { type: 'textArea' }>;
  onAction(actionId: string, value?: string): void;
}): ReactElement {
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = (): void => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(resize, [node.value]);
  return (
    <label className="plugin-ui-field">
      {node.label}
      <textarea
        ref={input}
        className={`plugin-ui-control plugin-ui-text-area plugin-ui-text-area--${node.rows ?? 'standard'}`}
        value={node.value ?? ''}
        placeholder={node.placeholder}
        maxLength={node.maxLength}
        disabled={node.disabled}
        onChange={(event) => {
          resize();
          onAction(node.actionId, event.currentTarget.value);
        }}
      />
    </label>
  );
}
