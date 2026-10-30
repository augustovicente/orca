import { translateMain } from '../i18n/main-i18n'
import { editionSupports } from '../../shared/edition'
import type { AppearanceMenuKey, AppearanceMenuState } from './register-app-menu'
import type { KeybindingActionId } from '../../shared/keybindings'

export function buildAppearanceSubmenu(params: {
  appearance: AppearanceMenuState
  onToggleLeftSidebar: () => void
  onToggleRightSidebar: () => void
  onToggleAppearance: (key: AppearanceMenuKey) => void
  shortcutLabel: (actionId: KeybindingActionId) => string
}): Electron.MenuItemConstructorOptions {
  const {
    appearance,
    onToggleLeftSidebar,
    onToggleRightSidebar,
    onToggleAppearance,
    shortcutLabel
  } = params
  return {
    label: translateMain('menu.appearance', 'Appearance'),
    submenu: [
      {
        // Display hints only: native accelerators bypass markdown bold handling and renderer-owned sidebar state.
        label: `${translateMain('menu.toggleLeftSidebar', 'Toggle Left Sidebar')}\t${shortcutLabel('sidebar.left.toggle')}`,
        click: () => onToggleLeftSidebar()
      },
      ...(editionSupports('rightSidebar')
        ? [
            {
              label: `${translateMain('menu.toggleRightSidebar', 'Toggle Right Sidebar')}\t${shortcutLabel('sidebar.right.toggle')}`,
              click: () => onToggleRightSidebar()
            }
          ]
        : []),
      ...(editionSupports('statusBar')
        ? [
            {
              label: translateMain('menu.showStatusBar', 'Show Status Bar'),
              type: 'checkbox' as const,
              checked: appearance.statusBarVisible,
              click: () => onToggleAppearance('statusBarVisible')
            }
          ]
        : []),
      { type: 'separator' },
      ...(editionSupports('taskProviders')
        ? [
            {
              label: translateMain('menu.showTasksButton', 'Show Tasks Button'),
              type: 'checkbox' as const,
              checked: appearance.showTasksButton,
              click: () => onToggleAppearance('showTasksButton')
            }
          ]
        : []),
      ...(editionSupports('automations')
        ? [
            {
              label: translateMain('menu.showAutomationsButton', 'Show Automations Button'),
              type: 'checkbox' as const,
              checked: appearance.showAutomationsButton,
              click: () => onToggleAppearance('showAutomationsButton')
            }
          ]
        : []),
      ...(editionSupports('mobile')
        ? [
            {
              label: translateMain('menu.showMobileButton', 'Show Orca Mobile Button'),
              type: 'checkbox' as const,
              checked: appearance.showMobileButton,
              click: () => onToggleAppearance('showMobileButton')
            }
          ]
        : []),
      {
        label: translateMain('menu.showTitlebarAppName', 'Show Titlebar App Name'),
        type: 'checkbox',
        checked: appearance.showTitlebarAppName,
        click: () => onToggleAppearance('showTitlebarAppName')
      }
    ]
  }
}
