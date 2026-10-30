import { BRAND } from '../../../shared/brand'

/** The branded support address; the plain card links to it instead of upstream community surfaces. */
export function supportMailtoHref(): string {
  return `mailto:${BRAND.supportEmail}`
}

/** Main's shell bridge accepts `mailto:` for the branded edition; web falls back to the anchor. */
export function openSupportEmail(): void {
  const href = supportMailtoHref()
  const shell = window.api?.shell
  if (shell) {
    void shell.openUrl(href)
    return
  }
  window.location.href = href
}
