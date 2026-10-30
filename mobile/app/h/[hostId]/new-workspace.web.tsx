import { NewWorkspacePageScreen } from '../../../src/new-workspace/NewWorkspacePageScreen'
import { mobileEditionSupports } from '../../../src/mobile-edition'
import { PageRouteUnavailableScreen } from '../../../src/mobile-web-shell/PageRouteUnavailableScreen'

/** The page's Create Workspace route, which Home's `/new-workspace` overlay opens in its shell. */
export default function NewWorkspaceRoute() {
  if (!mobileEditionSupports('gitWorkflows')) {
    return <PageRouteUnavailableScreen hostId="" />
  }
  return <NewWorkspacePageScreen />
}
