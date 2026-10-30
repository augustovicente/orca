import { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatNoticeRow } from '@/components/native-chat/NativeChatNoticeRow'
import {
  beginSwitchPresentation,
  reportSwitchPresentationFailure,
  SwitchPresentationContext,
  useSwitchPresentation,
  useSwitchPresentationRows
} from './conversation-switch-presentation'

// @vitest-environment happy-dom

const target = { kind: 'local' as const }
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function List({ item }: { item?: string }) {
  const root = useRef<HTMLDivElement>(null)
  useSwitchPresentationRows(root)
  return (
    <div ref={root} data-testid="list">
      {item && (
        <div data-switch-item-id={item}>
          <NativeChatNoticeRow
            messageId={item}
            agentName="Codex"
            block={{ type: 'text', text: 'Codex could not start. Try again.' }}
          />
        </div>
      )}
    </div>
  )
}
function Visit({ item, visible = true }: { item?: string; visible?: boolean }) {
  const visit = useSwitchPresentation(target, 'conversation', visible)
  return (
    <SwitchPresentationContext.Provider value={visit}>
      <List item={item} />
    </SwitchPresentationContext.Provider>
  )
}
function bounds(top: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 200,
    height: 30,
    top,
    bottom: top + 30,
    left: 0,
    right: 200,
    toJSON: () => ({})
  }
}
it.each([true, false])(
  'reports the exact failure once in the clicked context (visible: %s)',
  (visible) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return bounds(!visible && this.dataset.switchItemId ? 5_000 : 0)
    })
    const visit = beginSwitchPresentation(target, 'conversation')
    const view = render(<Visit item="failed-new" />)
    act(() => {
      expect(reportSwitchPresentationFailure(visit, 'failed-new')).toBe(!visible)
    })
    expect(reportSwitchPresentationFailure(visit, 'failed-new')).toBe(false)
    if (visible) {
      expect(screen.getByText('Codex could not start. Try again.')).toBeTruthy()
    } else {
      expect(screen.queryByText('Codex could not start. Try again.')).toBeNull()
    }
    view.unmount()
    visit.release()
    render(<Visit item="failed-new" />)
    expect(screen.getByText('Codex could not start. Try again.')).toBeTruthy()
  }
)
