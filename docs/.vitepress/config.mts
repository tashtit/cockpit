import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Cockpit',
  description:
    'Unified desktop hub for Claude Code, Codex, and GitHub Copilot CLI — every session, one window.',
  // published by .github/workflows/docs.yml to GitHub Pages, which serves a project
  // site under the repository's name; `npm run docs:dev` serves it there too
  base: '/cockpit/',
  // the app is dark-only; the docs follow it
  appearance: 'force-dark',
  // head tags are written as given — only themeConfig and markdown links get the base
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/cockpit/logo.png' }],
    // the card link previews show; made by `npm run ui:readme` with the README's pictures
    ['meta', { property: 'og:image', content: 'https://tashtit.github.io/cockpit/readme/social-preview.png' }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }]
  ],
  sitemap: { hostname: 'https://tashtit.github.io/cockpit/' },
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Guide', link: '/guide/what-is-cockpit', activeMatch: '/guide/' },
      { text: 'Download', link: 'https://github.com/tashtit/cockpit/releases/latest' },
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
          { text: 'Chat', link: '/guide/chat' },
          { text: 'Roundtables', link: '/guide/roundtables' },
          { text: 'Notifications', link: '/guide/notifications' },
          { text: 'Cleanup', link: '/guide/cleanup' }
        ]
      },
      {
        text: 'Configuration',
        items: [
          { text: 'The Agents view', link: '/guide/agents' },
          { text: 'Accounts & usage', link: '/guide/accounts-and-usage' },
          { text: 'Custom providers', link: '/guide/custom-providers' },
          { text: 'ACP agents', link: '/guide/acp-agents' },
          { text: 'Backup & restore', link: '/guide/backup' }
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
