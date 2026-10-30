import { join } from 'node:path'
import { vi } from 'vitest'
import type * as Passthrough from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type {
  addEnvironmentFromPairingCode,
  updateEnvironmentFromPairingCode
} from '../../../shared/runtime-environment-store'
import type { createRuntimeEnvironmentMobileRelayHosts } from '../../ipc/runtime-environments/runtime-environment-mobile-relay-hosts'
import type { invalidateRuntimeEnvironmentTransport } from '../../ipc/runtime-environments/runtime-environments'
import type { MobileDesktopRelay } from '../mobile-desktop-relay/mobile-desktop-relay'
import type { observationRuntime } from './push-rfp1-source-runtime.test-fixture'
import type { observationNativePorts } from './push-rfp1-renderer.test-fixture'
import { record } from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

type Runtime = Awaited<ReturnType<typeof observationRuntime>>
export type ObservationCapture = (value: Record<string, unknown>) => void

export function observationRelayWire(root: string, pin: string, capture: ObservationCapture) {
  const entered = Promise.withResolvers<void>()
  let hold = false
  const held: (() => void)[] = []
  const path = join(root, 'src/shared/remote-runtime/remote-runtime-passthrough-socket.ts')
  vi.doMock(path, async (importOriginal) => {
    const original = await importOriginal<typeof Passthrough>()
    return {
      ...original,
      openRemoteRuntimePassthroughSocket: async (
        ...[connection, capabilities, callbacks, options]: Parameters<
          typeof original.openRemoteRuntimePassthroughSocket
        >
      ) => {
        const methods = new Map<string, string>()
        const socket = await original.openRemoteRuntimePassthroughSocket(
          connection,
          capabilities,
          {
            ...callbacks,
            onText: (plaintext) => {
              const frame = record(JSON.parse(plaintext))
              capture({
                boundary: 'downstream-encoded-reply-before-C',
                pin,
                endpoint: connection.endpoint,
                plaintext,
                frame
              })
              if (hold && typeof frame.id === 'string' && methods.get(frame.id) === 'status.get') {
                hold = false
                held.push(() => callbacks.onText(plaintext))
                entered.resolve()
              } else {
                callbacks.onText(plaintext)
              }
            }
          },
          options
        )
        return {
          close: socket.close,
          send: (plaintext: string) => {
            const frame = record(JSON.parse(plaintext))
            if (typeof frame.id === 'string' && typeof frame.method === 'string') {
              methods.set(frame.id, frame.method)
            }
            capture({
              boundary: 'C-rewritten-request-to-downstream',
              pin,
              endpoint: connection.endpoint,
              plaintext,
              frame
            })
            return socket.send(plaintext)
          }
        }
      }
    }
  })
  return {
    holdStatus: () => {
      hold = true
      return entered.promise
    },
    release: () => {
      hold = false
      for (const send of held.splice(0)) {
        send()
      }
    }
  }
}

export async function observationRelay(
  actor: Runtime,
  native: ReturnType<typeof observationNativePorts>,
  capture: ObservationCapture
) {
  return native.run(actor.profile, async () => {
    const add = await actor.load<typeof addEnvironmentFromPairingCode>(
      'src/shared/runtime-environment-store.ts',
      'addEnvironmentFromPairingCode'
    )
    const update = await actor.load<typeof updateEnvironmentFromPairingCode>(
      'src/shared/runtime-environment-store.ts',
      'updateEnvironmentFromPairingCode'
    )
    const createHosts = await actor.load<typeof createRuntimeEnvironmentMobileRelayHosts>(
      'src/main/ipc/runtime-environments/runtime-environment-mobile-relay-hosts.ts',
      'createRuntimeEnvironmentMobileRelayHosts'
    )
    const invalidate = await actor.load<typeof invalidateRuntimeEnvironmentTransport>(
      'src/main/ipc/runtime-environments/runtime-environments.ts',
      'invalidateRuntimeEnvironmentTransport'
    )
    const Relay = await actor.load<typeof MobileDesktopRelay>(
      'src/main/runtime/mobile-desktop-relay/mobile-desktop-relay.ts',
      'MobileDesktopRelay'
    )
    const forward = Relay.prototype.forward
    const observer = vi.spyOn(Relay.prototype, 'forward').mockImplementation(function (
      this: MobileDesktopRelay,
      phone,
      environmentId,
      request,
      frame
    ) {
      capture({
        boundary: 'phone-request-before-C-rewrite',
        pin: actor.checkout.commit,
        callerPairedDeviceId: phone.deviceId,
        environmentId,
        request,
        plaintext: frame,
        frame: record(JSON.parse(frame))
      })
      return forward.call(this, phone, environmentId, request, frame)
    })
    actor.server.setMobileDesktopRelayHosts(createHosts())
    return {
      close: () => observer.mockRestore(),
      pair: (target: Runtime) =>
        native.run(
          actor.profile,
          () =>
            add(actor.profile, {
              name: 'Server',
              pairingCode: target.offer('runtime', actor.profile)
            }).environment
        ),
      ...actor.wire,
      replace: async (environmentId: string, target: Runtime) =>
        native.run(actor.profile, async () => {
          const next = update(actor.profile, environmentId, {
            pairingCode: target.offer('runtime', actor.profile),
            runtimeId: target.runtime.getRuntimeId()
          })
          await invalidate(environmentId)
          capture({
            boundary: 'real-saved-repair-and-invalidation',
            pin: actor.checkout.commit,
            environmentId,
            pairingRevision: next.pairingRevision,
            runtimeId: next.runtimeId
          })
        })
    }
  })
}
