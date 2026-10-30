import { useRef, type ComponentProps, type PointerEvent } from 'react'
import { DropdownMenuContent } from './dropdown-menu'

export type PointContextMenuAnchor = {
  x: number
  y: number
  openingEvent?: Pick<MouseEvent, 'timeStamp'>
}

export function capturePointContextMenuAnchor(
  event?: Pick<MouseEvent, 'clientX' | 'clientY' | 'timeStamp' | 'preventDefault'>
): PointContextMenuAnchor {
  event?.preventDefault()
  return {
    x: event?.clientX ?? 0,
    y: event?.clientY ?? 0,
    openingEvent: event && { timeStamp: event.timeStamp }
  }
}

export function preventSecondaryMenuSelection(event: PointerEvent): void {
  if (event.button === 2) {
    event.preventDefault()
    event.stopPropagation()
  }
}

export function PointContextMenuContent({
  openingEvent,
  ...props
}: ComponentProps<typeof DropdownMenuContent> & { openingEvent?: Pick<MouseEvent, 'timeStamp'> }) {
  const opening = useRef({ event: openingEvent, pressedPointer: -1 })
  if (opening.current.event !== openingEvent) {
    opening.current = { event: openingEvent, pressedPointer: -1 }
  }
  return (
    <DropdownMenuContent
      {...props}
      onPointerDownCapture={(event) => {
        props.onPointerDownCapture?.(event)
        opening.current.pressedPointer = event.pointerId
      }}
      onPointerUpCapture={(event) => {
        props.onPointerUpCapture?.(event)
        preventSecondaryMenuSelection(event)
        // Radix synthesizes a click for releases whose press opened the menu underneath them.
        if (openingEvent && opening.current.pressedPointer !== event.pointerId) {
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    />
  )
}
