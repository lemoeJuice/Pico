import { createPortal } from 'react-dom';
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PluginUiNode } from '../plugins/ui-protocol.js';

export function reconcilePluginUiInputDraft(
  draft: string,
  incoming: string,
  focused: boolean,
  pendingEcho: boolean,
): { draft: string; pendingEcho: boolean } {
  const matched = incoming === draft;
  const nextPending = matched ? false : pendingEcho;
  return focused || nextPending ? { draft, pendingEcho: nextPending } : { draft: incoming, pendingEcho: false };
}

function uiNodeIdentity(node: PluginUiNode, path: string): string {
  return 'actionId' in node ? `action:${node.actionId}` : `path:${path}`;
}

function shareNode(previous: PluginUiNode, incoming: PluginUiNode, path: string): PluginUiNode {
  if (previous.type !== incoming.type) return incoming;
  let next = incoming;
  if (
    (incoming.type === 'group' ||
      incoming.type === 'card' ||
      incoming.type === 'actions' ||
      incoming.type === 'disclosure') &&
    (previous.type === 'group' ||
      previous.type === 'card' ||
      previous.type === 'actions' ||
      previous.type === 'disclosure')
  ) {
    const beforeChildren = previous.children;
    const afterChildren = incoming.children;
    const children = shareList(beforeChildren, afterChildren, path);
    next = children === afterChildren ? incoming : { ...incoming, children };
  } else if (incoming.type === 'list' && previous.type === 'list') {
    const items = shareList(previous.items, incoming.items, path);
    next = items === incoming.items ? incoming : { ...incoming, items };
  }
  return shallowNodeEqual(previous, next) ? previous : next;
}

function sameUiValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (depth > 12 || !left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameUiValue(leftRecord[key], rightRecord[key], depth + 1),
    )
  );
}

function shallowNodeEqual(left: PluginUiNode, right: PluginUiNode): boolean {
  return sameUiValue(left, right);
}

function shareList(previous: PluginUiNode[], incoming: PluginUiNode[], path: string): PluginUiNode[] {
  let changed = previous.length !== incoming.length;
  const result = incoming.map((node, index) => {
    const before = previous[index];
    if (
      !before ||
      before.type !== node.type ||
      uiNodeIdentity(before, `${path}.${index}`) !== uiNodeIdentity(node, `${path}.${index}`)
    ) {
      changed = true;
      return node;
    }
    const shared = shareNode(before, node, `${path}.${index}`);
    if (shared !== before) changed = true;
    return shared;
  });
  return changed ? result : previous;
}

export function sharePluginUiTree(previous: PluginUiNode[], incoming: PluginUiNode[]): PluginUiNode[] {
  return shareList(previous, incoming, 'root');
}

type PluginUiDraftNode = Extract<PluginUiNode, { type: 'textInput' | 'textArea' }>;

export function samePluginUiTextInputProps(
  previous: { node: PluginUiDraftNode; onAction: unknown; compact: boolean },
  next: { node: PluginUiDraftNode; onAction: unknown; compact: boolean },
): boolean {
  const before = previous.node;
  const after = next.node;
  return (
    previous.compact === next.compact &&
    previous.onAction === next.onAction &&
    Object.keys(before).length === Object.keys(after).length &&
    Object.keys(before).every((key) => before[key as keyof typeof before] === after[key as keyof typeof after])
  );
}

export const PluginUiTreeView = memo(function PluginUiTreeView({
  nodes,
  onAction,
  compactComposerControls = false,
}: {
  nodes: PluginUiNode[];
  onAction(actionId: string, value?: string, event?: 'submit', externalAuth?: boolean): void;
  compactComposerControls?: boolean;
}): ReactElement {
  const previousNodes = useRef(nodes);
  const sharedNodes = sharePluginUiTree(previousNodes.current, nodes);
  useLayoutEffect(() => {
    previousNodes.current = sharedNodes;
  }, [sharedNodes]);
  const render = (node: PluginUiNode, key: string): ReactElement => {
    const renderNode = (): ReactElement => {
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
        case 'fieldButton':
          return (
            <div className="plugin-ui-field plugin-ui-field--action" key={key}>
              <span className="plugin-ui-field-label" aria-hidden="true" />
              <button
                type="button"
                className={`plugin-ui-button${node.tone ? ` plugin-ui-button--${node.tone}` : ''}`}
                disabled={node.disabled}
                onClick={() => onAction(node.actionId)}
              >
                {node.label}
              </button>
            </div>
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
        case 'textArea':
          return (
            <PluginUiDraftInput key={node.actionId} node={node} onAction={onAction} compact={compactComposerControls} />
          );
        case 'select':
          return (
            <div
              className={`plugin-ui-field plugin-ui-select-field${compactComposerControls ? ' plugin-ui-select-field--compact' : ''}`}
              key={key}
            >
              <span
                className={
                  compactComposerControls ? 'plugin-ui-field-label plugin-ui-sr-only' : 'plugin-ui-field-label'
                }
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
    return (
      <MemoizedUiNode key={uiNodeIdentity(node, key)} node={node} onAction={onAction} compact={compactComposerControls}>
        {renderNode()}
      </MemoizedUiNode>
    );
  };
  const children = sharedNodes.map((node, index) => render(node, String(index)));
  return (
    <div className={`plugin-ui-tree${compactComposerControls ? ' plugin-ui-tree--composer-scroll' : ''}`}>
      {compactComposerControls ? <div className="plugin-ui-tree--composer-content">{children}</div> : children}
    </div>
  );
});

const MemoizedUiNode = memo(
  function MemoizedUiNode({
    children,
  }: {
    node: PluginUiNode;
    onAction: unknown;
    compact: boolean;
    children: ReactElement;
  }): ReactElement {
    return children;
  },
  (previous, next) =>
    previous.node === next.node && previous.onAction === next.onAction && previous.compact === next.compact,
);

/** Keeps keystrokes synchronous in the host while plugin actions cross the iframe asynchronously. */
export const PluginUiDraftInput = memo(function PluginUiDraftInput({
  node,
  onAction,
  compact,
}: {
  node: PluginUiDraftNode;
  onAction(actionId: string, value?: string, event?: 'submit'): void;
  compact: boolean;
}): ReactElement {
  const inputElement = useRef<HTMLInputElement>(null);
  const areaElement = useRef<HTMLTextAreaElement>(null);
  const incoming = node.value ?? '';
  const [draft, setDraft] = useState(incoming);
  const draftRef = useRef(draft);
  const pendingEcho = useRef(false);
  const focused = useRef(false);
  const latestIncoming = useRef(incoming);
  latestIncoming.current = incoming;
  useEffect(() => {
    const reconciled = reconcilePluginUiInputDraft(draftRef.current, incoming, focused.current, pendingEcho.current);
    pendingEcho.current = reconciled.pendingEcho;
    if (reconciled.draft === draftRef.current) return;
    draftRef.current = reconciled.draft;
    setDraft(reconciled.draft);
  }, [incoming, draft]);
  const setLocalDraft = (value: string): void => {
    draftRef.current = value;
    setDraft(value);
  };
  useLayoutEffect(() => {
    if (node.type !== 'textArea' || !areaElement.current) return;
    areaElement.current.style.height = 'auto';
    areaElement.current.style.height = `${areaElement.current.scrollHeight}px`;
  }, [draft, node.type]);
  const onFocus = (): void => {
    focused.current = true;
  };
  const onBlur = (): void => {
    focused.current = false;
    if (!pendingEcho.current) setLocalDraft(latestIncoming.current);
  };
  const onChange = (value: string): void => {
    pendingEcho.current = true;
    setLocalDraft(value);
    onAction(node.actionId, value);
  };
  return (
    <label className="plugin-ui-field">
      {node.type === 'textInput' ? (
        <>
          <span className={compact ? 'plugin-ui-field-label plugin-ui-sr-only' : 'plugin-ui-field-label'}>
            {node.label}
          </span>
          <input
            ref={inputElement}
            className={
              node.inputType === 'date'
                ? 'plugin-ui-control plugin-ui-text-input plugin-ui-date-input'
                : 'plugin-ui-control plugin-ui-text-input'
            }
            type={node.inputType ?? 'text'}
            aria-label={node.label}
            value={draft}
            placeholder={node.placeholder}
            min={node.min}
            step={node.step}
            maxLength={node.maxLength}
            disabled={node.disabled}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onAction(node.actionId, event.currentTarget.value, 'submit');
            }}
          />
        </>
      ) : (
        <>
          <span className="plugin-ui-field-label">{node.label}</span>
          <textarea
            ref={areaElement}
            className={`plugin-ui-control plugin-ui-text-area plugin-ui-text-area--${node.rows ?? 'standard'}`}
            value={draft}
            placeholder={node.placeholder}
            maxLength={node.maxLength}
            disabled={node.disabled}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </>
      )}
    </label>
  );
}, samePluginUiTextInputProps);

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
