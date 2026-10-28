export function shouldCloseModalOnEscape(
  event: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'defaultPrevented'>,
  isTopmost: boolean,
): boolean {
  return isTopmost && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && event.key === 'Escape';
}
