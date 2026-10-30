# contadorca Release Guide

## Build

```bash
ORCA_EDITION=contadorca ORCA_APP_NAME=contadorca ORCA_APP_ID=com.contadorca.app pnpm build:release
pnpm build:whitelabel
```

`ORCA_EDITION=contadorca` is what removes the development surface; without it the build is full Orca.
See [`docs/plans/whitelabel-edition.md`](../docs/plans/whitelabel-edition.md).

## Branding assets

Replace icons in `resources/` (icon.png, app-icons) before packaging. The builder uses `resources/build/icon.png`.

## Skills

Accounting skills live in `whitelabel/skills/` and are merged into `skills/` by `apply.mjs` before manifest generation. Run `pnpm verify:bundled-skill-guides` and `pnpm verify:skill-bundle-manifest`.

## Settings seed

On first run, `whitelabel-seed` applies `profile.json` overrides (OpenCode-only, chat-first, Portuguese UI, hidden dev UI). Guarded by `whitelabelAppliedVersion`.

## Distribution

Public release with auto-update channel. Configure update URL in electron-builder config before publishing.
EOF
echo done
