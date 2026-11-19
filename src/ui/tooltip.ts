/**
 * Quick, readable tooltips for every element with a `title` (or `data-tip`): they appear after a
 * short pause on hover, wrap to a sensible width, stay inside the window, and also show on a tap
 * on touch screens (where the browser's own title tooltips never appear).
 *
 * A `title` is moved to `data-tip` the first time the pointer reaches it, so the browser's own
 * tooltip doesn't show as well; titles set later by code are picked up the same way.
 */
const DELAY = 300;

export function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);

  let timer = 0;
  let current: HTMLElement | null = null;

  /** the nearest element with a tip, moving a native title over to data-tip */
  const target = (e: Event): HTMLElement | null => {
    let el = e.target as HTMLElement | null;
    while (el && el !== document.body) {
      if (el.hasAttribute('title')) {
        const t = el.getAttribute('title') ?? '';
        el.removeAttribute('title');
        if (t) el.dataset.tip = t;
        else delete el.dataset.tip;
      }
      if (el.dataset.tip) return el;
      el = el.parentElement;
    }
    return null;
  };

  const hide = () => {
    clearTimeout(timer);
    tip.hidden = true;
    current = null;
  };

  const show = (el: HTMLElement) => {
    const text = el.dataset.tip;
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    // place under the element (above it if there is no room), inside the window
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
    const left = Math.max(m, Math.min(window.innerWidth - w - m, r.left));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - m) top = Math.max(m, r.top - h - 6);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  document.addEventListener('mouseover', (e) => {
    const el = target(e);
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => show(el), DELAY);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && !current.contains(e.relatedTarget as Node | null)) hide();
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') {
        hide(); // clicking or dragging a slider: get out of the way
        return;
      }
      const el = target(e);
      hide();
      if (!el) return;
      current = el;
      show(el);
      timer = window.setTimeout(hide, 6000);
    },
    true,
  );
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}
