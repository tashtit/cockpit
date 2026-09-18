import { describe, expect, it } from 'vitest'
import { describePlan, planPublish, type LocalAsset, type ReleaseState } from '../scripts/publish-release-core.mts'

const dist: readonly LocalAsset[] = [
  { name: 'Cockpit-0.11.0-arm64.dmg', size: 131_780_497 },
  { name: 'Cockpit-0.11.0-x64.dmg', size: 138_895_474 },
  { name: 'latest-mac.yml', size: 805 }
]

/** the release as it stands when every asset landed and only the draft flag is left */
function release(over: Partial<ReleaseState> = {}): ReleaseState {
  return {
    tagName: 'v0.11.0',
    isDraft: true,
    assets: dist.map((asset) => ({ ...asset, state: 'uploaded' })),
    ...over
  }
}

describe('planPublish', () => {
  it('uploads everything to the empty draft semantic-release leaves, then publishes', () => {
    expect(planPublish('0.11.0', release({ assets: [] }), dist)).toEqual({
      action: 'finish',
      upload: dist.map((a) => a.name),
      publish: true
    })
  })

  it('publishes a draft whose assets all landed', () => {
    expect(planPublish('0.11.0', release(), dist)).toEqual({ action: 'finish', upload: [], publish: true })
  })

  it('uploads only the asset the 500 lost, then publishes — the v0.11.0 failure', () => {
    const assets = release().assets.filter((a) => a.name !== 'Cockpit-0.11.0-x64.dmg')
    expect(planPublish('0.11.0', release({ assets }), dist)).toEqual({
      action: 'finish',
      upload: ['Cockpit-0.11.0-x64.dmg'],
      publish: true
    })
  })

  it('re-uploads an asset GitHub never finished storing', () => {
    const assets = release().assets.map((a) =>
      a.name === 'latest-mac.yml' ? { ...a, state: 'starter' } : a
    )
    expect(planPublish('0.11.0', release({ assets }), dist)).toMatchObject({ upload: ['latest-mac.yml'] })
  })

  it('re-uploads an asset stored short, which would otherwise look like a good download', () => {
    const assets = release().assets.map((a) =>
      a.name === 'Cockpit-0.11.0-x64.dmg' ? { ...a, size: 1024 } : a
    )
    expect(planPublish('0.11.0', release({ assets }), dist)).toMatchObject({
      upload: ['Cockpit-0.11.0-x64.dmg']
    })
  })

  it('does nothing for a release that is already published and complete', () => {
    expect(planPublish('0.11.0', release({ isDraft: false }), dist)).toEqual({ action: 'none' })
  })

  it('still repairs a published release that is missing an asset', () => {
    const assets = release({ isDraft: false }).assets.slice(1)
    expect(planPublish('0.11.0', release({ isDraft: false, assets }), dist)).toEqual({
      action: 'finish',
      upload: ['Cockpit-0.11.0-arm64.dmg'],
      publish: false
    })
  })

  it('refuses when semantic-release never got as far as creating the release', () => {
    expect(planPublish('0.11.0', null, dist)).toMatchObject({ action: 'refuse' })
  })

  it('refuses a release tagged something other than the packaged version', () => {
    expect(planPublish('0.11.0', release({ tagName: 'v0.10.0' }), dist)).toMatchObject({ action: 'refuse' })
  })

  it('refuses when there is no packaged version or nothing was built', () => {
    expect(planPublish('', release(), dist)).toMatchObject({ action: 'refuse' })
    expect(planPublish('0.11.0', release(), [])).toMatchObject({ action: 'refuse' })
  })
})

describe('describePlan', () => {
  it('says what it is about to do', () => {
    expect(describePlan('0.11.0', { action: 'finish', upload: ['a.dmg'], publish: true })).toBe(
      'v0.11.0: uploading a.dmg; then publishing'
    )
    expect(describePlan('0.11.0', { action: 'none' })).toContain('already published')
    expect(describePlan('0.11.0', { action: 'refuse', reason: 'nope' })).toBe('cannot publish v0.11.0: nope')
  })
})
