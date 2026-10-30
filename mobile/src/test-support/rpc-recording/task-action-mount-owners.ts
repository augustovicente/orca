import { useLayoutEffect } from 'react'
import type { operationModuleLoader } from './operation-module-loader'
import type { ActionableTaskItem } from '../../tasks/mobile-tasks-project-workspace-types'
import type { DetailPayload } from '../../tasks/mobile-tasks-provider-detail-types'
import type { RpcClient } from '../../transport/rpc-client'

// Recording projections use the same native mutation, selection and file owners as the screen.
export function useTaskActionMountOwners(
  modules: ReturnType<typeof operationModuleLoader>,
  model: Record<string, unknown>,
  fixture: Record<string, unknown>
): void {
  const { useMobileTasksItemState } = modules.load<
    typeof import('../../tasks/use-mobile-tasks-item-state')
  >('mobile/src/tasks/use-mobile-tasks-item-state.tsx')
  const { useMobileTasksMutation } = modules.load<
    typeof import('../../tasks/use-mobile-tasks-workspace-and-project-state')
  >('mobile/src/tasks/use-mobile-tasks-workspace-and-project-state.tsx')
  const { useMobileTasksSelection, githubTaskKey } = modules.load<
    typeof import('../../tasks/github-task-identity')
  >('mobile/src/tasks/github-task-identity.ts')
  const state = useMobileTasksItemState()
  const mutation = useMobileTasksMutation()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mount adapter stores its actual recording client in this field.
  const selection = useMobileTasksSelection(model.client as RpcClient, state.detailPayload)
  useLayoutEffect(() => {
    for (const [field, value] of Object.entries(fixture)) {
      const setter = Reflect.get(state, `set${field[0].toUpperCase()}${field.slice(1)}`)
      if (typeof setter === 'function') {
        setter(value)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: action adapters declare the concrete provider fixture they dispatch below.
    const selected = (fixture.actionItem ?? null) as ActionableTaskItem | null
    selection.setActionItem(selected)
    if (
      selected?.provider === 'github' &&
      fixture.detailPayload &&
      typeof fixture.detailPayload === 'object'
    ) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's declared GitHub detail fixture supplies the consumed members; provenance comes from its selected item.
      state.setDetailPayload({
        ...fixture.detailPayload,
        targetKey: githubTaskKey(selected.source)
      } as DetailPayload)
    }
  }, [])
  Object.assign(model, state, mutation, selection, {
    captureTaskListRefresh: () => () => {
      if (typeof fixture.loadTasks === 'function') {
        void fixture.loadTasks()
      }
    }
  })
}
