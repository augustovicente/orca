import { ipcMain, type BrowserWindow } from 'electron'
import { isAbsolute } from 'node:path'
import {
  WINDOW_REPRESENTED_WORKSPACE_CHANNEL,
  type WindowRepresentedWorkspace
} from '../../shared/window-represented-workspace'

function parseRepresentedWorkspace(value: unknown): WindowRepresentedWorkspace {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('path' in value) ||
    !('name' in value) ||
    typeof value.path !== 'string' ||
    typeof value.name !== 'string' ||
    !isAbsolute(value.path)
  ) {
    return null
  }
  return { path: value.path, name: value.name }
}

/** macOS publishes the represented folder as the window's AXDocument for time trackers and window managers. */
export function installMainWindowRepresentedWorkspace(
  mainWindow: BrowserWindow,
  appTitle: string
): () => void {
  if (process.platform !== 'darwin') {
    return () => {}
  }
  const rendererWebContents = mainWindow.webContents
  const onRepresentedWorkspace = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (event.sender !== rendererWebContents || mainWindow.isDestroyed()) {
      return
    }
    const workspace = parseRepresentedWorkspace(value)
    mainWindow.setRepresentedFilename(workspace?.path ?? '')
    mainWindow.setTitle(workspace ? `${workspace.name} — ${appTitle}` : appTitle)
  }
  ipcMain.on(WINDOW_REPRESENTED_WORKSPACE_CHANNEL, onRepresentedWorkspace)
  return () => ipcMain.removeListener(WINDOW_REPRESENTED_WORKSPACE_CHANNEL, onRepresentedWorkspace)
}
