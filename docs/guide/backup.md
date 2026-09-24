# Backup & restore

Cockpit's own state — the config homes it indexes, your shared instructions, the library and its skills, your custom providers and your view settings — lives in one place on your Mac. **Settings › Backup** writes all of it to a single file you keep, and puts it back on the same Mac or a new one.

## What a backup holds

| In | Out |
| --- | --- |
| Config homes (sources) | Session transcripts — those stay where each agent keeps them |
| Shared instruction baselines, global and per repo | The session index (rebuilt on first scan) |
| Library entries and the skills behind them | Worktrees and their branches |
| Custom provider definitions | Roundtable transcripts |
| Archived sessions, provider bindings, handoff lineage | Chat images |
| History window, stale threshold, time format, hidden repos | |

Repos are recorded as `owner/repo` wherever Cockpit knows the GitHub remote, so a repo's instructions and skills still find it on another Mac, whatever the checkout is called there.

## Passphrases and secrets

Without a passphrase, a backup leaves out everything secret: your provider API keys, and the environment values of your MCP servers. The file still names what is missing, so a restore can tell you which server needs which variable.

With a passphrase, those values are encrypted into the file (scrypt + AES-256-GCM) and a restore puts them straight back — including keys, which are otherwise tied to the keychain of the Mac that stored them.

::: warning Nothing can recover a lost passphrase
There is no reset and no escrow. If you lose it, the rest of the file still restores — only the secrets are gone.
:::

MCP commands, arguments and URLs are written as they are unless a passphrase seals them, so a token embedded in a command line ends up in the file. Set a passphrase if that applies to you.

Each agent's own copy of a server's definition — an http server's headers, Copilot's tools allowlist, Codex's timeouts — never goes in the file, passphrase or not: it is read back from the agents on this Mac. A server restored on another machine is written from the command, arguments, env and url alone.

## Restoring

Choosing a file shows what it holds before anything is written: when it was made, how much is in it, which MCP commands it would introduce, and any repo it mentions that this Mac doesn't have.

A restore **only ever adds**. Anything already here — a library entry, an instruction baseline, a provider — stays exactly as it is, because what is here is what your agents actually run. Restoring the same file twice changes nothing the second time, which is also how you pick up repos you have cloned since.

Restored library entries arrive switched off in the agents: they show as **pending** in the Agents view, and you turn on the ones you want. An MCP server restored without its values refuses to switch on until it has them — set the server up in an agent, or restore from a backup with a passphrase.

Right after a restore, **Undo this restore** puts your settings back. It stays available until something else writes to the config; a snapshot is kept on disk either way, and the message names it.

## Sharing with teammates

Backups are for your own machines, not for a team — they carry your accounts, your bindings and your keys. To share a repo's instructions with the people you work with, put them in the repo itself: see [The Agents view](/guide/agents).
