# Custom providers

Custom providers (BYOK — bring your own key) let you point agents at model endpoints you control: an enterprise gateway, a LiteLLM proxy, or a local server like **Ollama** or **LM Studio**. Local gateways on `localhost` or your LAN are a first-class use case.

## What's supported

A provider has one of three API types, and the type decides which agents can use it:

| Endpoint type | Claude Code | Copilot CLI | Codex |
| --- | --- | --- | --- |
| Anthropic-compatible | ✅ | ✅ | — |
| OpenAI-compatible | — | ✅ | — |
| Azure | — | ✅ | — |

Claude Code only speaks its own API shape, so it pairs with Anthropic-compatible endpoints; Copilot's BYOK mode speaks all three. **Codex is not supported yet** — pointing it elsewhere requires `config.toml` writes rather than environment variables.

## Adding a provider

**Settings › Providers › Add a model provider…** starts from a **Provider** picker that fills in everything it can, so a hosted API needs only its key and a local server needs nothing at all:

| Provider | Base URL filled in | Key | Works with |
| --- | --- | --- | --- |
| Anthropic (the default) | `https://api.anthropic.com` | required — from console.anthropic.com | Claude Code, Copilot |
| OpenAI | `https://api.openai.com/v1` (wire API `responses`) | required | Copilot |
| Azure OpenAI | your resource's URL | required | Copilot |
| Ollama | `http://localhost:11434/v1` | none | Copilot |
| LM Studio | `http://localhost:1234/v1` | none | Copilot |
| Anthropic-compatible | your gateway's URL | optional | Claude Code, Copilot |
| OpenAI-compatible | your endpoint's URL | optional | Copilot |

Every filled-in field stays editable: point Anthropic at a regional proxy, or run Ollama on another port. **Add provider** stays off until a hosted API has its key, because those APIs refuse every request without one.

A base URL has to start with `https://` unless it is on this Mac or a private network — `localhost`, a `10.`, `172.16–31.`, `192.168.` or Tailscale `100.64–127.` address, a `.local` / `.lan` / `.internal` name, or a bare machine name like `gpu-box`. Over plain `http://` to anywhere else, the key and every prompt would cross the internet unencrypted.

Only the two **-compatible** entries ask for more, because only a gateway can differ:

- **Wire API** (`completions` or `responses`) for OpenAI-compatible endpoints; GPT-5 models need `responses`. The OpenAI entry asks too, starting on `responses`.
- **Send key as** for Anthropic-compatible gateways: `Authorization: Bearer` (most gateways, such as LiteLLM) or `x-api-key` (the Anthropic API's own header, which some proxies pass through).
- **Headers** (up to 16) for gateways that require them, as a JSON object.

When a provider is added, Cockpit fetches its model list from its `/models` listing and says how many models it found. The key goes out the way sessions will send it, so a list that loads means the key works. Azure has no listable catalog, so type the deployment name as the model when you start a session. Models from your providers then appear in the task composer's model picker.

## How the key is sent

Claude Code and Copilot send a provider's key the same way, and so does the model listing:

- **Anthropic** and gateways set to `x-api-key`: Claude Code gets `ANTHROPIC_API_KEY`, Copilot gets `COPILOT_PROVIDER_API_KEY`.
- **Gateways set to Bearer**: Claude Code gets `ANTHROPIC_AUTH_TOKEN`, Copilot gets `COPILOT_PROVIDER_BEARER_TOKEN`.
- **OpenAI-compatible and Azure**: Copilot gets `COPILOT_PROVIDER_API_KEY`, sent as that API's own header.

A session on a provider carries that provider's key and no other. Every other credential variable the agent reads is set to empty, so a key exported in your shell never reaches the provider. A provider with no key (a local Ollama, a keyless gateway) is sent the placeholder `cockpit-no-key` in the same header: left with no key at all, Claude Code would fall back to your own Claude sign-in and send its token to the provider. A provider added before this choice existed keeps working as it did. The one change is Claude against `api.anthropic.com`, which now gets `x-api-key`: that API never accepted the bearer token Claude used to send it.

## Where the key lives

The API key is **not** part of the provider definition and never lands in Cockpit's config file. It's encrypted with the OS keychain (Electron `safeStorage`) into a separate store, decrypted only at spawn time, and injected into the agent's environment for that one turn.

## Sessions remember their provider

A session started on a custom endpoint is pinned to it: resuming always goes back to the same backend, never silently falling back to the first-party API. If the endpoint has since been removed, the resume **refuses loudly** instead of continuing somewhere you didn't intend.

::: warning Blocked hosts
Endpoints may target `localhost` and private-network hosts freely, but link-local addresses (`169.254.0.0/16`, IPv6 `fe80::/10`) and cloud instance-metadata hosts are rejected — no legitimate model gateway lives there, and those addresses hand out cloud credentials to whatever asks.
:::
