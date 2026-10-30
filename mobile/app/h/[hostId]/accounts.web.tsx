import { useLocalSearchParams } from 'expo-router'
import { MobileAccountsScreen } from '../../../src/accounts/MobileAccountsScreen'
import { mobileEditionSupports } from '../../../src/mobile-edition'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileAccountsRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  if (!mobileEditionSupports('agentPicker')) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileAccountsScreen />
}
