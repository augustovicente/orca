import { useLocalSearchParams } from 'expo-router'
import { withWorkspaceRoute } from '../../../../src/navigation/workspace-route'
import { firstParam } from '../../../../src/navigation/route-param-reader'
import { mobileEditionSupports } from '../../../../src/mobile-edition'
import { PageRouteUnavailableScreen } from '../../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { MobileDiffReviewRouteScreen } from '../../../../src/session/MobileDiffReviewRouteScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default withWorkspaceRoute(function MobileDiffReviewScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  if (!mobileEditionSupports('sourceControl')) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileDiffReviewRouteScreen />
})
