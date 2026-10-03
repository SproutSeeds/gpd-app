import { For, Show, onCleanup, createEffect } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useSubscription } from "@/context/subscription"
import { usePlatform } from "@/context/platform"

const links = {
  "codex-subscription": {
    install: "https://learn.chatgpt.com/docs/cli",
    usage: "https://chatgpt.com/codex/settings/usage",
  },
  "claude-subscription": {
    install: "https://code.claude.com/docs/en/setup",
    usage: "https://claude.ai/settings/usage",
  },
}

export function SubscriptionConnections(props: { welcome?: boolean }) {
  const subscription = useSubscription()
  const platform = usePlatform()
  let returnFocus: HTMLElement | undefined
  createEffect(() => {
    if (subscription.state.login) returnFocus = document.activeElement as HTMLElement
  })
  const close = () => {
    void subscription.cancel()
    returnFocus?.focus()
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && subscription.state.login) {
      event.stopPropagation()
      close()
    }
  }
  document.addEventListener("keydown", escape, true)
  onCleanup(() => document.removeEventListener("keydown", escape, true))
  return (
    <div class="flex flex-col gap-6 w-full">
      <div class="flex flex-col gap-2">
        <h2 class="text-20-medium text-text-strong">{props.welcome ? "Start your research" : "AI connections"}</h2>
        <p class="text-14-regular text-text-weak">
          Connect Codex or Claude Code with your existing subscription. One connection is enough to begin.
        </p>
      </div>
      <Show when={subscription.state.error}>
        <div role="alert" class="text-14-regular text-text-strong p-4 rounded-lg border border-border-base">
          {subscription.state.error}
        </div>
      </Show>
      <Show when={subscription.state.loading && !subscription.state.connections.length}>
        <p role="status" class="text-14-regular text-text-weak">
          Checking local connections…
        </p>
      </Show>
      <div class="grid gap-3 sm:grid-cols-2">
        <For each={subscription.state.connections}>
          {(connection) => (
            <section class="rounded-xl border border-border-base p-5 flex flex-col gap-4 bg-background-weak">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h3 class="text-16-medium text-text-strong">{connection.name}</h3>
                  <p class="text-12-regular text-text-weak mt-1">
                    {connection.authenticated
                      ? "Subscription connected"
                      : connection.installed
                        ? "Ready to connect"
                        : "Install to connect"}
                  </p>
                </div>
                <span class="text-12-medium text-text-strong">
                  {connection.authenticated ? (connection.usage.ready ? "Ready" : "Usage check needed") : ""}
                </span>
              </div>
              <p class="text-12-regular text-text-base flex-1" role="status">
                {connection.usage.reason}
              </p>
              <Show when={connection.authenticated}>
                <p class="text-12-regular text-text-weak">
                  {connection.models.length} models discovered from your runtime
                </p>
              </Show>
              <Show
                when={connection.installed}
                fallback={
                  <Button
                    class="cursor-pointer"
                    variant="secondary"
                    onClick={() => platform.openLink(links[connection.id].install)}
                  >
                    Install {connection.name}
                  </Button>
                }
              >
                <Show
                  when={connection.authenticated}
                  fallback={
                    <Button
                      class="cursor-pointer"
                      variant="primary"
                      disabled={!!subscription.state.login}
                      onClick={() => void subscription.connect(connection.id)}
                    >
                      Connect {connection.name}
                    </Button>
                  }
                >
                  <Button
                    class="cursor-pointer"
                    variant="secondary"
                    onClick={() => platform.openLink(links[connection.id].usage)}
                  >
                    Manage usage
                  </Button>
                </Show>
              </Show>
            </section>
          )}
        </For>
      </div>
      <Show when={subscription.state.login}>
        <div class="rounded-lg border border-border-base p-4 flex flex-col gap-3" role="status">
          <p class="text-14-medium">
            {subscription.state.loginState?.status === "failed"
              ? "Sign in needs attention"
              : "Finish signing in with your provider"}
          </p>
          <p class="text-12-regular text-text-weak">
            {subscription.state.loginState?.message ??
              "Your provider opens its own sign in page. GPD does not receive your password."}
          </p>
          <div class="flex gap-2">
            <Show when={subscription.state.loginState?.url}>
              {(url) => (
                <Button class="cursor-pointer" variant="secondary" onClick={() => platform.openLink(url())}>
                  Open sign in page
                </Button>
              )}
            </Show>
            <Button class="cursor-pointer" variant="ghost" onClick={close}>
              Cancel sign in
            </Button>
          </div>
        </div>
      </Show>
      <p class="text-12-regular text-text-weak">
        Research uses included subscription allowances. GPD checks usage before each turn and stops when paid overflow
        is available or usage cannot be verified.
      </p>
      <div class="flex gap-3 flex-wrap items-center">
        <Show when={props.welcome}>
          <Button class="cursor-pointer" variant="primary" onClick={() => subscription.enter()}>
            {subscription.state.connections.some((c) => c.authenticated) ? "Open workspace" : "Explore workspace"}
          </Button>
        </Show>
        <Button
          class="cursor-pointer"
          variant="ghost"
          disabled={subscription.state.loading}
          onClick={() => void subscription.refresh()}
        >
          Refresh connections
        </Button>
      </div>
    </div>
  )
}

export function SubscriptionWelcome() {
  return (
    <main class="h-dvh w-full overflow-y-auto bg-background-base flex items-center justify-center p-8">
      <div class="w-full max-w-[760px] flex flex-col gap-8 py-10">
        <div class="flex items-center gap-3">
          <span class="text-32-medium text-text-strong">Ψ</span>
          <span class="text-16-medium text-text-strong">
            GPD <span class="text-text-weak text-12-regular ml-2">Research workspace</span>
          </span>
        </div>
        <SubscriptionConnections welcome />
        <p class="text-12-regular text-text-weak">Independent GPD fork by Cody Mitchell, built on PSI and OpenCode.</p>
      </div>
    </main>
  )
}
