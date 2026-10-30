import { translate } from '@/i18n/i18n'
import { openSupportEmail, supportMailtoHref } from '@/lib/support-link'

/** The toast's words: a plain customer headline, or the host's message in the developer edition. */
export function TerminalErrorToastMessage({
  plainHeadline,
  displayError,
  showDaemonRestart,
  showIssueLink,
  showSupportLink,
  showClientEnvironment,
  footer,
  technicalOpen,
  onToggleTechnical
}: {
  /** Null in the full edition, which shows the host's own words up front. */
  plainHeadline: string | null
  displayError: string
  showDaemonRestart: boolean
  showIssueLink: boolean
  showSupportLink: boolean
  showClientEnvironment: boolean
  footer: string
  technicalOpen: boolean
  onToggleTechnical: () => void
}): React.JSX.Element {
  const plainLanguage = plainHeadline !== null
  return (
    <span style={{ minWidth: 0 }}>
      {plainLanguage ? (
        <>
          <span style={{ fontFamily: 'inherit', fontWeight: 600 }}>{plainHeadline}</span>
          {displayError ? (
            <>
              {'\n'}
              <button
                type="button"
                onClick={onToggleTechnical}
                aria-expanded={technicalOpen}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  font: 'inherit',
                  padding: 0,
                  textDecoration: 'underline'
                }}
              >
                {translate('contadorca.chat.details', 'Detalhes técnicos')}
              </button>
              {technicalOpen ? <span>{`\n${displayError}`}</span> : null}
            </>
          ) : null}
        </>
      ) : (
        displayError
      )}
      {showDaemonRestart && (!plainLanguage || technicalOpen) ? (
        <>
          {'\n'}
          {translate(
            'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
            'Restart the terminal daemon from here to clear stale daemon state.'
          )}
        </>
      ) : showIssueLink ? (
        <>
          {'\n'}
          {translate(
            'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
            'If this persists, please'
          )}{' '}
          <a
            href="https://github.com/stablyai/orca/issues"
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
              'file an issue'
            )}
          </a>
          .
        </>
      ) : showSupportLink ? (
        <>
          {'\n'}
          {translate('contadorca.chat.failure.supportLead', 'Se precisar de ajuda,')}{' '}
          <a
            href={supportMailtoHref()}
            onClick={(event) => {
              event.preventDefault()
              openSupportEmail()
            }}
            style={{ color: 'inherit', textDecoration: 'underline' }}
          >
            {translate('contadorca.chat.failure.support', 'falar com suporte')}
          </a>
          .
        </>
      ) : null}
      {showClientEnvironment && footer && (!plainLanguage || technicalOpen)
        ? `\n\n${footer}`
        : null}
    </span>
  )
}
