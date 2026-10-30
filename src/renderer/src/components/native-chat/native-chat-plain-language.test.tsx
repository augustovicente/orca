// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import type { AgentMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import type * as EditionModule from '../../../../shared/edition'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatBackgroundTaskRun } from './NativeChatBackgroundTaskRun'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import { NativeChatComposerActions } from './NativeChatComposerActions'

// W5: the customer edition reads agent work in plain words and hides developer telemetry.
vi.mock('../../../../shared/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof EditionModule>()
  return {
    ...actual,
    ORCA_EDITION_ID: 'contadorca',
    editionSupports: (capability: string) =>
      capability !== 'developerTools' && capability !== 'modelPicker' && capability !== 'starNag'
  }
})

// Present only when the edition shows them, so their absence is what this file proves.
vi.mock('./NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))
vi.mock('./NativeChatPermissionModePicker', () => ({
  NativeChatComposerPermissionPicker: () => <div data-testid="permission-picker" />
}))

afterEach(cleanup)

const shellRun: NativeChatBlock[] = [
  {
    type: 'tool-call',
    name: 'shell',
    input: { command: 'ls -la' },
    state: 'completed'
  },
  { type: 'tool-result', output: 'total 0' }
]

describe('contadorca tool activity', () => {
  it('summarizes a run in plain words and keeps the shell behind Detalhes técnicos', () => {
    render(<NativeChatToolRun blocks={shellRun} expandSignal={false} activeTurnIsWorking={false} />)

    expect(screen.getByText('Executando comando')).toBeInTheDocument()
    expect(screen.getByText('Concluído')).toBeInTheDocument()
    expect(screen.queryByText('ls -la')).toBeNull()
    expect(screen.queryByText('total 0')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Detalhes técnicos' }))

    expect(screen.getByText('ls -la')).toBeInTheDocument()
    fireEvent.click(screen.getByText('ls -la').closest('button')!)
    expect(screen.getByText('total 0')).toBeInTheDocument()
  })

  it('says Falhou instead of drawing an exit code in the summary', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'shell',
        input: { command: 'false' },
        state: 'failed'
      },
      { type: 'tool-result', output: 'exit 1', isError: true }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />)

    expect(screen.getByText('Falhou')).toBeInTheDocument()
    expect(screen.queryByText(/exit 1/)).toBeNull()
  })

  it('names reads, searches, edits, and browser steps in plain words', () => {
    const labels = [
      { name: 'read', input: { file_path: 'a.ts' }, expected: 'Lendo arquivo' },
      { name: 'Grep', input: { pattern: 'todo' }, expected: 'Pesquisando' },
      {
        name: 'Edit',
        input: { file_path: 'a.ts' },
        expected: 'Alterando arquivo'
      },
      {
        name: 'shell',
        input: { command: 'orca goto https://example.com' },
        expected: 'Abrindo site'
      }
    ]

    for (const { name, input, expected } of labels) {
      const { unmount } = render(
        <NativeChatToolRun
          blocks={[{ type: 'tool-call', name, input, state: 'completed' }]}
          expandSignal={false}
          activeTurnIsWorking={false}
        />
      )
      expect(screen.getByText(expected)).toBeInTheDocument()
      unmount()
    }
  })

  it('keeps a running step live with a spinner, not a raw command', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'shell',
        input: { command: 'sleep 5' },
        state: 'running'
      }
    ]

    const { container } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking />
    )

    expect(screen.getByText('Executando comando')).toBeInTheDocument()
    expect(container.querySelector('[data-native-chat-tool-run-state="live"]')).not.toBeNull()
    expect(screen.queryByText('sleep 5')).toBeNull()
  })
})

describe('contadorca approvals', () => {
  const commandApproval = {
    title: 'Run a command?',
    detail: 'ls -la /tmp',
    options: [
      { label: 'Allow', send: 'allow' },
      { label: 'Allow for this session', send: 'allowForSession' },
      { label: 'Deny', send: 'deny' }
    ]
  }

  it('states the intent in Portuguese and keeps the command behind Detalhes técnicos', () => {
    const onChoose = vi.fn()
    render(<NativeChatApprovalCard approval={commandApproval} onChoose={onChoose} />)

    expect(
      screen.getByText('O assistente quer executar uma ação no computador')
    ).toBeInTheDocument()
    expect(screen.queryByText('ls -la /tmp')).toBeNull()
    expect(screen.queryByText('Run a command?')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Detalhes técnicos' }))
    expect(screen.getByText('ls -la /tmp')).toBeInTheDocument()
  })

  it('labels the three decisions and keeps their transport tokens', () => {
    const onChoose = vi.fn()
    render(<NativeChatApprovalCard approval={commandApproval} onChoose={onChoose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Permitir uma vez' }))
    fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre' }))
    fireEvent.click(screen.getByRole('button', { name: 'Negar' }))

    expect(onChoose.mock.calls).toEqual([['allow'], ['allowForSession'], ['deny']])
  })

  it('says the assistant wants to open the browser for a browser command', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          ...commandApproval,
          detail: 'orca goto https://example.com'
        }}
        onChoose={() => {}}
      />
    )

    expect(
      screen.getByText('O assistente quer abrir o navegador e acessar um site')
    ).toBeInTheDocument()
  })

  it('keeps a proposed plan visible while stating its intent', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Review proposed plan',
          subject: { kind: 'plan', text: 'Passo um' },
          options: [{ label: 'Approve plan', send: 'allow' }]
        }}
        onChoose={() => {}}
      />
    )

    expect(
      screen.getByText('O assistente quer que você revise o plano antes de continuar')
    ).toBeInTheDocument()
    expect(screen.getByText('Passo um')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aprovar plano' })).toBeInTheDocument()
  })
})

describe('contadorca hidden telemetry', () => {
  it('drops token counts from a background task while keeping its duration', () => {
    render(
      <NativeChatBackgroundTaskRun
        block={{
          type: 'background-task',
          taskId: 'byjnee2no',
          kind: 'command',
          label: 'Gerar a guia',
          state: 'blocked',
          startedAt: 1_000,
          settledAt: 61_000,
          tokens: 18_200
        }}
      />
    )

    expect(screen.queryByText(/18\.2k/)).toBeNull()
    expect(screen.getByText(/1m 0s/)).toBeInTheDocument()
  })

  it('drops token counts from a subagent run', () => {
    render(
      <NativeChatSubagentRun
        block={{
          type: 'subagent-group',
          groupId: 'thread:turn-1',
          agents: [{ id: 'b', label: 'search', state: 'completed', tokens: 40_661 }]
        }}
      />
    )

    expect(screen.getByRole('button').textContent).not.toContain('40.7k')
  })

  it('names no agent sender on an agent message', () => {
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [
        {
          party: {
            address: 'terminal:pty-1',
            terminalHandle: 'pty-1',
            orcaSessionId: null
          },
          name: 'Claude Code',
          relation: 'none'
        }
      ],
      orchestration: null
    }
    const { container } = render(
      <NativeChatAgentMessageSenders from={from} chatWorktreeId="wt-chat" />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('hides the model, effort, permission mode, and context readouts in the composer', () => {
    const { container } = render(
      <TooltipProvider>
        <NativeChatComposerActions
          attachDisabled={false}
          dictationDisabled={false}
          sendDisabled={false}
          isWorking={false}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={() => {}}
          onDictationToggle={() => {}}
          onDictationHoldStart={() => {}}
          onDictationHoldEnd={() => {}}
          onSend={() => {}}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
          contextUsage={{
            usedTokens: 26_400,
            windowTokens: 1_000_000,
            percentage: 3,
            estimated: false,
            rows: []
          }}
          agent="claude"
        />
      </TooltipProvider>
    )

    expect(screen.queryByTestId('session-option-pickers')).toBeNull()
    expect(screen.queryByTestId('permission-picker')).toBeNull()
    expect(container.querySelector('[data-native-chat-context-usage]')).toBeNull()
    // Sending still works without the developer readouts.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })
})
