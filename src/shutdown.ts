// remove.bg's standalone website closes on 1 December 2026 at 09:00 CET.
// Copy around that date is written in the future tense; after the date, elements
// with data-after-shutdown switch to their past-tense text so the page never reads stale.
export const REMOVE_BG_SHUTDOWN = Date.UTC(2026, 11, 1, 8, 0, 0);

export function applyShutdownTense(now = Date.now()) {
  if (now < REMOVE_BG_SHUTDOWN) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-after-shutdown]')) {
    el.textContent = el.dataset.afterShutdown!;
  }
}

applyShutdownTense();
