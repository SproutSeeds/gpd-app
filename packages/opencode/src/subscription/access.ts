import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"
import type { RuntimeID } from "./types"

export function createSubscriptionAccess(directory: string) {
  const blocked = new Set<RuntimeID>()
  const active = new Map<RuntimeID, Set<AbortController>>()
  const writes = new Map<RuntimeID, Promise<void>>()
  const revisions = new Map<RuntimeID, number>()
  const disconnected = () => new Error("This provider is disconnected from GPD. Reconnect it in AI connections.")

  async function enabled(id: RuntimeID) {
    if (blocked.has(id)) return false
    try {
      const value = JSON.parse(await readFile(path.join(directory, `${id}.json`), "utf8"))
      if (typeof value.enabled !== "boolean") throw new Error("Invalid connection preference")
      return value.enabled && !blocked.has(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return !blocked.has(id)
      throw new Error("GPD could not read this connection preference. Reconnect the provider to try again.")
    }
  }

  function setEnabled(id: RuntimeID, value: boolean) {
    const revision = (revisions.get(id) ?? 0) + 1
    revisions.set(id, revision)
    // Stop owned work immediately, before waiting for persistence. Never call
    // runtime logout or modify credentials shared with another application.
    if (!value) {
      blocked.add(id)
      for (const controller of active.get(id) ?? []) controller.abort(disconnected())
    }
    const pending = (writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(directory, { recursive: true })
        const target = path.join(directory, `${id}.json`)
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify({ enabled: value }), { mode: 0o600 })
          await rename(temporary, target)
          if (value && revisions.get(id) === revision) blocked.delete(id)
        } finally {
          await rm(temporary, { force: true })
        }
      })
    writes.set(id, pending)
    return pending
  }

  async function run<T>(id: RuntimeID, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController()
    const tasks = active.get(id) ?? new Set<AbortController>()
    active.set(id, tasks)
    tasks.add(controller)
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      if (!(await enabled(id))) throw disconnected()
      combined.throwIfAborted()
      return await work(combined)
    } finally {
      tasks.delete(controller)
      if (!tasks.size) active.delete(id)
    }
  }

  return { enabled, setEnabled, run }
}

export const subscriptionAccess = createSubscriptionAccess(path.join(Global.Path.state, "subscription-access"))
