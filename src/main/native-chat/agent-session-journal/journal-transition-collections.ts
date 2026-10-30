// Overlay collections leave the live containers untouched until their transaction commits.

export type JournalEntryChange = {
  path: string
  key: unknown
  deleted: boolean
  reinsert: boolean
  value: unknown
}

export type JournalDraftAccess = {
  wrap: <T>(value: T, changed: () => void, path: string) => T
  assign: (value: unknown) => void
  finish: (value: unknown) => unknown
  defer: (apply: () => void) => void
}

export class JournalDraftMap<K, V> extends Map<K, V> {
  private readonly writes = new Map<K, V>()
  private readonly removed = new Set<K>()
  private readonly inserted = new Set<K>()
  private readonly touched = new Set<K>()

  constructor(
    private readonly source: Map<K, V>,
    private readonly access: JournalDraftAccess,
    private readonly changed: () => void,
    readonly path: string
  ) {
    super()
  }

  override get size(): number {
    return this.source.size - this.removed.size + this.inserted.size
  }

  override has(key: K): boolean {
    return this.inserted.has(key) || (!this.removed.has(key) && this.source.has(key))
  }

  override get(key: K): V | undefined {
    if (!this.has(key)) {
      return undefined
    }
    const value = this.writes.has(key) ? this.writes.get(key) : this.source.get(key)
    return this.access.wrap(value, () => this.touch(key), `${this.path}.*`)
  }

  override set(key: K, value: V): this {
    if (!this.has(key)) {
      this.inserted.add(key)
      this.touched.delete(key)
    }
    this.access.assign(value)
    this.writes.set(key, value)
    this.touch(key)
    return this
  }

  override delete(key: K): boolean {
    if (!this.has(key)) {
      return false
    }
    if (this.source.has(key)) {
      this.removed.add(key)
    }
    this.inserted.delete(key)
    this.writes.delete(key)
    this.touch(key)
    return true
  }

  override clear(): void {
    for (const key of this.keys()) {
      this.delete(key)
    }
  }

  override *keys(): MapIterator<K> {
    for (const key of this.source.keys()) {
      if (!this.removed.has(key)) {
        yield key
      }
    }
    yield* this.inserted
  }

  override *values(): MapIterator<V> {
    for (const key of this.keys()) {
      // SAFETY: keys() yields only present entries, including entries with an undefined value.
      yield this.get(key) as V
    }
  }

  override *entries(): MapIterator<[K, V]> {
    for (const key of this.keys()) {
      // SAFETY: keys() yields only present entries, including entries with an undefined value.
      yield [key, this.get(key) as V]
    }
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }

  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) {
      callback.call(thisArg, value, key, this)
    }
  }

  changes(): JournalEntryChange[] {
    return [...this.touched].map((key) => ({
      path: this.path,
      key,
      deleted: !this.has(key),
      reinsert: this.inserted.has(key),
      value: this.get(key)
    }))
  }

  finish(): Map<K, V> {
    const changes = this.changes().map((entry) => ({
      ...entry,
      // SAFETY: finishing a draft preserves the type of its collection value.
      value: this.access.finish(entry.value) as V,
      // SAFETY: changes() returns keys from this map.
      key: entry.key as K
    }))
    this.access.defer(() => {
      for (const entry of changes) {
        if (entry.deleted || entry.reinsert) {
          this.source.delete(entry.key)
        }
        if (!entry.deleted) {
          this.source.set(entry.key, entry.value)
        }
      }
    })
    return this.source
  }

  private touch(key: K): void {
    this.touched.add(key)
    this.changed()
  }
}

export class JournalDraftSet<T> extends Set<T> {
  private readonly removed = new Set<T>()
  private readonly inserted = new Set<T>()
  private readonly touched = new Set<T>()

  constructor(
    private readonly source: Set<T>,
    private readonly access: JournalDraftAccess,
    private readonly changed: () => void,
    readonly path: string
  ) {
    super()
  }

  override get size(): number {
    return this.source.size - this.removed.size + this.inserted.size
  }
  override has(value: T): boolean {
    return this.inserted.has(value) || (!this.removed.has(value) && this.source.has(value))
  }
  override add(value: T): this {
    if (!this.has(value)) {
      this.inserted.add(value)
      this.touched.delete(value)
      this.touched.add(value)
      this.changed()
    }
    return this
  }
  override delete(value: T): boolean {
    if (!this.has(value)) {
      return false
    }
    if (this.source.has(value)) {
      this.removed.add(value)
    }
    this.inserted.delete(value)
    this.touched.add(value)
    this.changed()
    return true
  }
  override clear(): void {
    for (const value of this) {
      this.delete(value)
    }
  }
  override *values(): SetIterator<T> {
    for (const value of this.source) {
      if (!this.removed.has(value)) {
        yield value
      }
    }
    yield* this.inserted
  }
  override keys(): SetIterator<T> {
    return this.values()
  }
  override *entries(): SetIterator<[T, T]> {
    for (const value of this.values()) {
      yield [value, value]
    }
  }
  override [Symbol.iterator](): SetIterator<T> {
    return this.values()
  }
  override forEach(callback: (value: T, key: T, set: Set<T>) => void, thisArg?: unknown): void {
    for (const value of this) {
      callback.call(thisArg, value, value, this)
    }
  }
  changes(): JournalEntryChange[] {
    return [...this.touched].map((key) => ({
      path: this.path,
      key,
      deleted: !this.has(key),
      reinsert: this.inserted.has(key),
      value: key
    }))
  }
  finish(): Set<T> {
    const changes = this.changes()
    this.access.defer(() => {
      for (const entry of changes) {
        // SAFETY: changes() returns keys from this set.
        const value = entry.key as T
        if (entry.deleted || entry.reinsert) {
          this.source.delete(value)
        }
        if (!entry.deleted) {
          this.source.add(value)
        }
      }
    })
    return this.source
  }
}
