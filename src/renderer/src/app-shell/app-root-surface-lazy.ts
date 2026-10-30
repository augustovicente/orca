import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

export const QuickOpen = lazy(() => import('../components/QuickOpen'))
export const WorkspaceCleanupDialog = lazy(
  () => import('../components/workspace-cleanup/WorkspaceCleanupDialog')
)
export const StatusBar = lazy(() =>
  import('../components/status-bar/StatusBar').then((module) => ({ default: module.StatusBar }))
)
export const SetupGuideModal = lazy(() => import('../components/setup-guide/SetupGuideModal'))
export const FeatureWallModal = lazy(() => import('../components/feature-wall/FeatureWallModal'))
export const FeatureTipsModal = lazy(() => import('../components/feature-tips/FeatureTipsModal'))
export const AddRepoDialog = lazy(() => import('../components/sidebar/AddRepoDialog'))
export const NonGitFolderDialog = lazy(() => import('../components/sidebar/NonGitFolderDialog'))
export const AddProjectFromFolderDialog = lazy(
  () => import('../components/sidebar/AddProjectFromFolderDialog')
)
export const DiagramViewerModal = lazy(() => import('../components/editor/DiagramViewerModal'))
export const ProjectAddedDialog = lazy(() => import('../components/sidebar/ProjectAddedDialog'))
export const NodeDistMirrorDialog = lazy(
  () => import('../components/settings/NodeDistMirrorDialog')
)
export const AiVaultSessionHistoryDialog = lazy(
  () => import('../components/right-sidebar/AiVaultSessionHistoryDialog')
)
export const DeleteWorktreeDialog = lazy(() => import('../components/sidebar/DeleteWorktreeDialog'))
export const PreservedBranchBatchReviewModal = lazy(
  () => import('../components/sidebar/PreservedBranchBatchReviewModal')
)
export const DictationController = lazy(() =>
  import('../components/dictation/DictationController').then((module) => ({
    default: module.DictationController
  }))
)
export const SshPassphraseDialog = lazy(() =>
  import('../components/settings/SshPassphraseDialog').then((module) => ({
    default: module.SshPassphraseDialog
  }))
)
export const UpdateCard = lazy(() =>
  import('../components/UpdateCard').then((module) => ({ default: module.UpdateCard }))
)
export const UnexpectedSignoutCard = lazy(() =>
  import('../components/UnexpectedSignoutCard').then((module) => ({
    default: module.UnexpectedSignoutCard
  }))
)
export const RemoteServerUpdateDialog = lazy(
  () => import('../components/settings/RemoteServerUpdateDialog')
)
export const ContextualTourOverlay = lazy(() =>
  import('../components/contextual-tours/ContextualTourOverlay').then((module) => ({
    default: module.ContextualTourOverlay
  }))
)
export const SetupGuideTelemetryObserver = lazy(() =>
  import('../components/setup-guide/SetupGuideTelemetryObserver').then((module) => ({
    default: module.SetupGuideTelemetryObserver
  }))
)
export const FloatingTerminalPanel = lazy(() =>
  import('../components/floating-terminal/FloatingTerminalPanel').then((module) => ({
    default: module.FloatingTerminalPanel
  }))
)
// Load the pet asset/overlay only when enabled.
export const PetOverlay = lazy(() => import('../components/pet/PetOverlay'))
// Avoid fetching onboarding assets for users past first launch.
export const OnboardingFlow = lazy(() => import('../components/onboarding/OnboardingFlow'))
