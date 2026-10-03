import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, reconcile } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"

export type Connection = {
  id: "codex-subscription" | "claude-subscription"
  name: string
  installed: boolean
  enabled?: boolean
  authenticated: boolean
  plan?: string
  models: { id: string; name: string; efforts: string[] }[]
  usage: { ready: boolean; reason: string }
  checkedAt: number
}
type Login = { status: "pending" | "complete" | "failed" | "idle"; url?: string; message?: string }

export const { use: useSubscription, provider: SubscriptionProvider } = createSimpleContext({
  name: "Subscription",
  init: () => {
    const platform = usePlatform()
    const server = useServer()
    const sdk = useGlobalSDK()
    const sync = useGlobalSync()
    const [state, setState] = createStore({
      enabled: undefined as boolean | undefined,
      loading: false,
      connections: [] as Connection[],
      error: "",
      login: undefined as Connection["id"] | undefined,
      disconnecting: undefined as Connection["id"] | undefined,
      loginState: undefined as Login | undefined,
      entered: localStorage.getItem("gpd.subscription.entered.v1") === "true",
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let refreshRevision = 0
    const request = async <T,>(path = "", method = "GET"): Promise<T> => {
      const current = server.current?.http
      if (!current) throw new Error("Local GPD server is unavailable.")
      const headers: Record<string, string> = {}
      if (current.password)
        headers.Authorization = `Basic ${btoa(`${current.username ?? "opencode"}:${current.password}`)}`
      const response = await (platform.fetch ?? fetch)(`${current.url.replace(/\/$/, "")}/subscription${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(45_000),
      })
      if (!response.ok) throw new Error(`Connection check failed (${response.status}).`)
      return response.json()
    }
    const refresh = async (fresh = true) => {
      const revision = ++refreshRevision
      setState({ loading: true, error: "" })
      try {
        const mode = await request<{ enabled: boolean }>("/mode")
        if (disposed || revision !== refreshRevision) return
        setState("enabled", mode.enabled)
        if (!mode.enabled) return
        const value = await request<{ enabled: boolean; connections: Connection[] }>(fresh ? "?refresh=true" : "")
        if (disposed || revision !== refreshRevision) return
        setState("enabled", value.enabled)
        setState("connections", reconcile(value.connections, { key: "id" }))
        if (value.enabled) {
          const providers = await sdk.client.provider.list()
          if (providers.data && !disposed && revision === refreshRevision) sync.set("provider", providers.data)
        }
      } catch (error) {
        if (!disposed && revision === refreshRevision) setState("error", (error as Error).message)
      } finally {
        if (!disposed && revision === refreshRevision) setState("loading", false)
      }
    }
    const cancel = async () => {
      if (timer) clearTimeout(timer)
      const id = state.login
      setState({ login: undefined, loginState: undefined })
      if (id) await request(`/${id}/login`, "DELETE").catch(() => {})
    }
    const poll = async (id: Connection["id"]) => {
      try {
        const value = await request<Login>(`/${id}/login`)
        if (disposed || state.login !== id) return
        setState("loginState", value)
        if (value.status === "complete") {
          await cancel()
          await refresh()
          return
        }
        if (value.status === "pending") timer = setTimeout(() => void poll(id), 1000)
      } catch (error) {
        setState("error", (error as Error).message)
      }
    }
    const connect = async (id: Connection["id"]) => {
      await cancel()
      setState({ login: id, error: "" })
      try {
        const value = await request<Login>(`/${id}/login`, "POST")
        setState("loginState", value)
        if (value.url) platform.openLink(value.url)
        void poll(id)
      } catch (error) {
        setState("error", (error as Error).message)
        setState("login", undefined)
      }
    }
    const disconnect = async (id: Connection["id"]) => {
      if (state.disconnecting) return
      ++refreshRevision
      setState({ disconnecting: id, error: "" })
      try {
        if (state.login === id) await cancel()
        await request(`/${id}/disconnect`, "POST")
        await refresh()
      } catch (error) {
        setState("error", (error as Error).message)
      } finally {
        setState({ disconnecting: undefined, loading: false })
      }
    }
    onMount(() => void refresh(false))
    onCleanup(() => {
      disposed = true
      void cancel()
    })
    return {
      state,
      refresh,
      connect,
      disconnect,
      cancel,
      enter() {
        localStorage.setItem("gpd.subscription.entered.v1", "true")
        setState("entered", true)
      },
      showWelcome() {
        setState("entered", false)
      },
    }
  },
})
