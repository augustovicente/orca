import type { CommandSpec } from '../args'
import { LOCAL_COMMAND_FLAGS } from '../args'
import { PLUGIN_TEMPLATE_NAMES } from '../plugin-authoring/plugin-template-names'

const TEMPLATES = PLUGIN_TEMPLATE_NAMES.join('|')

const EXIT_CODES_NOTE =
  'Exit codes: 0 ok, 1 error, 2 the plugin is invalid (plugin_invalid), 3 approval is needed (approval_required or approval_stale).'

export const PLUGIN_AUTHORING_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'create'],
    summary: 'Scaffold a new Orca plugin from a template',
    usage: `orca plugin create <dir> --template <${TEMPLATES}> [--publisher <name>] [--id <id>] [--name <display name>] [--json]`,
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'dir', 'template', 'publisher', 'id', 'name'],
    positionalArgs: ['dir'],
    notes: [
      'Writes into a new or empty folder (a .git folder is allowed) and never overwrites; it runs no Git, package install or plugin code.',
      'theme, terminal-theme, icon-theme, syntax and language-pack are content only: loading them never needs approval.',
      'editor and panel run code in a sandboxed frame: loading them prints the access they ask for and needs --approve.',
      'The id defaults to the folder name. Set --publisher to the GitHub or GitLab owner of the repository you will publish from.',
      'Runs on the machine that runs this command; it does not reach the Orca app.',
      EXIT_CODES_NOTE
    ],
    examples: [
      'orca plugin create ./dusk-theme --template theme --publisher acme',
      'orca plugin create ./notes-editor --template editor --publisher acme --name "Notes" --json'
    ]
  },
  {
    path: ['plugin', 'validate'],
    summary: 'Check a plugin folder, manifest or catalog the way Orca will load it',
    usage: 'orca plugin validate <dir|orca-plugin.json|orca-catalog.json> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'Runs the strict checks of `pnpm validate:plugin`: manifest, limits, execution profile, every theme, icon, syntax and translation file, and every file the manifest names.',
      'Offline; never runs plugin code. The result says whether loading needs --approve and what it would grant.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin validate .', 'orca plugin validate ./dusk-theme --json']
  },
  {
    path: ['plugin', 'inspect'],
    summary: 'Show what a plugin folder contributes, the access it asks for, and its content hash',
    usage: 'orca plugin inspect <dir> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'path'],
    positionalArgs: ['path'],
    notes: [
      'Validates like `orca plugin validate`, then hashes the files the way install does.',
      'Use it to show your user exactly what a plugin would be allowed to do before loading it.',
      EXIT_CODES_NOTE
    ],
    examples: ['orca plugin inspect ./notes-editor --json']
  }
]
