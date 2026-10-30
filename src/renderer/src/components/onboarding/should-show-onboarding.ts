import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { editionSupports } from '../../../../shared/edition'

// Keep the visibility gate separate so App can lazy-load the flow without eagerly importing its chunk.
export function shouldShowOnboarding(onboarding: OnboardingState | null): boolean {
  if (!editionSupports('onboarding')) {
    return false
  }
  return onboarding !== null && onboarding.closedAt === null
}
