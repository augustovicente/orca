// Keep input hit regions beside the opening point, including during placement and dismissal.
const TAB_CONTEXT_MENU_STATIONARY_CLASS =
  'data-[state=open]:animate-none data-[state=closed]:animate-none data-[state=closed]:pointer-events-none'

// Size menus to localized labels and platform shortcut widths, capped to the viewport.
export const TAB_CONTEXT_MENU_CONTENT_CLASS = `min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap ${TAB_CONTEXT_MENU_STATIONARY_CLASS}`

/** Submenus portal out of the parent menu, so they can't inherit its nowrap. */
export const TAB_CONTEXT_SUBMENU_CONTENT_CLASS = `max-w-[calc(100vw-1rem)] whitespace-nowrap ${TAB_CONTEXT_MENU_STATIONARY_CLASS}`
