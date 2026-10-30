// @vitest-environment happy-dom

import { act, useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu'
import { TooltipProvider } from './tooltip'
import {
  capturePointContextMenuAnchor,
  PointContextMenuContent
} from './point-context-menu-content'
import { TabHoverCard } from '../tab-bar/TabHoverCard'
import { useTabStripPointerActivation } from '../tab-bar/tab-strip-pointer-activation'

vi.mock('../tab-group/useTabDragSplit', () => ({ TAB_DRAG_ACTIVATION_DISTANCE_PX: 12 }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function TabMenu({ trace }: { trace: string[] }) {
  const [open, setOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState(capturePointContextMenuAnchor)
  const terminal = useRef<HTMLTextAreaElement>(null)
  const activation = useTabStripPointerActivation({
    onActivate: () => {
      trace.push('activate')
      terminal.current?.focus()
    }
  })
  const tab = (
    <button type="button" onPointerDown={activation.onPointerDown}>
      Tab
    </button>
  )
  return (
    <TooltipProvider>
      <textarea ref={terminal} aria-label="Terminal" />
      <div
        onContextMenuCapture={(event) => {
          trace.push('contextmenu')
          setMenuPoint(capturePointContextMenuAnchor(event))
          setOpen(true)
        }}
      >
        {open ? (
          tab
        ) : (
          <TabHoverCard title="Tab" programName="Terminal" icon={null}>
            {tab}
          </TabHoverCard>
        )}
      </div>
      <DropdownMenu
        open={open}
        modal={false}
        onOpenChange={(next) => {
          trace.push(next ? 'open' : 'close')
          setOpen(next)
        }}
      >
        <DropdownMenuTrigger asChild>
          <button aria-hidden tabIndex={-1} className="pointer-events-none fixed size-px" />
        </DropdownMenuTrigger>
        <PointContextMenuContent
          openingEvent={menuPoint.openingEvent}
          sideOffset={0}
          align="start"
          onFocusOutside={() => trace.push('focus-outside')}
        >
          <DropdownMenuItem onSelect={() => trace.push('select')}>Move Tab</DropdownMenuItem>
        </PointContextMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

it.each([
  { name: 'Control-click release on tab', button: 0, ctrlKey: true, releaseOnItem: false },
  { name: 'Control-click release on item', button: 0, ctrlKey: true, releaseOnItem: true },
  { name: 'secondary/two-finger release on item', button: 2, ctrlKey: false, releaseOnItem: true }
])('keeps the menu open after $name', async ({ button, ctrlKey, releaseOnItem }) => {
  const trace: string[] = []
  render(<TabMenu trace={trace} />)
  const tab = screen.getByRole('button', { name: 'Tab' })
  const event = { button, buttons: button === 0 ? 1 : 2, ctrlKey, clientX: 40, clientY: 16 }
  fireEvent.pointerDown(tab, event)
  fireEvent.mouseDown(tab, event)
  fireEvent.contextMenu(tab, event)
  const item = await screen.findByRole('menuitem', { name: 'Move Tab' })
  const releaseTarget = releaseOnItem ? item : screen.getByRole('button', { name: 'Tab' })
  fireEvent.pointerUp(releaseTarget, { ...event, buttons: 0 })
  fireEvent.mouseUp(releaseTarget, { ...event, buttons: 0 })
  await waitFor(() => expect(trace, trace.join(' → ')).not.toContain('close'))
  expect(trace, trace.join(' → ')).not.toContain('select')
  expect(trace).not.toContain('activate')
  expect(trace).not.toContain('focus-outside')
  expect(screen.getByRole('menu')).toBeTruthy()
})

it('keeps an after-release secondary menu open and accepts a fresh primary press', async () => {
  const trace: string[] = []
  render(<TabMenu trace={trace} />)
  const tab = screen.getByRole('button', { name: 'Tab' })
  const secondary = { button: 2, buttons: 2, clientX: 40, clientY: 16 }
  fireEvent.pointerDown(tab, secondary)
  fireEvent.pointerUp(tab, { ...secondary, buttons: 0 })
  fireEvent.mouseUp(tab, { ...secondary, buttons: 0 })
  fireEvent.contextMenu(tab, secondary)
  const item = await screen.findByRole('menuitem', { name: 'Move Tab' })
  expect(trace).not.toContain('close')
  fireEvent.pointerDown(item, { button: 0, buttons: 1 })
  fireEvent.pointerUp(item, { button: 0, buttons: 0 })
  fireEvent.click(item, { button: 0 })
  expect(trace.filter((entry) => entry === 'select')).toHaveLength(1)
  expect(trace).toContain('close')
})

it('blocks secondary release after a long hold and a new secondary press, then selects immediately on primary click', async () => {
  const trace: string[] = []
  render(<TabMenu trace={trace} />)
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Tab' }), { button: 2 })
  const item = await screen.findByRole('menuitem', { name: 'Move Tab' })
  vi.useFakeTimers()
  act(() => vi.advanceTimersByTime(60_000))
  fireEvent.pointerUp(item, { button: 2, pointerId: 1 })
  fireEvent.pointerDown(item, { button: 2, pointerId: 2 })
  fireEvent.pointerUp(item, { button: 2, pointerId: 2 })
  expect(trace).not.toContain('select')
  expect(trace).not.toContain('close')
  fireEvent.pointerDown(item, { button: 0, pointerId: 3 })
  fireEvent.pointerUp(item, { button: 0, pointerId: 3 })
  fireEvent.click(item, { button: 0, detail: 1 })
  expect(trace.filter((entry) => entry === 'select')).toHaveLength(1)
})

it.each(['Escape', 'outside focus', 'outside press', 'Enter'])(
  'honors intentional %s immediately after opening',
  async (action) => {
    const trace: string[] = []
    render(<TabMenu trace={trace} />)
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Tab' }), { button: 2 })
    const item = await screen.findByRole('menuitem', { name: 'Move Tab' })
    if (action === 'outside focus') {
      act(() => screen.getByRole('textbox', { name: 'Terminal' }).focus())
    } else if (action === 'outside press') {
      // Radix installs its outside-pointer listener on the next task.
      await new Promise((resolve) => setTimeout(resolve, 0))
      fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Terminal' }), {
        button: 0,
        pointerType: 'mouse'
      })
    } else if (action === 'Enter') {
      act(() => item.focus())
      fireEvent.keyDown(item, { key: 'Enter' })
    } else {
      fireEvent.keyDown(item, { key: 'Escape' })
    }
    expect(trace).toContain('close')
    expect(trace.filter((entry) => entry === 'select')).toHaveLength(action === 'Enter' ? 1 : 0)
  }
)
