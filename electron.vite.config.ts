import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { licenseNotices } from './scripts/licenses/notices'

// every target reports what it bundles; the notices cover all three plus production node_modules
export default defineConfig({
  main: { plugins: [licenseNotices()] },
  preload: { plugins: [licenseNotices()] },
  renderer: {
    plugins: [react(), licenseNotices()]
  }
})
