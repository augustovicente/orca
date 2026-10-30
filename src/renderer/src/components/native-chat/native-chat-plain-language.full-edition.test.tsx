// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatToolRun } from './NativeChatToolRun'

// W5: the full edition keeps its shell-precise transcript; only the customer edition simplifies it.
afterEach(cleanup)

describe('full edition transcript', () => {
  it('keeps the shell command in the tool-run header', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'shell',
        input: { command: 'pnpm test' },
        state: 'completed'
      }
    ]
    const { container } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />
    )

    expect(container.querySelector('[data-native-chat-tool-run-plain]')).toBeNull()
    expect(screen.getByText(/pnpm test/)).toBeInTheDocument()
  })

  it('keeps the provider approval title, command, and option wording on the card', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Run a command?',
          detail: 'ls -la',
          options: [{ label: 'Allow', send: 'allow' }]
        }}
        onChoose={() => {}}
      />
    )

    expect(screen.getByText('Run a command?')).toBeInTheDocument()
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
  })
})
