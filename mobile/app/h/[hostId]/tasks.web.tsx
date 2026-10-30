import { useLocalSearchParams } from 'expo-router'
import { mobileEditionSupports } from '../../../src/mobile-edition'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'
import { firstParam } from '../../../src/navigation/route-param-reader'
import { MobileTasksScreen } from '../../../src/tasks/MobileTasksScreen'

// Render screen directly: native sibling imports a shell module that throws in browsers, and manifest imports every route.
export default function MobileTasksRoute() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)

  if (!mobileEditionSupports('taskProviders')) {
    return <PageRouteUnavailableScreen hostId={hostId} />
  }
  return <MobileTasksScreen />
}
