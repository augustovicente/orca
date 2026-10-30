export const WINDOW_REPRESENTED_WORKSPACE_CHANNEL = 'ui:setRepresentedWorkspace'

/** A workspace folder on this computer and its sidebar name; null when the window shows none. */
export type WindowRepresentedWorkspace = { path: string; name: string } | null
