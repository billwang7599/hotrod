// How wide the window, side panels and chat column may be, and which panels dock beside the chat at a given width.

export const MIN_WINDOW_PX = { width: 375, height: 600 }
export const PANEL_PX = { sidebar: 232, context: 320 }
const PANE_PADDING_PX = 24
/** The chat column's width. It never exceeds the pane (CSS caps it at 100%); `max` only bounds a saved value. */
export const COLUMN_PX = { min: MIN_WINDOW_PX.width - 2 * PANE_PADDING_PX, max: 2400, default: 760 }

export function dockedPanels(windowPx: number, widths: typeof PANEL_PX = PANEL_PX) {
  const sidebar = widths.sidebar + MIN_WINDOW_PX.width
  if (windowPx >= sidebar + widths.context) return 'both'
  return windowPx >= sidebar ? 'sidebar' : 'none'
}

export function storedColumn(value: string | null) {
  const px = Number(value ?? NaN)
  return Number.isFinite(px) ? Math.min(Math.max(Math.round(px), COLUMN_PX.min), COLUMN_PX.max) : COLUMN_PX.default
}

export function columnSlider(savedPx: number, paneColumnPx: number) {
  const max = Math.max(Math.floor(paneColumnPx), COLUMN_PX.min)
  return { min: COLUMN_PX.min, max, value: Math.min(Math.max(savedPx, COLUMN_PX.min), max) }
}
