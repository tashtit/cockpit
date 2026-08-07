import type { CockpitApi } from '../../shared/types'

declare global {
  interface Window {
    cockpit: CockpitApi
  }
}

export const api = window.cockpit
