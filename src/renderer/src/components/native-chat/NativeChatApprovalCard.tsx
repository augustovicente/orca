import { SecuritySurface } from '@/components/ui/security-surface'
import { useRef, useState } from 'react'
import { ChevronRight, ShieldQuestion, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { approvalBlockedPathToShow } from '../../../../shared/agent-session-approval-blocked-path'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject
} from '../../../../shared/agent-session-approval-subject'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import type { ChatApproval } from '../../../../shared/native-chat-interactive-prompt'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { NativeChatExpandable } from './NativeChatExpandable'
import {
  nativeChatUsesPlainLanguage,
  plainToolActivityDetailsLabel
} from './native-chat-plain-language'
import { plainChatApproval } from './native-chat-plain-approval'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Deliver the option's transport-specific response token. */
  onChoose: (option: string) => void
  /** Cancel the active provider turn while this card owns the composer region. */
  onCancel?: () => void
  /** Without `onCancel`: fold the card to a strip and give the input back, writing nothing. */
  onCollapse?: () => void
  /** A choice is being delivered: the options wait for its answer. */
  isSubmitting?: boolean
  shouldFocus?: boolean
  /** A plan body renders as markdown; these make its file paths clickable. */
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}

/** PTY options are literal replies; structured options are journal ids. Style the first option as primary. */
export function NativeChatApprovalCard({
  approval,
  onChoose,
  onCancel,
  onCollapse,
  isSubmitting = false,
  shouldFocus = false,
  onLinkClick,
  allowFileUriLinks = false
}: NativeChatApprovalCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const neededPath = approvalBlockedPathToShow(approval)
  // A newer Orca's subject: its detail is shown, and only the card's cancel answers.
  const newerSubject = isNewerApprovalSubject(approval.subject)
  const planSubject = isPlanApprovalSubject(approval.subject)
  const plainLanguage = nativeChatUsesPlainLanguage()
  const plainView = plainLanguage ? plainChatApproval(approval) : null
  const headline = plainView?.headline ?? approval.title
  const options = plainView?.options ?? approval.options
  const hasContext = Boolean(
    approval.description ||
    approval.decisionReason ||
    neededPath ||
    approval.subject ||
    approval.detail
  )
  // The plain card keeps provider words, paths, and command syntax behind one disclosure.
  const hasTechnicalContext = Boolean(
    approval.description ||
    approval.decisionReason ||
    neededPath ||
    (!planSubject && approval.detail)
  )
  const [technicalOpen, setTechnicalOpen] = useState(false)
  useNativeChatPromptCardFocus(cardRef, shouldFocus)
  const escape = onCancel ?? (isSubmitting ? undefined : onCollapse)
  const showsContext = plainLanguage
    ? planSubject || hasTechnicalContext || newerSubject
    : hasContext

  return (
    <SecuritySurface>
      <div className="min-h-0 shrink overflow-hidden bg-chat-canvas">
        <div className="mx-auto flex h-full min-h-0 max-h-full w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4">
          <div
            ref={cardRef}
            data-native-chat-prompt-card-focus={shouldFocus || undefined}
            data-native-chat-approval-card="true"
            role="group"
            aria-label={headline}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && escape) {
                event.preventDefault()
                event.stopPropagation()
                escape()
              }
            }}
            className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-hidden rounded-lg border border-input bg-card px-4 py-3 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex shrink-0 items-start gap-2">
              <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-sm font-semibold text-foreground">
                  {headline}
                </p>
              </div>
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label={translate('components.native-chat.approval.cancel', 'Cancel')}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-4" />
                </button>
              ) : onCollapse ? (
                <NativeChatPromptCollapseToggle
                  expanded
                  disabled={isSubmitting}
                  onToggle={onCollapse}
                />
              ) : null}
            </div>
            {showsContext ? (
              plainLanguage ? (
                <div
                  data-native-chat-approval-content="true"
                  data-native-chat-approval-plain="true"
                  tabIndex={0}
                  className="min-h-0 max-h-72 shrink space-y-2 overflow-auto text-sm text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {isPlanApprovalSubject(approval.subject) ? (
                    <div data-native-chat-approval-plan="true">
                      <NativeChatMarkdown
                        content={approval.subject.text}
                        variant="document"
                        className="text-sm text-chat-foreground"
                        renderCodeBlock={NativeChatCodeBlock}
                        {...(onLinkClick ? { onLinkClick } : {})}
                        allowFileUriLinks={allowFileUriLinks}
                        linkifyFilePaths={onLinkClick !== undefined}
                      />
                      {approval.subject.filePath ? (
                        <p className="mt-2 break-all">
                          <span className="font-medium text-foreground">
                            {translate('components.native-chat.approval.plan.file', 'Plan file')}
                            :{' '}
                          </span>
                          <span className="font-mono">{approval.subject.filePath}</span>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {hasTechnicalContext ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setTechnicalOpen(!technicalOpen)}
                        aria-expanded={technicalOpen}
                        className="flex min-h-6 w-fit items-center gap-1 rounded-md text-left font-sans text-xs text-chat-foreground-faint transition-colors hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn(
                            'size-3 shrink-0 transition-transform motion-reduce:transition-none',
                            technicalOpen && 'rotate-90'
                          )}
                        />
                        {plainToolActivityDetailsLabel()}
                      </button>
                      <NativeChatExpandable open={technicalOpen}>
                        <div className="space-y-2 pt-1">
                          {approval.description ? (
                            <p className="whitespace-pre-wrap break-words">
                              {approval.description}
                            </p>
                          ) : null}
                          {approval.decisionReason ? (
                            <p className="whitespace-pre-wrap break-words">
                              <span className="font-medium text-foreground">
                                {translate('components.native-chat.approval.reason', 'Reason')}
                                :{' '}
                              </span>
                              {approval.decisionReason}
                            </p>
                          ) : null}
                          {neededPath ? (
                            <p className="break-words">
                              <span className="font-medium text-foreground">
                                {translate(
                                  'components.native-chat.approval.needsAccess',
                                  'Needs access to'
                                )}
                                :{' '}
                              </span>
                              <span className="font-mono">{neededPath}</span>
                            </p>
                          ) : null}
                          {!planSubject && approval.detail ? (
                            <div
                              data-native-chat-approval-detail="true"
                              data-native-chat-code-content
                              className="whitespace-pre-wrap break-words font-mono text-chat-code"
                            >
                              {approval.detail}
                            </div>
                          ) : null}
                        </div>
                      </NativeChatExpandable>
                    </>
                  ) : null}
                  {newerSubject ? (
                    <p data-native-chat-approval-needs-newer-orca="true" className="break-words">
                      {translate(
                        'components.native-chat.approval.needsNewerOrca',
                        'This request needs a newer version of Orca.'
                      )}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div
                  data-native-chat-approval-content="true"
                  tabIndex={0}
                  className="min-h-0 max-h-72 shrink space-y-2 overflow-auto text-sm text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {approval.description ? (
                    <p className="whitespace-pre-wrap break-words">{approval.description}</p>
                  ) : null}
                  {approval.decisionReason ? (
                    <p className="whitespace-pre-wrap break-words">
                      <span className="font-medium text-foreground">
                        {translate('components.native-chat.approval.reason', 'Reason')}:{' '}
                      </span>
                      {approval.decisionReason}
                    </p>
                  ) : null}
                  {neededPath ? (
                    <p className="break-words">
                      <span className="font-medium text-foreground">
                        {translate(
                          'components.native-chat.approval.needsAccess',
                          'Needs access to'
                        )}
                        :{' '}
                      </span>
                      <span className="font-mono">{neededPath}</span>
                    </p>
                  ) : null}
                  {isPlanApprovalSubject(approval.subject) ? (
                    <div data-native-chat-approval-plan="true">
                      <NativeChatMarkdown
                        content={approval.subject.text}
                        variant="document"
                        className="text-sm text-chat-foreground"
                        renderCodeBlock={NativeChatCodeBlock}
                        {...(onLinkClick ? { onLinkClick } : {})}
                        allowFileUriLinks={allowFileUriLinks}
                        linkifyFilePaths={onLinkClick !== undefined}
                      />
                      {approval.subject.filePath ? (
                        <p className="mt-2 break-all">
                          <span className="font-medium text-foreground">
                            {translate('components.native-chat.approval.plan.file', 'Plan file')}
                            :{' '}
                          </span>
                          <span className="font-mono">{approval.subject.filePath}</span>
                        </p>
                      ) : null}
                    </div>
                  ) : approval.detail ? (
                    <div
                      data-native-chat-approval-detail="true"
                      data-native-chat-code-content
                      className="whitespace-pre-wrap break-words font-mono text-chat-code"
                    >
                      {approval.detail}
                    </div>
                  ) : null}
                  {newerSubject ? (
                    <p data-native-chat-approval-needs-newer-orca="true" className="break-words">
                      {translate(
                        'components.native-chat.approval.needsNewerOrca',
                        'This request needs a newer version of Orca.'
                      )}
                    </p>
                  ) : null}
                </div>
              )
            ) : null}
            <div data-native-chat-approval-actions="true" className="flex shrink-0 flex-wrap gap-2">
              {options.map((opt, i) => (
                <button
                  key={`${opt.label}-${i}`}
                  type="button"
                  disabled={newerSubject || isSubmitting}
                  onClick={() => onChoose(opt.send)}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                    i === 0
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SecuritySurface>
  )
}
