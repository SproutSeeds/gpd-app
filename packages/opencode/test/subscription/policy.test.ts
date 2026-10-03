import { describe, test, expect } from "bun:test"
import { codexReadiness, claudeReadiness, subscriptionEnvironment } from "../../src/subscription/types"

const codex = () => ({
  accountId: "test-account",
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 25 },
    secondary: { usedPercent: 40 },
    credits: { hasCredits: false, unlimited: false },
    spendControlReached: false,
    rateLimitReachedType: null,
  },
})
const claude = () => ({
  rate_limits_available: true,
  rate_limits: {
    limits: [
      { kind: "session", percent: 20 },
      { kind: "weekly_all", percent: 40 },
    ],
    extra_usage: { is_enabled: false },
  },
})

describe("subscription spending policy", () => {
  test("accepts affirmative included usage with unavailable paid overflow", () => {
    expect(codexReadiness(codex()).ready).toBe(true)
    expect(claudeReadiness(claude()).ready).toBe(true)
  })
  test.each([undefined, null, {}, { ordinaryUsageAllowed: true }, { rate_limits_available: true, rate_limits: null }])(
    "unknown metadata fails closed: %j",
    (input) => {
      expect(codexReadiness(input).ready).toBe(false)
      expect(claudeReadiness(input).ready).toBe(false)
    },
  )
  test("Codex credits, unbounded credit access, exhausted and unrelated quotas stop inference", () => {
    for (const change of [
      { credits: { hasCredits: true, unlimited: false } },
      { credits: { hasCredits: false, unlimited: true } },
      { credits: null },
      { credits: {} },
      { primary: { usedPercent: 100 } },
      { secondary: { usedPercent: NaN } },
      { spendControlReached: true },
      { rateLimitReachedType: "credits" },
      { limitId: "other" },
    ])
      expect(codexReadiness({ ...codex(), rateLimits: { ...codex().rateLimits, ...change } }).ready).toBe(false)
    expect(codexReadiness({ ...codex(), ordinaryUsageAllowed: null }).ready).toBe(false)
    expect(codexReadiness({ ...codex(), ordinaryUsageAllowed: false }).ready).toBe(false)
  })
  test("Claude missing limits, enabled extra usage, and exhaustion stop inference", () => {
    for (const change of [
      { extra_usage: { is_enabled: true } },
      { extra_usage: {} },
      { extra_usage: null },
      { limits: [] },
      { limits: [{ percent: 100 }] },
      { limits: [{ percent: "20" }] },
      { limits: null },
    ])
      expect(claudeReadiness({ ...claude(), rate_limits: { ...claude().rate_limits, ...change } }).ready).toBe(false)
    expect(claudeReadiness({ ...claude(), rate_limits_available: false }).ready).toBe(false)
  })
  test("runtime environment strips API routes and tokens while preserving native auth homes", () => {
    const input = {
      HOME: "/native-home",
      PATH: "/bin",
      CODEX_HOME: "/native-codex",
      OPENAI_API_KEY: "sentinel",
      OPENAI_BASE_URL: "https://invalid",
      ANTHROPIC_API_KEY: "sentinel",
      ANTHROPIC_BASE_URL: "https://invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "sentinel",
      CODEX_API_KEY: "sentinel",
      CLAUDECODE: "1",
    }
    const env = subscriptionEnvironment(input)
    expect(env.HOME).toBe(input.HOME)
    expect(env.CODEX_HOME).toBe(input.CODEX_HOME)
    for (const name of Object.keys(input).filter((k) => !["HOME", "PATH", "CODEX_HOME"].includes(k)))
      expect(env[name]).toBeUndefined()
    expect(input.OPENAI_API_KEY).toBe("sentinel")
  })
})
