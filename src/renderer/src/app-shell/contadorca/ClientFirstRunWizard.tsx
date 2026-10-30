import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { editionSupports } from '../../../../shared/edition'
import { useClientWorkspaces, useHasAnyConversation } from './use-client-workspaces'
import {
  readClientFirstRunWizardDismissed,
  shouldShowClientFirstRunWizard,
  writeClientFirstRunWizardDismissed
} from './first-run-wizard'

const STEP_COUNT = 3

// Add Project hands off through its own modals before the flow is actually done.
const CLIENT_ADD_FLOW_MODALS: ReadonlySet<string> = new Set([
  'add-repo',
  'confirm-non-git-folder',
  'confirm-add-project-from-folder',
  'project-added'
])

/** Contadorca first run: add a client folder, connect the assistant, then start. */
export function ClientFirstRunWizard(): React.JSX.Element | null {
  useUiLanguageRevision()
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeModal = useAppStore((s) => s.activeModal)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const clients = useClientWorkspaces()
  const hasConversation = useHasAnyConversation()
  const [dismissed, setDismissed] = useState(() => readClientFirstRunWizardDismissed())
  const [engaged, setEngaged] = useState(false)
  const [step, setStep] = useState(0)
  const [addFlowOpen, setAddFlowOpen] = useState(false)
  const [settingsFlowOpen, setSettingsFlowOpen] = useState(false)
  const activeView = useAppStore((s) => s.activeView)
  const sawAddRepoModalRef = useRef(false)
  const sawSettingsViewRef = useRef(false)

  const firstRun = shouldShowClientFirstRunWizard({
    customerShell: editionSupports('customerShell'),
    clientCount: clients.length,
    hasConversation,
    dismissed
  })
  useEffect(() => {
    if (persistedUIReady && firstRun) {
      setEngaged(true)
    }
  }, [persistedUIReady, firstRun])

  // Hide this dialog while Add Project runs.
  useEffect(() => {
    if (!addFlowOpen) {
      return
    }
    if (CLIENT_ADD_FLOW_MODALS.has(activeModal)) {
      sawAddRepoModalRef.current = true
      return
    }
    if (!sawAddRepoModalRef.current) {
      return
    }
    sawAddRepoModalRef.current = false
    setAddFlowOpen(false)
  }, [activeModal, addFlowOpen])

  // A new client can land just after the add dialog closes; advance once it is visible.
  useEffect(() => {
    if (step === 0 && clients.length > 0) {
      setStep(1)
    }
  }, [clients.length, step])

  // Settings owns the screen while the user connects the assistant; resume on "Pronto".
  useEffect(() => {
    if (!settingsFlowOpen) {
      return
    }
    if (activeView === 'settings') {
      sawSettingsViewRef.current = true
      return
    }
    if (!sawSettingsViewRef.current) {
      return
    }
    sawSettingsViewRef.current = false
    setSettingsFlowOpen(false)
    setStep(2)
  }, [activeView, settingsFlowOpen])

  // Once the first-run flow is engaged it owns the session even after a client is added.
  if (!editionSupports('customerShell') || dismissed || !(engaged || firstRun)) {
    return null
  }
  const open = persistedUIReady && !addFlowOpen && !settingsFlowOpen

  const dismiss = (): void => {
    if (addFlowOpen || settingsFlowOpen) {
      return
    }
    writeClientFirstRunWizardDismissed()
    setDismissed(true)
    setEngaged(false)
  }
  const handleAddFolder = (): void => {
    setAddFlowOpen(true)
    openModal('add-repo')
  }
  const handleOpenChatSettings = (): void => {
    setSettingsFlowOpen(true)
    openSettingsTarget({ pane: 'chat', repoId: null })
    openSettingsPage()
  }

  const stepBody =
    step === 0 ? (
      <div className="flex flex-col gap-2">
        <DialogTitle>
          {translate('contadorca.firstRun.addFolderTitle', 'Adicione a pasta de um cliente')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'contadorca.firstRun.addFolderBody',
            'Escolha a pasta onde ficam os arquivos do cliente. O assistente usa esses arquivos nas conversas.'
          )}
        </DialogDescription>
      </div>
    ) : step === 1 ? (
      <div className="flex flex-col gap-2">
        <DialogTitle>
          {translate('contadorca.firstRun.connectTitle', 'Conecte seu assistente')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'contadorca.firstRun.connectBody',
            'Entre com o OpenCode nas configurações de chat para o assistente responder às suas perguntas.'
          )}
        </DialogDescription>
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        <DialogTitle>{translate('contadorca.firstRun.readyTitle', 'Pronto')}</DialogTitle>
        <DialogDescription>
          {translate(
            'contadorca.firstRun.readyBody',
            'Sua pasta está adicionada. Comece uma conversa e peça o que precisar.'
          )}
        </DialogDescription>
      </div>
    )

  const footer =
    step === 0 ? (
      <>
        <Button variant="ghost" onClick={dismiss}>
          {translate('contadorca.firstRun.skip', 'Pular')}
        </Button>
        <Button variant="outline" onClick={handleAddFolder}>
          {translate('contadorca.firstRun.addFolderAction', 'Adicionar pasta do cliente')}
        </Button>
        <Button onClick={() => setStep(1)}>
          {translate('contadorca.firstRun.continue', 'Continuar')}
        </Button>
      </>
    ) : step === 1 ? (
      <>
        <Button variant="ghost" onClick={dismiss}>
          {translate('contadorca.firstRun.skip', 'Pular')}
        </Button>
        <Button variant="outline" onClick={handleOpenChatSettings}>
          {translate('contadorca.firstRun.openChatSettings', 'Abrir configurações de chat')}
        </Button>
        <Button onClick={() => setStep(2)}>
          {translate('contadorca.firstRun.continue', 'Continuar')}
        </Button>
      </>
    ) : (
      <Button onClick={dismiss}>{translate('contadorca.firstRun.finish', 'Começar a usar')}</Button>
    )

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? undefined : dismiss())}>
      <DialogContent data-contadorca-first-run-wizard="">
        <DialogHeader>
          <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            {translate('contadorca.firstRun.stepCounter', 'Etapa {{current}} de {{total}}', {
              current: step + 1,
              total: STEP_COUNT
            })}
          </p>
          {stepBody}
        </DialogHeader>
        <DialogFooter className="sm:items-center sm:justify-end">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ClientFirstRunWizard
