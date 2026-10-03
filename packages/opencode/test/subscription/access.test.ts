import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { createSubscriptionAccess } from "../../src/subscription/access"
import { createConnections } from "../../src/subscription/connections"
import { SubscriptionRoutes } from "../../src/server/instance/subscription"
import { runtimeIDs, type Connection, type RuntimeID } from "../../src/subscription/types"

function account(id: RuntimeID): Connection {
  return {
    id,
    name: id,
    installed: true,
    authenticated: true,
    models: [{ id: "fixture", name: "Fixture", efforts: [] }],
    usage: { ready: true, reason: "Included" },
    checkedAt: Date.now(),
  }
}
const probes = Object.fromEntries(runtimeIDs.map((id) => [id, async () => account(id)])) as Record<
  RuntimeID,
  () => Promise<Connection>
>

test("disconnect persists per provider and preserves unrelated credentials and conversation files", async () => {
  await using tmp = await tmpdir()
  const credentials = path.join(tmp.path, "auth.json")
  const conversation = path.join(tmp.path, "conversation.json")
  await fs.writeFile(credentials, '{"fixture":"native credentials"}')
  await fs.writeFile(conversation, '{"messages":["keep this history"]}')
  const directory = path.join(tmp.path, "access")
  const access = createSubscriptionAccess(directory)
  await access.setEnabled("claude-subscription", false)
  expect(await createSubscriptionAccess(directory).enabled("claude-subscription")).toBe(false)
  expect(await access.enabled("codex-subscription")).toBe(true)
  await access.setEnabled("claude-subscription", true)
  expect(await createSubscriptionAccess(directory).enabled("claude-subscription")).toBe(true)
  expect(await fs.readFile(credentials, "utf8")).toBe('{"fixture":"native credentials"}')
  expect(await fs.readFile(conversation, "utf8")).toBe('{"messages":["keep this history"]}')
})

test("disconnect aborts only this provider and rejects later work before the runtime starts", async () => {
  await using tmp = await tmpdir()
  const access = createSubscriptionAccess(tmp.path)
  const entered = Promise.withResolvers<void>()
  let otherSignal: AbortSignal | undefined
  const keep = Promise.withResolvers<void>()
  const other = access.run("claude-subscription", new AbortController().signal, async (signal) => {
    otherSignal = signal
    await keep.promise
  })
  const running = access.run(
    "codex-subscription",
    new AbortController().signal,
    (signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        entered.resolve()
      }),
  )
  void running.catch(() => {})
  await entered.promise
  await access.setEnabled("codex-subscription", false)
  await expect(running).rejects.toThrow("disconnected from GPD")
  expect(otherSignal?.aborted).toBe(false)
  let started = false
  await expect(
    access.run("codex-subscription", new AbortController().signal, async () => {
      started = true
    }),
  ).rejects.toThrow("disconnected from GPD")
  expect(started).toBe(false)
  keep.resolve()
  await other
})

test("a newer disconnect wins over a queued reconnect and concurrent providers persist independently", async () => {
  await using tmp = await tmpdir()
  const access = createSubscriptionAccess(tmp.path)
  await access.setEnabled("codex-subscription", false)
  const reconnect = access.setEnabled("codex-subscription", true)
  const disconnect = access.setEnabled("codex-subscription", false)
  expect(await access.enabled("codex-subscription")).toBe(false)
  await Promise.all([reconnect, disconnect, access.setEnabled("claude-subscription", false)])
  const reopened = createSubscriptionAccess(tmp.path)
  expect(await reopened.enabled("codex-subscription")).toBe(false)
  expect(await reopened.enabled("claude-subscription")).toBe(false)
})

test("invalid stored preference fails closed and an explicit reconnect can repair it", async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "codex-subscription.json"), '{"enabled":"false"}')
  const access = createSubscriptionAccess(tmp.path)
  await expect(access.enabled("codex-subscription")).rejects.toThrow("could not read")
  await access.setEnabled("codex-subscription", true)
  expect(await access.enabled("codex-subscription")).toBe(true)
})

test("disconnect masks an in-flight cached catalog and does not probe a disabled runtime", async () => {
  await using tmp = await tmpdir()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let calls = 0
  const manager = createConnections(
    {
      ...probes,
      "claude-subscription": async () => {
        calls++
        entered.resolve()
        await gate.promise
        return account("claude-subscription")
      },
    },
    createSubscriptionAccess(tmp.path),
  )
  const pending = manager.connections()
  await entered.promise
  await manager.disconnect("claude-subscription")
  gate.resolve()
  const result = await pending
  expect(result.find((x) => x.id === "claude-subscription")).toMatchObject({
    enabled: false,
    authenticated: false,
    models: [],
  })
  expect(result.find((x) => x.id === "codex-subscription")?.authenticated).toBe(true)
  await manager.connections(true)
  expect(calls).toBe(1)
})

test.each([...runtimeIDs])("%s reconnects an existing account without starting OAuth", async (id) => {
  await using tmp = await tmpdir()
  const access = createSubscriptionAccess(tmp.path)
  const manager = createConnections(probes, access)
  await manager.disconnect(id)
  expect(await manager.startLogin(id)).toMatchObject({ status: "complete", url: undefined })
  expect(await access.enabled(id)).toBe(true)
  expect((await manager.connections(true)).find((x) => x.id === id)?.authenticated).toBe(true)
  manager.cancelLogin(id)
})

test("disconnect during reconnect cannot resurrect a late successful account check", async () => {
  await using tmp = await tmpdir()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const access = createSubscriptionAccess(tmp.path)
  const manager = createConnections(
    {
      ...probes,
      "claude-subscription": async () => {
        entered.resolve()
        await gate.promise
        return account("claude-subscription")
      },
    },
    access,
  )
  const connecting = manager.startLogin("claude-subscription")
  await entered.promise
  await manager.disconnect("claude-subscription")
  gate.resolve()
  expect(await connecting).toMatchObject({ status: "idle" })
  expect(await access.enabled("claude-subscription")).toBe(false)
})

test("HTTP disconnect and reconnect use the durable preference and reject unknown runtime IDs", async () => {
  await using tmp = await tmpdir()
  const access = createSubscriptionAccess(tmp.path)
  const routes = SubscriptionRoutes(createConnections(probes, access))
  expect((await routes.request("/invalid/disconnect", { method: "POST" })).status).toBe(400)
  expect((await routes.request("/codex-subscription/disconnect", { method: "POST" })).status).toBe(200)
  expect(await access.enabled("codex-subscription")).toBe(false)
  expect(await access.enabled("claude-subscription")).toBe(true)
  const connected = await routes.request("/codex-subscription/login", { method: "POST" })
  expect(await connected.json()).toMatchObject({ status: "complete" })
  expect(await access.enabled("codex-subscription")).toBe(true)
})
