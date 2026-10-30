import { Redirect, useLocalSearchParams } from 'expo-router'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { mobileEditionSupports } from '../../../../src/mobile-edition'

// Redirect legacy deep links to Source Control’s PR tab; wide SessionDockColumn opens that hub directly with initialTab="pr".
export default function PrRedirect() {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    name?: string | string[]
    origin?: string | string[]
    executionHost?: string | string[]
  }>()
  if (!mobileEditionSupports('hostedReview')) {
    return <PageRouteUnavailableScreen hostId={firstParam(params.hostId) ?? ''} />
  }
  return (
    <Redirect
      href={{
        pathname: '/h/[hostId]/source-control/[worktreeId]',
        params: {
          hostId: firstParam(params.hostId),
          worktreeId: firstParam(params.worktreeId),
          name: firstParam(params.name),
          origin: firstParam(params.origin),
          executionHost: firstParam(params.executionHost),
          tab: 'pr'
        }
      }}
    />
  )
}
