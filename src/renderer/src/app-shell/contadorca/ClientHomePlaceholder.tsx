/**
 * Temporary placeholder for the Contadorca client workspace (W3).
 *
 * Contract (minimal, intentionally stable for the follow-up shell workstream):
 * - No props. Renders the main workspace slot content for the Contadorca edition
 *   until the real client shell replaces this file.
 * - Follow-up workstream may replace this component's implementation, but should keep
 *   the default export and the no-props signature so call sites stay untouched.
 * - Do not add a new `TopLevelView` value for this; it renders inside the existing
 *   `terminal` view slot resolved by `resolveTopLevelView`.
 */
export function ClientHomePlaceholder(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
      <p>Client workspace</p>
    </div>
  )
}

export default ClientHomePlaceholder
