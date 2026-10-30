import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'

// Why optional: only `approval_required` hands it out; older hosts strip it and older callers omit it.
const approvalFingerprintParam = z.string().min(1).max(128).optional()

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean(),
  approvalFingerprint: approvalFingerprintParam
})

/** Over RPC, approval needs the explicit CLI fingerprint; the desktop review dialog uses IPC. */
export const PluginRpcConsentParams = z
  .object({
    pluginKey: z.string().min(1),
    reviewedFingerprint: z.string().min(1).max(256).optional(),
    decision: z.enum(['approve', 'keep-disabled']),
    approvalFingerprint: approvalFingerprintParam
  })
  .strip()

export const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()
