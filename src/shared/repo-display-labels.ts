import { getRepoExecutionHostId, type ExecutionHostId } from './execution-host'

type RepoDisplayLabelItem = {
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

// Scope labels by execution host: same-path local/SSH/runtime repos must not overwrite one another’s labels.
export function getRepoDisplayLabelKey(
  item: Pick<RepoDisplayLabelItem, 'path' | 'connectionId' | 'executionHostId'>
): string {
  return `${getRepoExecutionHostId(item)}::${item.path}`
}

function normalizePathSegments(path: string): string[] {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').split('/').filter(Boolean)
}

function labelForDepth(
  segments: readonly string[],
  displayName: string,
  depth: number,
  realLeaf = false
): string {
  const suffix = segments.slice(Math.max(0, segments.length - depth))
  if (suffix.length === 0) {
    return displayName
  }
  if (!realLeaf) {
    suffix[suffix.length - 1] = displayName
  }
  return suffix.join('/')
}

function hasDuplicateLabels(labels: readonly string[]): boolean {
  return new Set(labels).size !== labels.length
}

export function getRepoDisplayLabelsByPath(
  items: readonly RepoDisplayLabelItem[]
): Map<string, string> {
  const labels = new Map<string, string>()
  const itemsByHostAndName = new Map<string, { item: RepoDisplayLabelItem; segments: string[] }[]>()

  for (const item of items) {
    const displayName = item.displayName || item.path
    labels.set(getRepoDisplayLabelKey(item), displayName)
    // Host labels already distinguish projects on different machines.
    const collisionKey = JSON.stringify([getRepoExecutionHostId(item), displayName])
    const colliding = itemsByHostAndName.get(collisionKey) ?? []
    colliding.push({ item: { ...item, displayName }, segments: normalizePathSegments(item.path) })
    itemsByHostAndName.set(collisionKey, colliding)
  }

  for (const collidingItems of itemsByHostAndName.values()) {
    if (collidingItems.length < 2) {
      continue
    }
    const maxDepth = Math.max(...collidingItems.map(({ segments }) => segments.length))
    let depth = 1
    let nextLabels = collidingItems.map(({ item, segments }) =>
      labelForDepth(segments, item.displayName, depth)
    )
    while (depth < maxDepth && hasDuplicateLabels(nextLabels)) {
      depth += 1
      nextLabels = collidingItems.map(({ item, segments }) =>
        labelForDepth(segments, item.displayName, depth)
      )
    }
    if (hasDuplicateLabels(nextLabels)) {
      depth = 1
      nextLabels = collidingItems.map(({ item, segments }) =>
        labelForDepth(segments, item.displayName, depth, true)
      )
      while (depth < maxDepth && hasDuplicateLabels(nextLabels)) {
        depth++
        nextLabels = collidingItems.map(({ item, segments }) =>
          labelForDepth(segments, item.displayName, depth, true)
        )
      }
    }
    collidingItems.forEach(({ item }, index) => {
      labels.set(getRepoDisplayLabelKey(item), nextLabels[index] ?? item.displayName)
    })
  }

  return labels
}
