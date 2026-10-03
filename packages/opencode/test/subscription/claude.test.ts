import { expect, test } from "bun:test"
import type { Query, query } from "@anthropic-ai/claude-agent-sdk"
import { runClaude } from "../../src/subscription/claude"
import type { ResearchInput, RuntimeEvent } from "../../src/subscription/types"

function fixture(options: { extra?: boolean; unknown?: boolean; api?: boolean; failed?: boolean } = {}) {
  const events: RuntimeEvent[] = []
  let closed = false
  let sent = 0
  let native = ""
  let captured: Parameters<typeof query>[0]["options"]
  const drivers = {
    auth: async () => ({
      loggedIn: true,
      authMethod: options.api ? "api_key" : "claude.ai",
      apiProvider: "firstParty",
      email: "fixture@example.invalid",
    }),
    query: ((args: Parameters<typeof query>[0]) => {
      captured = args.options
      return {
        accountInfo: async () => ({ apiProvider: "firstParty", subscriptionType: "Claude Pro" }),
        supportedModels: async () => [
          { value: "default", displayName: "Default", description: "Included model", supportedEffortLevels: ["low"] },
        ],
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          rate_limits_available: true,
          rate_limits: options.unknown
            ? null
            : { limits: [{ percent: 20 }], extra_usage: { is_enabled: !!options.extra } },
        }),
        close: () => {
          closed = true
        },
        async *[Symbol.asyncIterator]() {
          for await (const message of args.prompt as AsyncIterable<unknown>) {
            if (message) sent++
            break
          }
          yield { type: "system", subtype: "init", session_id: "claude-thread" }
          yield { type: "stream_event", event: { type: "message_start", message: { id: "response" } } }
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Research answer" } },
          }
          yield {
            type: "assistant",
            message: {
              id: "response",
              content: [{ type: "tool_use", id: "tool", name: "Read", input: { file_path: "experiment.txt" } }],
            },
          }
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "data" }] } }
          yield {
            type: "result",
            subtype: options.failed ? "error_during_execution" : "success",
            is_error: !!options.failed,
            result: "Research answer",
            errors: options.failed ? ["fixture failure"] : undefined,
            usage: { input_tokens: 12, output_tokens: 5 },
          }
        },
      } as unknown as Query
    }) as typeof query,
  }
  const input: ResearchInput = {
    model: "default",
    effort: "low",
    cwd: "/tmp",
    messageID: "message",
    text: "test",
    images: [],
    mcp: { physics: { command: "python", args: ["-m", "gpd"] } },
    signal: AbortSignal.timeout(1000),
    native: async (id) => {
      native = id
    },
    emit: async (event) => {
      events.push(event)
    },
    approve: async () => false,
    question: async () => [],
  }
  return {
    input,
    drivers,
    events,
    sent: () => sent,
    closed: () => closed,
    native: () => native,
    options: () => captured,
  }
}

test.each([{ extra: true }, { unknown: true }, { api: true }])(
  "Claude refuses unsafe or unknown usage before sending input: %j",
  async (options) => {
    const f = fixture(options)
    await expect(runClaude(f.input, f.drivers)).rejects.toThrow()
    expect(f.sent()).toBe(0)
    expect(f.closed()).toBe(true)
  },
)
test("Claude streams once, captures tools and usage, and owns process cleanup", async () => {
  const f = fixture()
  await runClaude(f.input, f.drivers)
  expect(f.sent()).toBe(1)
  expect(f.native()).toBe("claude-thread")
  expect(f.events.filter((e) => e.type === "text")).toHaveLength(1)
  expect(f.events.filter((e) => e.type === "tool")).toHaveLength(2)
  expect(f.events.find((e) => e.type === "usage")).toMatchObject({ input: 12, output: 5 })
  expect(f.options()?.strictMcpConfig).toBe(true)
  expect(f.options()?.settings).toMatchObject({ fastMode: false, disableAllHooks: true })
  expect(f.options()?.mcpServers?.physics).toMatchObject({ command: "python" })
  expect(f.closed()).toBe(true)
})
test("Claude native errors do not become successful answers", async () => {
  const f = fixture({ failed: true })
  await expect(runClaude(f.input, f.drivers)).rejects.toThrow("fixture failure")
  expect(f.closed()).toBe(true)
})
test("Claude refuses resuming another account's native session", async () => {
  const f = fixture()
  f.input.nativeID = "previous-thread"
  f.input.nativeOwner = "different-owner"
  await expect(runClaude(f.input, f.drivers)).rejects.toThrow("different Claude account")
  expect(f.sent()).toBe(0)
})
