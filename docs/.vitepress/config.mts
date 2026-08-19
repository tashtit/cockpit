import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Cockpit',
  description:
    'Unified desktop hub for Claude Code, Codex, and GitHub Copilot CLI — every session, one window.',
  // the app is dark-only; the docs follow it
  appearance: 'force-dark',
  head: [['link', { rel: 'icon', type: 'image/png', href: '/logo.png' }]],
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/what-is-cockpit', activeMatch: '/guide/' },
      {
        text: 'Contributing',
        link: 'https://github.com/tashtit/cockpit/blob/main/CONTRIBUTING.md'
      }
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is Cockpit?', link: '/guide/what-is-cockpit' },
          { text: 'Getting started', link: '/guide/getting-started' }
        ]
      },
      {
        text: 'Using Cockpit',
        items: [
          { text: 'Sessions & the index', link: '/guide/sessions' },
          { text: 'Worktrees & PRs', link: '/guide/worktrees-and-prs' },
          { text: 'Chat', link: '/guide/chat' }
        ]
      },
      {
        text: 'Configuration',
        items: [
          { text: 'The Agents view', link: '/guide/agents' },
          { text: 'Accounts & usage', link: '/guide/accounts-and-usage' },
          { text: 'Custom providers', link: '/guide/custom-providers' }
        ]
      },
      {
        text: 'Help',
        items: [{ text: 'Troubleshooting', link: '/guide/troubleshooting' }]
      }
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/tashtit/cockpit' }],
    search: { provider: 'local' },
    outline: [2, 3],
    footer: {
      message: 'Released under the Apache-2.0 License.'
    }
  }
})
