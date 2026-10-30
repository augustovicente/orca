---
name: program-automation
description: >-
  Drive legacy desktop accounting programs via GUI automation (computer-use)
  when no API/CLI exists. Use for specific accounting software workflows.
---

# Program Automation

When a program has no API, use the computer-use skill of o app to:

- Launch the program.
- Navigate menus via accessibility tree.
- Fill forms and trigger exports.
- Capture screenshots for verification.

Rules:

- Prefer keyboard shortcuts over mouse when possible.
- Add waits after actions that trigger dialogs.
- Verify results via screenshot before proceeding.
- Keep a log of steps for auditability.
  EOF
