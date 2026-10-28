import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const resourcesDir = path.join(root, 'resources')

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    return false
  }
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDir(s, d)
    } else {
      fs.copyFileSync(s, d)
    }
  }
  return true
}

const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  console.log('[whitelabel] check OK')
  process.exit(0)
}

const skillsSrc = path.join(import.meta.dirname, 'skills')
const skillsDst = path.join(root, 'skills')
if (fs.existsSync(skillsSrc)) {
  copyDir(skillsSrc, skillsDst)
  console.log('[whitelabel] skills merged into', skillsDst)
}

const profileSrc = path.join(import.meta.dirname, 'profile.json')
const profileDstDir = path.join(resourcesDir, 'whitelabel')
if (fs.existsSync(profileSrc)) {
  fs.mkdirSync(profileDstDir, { recursive: true })
  fs.copyFileSync(profileSrc, path.join(profileDstDir, 'profile.json'))
  console.log('[whitelabel] profile shipped to', profileDstDir)
}

console.log('[whitelabel] apply complete')
