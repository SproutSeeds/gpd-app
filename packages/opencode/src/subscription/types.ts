export const runtimeIDs = ["codex-subscription", "claude-subscription"] as const
export type RuntimeID = (typeof runtimeIDs)[number]
export function isRuntime(id: string): id is RuntimeID {
  return runtimeIDs.some((x) => x === id)
}
export function subscriptionOnly() {
  return process.env.GPD_SUBSCRIPTION_ONLY === "1"
}
export type RuntimeModel = {
  id: string
  name: string
  efforts: string[]
  default?: boolean
  image?: boolean
}
export type Readiness = { ready: boolean; reason: string }
export type Connection = {
  id: RuntimeID
  name: string
  installed: boolean
  enabled?: boolean
  authenticated: boolean
  plan?: string
  models: RuntimeModel[]
  usage: Readiness
  checkedAt: number
  error?: string
}
export type RuntimeEvent =
  | {
      type: "usage"
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      total?: number
    }
  | { type: "text" | "reasoning"; id: string; text: string; replace?: boolean }
  | {
      type: "tool"
      id: string
      name: string
      input: Record<string, unknown>
      output?: string
      error?: string
      done: boolean
    }
export type ResearchInput = {
  model: string
  effort?: string
  cwd: string
  nativeID?: string
  nativeOwner?: string
  messageID: string
  text: string
  images: string[]
  instructions?: string
  readOnly?: boolean
  mcp: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
  signal: AbortSignal
  native: (id: string, owner: string) => Promise<void>
  emit: (event: RuntimeEvent) => Promise<void>
  approve: (name: string, input: Record<string, unknown>, id: string) => Promise<boolean>
  question: (
    questions: { header: string; question: string; options: { label: string; description: string }[] }[],
  ) => Promise<string[][]>
}

/** Credentials stay with each official runtime. API and gateway overrides never
 * enter these processes, even when inherited by the GPD sidecar. */
export function subscriptionEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (
      /^(OPENAI|ANTHROPIC|AZURE_OPENAI|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|API_TIMEOUT_MS)/.test(key)
    )
      delete env[key]
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
  env.DISABLE_TELEMETRY = "1"
  return env
}

// Usage metadata is an external protocol. Deliberately accept only known,
// affirmative evidence; missing fields are not proof that spending is disabled.
export function codexReadiness(value: any): Readiness {
  const quota = value?.rateLimitsByLimitId?.codex ?? value?.rateLimits
  if (!quota || quota.limitId !== "codex" || value.ordinaryUsageAllowed !== true)
    return {
      ready: false,
      reason: "Included Codex usage is unavailable or could not be verified. Refresh usage in Codex.",
    }
  if (quota.credits?.hasCredits !== false || quota.credits?.unlimited !== false)
    return {
      ready: false,
      reason:
        "Codex paid credit access must be unavailable before research can run. Check your Codex usage settings, then refresh.",
    }
  if (
    quota.spendControlReached === true ||
    quota.rateLimitReachedType ||
    [quota.primary, quota.secondary].some((x) => x && (!Number.isFinite(x.usedPercent) || x.usedPercent >= 100))
  )
    return { ready: false, reason: "Codex has reached a usage limit. Wait for the allowance to reset." }
  return { ready: true, reason: "Included Codex usage available. No paid credits available." }
}

export function claudeReadiness(value: any): Readiness {
  const quota = value?.rate_limits
  const limits = Array.isArray(quota?.limits)
    ? quota.limits.map((x: any) => x.percent)
    : quota?.limits === undefined
      ? [quota?.five_hour, quota?.seven_day, quota?.seven_day_opus, quota?.seven_day_sonnet]
          .filter(Boolean)
          .map((x) => x.utilization)
      : []
  if (value?.rate_limits_available !== true || !quota || !limits.length)
    return {
      ready: false,
      reason: "Claude included usage could not be verified. Check usage in Claude Code, then refresh the connection.",
    }
  if (quota.extra_usage?.is_enabled !== false)
    return {
      ready: false,
      reason:
        "Turn off extra usage in Claude account settings, then refresh. GPD requires verified included usage only.",
    }
  if (
    limits.some(
      (percent: unknown) => typeof percent !== "number" || !Number.isFinite(percent) || percent >= 100 || percent < 0,
    )
  )
    return { ready: false, reason: "Claude has reached a subscription limit. Wait for the allowance to reset." }
  return { ready: true, reason: "Included Claude usage available. Extra usage is disabled." }
}
