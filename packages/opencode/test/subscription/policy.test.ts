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
      { primary: { usedPercent: -1 } },
      { primary: null, secondary: null },
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
      { limits: [null] },
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
    // Disabling all nonessential traffic breaks the official SDK's usage read.
    // Specific controls keep telemetry, error reporting and updates disabled.
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined()
    expect(env.DISABLE_TELEMETRY).toBe("1")
    expect(env.DISABLE_ERROR_REPORTING).toBe("1")
    expect(env.DISABLE_AUTOUPDATER).toBe("1")
  })
  test("reports remaining allowance even when paid Codex credits keep research paused", () => {
    const value = codex()
    value.rateLimits.credits.hasCredits = true
    const result = codexReadiness(value)
    expect(result.ready).toBe(false)
    expect(result.windows).toEqual([
      { label: "Primary", usedPercent: 25 },
      { label: "Secondary", usedPercent: 40 },
    ])
    expect(result.reason).toContain("paid credits")
  })
  test("shows runtime window durations and reset times without inventing missing resets", () => {
    const result = codexReadiness({
      ...codex(),
      rateLimits: {
        ...codex().rateLimits,
        primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1800000000 },
        secondary: null,
      },
    })
    expect(result.windows).toEqual([{ label: "Weekly", usedPercent: 16, resetsAt: 1800000000000 }])
    const resultClaude = claudeReadiness({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 20, resets_at: "2026-10-10T05:00:00Z" },
        extra_usage: { is_enabled: false },
        limits: [
          { kind: "session", percent: 0, resets_at: null },
          { kind: "weekly_all", percent: 20, resets_at: "2026-10-10T05:00:00Z" },
          { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "Model A" } } },
        ],
      },
    })
    expect(resultClaude.ready).toBe(true)
    expect(resultClaude.windows).toEqual([
      { label: "5 hour", usedPercent: 0 },
      { label: "Weekly", usedPercent: 20, resetsAt: Date.parse("2026-10-10T05:00:00Z") },
      { label: "Model A", usedPercent: 5 },
    ])
  })
  test("legacy Claude OAuth app allowance exhaustion cannot be hidden by a healthy weekly allowance", () => {
    const result = claudeReadiness({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 20 },
        seven_day_oauth_apps: { utilization: 100 },
        extra_usage: { is_enabled: false },
      },
    })
    expect(result.ready).toBe(false)
    expect(result.windows).toHaveLength(2)
  })
})
