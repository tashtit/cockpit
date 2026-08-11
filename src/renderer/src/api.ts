import type { CockpitApi } from '../../shared/types'

declare global {
  // global augmentation requires interface merging — the one allowed `interface`;
  // not readonly: the component-test setup installs the stub by assignment
  interface Window {
    cockpit: CockpitApi
  }
}

export const api = window.cockpit
