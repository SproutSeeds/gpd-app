import { connections } from "./connections"
import { ProviderID, ModelID } from "../provider/schema"
import type { Provider } from "../provider/provider"

export async function subscriptionProviders(): Promise<Record<ProviderID, Provider.Info>> {
  const result: Record<string, Provider.Info> = {}
  for (const connection of await connections()) {
    if (!connection.authenticated || !connection.models.length) continue
    const id = ProviderID.make(connection.id)
    result[id] = {
      id,
      name: connection.name,
      source: "custom",
      env: [],
      options: { subscription: true },
      models: Object.fromEntries(
        connection.models.map((model) => [
          model.id,
          {
            id: ModelID.make(model.id),
            providerID: id,
            name: model.name,
            api: { id: model.id, url: "", npm: "local-subscription-runtime" },
            capabilities: {
              temperature: false,
              reasoning: model.efforts.length > 0,
              attachment: !!model.image,
              toolcall: true,
              input: { text: true, image: !!model.image, audio: false, video: false, pdf: false },
              output: { text: true, image: false, audio: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            // Context is managed by the native runtime. Zero means unknown, not a
            // fabricated allowance, and disables the OpenCode compaction heuristic.
            limit: { context: 0, output: 0 },
            status: "active",
            release_date: "",
            headers: {},
            options: { subscription: true, default: model.default },
            variants: Object.fromEntries(model.efforts.map((effort) => [effort, { reasoningEffort: effort }])),
          },
        ]),
      ),
    }
  }
  return result
}
