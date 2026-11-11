// Inline 24x24 stroke icons (currentColor, decorative). Buttons carry their own aria-label.
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true, focusable: 'false' } as const;

export const IconGrip = () => (
  <svg {...base} stroke="none" fill="currentColor"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg>
);
export const IconPen = () => (<svg {...base}><path d="M4 20l4-1 11-11-3-3L5 16z" /><path d="M14 6l3 3" /></svg>);
export const IconLayers = () => (<svg {...base}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>);
export const IconSliders = () => (<svg {...base}><path d="M4 7h9M19 7h1M4 17h1M11 17h9" /><circle cx="16" cy="7" r="2.2" /><circle cx="8" cy="17" r="2.2" /></svg>);
export const IconStroke = () => (<svg {...base}><circle cx="12" cy="12" r="7" /></svg>);
export const IconFill = () => (<svg {...base}><circle cx="12" cy="12" r="7" fill="currentColor" /></svg>);
export const IconSwatches = () => (<svg {...base}><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" fill="currentColor" stroke="none" /></svg>);
export const IconTrash = () => (<svg {...base}><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" /></svg>);
export const IconMinus = () => (<svg {...base}><path d="M6 12h12" /></svg>);
export const IconPlus = () => (<svg {...base}><path d="M12 6v12M6 12h12" /></svg>);
export const IconChevron = () => (<svg {...base} width={14} height={14}><path d="M6 9l6 6 6-6" /></svg>);
export const IconCheck = () => (<svg {...base} width={14} height={14} stroke-width={2.4}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>);
export const IconLock = () => (<svg {...base}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>);
export const IconArrowUpDown = () => (<svg {...base}><path d="M8 4v16M8 4l-3 3M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3" /></svg>);
export const IconFlask = () => (<svg {...base}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.6 14h8.8" /></svg>);
export const IconPalette = () => (<svg {...base}><path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.5-2s0-2 1.5-2h2a4 4 0 0 0 4-4 9 9 0 0 0-9-10z" /><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="16" cy="11" r="1" fill="currentColor" stroke="none" /></svg>);
/** Half-filled disc: the same glyph for Stroke and Fill; the pressed state says which is on. */
export const IconStyle = () => (<svg {...base}><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" /></svg>);
/** Ring around a dot: collapses the toolbar to the dot it becomes. */
export const IconCollapse = () => (<svg {...base}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" /></svg>);
/** The toolbar itself: a pill with three tools in it. Reads as "the toolbar" without a label. */
export const IconToolbar = () => (<svg {...base}><rect x="2.5" y="7.5" width="19" height="9" rx="4.5" /><circle cx="8" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="16" cy="12" r="1.1" fill="currentColor" stroke="none" /></svg>);
