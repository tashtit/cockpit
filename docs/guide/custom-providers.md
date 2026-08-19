# Custom providers

Custom providers (BYOK — bring your own key) let you point agents at model endpoints you control: an enterprise gateway, a LiteLLM proxy, or a local server like **Ollama** or **LM Studio**. Local gateways on `localhost` or your LAN are a first-class use case.

## What's supported

An endpoint has one of three types, and the type decides which agents can use it:

| Endpoint type | Claude Code | Copilot CLI | Codex |
| --- | --- | --- | --- |
| Anthropic-compatible | ✅ | ✅ | — |
| OpenAI-compatible | — | ✅ | — |
| Azure | — | ✅ | — |

Claude Code only speaks its own API shape, so it pairs with Anthropic-compatible endpoints; Copilot's BYOK mode speaks all three. **Codex is not supported yet** — pointing it elsewhere requires `config.toml` writes rather than environment variables.

## Defining an endpoint

A definition is a label, a base URL, and a type — plus optionally:

- a **wire API** (`completions` or `responses`) for OpenAI-compatible endpoints,
- **custom headers** (up to 16), for gateways that require them,
- a **model list**. For OpenAI- and Anthropic-compatible endpoints Cockpit fetches the catalog from the endpoint's `/models` listing automatically; Azure has no listable catalog, so you enter deployment names yourself.

Models from your endpoints then appear in the task composer's model picker.

## Where the key lives

The API key is **not** part of the endpoint definition and never lands in Cockpit's config file. It's encrypted with the OS keychain (Electron `safeStorage`) into a separate store, decrypted only at spawn time, and injected into the provider CLI's environment for that one turn (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` for Claude Code, `COPILOT_PROVIDER_*` for Copilot).

## Sessions remember their provider

A session started on a custom endpoint is pinned to it: resuming always goes back to the same backend, never silently falling back to the first-party API. If the endpoint has since been removed, the resume **refuses loudly** instead of continuing somewhere you didn't intend.

::: warning Blocked hosts
Endpoints may target `localhost` and private-network hosts freely, but link-local addresses (`169.254.0.0/16`, IPv6 `fe80::/10`) and cloud instance-metadata hosts are rejected — no legitimate model gateway lives there, and those addresses hand out cloud credentials to whatever asks.
:::
