// OpenChamber toast limits: the message is capped at 500 characters, copy text at 32,000.
export const TOAST_MESSAGE_MAX = 500;
export const TOAST_COPY_MAX = 32_000;

/** Cut `text` to `max` characters, ending with "…" when cut. */
export function capText(text: string, max = TOAST_COPY_MAX) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 20))}\n…` : text;
}

/**
 * `head` + as many `items` as fit within `max` (default 480, under the 500 limit),
 * then " and N more". Shows just "N more" when none fit.
 */
export function fitList(head: string, items: readonly string[], max = TOAST_MESSAGE_MAX - 20) {
  const shown: string[] = [];
  for (const it of items) {
    const rest = items.length - shown.length - 1;
    const candidate = [...shown, it].join(', ') + (rest ? ` and ${rest} more` : '');
    if ((head + candidate).length > max) break;
    shown.push(it);
  }
  const more = items.length - shown.length;
  return head + shown.join(', ') + (more ? `${shown.length ? ' and ' : ''}${more} more` : '');
}

/** Cut a toast message to `max`, ending with "…". */
export function fitToast(message: string, max = TOAST_MESSAGE_MAX) {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}
