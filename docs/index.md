---
layout: home

hero:
  name: Cockpit
  text: One window for every coding agent
  tagline: Browse, continue, and launch Claude Code, Codex, and GitHub Copilot CLI sessions, with six more agents' sessions beside them — grouped by repository, isolated in worktrees, shipped as pull requests.
  image:
    src: /logo.png
    alt: Cockpit
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is Cockpit?
      link: /guide/what-is-cockpit

features:
  - icon: 🗂️
    title: Every session, one index
    details: Auto-detects ~/.claude, ~/.codex, and ~/.copilot, plus where Gemini CLI, Cursor, Cline, Roo Code, opencode and Antigravity keep theirs, and indexes every session it finds — grouped by GitHub repository, worktree-aware, updating live as you work in any terminal.
  - icon: 🌿
    title: Always worktrees, always PRs
    details: Every task starts on its own branch in an isolated git worktree — never in your checkout. When it's done, one click pushes the branch and opens the pull request.
  - icon: 💬
    title: A working chat, not just a viewer
    details: Continue a conversation or start a new one — or, when its agent can't reopen it, hand it to one that can. Cockpit spawns the provider CLI headless and streams replies, tool activity, and errors into the window.
  - icon: 🧩
    title: One AI setup for all three agents
    details: Write shared instructions once and fan them out to each agent's own format. Share MCP servers across configs, copy skills between agents, and see drift at a glance.
  - icon: 🗣️
    title: Roundtables
    details: Seat Claude Code, Codex and Copilot at one table. Each answers your question, then they answer each other — and, asked to reach an understanding, keep going until they agree or hit the limits you set. A disagreement shows instead of hiding behind whichever model you asked.
  - icon: 👤
    title: Accounts, usage and your own models
    details: See who each CLI is signed in as, juggle several config homes per agent, and watch subscription usage, without Cockpit ever touching your credentials. Point Claude Code and Copilot at your own endpoints — LiteLLM, Ollama, LM Studio, a gateway — with keys kept encrypted in the keychain.
---
