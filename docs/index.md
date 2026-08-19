---
layout: home

hero:
  name: Cockpit
  text: One window for every coding agent
  tagline: Browse, continue, and launch Claude Code, Codex, and GitHub Copilot CLI sessions — grouped by repository, isolated in worktrees, shipped as pull requests.
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
    details: Auto-detects ~/.claude, ~/.codex, and ~/.copilot, and indexes every session it finds — grouped by GitHub repository, worktree-aware, updating live as you work in any terminal.
  - icon: 🌿
    title: Always worktrees, always PRs
    details: Every task starts on its own branch in an isolated git worktree — never in your checkout. When it's done, one click pushes the branch and opens the pull request.
  - icon: 💬
    title: A working chat, not just a viewer
    details: Continue any indexed conversation or start a new one. Cockpit spawns the provider CLI headless and streams replies, tool activity, and errors into the window.
  - icon: 🧩
    title: One AI setup for all three agents
    details: Write shared instructions once and fan them out to each agent's own format. Share MCP servers across configs, copy skills between agents, and see drift at a glance.
  - icon: 👤
    title: Accounts & usage, credential-free
    details: See who each CLI is signed in as, juggle multiple config homes per provider, and watch subscription usage — without Cockpit ever touching your credentials.
  - icon: 🔌
    title: Custom model providers
    details: Point Claude Code and Copilot at your own endpoints — LiteLLM, Ollama, LM Studio, enterprise gateways. API keys live encrypted in the OS keychain.
---
