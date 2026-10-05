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
export type UsageWindow = { label: string; usedPercent: number; resetsAt?: number }
export type Readiness = { ready: boolean; reason: string; windows?: UsageWindow[] }
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
  // The broad nonessential-traffic switch also disables the SDK's plan usage
  // lookup. Disable telemetry and updates individually so that read can work.
  env.DISABLE_TELEMETRY = "1"
  env.DISABLE_ERROR_REPORTING = "1"
  env.DISABLE_AUTOUPDATER = "1"
  return env
}

function usageWindow(label: unknown, percent: unknown, reset: unknown): UsageWindow[] {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return []
  const time = typeof reset === "number" ? reset * 1000 : typeof reset === "string" ? Date.parse(reset) : NaN
  return [
    {
      label: typeof label === "string" ? label : "Included usage",
      usedPercent: percent,
      ...(Number.isFinite(time) && time > 0 ? { resetsAt: time } : {}),
    },
  ]
}

function codexWindowLabel(minutes: unknown, fallback: string) {
  if (minutes === 10080) return "Weekly"
  if (minutes === 300) return "5 hour"
  if (minutes === 1440) return "Daily"
  return fallback
}

// Usage metadata is an external protocol. Deliberately accept only known,
// affirmative evidence; missing fields are not proof that spending is disabled.
export function codexReadiness(value: any): Readiness {
  const quota = value?.rateLimitsByLimitId?.codex ?? value?.rateLimits
  const windows = [
    ...usageWindow(
      codexWindowLabel(quota?.primary?.windowDurationMins, "Primary"),
      quota?.primary?.usedPercent,
      quota?.primary?.resetsAt,
    ),
    ...usageWindow(
      codexWindowLabel(quota?.secondary?.windowDurationMins, "Secondary"),
      quota?.secondary?.usedPercent,
      quota?.secondary?.resetsAt,
    ),
  ]
  const result = (ready: boolean, reason: string): Readiness => ({ ready, reason, windows })
  if (!quota || quota.limitId !== "codex" || value.ordinaryUsageAllowed !== true)
    return result(false, "Included Codex usage is unavailable or could not be verified. Refresh usage in Codex.")
  if (
    quota.spendControlReached === true ||
    quota.rateLimitReachedType ||
    !windows.length ||
    [quota.primary, quota.secondary].some(
      (x) => x && (!Number.isFinite(x.usedPercent) || x.usedPercent < 0 || x.usedPercent >= 100),
    )
  )
    return result(false, "Included Codex usage is exhausted or unavailable. Refresh after the allowance resets.")
  if (quota.credits?.hasCredits === true || quota.credits?.unlimited === true)
    return result(
      false,
      "Included usage remains, but paid credits are also available. GPD keeps this connection paused to avoid credit spending. You can use another ready connection.",
    )
  if (quota.credits?.hasCredits !== false || quota.credits?.unlimited !== false)
    return result(
      false,
      "Codex has not confirmed that paid credits are unavailable. Refresh the connection or check Manage usage.",
    )
  return result(true, "Included Codex usage available. No paid credits available.")
}

export function claudeReadiness(value: any): Readiness {
  const quota = value?.rate_limits
  const labels: Record<string, string> = { session: "5 hour", weekly_all: "Weekly", weekly_scoped: "Model weekly" }
  const windows = Array.isArray(quota?.limits)
    ? quota.limits.flatMap((x: any) =>
        usageWindow(x?.scope?.model?.display_name ?? labels[x?.kind] ?? "Included usage", x?.percent, x?.resets_at),
      )
    : [
        ["5 hour", quota?.five_hour],
        ["Weekly", quota?.seven_day],
        ["OAuth apps weekly", quota?.seven_day_oauth_apps],
        ["Opus weekly", quota?.seven_day_opus],
        ["Sonnet weekly", quota?.seven_day_sonnet],
      ].flatMap(([label, x]) => usageWindow(label, x?.utilization, x?.resets_at))
  const result = (ready: boolean, reason: string): Readiness => ({ ready, reason, windows })
  const limits = Array.isArray(quota?.limits)
    ? quota.limits.map((x: any) => x?.percent)
    : quota?.limits === undefined
      ? [
          quota?.five_hour,
          quota?.seven_day,
          quota?.seven_day_oauth_apps,
          quota?.seven_day_opus,
          quota?.seven_day_sonnet,
        ]
          .filter(Boolean)
          .map((x) => x.utilization)
      : []
  if (value?.rate_limits_available !== true || !quota || !limits.length)
    return result(false, "Claude usage could not be loaded. Refresh the connection to retry, or check Manage usage.")
  if (quota.extra_usage?.is_enabled !== false)
    return result(
      false,
      "Turn off extra usage in Claude account settings, then refresh. GPD requires verified included usage only.",
    )
  if (
    limits.some(
      (percent: unknown) => typeof percent !== "number" || !Number.isFinite(percent) || percent >= 100 || percent < 0,
    )
  )
    return result(false, "Claude has reached a subscription limit. Wait for the allowance to reset.")
  return result(true, "Included Claude usage available. Extra usage is disabled.")
}
