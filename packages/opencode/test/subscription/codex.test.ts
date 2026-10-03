import { expect, test } from "bun:test"
import { runCodex } from "../../src/subscription/codex"
import type { ResearchInput, RuntimeEvent } from "../../src/subscription/types"

function fixture(options: { credits?: boolean; exit?: boolean; wait?: boolean; accountChange?: boolean } = {}) {
  const calls: { method: string; params: any }[] = []
  const events: RuntimeEvent[] = []
  let closed = false
  let reads = 0
  const rpc = {
    onNotification: (_method: string, _params: any) => {},
    onRequest: async (_method: string, _params: any): Promise<any> => ({}),
    onExit: (_error: Error) => {},
    notify() {},
    close() {
      closed = true
    },
    async request(method: string, params: any): Promise<any> {
      calls.push({ method, params })
      if (method === "account/read")
        return {
          account: {
            type: "chatgpt",
            planType: "test",
            email: options.accountChange && ++reads > 1 ? "second@example.invalid" : "first@example.invalid",
          },
        }
      if (method === "model/list")
        return { data: [{ id: "test", model: "test", displayName: "Test", supportedReasoningEfforts: [] }] }
      if (method === "account/rateLimits/read")
        return {
          accountId: "account",
          ordinaryUsageAllowed: true,
          rateLimits: {
            limitId: "codex",
            credits: { hasCredits: !!options.credits, unlimited: false },
            primary: { usedPercent: 5 },
          },
        }
      if (method.startsWith("thread/")) return { thread: { id: "thread" } }
      if (method === "turn/start") {
        setTimeout(async () => {
          if (options.wait) return
          if (options.exit) {
            rpc.onExit(new Error("connection lost"))
            return
          }
          rpc.onNotification("item/agentMessage/delta", {
            threadId: "wrong-thread",
            turnId: "turn",
            itemId: "wrong",
            delta: "private",
          })
          rpc.onNotification("item/agentMessage/delta", {
            threadId: "thread",
            turnId: "turn",
            itemId: "answer",
            delta: "Hello",
          })
          rpc.onNotification("item/completed", {
            threadId: "thread",
            turnId: "turn",
            item: { type: "agentMessage", id: "answer", text: "Hello" },
          })
          rpc.onNotification("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } })
        }, 5)
        return { turn: { id: "turn" } }
      }
      return {}
    },
  }
  const controller = new AbortController()
  let native: { id: string; owner: string } | undefined
  const input: ResearchInput = {
    cwd: "/tmp",
    model: "test",
    text: "hello",
    images: [],
    messageID: "message",
    mcp: { physics: { command: "python", args: ["-m", "gpd"] } },
    signal: controller.signal,
    native: async (id, owner) => {
      native = { id, owner }
    },
    emit: async (e) => {
      events.push(e)
    },
    approve: async () => false,
    question: async () => [],
  }
  return { rpc, input, events, calls, controller, native: () => native, closed: () => closed }
}

test("paid overflow is rejected before thread creation or inference", async () => {
  const f = fixture({ credits: true })
  await expect(runCodex(f.input, async () => f.rpc)).rejects.toThrow("paid credit")
  expect(f.calls.some((x) => x.method.startsWith("thread/") || x.method === "turn/start")).toBe(false)
  expect(f.closed()).toBe(true)
})
test("account changes during discovery stop before inference", async () => {
  const f = fixture({ accountChange: true })
  await expect(runCodex(f.input, async () => f.rpc)).rejects.toThrow("account changed")
  expect(f.calls.some((x) => x.method === "turn/start")).toBe(false)
})
test("streams only matching events, passes MCP tools and persists native identity", async () => {
  const f = fixture()
  await runCodex(f.input, async () => f.rpc)
  expect(f.events).toHaveLength(2)
  expect(f.events[0]).toMatchObject({ type: "text", text: "Hello" })
  expect(f.events[1]).toMatchObject({ replace: true, text: "Hello" })
  expect(f.native()?.id).toBe("thread")
  expect(f.calls.find((x) => x.method === "thread/start")?.params.config.mcp_servers.physics.command).toBe("python")
  expect(f.calls.find((x) => x.method === "turn/start")?.params.serviceTierForTurn).toBe("default")
  expect(f.closed()).toBe(true)
})
test("resume requires the original account and uses native thread resume", async () => {
  const first = fixture()
  await runCodex(first.input, async () => first.rpc)
  const second = fixture()
  second.input.nativeID = first.native()!.id
  second.input.nativeOwner = first.native()!.owner
  await runCodex(second.input, async () => second.rpc)
  expect(second.calls.some((x) => x.method === "thread/resume")).toBe(true)
  const wrong = fixture()
  wrong.input.nativeID = "thread"
  wrong.input.nativeOwner = "other-account"
  await expect(runCodex(wrong.input, async () => wrong.rpc)).rejects.toThrow("different Codex account")
})
test("cancel interrupts the owned turn and closes its process", async () => {
  const f = fixture({ wait: true })
  const running = runCodex(f.input, async () => f.rpc)
  setTimeout(() => f.controller.abort(), 20)
  await expect(running).rejects.toThrow("Research stopped")
  expect(f.calls.some((x) => x.method === "turn/interrupt")).toBe(true)
  expect(f.closed()).toBe(true)
})
test("process loss reports failure without resending an uncertain turn", async () => {
  const f = fixture({ exit: true })
  await expect(runCodex(f.input, async () => f.rpc)).rejects.toThrow("connection lost")
  expect(f.calls.filter((x) => x.method === "turn/start")).toHaveLength(1)
})
test("unmatched approvals are rejected and matching tool rejection is forwarded", async () => {
  const f = fixture({ wait: true })
  const running = runCodex(f.input, async () => f.rpc)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await expect(
    f.rpc.onRequest("item/commandExecution/requestApproval", { threadId: "foreign", turnId: "turn", itemId: "tool" }),
  ).rejects.toThrow("Unmatched")
  expect(
    await f.rpc.onRequest("item/commandExecution/requestApproval", {
      threadId: "thread",
      turnId: "turn",
      itemId: "tool",
      command: "echo test",
    }),
  ).toEqual({ decision: "decline" })
  f.controller.abort()
  await expect(running).rejects.toThrow()
})

test("plan mode keeps the native sandbox read only and disables external MCP mutations", async () => {
  const f = fixture()
  f.input.readOnly = true
  await runCodex(f.input, async () => f.rpc)
  const start = f.calls.find((x) => x.method === "thread/start")!.params
  expect(start.sandbox).toBe("read-only")
  expect(start.config.mcp_servers.physics.enabled).toBe(false)
})

test("failed UI or storage delivery cannot be reported as a successful turn", async () => {
  const f = fixture()
  f.input.emit = async () => {
    throw new Error("storage unavailable")
  }
  await expect(runCodex(f.input, async () => f.rpc)).rejects.toThrow("storage unavailable")
  expect(f.closed()).toBe(true)
})

test("account changes during a turn interrupt the owned runtime", async () => {
  const f = fixture({ wait: true })
  const running = runCodex(f.input, async () => f.rpc)
  await new Promise((resolve) => setTimeout(resolve, 10))
  f.rpc.onNotification("account/updated", { authMode: "apikey" })
  await expect(running).rejects.toThrow("Research stopped")
  expect(f.calls.some((x) => x.method === "turn/interrupt")).toBe(true)
  expect(f.closed()).toBe(true)
})
