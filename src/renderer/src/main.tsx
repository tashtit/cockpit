import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

// dropped files must never navigate the window (defense in depth with will-navigate)
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
