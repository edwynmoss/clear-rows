/**
 * The Clear Rows mark (public/clear-rows-logo.png, src-tauri/icons): three
 * rows split by a notch, with the middle cell picked out in brand gold.
 * Geometry traced from the 1024px artwork; bars follow the text colour so
 * the mark reads in both themes, the gold stays fixed. Each piece carries a
 * class so the empty state can animate them assembling.
 */
export function markSvg(): string {
  return `<svg viewBox="180 312 665 400" aria-hidden="true">
  <g fill="currentColor">
    <path class="cr-mark-l cr-mark-r1" d="M180 312h290l33 72H180z"/>
    <path class="cr-mark-r cr-mark-r1" d="M555 312h290v72H522z"/>
    <path class="cr-mark-l cr-mark-r2" d="M180 476h208l-30 72H180z"/>
    <path class="cr-mark-r cr-mark-r2" d="M628 476h217v72H598z"/>
    <path class="cr-mark-l cr-mark-r3" d="M180 640h290l33 72H180z"/>
    <path class="cr-mark-r cr-mark-r3" d="M555 640h290v72H522z"/>
  </g>
  <path class="cr-logo-accent cr-mark-cell" d="M412 476h192l-31 72H382z"/>
</svg>`;
}
