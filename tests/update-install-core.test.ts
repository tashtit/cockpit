import { describe, it, expect } from 'vitest'
import {
  assetUrl,
  bundleOf,
  checkOutcome,
  isNewer,
  isSafeAssetName,
  isSafeVersion,
  pickZip,
  swapRefusal,
  swapScript,
  teamIdentifier,
  type BundleFacts,
  type FeedFile
} from '../src/main/update-install-core'

/** latest-mac.yml as a real release publishes it — both arches, zip and dmg. */
const FEED: FeedFile[] = [
  { url: 'Cockpit-0.11.0-x64.zip', sha512: 'x64zip', size: 138485213 },
  { url: 'Cockpit-0.11.0-arm64.zip', sha512: 'armzip', size: 131325457 },
  { url: 'Cockpit-0.11.0-x64.dmg', sha512: 'x64dmg', size: 138895474 },
  { url: 'Cockpit-0.11.0-arm64.dmg', sha512: 'armdmg', size: 131780497 }
]

const RUNNING: BundleFacts = {
  identifier: 'dev.tashtit.cockpit',
  version: '0.11.0',
  team: '',
  executable: 'Cockpit'
}

describe('pickZip', () => {
  it('takes this Mac’s zip, never the dmg', () => {
    expect(pickZip(FEED, 'arm64')?.url).toBe('Cockpit-0.11.0-arm64.zip')
    expect(pickZip(FEED, 'x64')?.url).toBe('Cockpit-0.11.0-x64.zip')
  })

  it('offers nothing for an architecture no release carries', () => {
    expect(pickZip(FEED, 'arm')).toBeNull()
    expect(pickZip(FEED, 'ia32')).toBeNull()
  })

  it('offers nothing when the feed has no zip for this Mac', () => {
    expect(pickZip(FEED.filter((f) => f.url.endsWith('.dmg')), 'arm64')).toBeNull()
  })
})

describe('the asset a release offer resolves to', () => {
  it('lives under the tag semantic-release cut', () => {
    expect(assetUrl('https://github.com/tashtit/cockpit/releases', '0.11.0', 'Cockpit-0.11.0-arm64.zip')).toBe(
      'https://github.com/tashtit/cockpit/releases/download/v0.11.0/Cockpit-0.11.0-arm64.zip'
    )
  })

  it('refuses a version or a file name that would escape the stage dir', () => {
    expect(isSafeVersion('0.11.0')).toBe(true)
    expect(isSafeVersion('1.0.0-beta.2')).toBe(true)
    expect(isSafeVersion('../../etc')).toBe(false)
    expect(isSafeVersion('0.1.0/x')).toBe(false)
    expect(isSafeVersion('')).toBe(false)
    expect(isSafeAssetName('Cockpit-0.11.0-arm64.zip')).toBe(true)
    expect(isSafeAssetName('../escape.zip')).toBe(false)
    expect(isSafeAssetName('Cockpit.dmg')).toBe(false)
  })
})

describe('bundleOf', () => {
  it('finds the bundle an executable path sits inside', () => {
    expect(bundleOf('/Applications/Cockpit.app/Contents/MacOS/Cockpit')).toBe('/Applications/Cockpit.app')
  })

  it('is null for anything that is not an installed app', () => {
    expect(bundleOf('/Users/dev/src/cockpit/node_modules/electron/dist/electron')).toBeNull()
    // the dev build runs Electron.app's own binary, which is not Cockpit's bundle
    expect(bundleOf('/usr/local/bin/cockpit')).toBeNull()
  })
})

describe('teamIdentifier', () => {
  it('reads the team out of what codesign prints', () => {
    expect(teamIdentifier('Identifier=dev.tashtit.cockpit\nTeamIdentifier=ABCDE12345\n')).toBe('ABCDE12345')
  })

  it('treats an ad-hoc build as having no team', () => {
    // what a released Cockpit actually prints today
    expect(teamIdentifier('Signature=adhoc\nTeamIdentifier=not set\n')).toBe('')
    expect(teamIdentifier('code object is not signed at all')).toBe('')
  })
})

describe('swapRefusal', () => {
  it('lets the offered build of the same app through', () => {
    expect(swapRefusal({ ...RUNNING, version: '0.12.0' }, RUNNING, '0.12.0')).toBeNull()
  })

  it('refuses an archive with no app in it', () => {
    expect(swapRefusal({ ...RUNNING, version: '0.12.0', executable: '' }, RUNNING, '0.12.0')).toMatch(
      /no application/
    )
  })

  it('refuses a different application', () => {
    const other = { ...RUNNING, version: '0.12.0', identifier: 'com.example.other' }
    expect(swapRefusal(other, RUNNING, '0.12.0')).toMatch(/com\.example\.other/)
  })

  it('refuses a build that is not the version that was offered', () => {
    expect(swapRefusal({ ...RUNNING, version: '0.9.0' }, RUNNING, '0.12.0')).toMatch(/not the 0\.12\.0/)
  })

  it('holds a signed install to the team that signed the running one', () => {
    const running = { ...RUNNING, team: 'ABCDE12345' }
    const stolen = { ...RUNNING, version: '0.12.0', team: 'ZZZZZ99999' }
    expect(swapRefusal(stolen, running, '0.12.0')).toMatch(/ZZZZZ99999/)
    expect(swapRefusal({ ...stolen, team: 'ABCDE12345' }, running, '0.12.0')).toBeNull()
  })

  it('asks nothing of the signature when the running build is ad-hoc', () => {
    // the state every release is in today: there is no team to hold it to
    expect(swapRefusal({ ...RUNNING, version: '0.12.0', team: '' }, RUNNING, '0.12.0')).toBeNull()
  })
})

describe('isNewer', () => {
  it('compares release numbers', () => {
    expect(isNewer('0.12.0', '0.11.0')).toBe(true)
    expect(isNewer('1.0.0', '0.99.9')).toBe(true)
    expect(isNewer('0.11.0', '0.11.0')).toBe(false)
    expect(isNewer('0.10.0', '0.11.0')).toBe(false)
    expect(isNewer('0.11.1', '0.11.0')).toBe(true)
  })

  it('never lets a prerelease win a tie', () => {
    expect(isNewer('0.11.0-beta.1', '0.11.0')).toBe(false)
  })
})

describe('swapScript', () => {
  const plan = {
    pid: 4242,
    target: '/Applications/Cockpit.app',
    staged: '/tmp/stage/app/Cockpit.app',
    stageDir: '/tmp/stage',
    resultFile: '/tmp/last-install',
    relaunch: true
  }

  it('waits for the app, clears quarantine and keeps a way back', () => {
    const sh = swapScript(plan)
    expect(sh).toMatch(/kill -0 "\$PID"/)
    expect(sh).toMatch(/xattr -dr com\.apple\.quarantine "\$TARGET"/)
    // the old bundle is renamed aside, not deleted, until the copy has landed
    expect(sh.indexOf('mv "$TARGET" "$BACKUP"')).toBeLessThan(sh.indexOf('ditto "$NEW" "$TARGET"'))
    expect(sh).toMatch(/mv "\$BACKUP" "\$TARGET"/)
  })

  it('quotes every path it was given', () => {
    const sh = swapScript({ ...plan, target: "/Applications/Some'App.app" })
    expect(sh).toContain(`TARGET='/Applications/Some'\\''App.app'`)
  })

  it('reopens the app only when asked', () => {
    expect(swapScript(plan)).toContain('RELAUNCH=1')
    expect(swapScript({ ...plan, relaunch: false })).toContain('RELAUNCH=0')
  })
})

describe('checkOutcome', () => {
  const AT = 1_700_000_000_000

  it('offers what a check found when nothing is downloaded', () => {
    expect(checkOutcome({ kind: 'offer', version: '0.18.0' }, null, AT)).toEqual({
      state: { status: 'available', version: '0.18.0', checkedAt: AT },
      sweep: false
    })
    expect(checkOutcome({ kind: 'none' }, null, AT)).toEqual({
      state: { status: 'up-to-date', checkedAt: AT },
      sweep: false
    })
    expect(checkOutcome({ kind: 'failed', message: 'no network' }, null, AT)).toEqual({
      state: { status: 'error', message: 'no network', checkedAt: AT },
      sweep: false
    })
  })

  it('answers a re-offer of the build already downloaded with that build', () => {
    // the whole point: checking again with 0.17.1 staged must not fetch 0.17.1 again
    const again = checkOutcome({ kind: 'offer', version: '0.17.1' }, '0.17.1', AT)
    expect(again).toEqual({ state: { status: 'ready', version: '0.17.1', checkedAt: AT }, sweep: false })
  })

  it('takes a newer release over the one on disk, and says the disk copy can go', () => {
    expect(checkOutcome({ kind: 'offer', version: '0.18.0' }, '0.17.1', AT)).toEqual({
      state: { status: 'available', version: '0.18.0', checkedAt: AT },
      sweep: true
    })
  })

  it('keeps a downloaded build through a check that came back with nothing', () => {
    // a withdrawn release, and an offline Mac: neither un-downloads a verified build,
    // and installOnQuit reads the same `ready` either way
    expect(checkOutcome({ kind: 'none' }, '0.17.1', AT)).toEqual({
      state: { status: 'ready', version: '0.17.1', checkedAt: AT },
      sweep: false
    })
    expect(checkOutcome({ kind: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' }, '0.17.1', AT)).toEqual({
      state: {
        status: 'ready',
        version: '0.17.1',
        message: 'net::ERR_INTERNET_DISCONNECTED',
        checkedAt: AT
      },
      sweep: false
    })
  })

  it('never sweeps a build it is not replacing', () => {
    for (const result of [
      { kind: 'none' } as const,
      { kind: 'failed', message: 'x' } as const,
      { kind: 'offer', version: '0.17.0' } as const
    ]) {
      expect(checkOutcome(result, '0.17.1', AT).sweep).toBe(false)
    }
  })
})
