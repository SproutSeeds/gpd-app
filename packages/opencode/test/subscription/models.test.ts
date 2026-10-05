import { expect, test } from "bun:test"
import { subscriptionProviderCatalog } from "../../src/subscription/models"
import type { Connection } from "../../src/subscription/types"

const connection = (id: Connection["id"], ready: boolean): Connection => ({
  id,
  name: id,
  installed: true,
  authenticated: true,
  checkedAt: Date.now(),
  models: [{ id: "test-model", name: "Test model", efforts: [] }],
  usage: { ready, reason: ready ? "Included usage available" : "Usage paused" },
})

test("one paused subscription leaves the other provider selectable", () => {
  const providers = subscriptionProviderCatalog([
    connection("codex-subscription", false),
    connection("claude-subscription", true),
  ])
  expect(Object.keys(providers)).toEqual(["claude-subscription"])
  expect(Object.keys(Object.values(providers)[0]!.models)).toEqual(["test-model"])
})

test("disconnected and signed out providers stay unavailable even with stale ready metadata", () => {
  const providers = subscriptionProviderCatalog([
    { ...connection("codex-subscription", true), enabled: false },
    { ...connection("claude-subscription", true), authenticated: false },
  ])
  expect(Object.keys(providers)).toEqual([])
})
