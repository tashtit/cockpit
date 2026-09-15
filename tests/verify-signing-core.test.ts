import { describe, expect, it } from 'vitest'
import {
  bundleProblems,
  describeSignature,
  expectedSigning,
  parseCodesign,
  type BundleEvidence
} from '../scripts/verify-signing-core.mts'

// `codesign -dvv` as it really prints: an ad-hoc arm64 bundle from `npm run package` without
// credentials, a Developer ID one (identities made up), and an x64 bundle nothing ever signed
const ADHOC = `Executable=/w/dist/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit
Identifier=dev.tashtit.cockpit
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=300 flags=0x2(adhoc) hashes=3+3 location=embedded
Signature=adhoc
Info.plist entries=25
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=6
Internal requirements count=0 size=12
`
const DEVELOPER_ID = `Executable=/w/dist/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit
Identifier=dev.tashtit.cockpit
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=458 flags=0x10000(runtime) hashes=3+7 location=embedded
Signature size=9045
Authority=Developer ID Application: Example Corp (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=15 Sep 2026 at 10:00:00
Notarization Ticket=stapled
Info.plist entries=25
TeamIdentifier=ABCDE12345
Runtime Version=15.0.0
Sealed Resources version=2 rules=13 files=6
Internal requirements count=1 size=180
`
const UNSIGNED = `/w/dist/mac/Cockpit.app: code object is not signed at all
`
const ACCEPTED = `/w/dist/mac-arm64/Cockpit.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: Example Corp (ABCDE12345)
`
const REJECTED = `/w/dist/mac-arm64/Cockpit.app: rejected
source=no usable signature
`

const SIGNED = { signed: true, teamId: 'ABCDE12345' } as const
const UNSIGNED_BUILD = { signed: false } as const

const good: BundleEvidence = { codesign: DEVELOPER_ID, verifyOk: true, assessment: ACCEPTED, staplerOk: true }

describe('expectedSigning', () => {
  it('is unsigned without a certificate, even when the other variables are set', () => {
    expect(expectedSigning({})).toEqual({ signed: false })
    expect(expectedSigning({ APPLE_TEAM_ID: 'ABCDE12345' })).toEqual({ signed: false })
    // GitHub hands an unset secret over as an empty string
    expect(expectedSigning({ CSC_LINK: '', APPLE_TEAM_ID: 'ABCDE12345' })).toEqual({ signed: false })
  })

  it('names the team that must have signed when a certificate is supplied', () => {
    expect(expectedSigning({ CSC_LINK: 'base64', APPLE_TEAM_ID: 'ABCDE12345' })).toEqual(SIGNED)
  })

  it('refuses a certificate without a team id', () => {
    expect(() => expectedSigning({ CSC_LINK: 'base64' })).toThrow(/APPLE_TEAM_ID/)
  })
})

describe('parseCodesign', () => {
  it('reads an ad-hoc bundle', () => {
    expect(parseCodesign(ADHOC)).toEqual({
      unsigned: false,
      adhoc: true,
      hardenedRuntime: false,
      authorities: [],
      teamId: null
    })
  })

  it('reads a Developer ID bundle', () => {
    expect(parseCodesign(DEVELOPER_ID)).toEqual({
      unsigned: false,
      adhoc: false,
      hardenedRuntime: true,
      authorities: [
        'Developer ID Application: Example Corp (ABCDE12345)',
        'Developer ID Certification Authority',
        'Apple Root CA'
      ],
      teamId: 'ABCDE12345'
    })
  })

  it('reads a bundle with no signature at all', () => {
    expect(parseCodesign(UNSIGNED)).toMatchObject({ unsigned: true, adhoc: false, authorities: [], teamId: null })
  })

  it('reads combined flags', () => {
    const both = ADHOC.replace('flags=0x2(adhoc)', 'flags=0x10002(adhoc,runtime)')
    expect(parseCodesign(both)).toMatchObject({ adhoc: true, hardenedRuntime: true })
  })
})

describe('bundleProblems without credentials', () => {
  it('accepts ad-hoc and unsigned bundles', () => {
    const none = { verifyOk: null, assessment: null, staplerOk: null }
    expect(bundleProblems({ codesign: ADHOC, ...none }, UNSIGNED_BUILD)).toEqual([])
    expect(bundleProblems({ codesign: UNSIGNED, ...none }, UNSIGNED_BUILD)).toEqual([])
  })

  it('rejects a bundle some keychain identity signed', () => {
    const problems = bundleProblems({ ...good, verifyOk: null, assessment: null, staplerOk: null }, UNSIGNED_BUILD)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Developer ID Application: Example Corp (ABCDE12345)')
    expect(problems[0]).toContain('no Apple credentials')
  })
})

describe('bundleProblems with credentials', () => {
  it('accepts a Developer ID bundle that is hardened, verified, stapled and assessed', () => {
    expect(bundleProblems(good, SIGNED)).toEqual([])
  })

  it('rejects an ad-hoc or unsigned bundle', () => {
    expect(bundleProblems({ ...good, codesign: ADHOC }, SIGNED)).toContain('not signed with a certificate (ad-hoc or unsigned)')
    expect(bundleProblems({ ...good, codesign: UNSIGNED }, SIGNED)).toContain('not signed with a certificate (ad-hoc or unsigned)')
  })

  it('rejects a signature from another team', () => {
    const problems = bundleProblems(good, { signed: true, teamId: 'ZZZZZ99999' })
    expect(problems).toEqual(['TeamIdentifier ABCDE12345, expected ZZZZZ99999'])
  })

  it('rejects a certificate that is not a Developer ID Application one', () => {
    const codesign = DEVELOPER_ID.replace('Developer ID Application: Example Corp', 'Apple Development: Example Corp')
    const problems = bundleProblems({ ...good, codesign }, SIGNED)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^no Developer ID Application authority \(found: Apple Development: Example Corp/)
  })

  it('rejects a bundle without the hardened runtime', () => {
    const codesign = DEVELOPER_ID.replace('flags=0x10000(runtime)', 'flags=0x0(none)')
    expect(bundleProblems({ ...good, codesign }, SIGNED)).toEqual(['hardened runtime flag missing'])
  })

  it('rejects a failed deep verification, a missing staple, and a skipped assessment', () => {
    expect(bundleProblems({ ...good, verifyOk: false }, SIGNED)).toEqual(['codesign --verify --deep --strict did not pass'])
    expect(bundleProblems({ ...good, staplerOk: false }, SIGNED)).toEqual([
      'no stapled notarization ticket (xcrun stapler validate did not pass)'
    ])
    expect(bundleProblems({ ...good, assessment: null }, SIGNED)).toEqual(['Gatekeeper assessment not run'])
  })

  it('reports what Gatekeeper said when it rejects', () => {
    expect(bundleProblems({ ...good, assessment: REJECTED }, SIGNED)).toEqual([
      'Gatekeeper assessment: /w/dist/mac-arm64/Cockpit.app: rejected; source=no usable signature'
    ])
  })

  it('does not take an accepted assessment from a non-notarized source', () => {
    const local = ACCEPTED.replace('source=Notarized Developer ID', 'source=Developer ID')
    expect(bundleProblems({ ...good, assessment: local }, SIGNED)).toHaveLength(1)
  })
})

describe('describeSignature', () => {
  it('summarizes each kind of bundle', () => {
    expect(describeSignature(ADHOC)).toBe('ad-hoc')
    expect(describeSignature(UNSIGNED)).toBe('unsigned')
    expect(describeSignature(DEVELOPER_ID)).toBe('Developer ID Application: Example Corp (ABCDE12345), hardened runtime')
  })
})
