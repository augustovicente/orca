import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function getLocalBuildIdentity() {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim()
  return { commit, version: `${packageJson.version}-local.${Date.now()}.${commit}` }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getLocalBuildIdentity()
  console.log(`[build:windows] local update version ${identity.version}`)
  execSync(
    'pnpm exec electron-builder --config config/electron-builder.config.cjs --win --publish never',
    {
      env: {
        ...process.env,
        ORCA_APP_NAME: 'contadorca',
        ORCA_APP_ID: 'com.contadorca.app',
        ORCA_BUILD_COMMIT: identity.commit,
        ORCA_LOCAL_BUILD_VERSION: identity.version
      },
      stdio: 'inherit',
      shell: true
    }
  )
}
