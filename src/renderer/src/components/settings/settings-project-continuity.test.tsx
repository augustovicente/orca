// @vitest-environment happy-dom
import { createRoot } from 'react-dom/client'
import { act, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '../ui/tooltip'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { ProjectGroupingSetting } from './ProjectGroupingSetting'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo
} from './settings-project-list'
import { useConcreteProjectContinuity, useSettingsNavigationActions } from './settings-view-model'
import { renderProjectSettingsSections } from './settings-project-section-renderer'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsRenderContext } from './settings-render-context'
import { buildSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { getSettingsSectionSearchEntries, rankSettingsSearchItems } from './settings-search'
import { useSettingsPageEffects } from './use-settings-page-effects'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'

// Pane presentation is the seam; actual control, write owner, selection and navigation remain production.
vi.mock('./repository/RepositoryPane', () => ({
  RepositoryPane: ({ repo, project }: { repo: Repo; project: { id: string } }) => {
    const settings = useAppStore((state) => state.settings)!
    const updateSettings = useAppStore((state) => state.updateSettings)
    return (
      <>
        <output>{repo.path}</output>
        <ProjectGroupingSetting
          settings={settings}
          updateSettings={updateSettings}
          projectId={project.id}
        />
      </>
    )
  }
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('keeps the actual implicit and explicitly chosen checkout through control saves, external regroup and rollback without a blank commit', async () => {
  const first: Repo = {
    id: 'a',
    path: '/work/harbor-first',
    displayName: 'Harbor',
    badgeColor: '',
    addedAt: 0,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/org/harbor',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/org/harbor'
    }
  }
  const second = { ...first, id: 'b', path: '/work/harbor-second' }
  const repos = [first, second]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const projectId = projection.projects[0].id
  let saved = getDefaultSettings('/tmp')
  const persist = vi.fn(async (patch: object) => {
    saved = { ...saved, ...patch }
    return saved
  })
  Object.assign(window, { api: { settings: { set: persist } } })
  useAppStore.setState({
    repos,
    settings: saved,
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  const commits: string[] = []
  let navigate!: ReturnType<typeof useSettingsNavigationActions>['scrollToSection']
  let discardAllowed = true
  const nothing = () => {}
  const asyncNothing = async () => {}
  let selectedSection = ''
  let selectSecond!: () => void
  function Harness() {
    const state = useAppStore(
      useShallow((state) => ({
        repos: state.repos,
        settings: state.settings,
        projects: state.projects,
        projectHostSetups: state.projectHostSetups,
        settingsProjectHostSelection: state.settingsProjectHostSelection,
        settingsProjectSetupSelection: state.settingsProjectSetupSelection,
        setSettingsProjectHostSelection: state.setSettingsProjectHostSelection,
        settingsSearchQuery: state.settingsSearchQuery,
        setSettingsSearchQuery: state.setSettingsSearchQuery,
        settingsNavigationTarget: state.settingsNavigationTarget,
        clearSettingsTarget: state.clearSettingsTarget,
        updateRepo: state.updateRepo,
        updateProject: state.updateProject
      }))
    )
    const entries = useMemo(
      () =>
        buildSettingsProjectList(state.repos, {
          projects: state.projects,
          projectHostSetups: state.projectHostSetups,
          settings: state.settings
        }),
      [state.repos, state.settings, state.projects, state.projectHostSetups]
    )
    const [activeSectionId, setActiveSectionId] = useState(`repo-${entries[0].selectionKey}`)
    const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
    const [, setMountedSectionIds] = useState(new Set<string>())
    const [repoHooksMap, setRepoHooksMap] = useState({})
    const pendingNavSectionRef = useRef<string | null>(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only supplied continuity/action fields are read.
    const interactions = {
      pendingNavSectionRef,
      pendingScrollTargetRef: useRef(null),
      contentScrollRef: useRef(null),
      confirmDiscardSourceControlAiPromptChanges: async () => discardAllowed,
      pendingScrollTargetWatchRef: useRef(null),
      pendingSubsectionScrollFrameRef: useRef(null),
      repoHooksRequestSeqRef: useRef(0),
      hasUnsavedSourceControlAiPromptChangesRef: useRef(false),
      shortcutsEscapeConfirmUntilRef: useRef(0),
      searchInputRef: useRef(null)
    } as unknown as SettingsInteractionController
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all fields read by continuity/actions/renderer are supplied.
    const raw = {
      ...state,
      settingsProjectList: entries,
      activeSectionId,
      setActiveSectionId,
      pendingNavRequestTick,
      setPendingNavRequestTick,
      setMountedSectionIds,
      repoHooksMap,
      setRepoHooksMap,
      repoIdToRepresentative: buildRepoIdToRepresentative(entries),
      repoIdToHostSelection: buildRepoIdToHostSelection(entries),
      fetchSettings: asyncNothing,
      fetchKeybindings: asyncNothing,
      refreshModelStates: asyncNothing,
      setVoiceModelStatesLoading: nothing,
      setHighlightedSettingsTargetId: nothing,
      showDesktopOnlySettings: false,
      removeProjectAllHosts: asyncNothing
    } as unknown as SettingsStoreModel
    const navSections = useMemo(
      () =>
        buildSettingsNavigationMetadata({
          isMac: false,
          isWindows: false,
          isWebClient: false,
          repos: state.repos,
          projectGrouping: {
            projects: state.projects,
            projectHostSetups: state.projectHostSetups,
            settings: state.settings
          }
        }),
      [state.repos, state.projects, state.projectHostSetups, state.settings]
    )
    const visibleNavSections = useMemo(
      () =>
        rankSettingsSearchItems(
          state.settingsSearchQuery,
          navSections,
          getSettingsSectionSearchEntries
        ).map(({ item }) => item),
      [state.settingsSearchQuery, navSections]
    )
    const visible = useMemo(
      () => new Set(visibleNavSections.map((section) => section.id)),
      [visibleNavSections]
    )
    const model = useConcreteProjectContinuity(raw, interactions, visible)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: scroll effect reads only visible navigation fields.
    const navigation = {
      visibleNavSections,
      visibleSectionIds: visible
    } as unknown as SettingsNavigationModel
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hook-file loading is outside the presentation fixture.
    const terminal = { neededRepos: [] } as unknown as SettingsTerminalModel
    useSettingsPageEffects(model, interactions)
    useSettingsRepoScrollEffects(model, interactions, navigation, terminal)
    selectedSection = model.activeSectionId
    navigate = useSettingsNavigationActions(model, interactions).scrollToSection
    selectSecond = () => {
      const entry = entries.find((entry) =>
        entry.setups.some((setup) => setup.repoId === second.id)
      )!
      const setup = entry.setups.find((setup) => setup.repoId === second.id)!
      state.setSettingsProjectHostSelection(entry.selectionKey, setup.hostId, setup.id)
      setActiveSectionId(`repo-${entry.selectionKey}`)
    }
    const active = entries.find((entry) => `repo-${entry.selectionKey}` === model.activeSectionId)
    const selected =
      active &&
      getSettingsEntryHostSelection(
        active,
        model.settingsProjectHostSelection,
        model.settingsProjectSetupSelection
      )
    const path =
      active &&
      selected &&
      getSettingsProjectHostRepo(active, state.repos, selected.hostId, selected.setupId)?.path
    useLayoutEffect(() => {
      commits.push(path ?? model.activeSectionId)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renderer reads only these presentation/navigation/terminal fields.
    const context = {
      model,
      navigation: { getSectionSearchEntries: () => [] },
      terminal: { windowsTerminalCapabilities: {}, isWindowsTerminalHost: false },
      view: { isSectionMounted: () => true }
    } as unknown as SettingsRenderContext
    return (
      <TooltipProvider>
        <ActiveSettingsSectionProvider value={model.activeSectionId}>
          {renderProjectSettingsSections(context)}
        </ActiveSettingsSectionProvider>
      </TooltipProvider>
    )
  }
  render(<Harness />)
  const user = userEvent.setup()
  async function choose(label: string | RegExp) {
    await user.click(screen.getByRole('combobox', { name: 'Group checkouts' }))
    await user.click(screen.getByRole('option', { name: label }))
  }
  expect(screen.getByText(first.path, { selector: 'output' })).toBeTruthy()
  commits.length = 0
  await choose('Separate by folder')
  expect(persist).toHaveBeenCalled()
  expect(screen.getByText(first.path, { selector: 'output' })).toBeTruthy()
  expect(new Set(commits)).toEqual(new Set([first.path]))
  act(() => selectSecond())
  commits.length = 0
  await choose(/Use default/)
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  expect(new Set(commits)).toEqual(new Set([second.path]))
  // Published input changes use the same projection, including a surviving merged key that loses this member.
  commits.length = 0
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  act(() => useAppStore.setState({ settings: saved }))
  expect(new Set(commits)).toEqual(new Set([second.path]))
  act(() => useAppStore.setState({ repos: [first] }))
  expect(document.querySelector('output')).toBeNull()
  act(() => useAppStore.setState({ repos }))
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  const movedProjects = [
    ...projection.projects,
    { ...projection.projects[0], id: 'moved', displayName: 'Moved Harbor' }
  ]
  const movedSetups = projection.setups.map((setup) =>
    setup.repoId === second.id ? { ...setup, projectId: 'moved' } : setup
  )
  commits.length = 0
  act(() => useAppStore.setState({ projects: movedProjects, projectHostSetups: movedSetups }))
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  expect(new Set(commits)).toEqual(new Set([second.path]))
  act(() =>
    useAppStore.setState({ projects: projection.projects, projectHostSetups: projection.setups })
  )
  persist.mockRejectedValueOnce(new Error('write refused'))
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await choose('Separate by folder')
  error.mockRestore()
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  discardAllowed = false
  await act(async () => {
    await navigate('general')
  })
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  discardAllowed = true
  act(() => useAppStore.getState().setSettingsSearchQuery('terminal scrollback'))
  await waitFor(() =>
    expect(useAppStore.getState().settingsSearchQuery).toBe('terminal scrollback')
  )
  expect(document.querySelector('output')).toBeNull()
  act(() => useAppStore.getState().setSettingsSearchQuery(''))
  expect(document.querySelector('output')).toBeNull()
  // The real deep-link and scroll owners replace the abandoned anchor with the requested checkout.
  act(() =>
    useAppStore.getState().openSettingsTarget({ pane: 'repo', repoId: first.id, hostId: 'local' })
  )
  expect(screen.getByText(first.path, { selector: 'output' })).toBeTruthy()
  expect(useAppStore.getState().settingsNavigationTarget).toBeNull()
  act(() => selectSecond())
  expect(screen.getByText(second.path, { selector: 'output' })).toBeTruthy()
  act(() =>
    useAppStore.setState({
      projectHostSetups: projection.setups.filter((setup) => setup.repoId !== second.id),
      repos: [first]
    })
  )
  expect(screen.getByText(first.path, { selector: 'output' })).toBeTruthy()
  act(() => useAppStore.setState({ projectHostSetups: projection.setups, repos }))
  expect(screen.getByText(first.path, { selector: 'output' })).toBeTruthy()
  expect(selectedSection).toMatch(/^repo-/)
  await act(async () => {
    await navigate('general')
  })
  act(() =>
    useAppStore.setState({
      settings: { ...saved, projectGroupingOverrides: { [projectId]: 'folder' } }
    })
  )
  expect(document.querySelector('output')).toBeNull()
})

it('bounds the mounted current-selection regroup operation with independent entry and setup populations', () => {
  for (const dimension of ['entries', 'setups'] as const) {
    for (const n of [100, 1000]) {
      const repos = Array.from({ length: 1000 }, (_, i) => ({
        id: `settings-${i}`,
        path: `/settings/${i}`,
        displayName: `Settings ${i}`,
        badgeColor: '',
        addedAt: 0
      }))
      const projection = projectHostSetupProjectionFromRepos(repos)
      const count = dimension === 'entries' ? n : 1000
      const setupCount = dimension === 'setups' ? n : 1000
      const setups = projection.setups
        .slice(0, setupCount)
        .map((setup, i) => ({ ...setup, projectId: projection.projects[i % count].id }))
      let entries = buildSettingsProjectList(repos, {
        projects: projection.projects.slice(0, count),
        projectHostSetups: setups
      })
      let activeSectionId = `repo-${entries[0].selectionKey}`
      const hosts = {}
      const choices = {}
      const setActiveSectionId = (id: string) => {
        activeSectionId = id
      }
      const nothing = () => {}
      const container = document.createElement('div')
      const root = createRoot(container)
      let actual = ''
      function Harness() {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exact fields read by continuity are supplied.
        const input = {
          settingsProjectList: entries,
          activeSectionId,
          setActiveSectionId,
          settingsProjectHostSelection: hosts,
          settingsProjectSetupSelection: choices,
          setSettingsProjectHostSelection: nothing,
          settingsNavigationTarget: null
        } as unknown as SettingsStoreModel
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: continuity reads only the pending navigation ref.
        const interactions = {
          pendingNavSectionRef: useRef(null)
        } as unknown as SettingsInteractionController
        actual = useConcreteProjectContinuity(
          input,
          interactions,
          new Set(entries.map((entry) => `repo-${entry.selectionKey}`))
        ).activeSectionId
        return null
      }
      const get = Map.prototype.get
      let reads = 0
      try {
        act(() => root.render(<Harness />))
        const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          reads++
          return get.call(this, key)
        })
        try {
          entries = buildSettingsProjectList(repos, {
            projects: projection.projects.slice(0, count),
            projectHostSetups: setups,
            settings: { projectGroupingMode: 'folder' }
          })
          act(() => root.render(<Harness />))
          expect(actual).toBe(
            `repo-${entries.find((entry) => entry.setups.some((setup) => setup.repoId === repos[0].id))!.selectionKey}`
          )
          expect(reads).toBeGreaterThan(setupCount)
          expect(reads).toBeLessThan(60 * (count + setupCount))
          process.stdout.write(
            `PG8 settings operations ${JSON.stringify({ dimension, n, entries: entries.length, setups: setupCount, reads })}\n`
          )
        } finally {
          probe.mockRestore()
        }
      } finally {
        act(() => root.unmount())
      }
    }
  }
})
