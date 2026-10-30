// Track writes through objects, iterators and collection entries; finalize only after COMMIT.

import { applyJournalRow, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import {
  JournalDraftMap,
  JournalDraftSet,
  type JournalDraftAccess,
  type JournalEntryChange
} from './journal-transition-collections'

type DraftNode = { value: object; finish: () => object; listen: (changed: () => void) => void }

class JournalDraft {
  private readonly originals = new WeakMap<object, DraftNode>()
  private readonly proxies = new WeakMap<object, DraftNode>()
  private readonly collections: (JournalDraftMap<unknown, unknown> | JournalDraftSet<unknown>)[] =
    []
  private readonly assigned = new WeakSet<object>()
  private readonly pending: (() => void)[] = []
  private readonly resolved = new WeakMap<object, object>()

  readonly access: JournalDraftAccess = {
    wrap: (value, changed, path) => this.wrap(value, changed, path),
    assign: (value) => {
      if (typeof value === 'object' && value !== null) this.assigned.add(value)
    },
    finish: (value) => this.finish(value),
    defer: (apply) => this.pending.push(apply)
  }

  wrap<T>(value: T, changed: () => void, path: string): T {
    if (typeof value !== 'object' || value === null) return value
    const previous = this.proxies.get(value) ?? this.originals.get(value)
    if (previous) {
      previous.listen(changed)
      // SAFETY: the draft has the same interface as the object it isolates.
      return previous.value as T
    }
    const listeners = new Set([changed])
    let dirty = false
    const mark = (): void => {
      if (!dirty) {
        dirty = true
        for (const notify of listeners) notify()
      }
    }
    let node: DraftNode
    if (value instanceof Map || value instanceof Set) {
      const collection =
        value instanceof Map
          ? new JournalDraftMap(value, this.access, mark, path)
          : new JournalDraftSet(value, this.access, mark, path)
      this.collections.push(collection)
      node = {
        value: collection,
        finish: () => collection.finish(),
        listen: (notify) => {
          listeners.add(notify)
          if (dirty) notify()
        }
      }
    } else {
      let copy: object | undefined
      const current = (): object => copy ?? value
      const writable = (): object => {
        if (!copy) {
          const cloned: object = Array.isArray(value)
            ? [...value]
            : Object.assign(Object.create(Object.getPrototypeOf(value)), value)
          copy = cloned
        }
        return copy
      }
      const assignedKeys = new Set<PropertyKey>()
      const target = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
      const proxy = new Proxy(target, {
        get: (_target, key, receiver) =>
          this.wrap(
            Reflect.get(current(), key, receiver),
            mark,
            path ? `${path}.${String(key)}` : String(key)
          ),
        has: (_target, key) => Reflect.has(current(), key),
        ownKeys: () => Reflect.ownKeys(current()),
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(current(), key)
          return (
            descriptor && { ...descriptor, configurable: key !== 'length' || !Array.isArray(value) }
          )
        },
        set: (_target, key, next) => {
          if (!Object.is(Reflect.get(current(), key), next) || !Object.hasOwn(current(), key)) {
            this.access.assign(next)
            assignedKeys.add(key)
            Reflect.set(writable(), key, next)
            mark()
          }
          return true
        },
        deleteProperty: (_target, key) => {
          if (Object.hasOwn(current(), key)) {
            Reflect.deleteProperty(writable(), key)
            mark()
          }
          return true
        },
        defineProperty: (_target, key, descriptor) => {
          this.access.assign(descriptor.value)
          assignedKeys.add(key)
          Reflect.defineProperty(writable(), key, descriptor)
          mark()
          return true
        }
      })
      node = {
        value: proxy,
        finish: () => {
          if (!dirty && !this.assigned.has(value)) return value
          const result = writable()
          for (const key of Reflect.ownKeys(result)) {
            const child = Reflect.get(result, key)
            if (
              assignedKeys.has(key) ||
              this.assigned.has(value) ||
              (typeof child === 'object' &&
                child !== null &&
                (this.originals.has(child) || this.proxies.has(child)))
            ) {
              Reflect.set(result, key, this.finish(child))
            }
          }
          return result
        },
        listen: (notify) => {
          listeners.add(notify)
          if (dirty) notify()
        }
      }
    }
    this.originals.set(value, node)
    this.proxies.set(node.value, node)
    // SAFETY: collection overlays and object proxies preserve the wrapped interface.
    return node.value as T
  }

  changes(): JournalEntryChange[] {
    return this.collections.flatMap((collection) => collection.changes())
  }

  adopt<T>(value: T): T {
    // SAFETY: finalization removes tracking wrappers without changing the reducer's shape.
    const result = this.finish(value) as T
    for (const apply of this.pending) apply()
    return result
  }

  private finish(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value
    const previous = this.resolved.get(value)
    if (previous) return previous
    const node = this.proxies.get(value) ?? this.originals.get(value)
    if (node) {
      const result = node.finish()
      this.resolved.set(value, result)
      this.resolved.set(node.value, result)
      return result
    }
    if (value instanceof Map || value instanceof Set) return value
    // Newly assigned objects may contain drafts introduced by spread or destructuring.
    const copy: object = Array.isArray(value)
      ? [...value]
      : Object.assign(Object.create(Object.getPrototypeOf(value)), value)
    this.resolved.set(value, copy)
    for (const key of Reflect.ownKeys(copy)) {
      Reflect.set(copy, key, this.finish(Reflect.get(copy, key)))
    }
    return copy
  }
}

export function isolateJournalTransition(
  state: JournalReducerState,
  rows: readonly JournalRow[],
  savedAt: number
): {
  state: JournalReducerState
  changes: () => JournalEntryChange[]
  adopt: () => JournalReducerState
} {
  const draft = new JournalDraft()
  const candidate = draft.wrap(state, () => undefined, '')
  for (const row of rows) applyJournalRow(candidate, row, savedAt)
  return { state: candidate, changes: () => draft.changes(), adopt: () => draft.adopt(candidate) }
}
