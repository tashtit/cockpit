import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

// dropped files must never navigate the window (defense in depth with will-navigate)
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

// dev-only: main tags the dev-server URL with the source branch so parallel
// worktree instances are tellable apart — index.html's <title> would otherwise
// reset the branded window title on load
const devBranch = new URLSearchParams(location.search).get('devBranch')
if (devBranch) document.title = `Cockpit — ${devBranch}`

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
