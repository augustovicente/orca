/** An export a release module must define; callers name the shape they use, so a changed one fails the test. */
export function releaseModuleExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the release module exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: release modules are typed unknown; a missing export throws above and a reshaped one fails its caller.
  return value as T
}
