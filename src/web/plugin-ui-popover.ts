const POPOVER_OWNER_ATTRIBUTE = 'data-plugin-ui-popover-owner';

/** Returns whether a pointer event path belongs to a particular hosted popover. */
export function pluginUiPopoverPathIncludesOwner(path: readonly unknown[], owner: string): boolean {
  return path.some((target) => {
    if (!target || typeof target !== 'object' || !('getAttribute' in target)) return false;
    const getAttribute = (target as { getAttribute?: unknown }).getAttribute;
    return typeof getAttribute === 'function' && getAttribute.call(target, POPOVER_OWNER_ATTRIBUTE) === owner;
  });
}
