import { useAppStore } from '@/store'

/** References name the original row and launch, including their explicit absence. */
export function captureTerminalFactSubject(paneKey: string) {
  const state = useAppStore.getState()
  const row = state.agentStatusByPaneKey[paneKey]
  const launch = state.agentLaunchConfigByPaneKey[paneKey]
  return {
    row,
    launch,
    isCurrent: () => {
      const current = useAppStore.getState()
      return (
        current.agentStatusByPaneKey[paneKey] === row &&
        current.agentLaunchConfigByPaneKey[paneKey] === launch
      )
    }
  }
}
export type TerminalFactSubject = ReturnType<typeof captureTerminalFactSubject>
