/**
 * IO-free half of scripts/verify-signing.mts: what a packaged Cockpit.app must look like
 * given the credentials the build ran with. The script gathers the codesign, spctl and
 * stapler output; this decides. tests/verify-signing-core.test.ts targets it.
 */

export type SigningExpectation =
  | { readonly signed: false }
  | { readonly signed: true; readonly teamId: string }

export type CodesignReport = {
  /** codesign found no signature at all (an x64 bundle nothing ever signed) */
  readonly unsigned: boolean
  /** ad-hoc signature — what an unsigned arm64 build carries */
  readonly adhoc: boolean
  /** the hardened runtime flag, which notarization requires */
  readonly hardenedRuntime: boolean
  /** the `Authority=` chain, leaf first; empty for ad-hoc and unsigned */
  readonly authorities: readonly string[]
  /** `TeamIdentifier=`; null when "not set" */
  readonly teamId: string | null
}

export type BundleEvidence = {
  /** `codesign -dvv <app>` */
  readonly codesign: string
  /** `codesign --verify --deep --strict <app>` passed; null when not run */
  readonly verifyOk: boolean | null
  /** `spctl --assess --type execute -vv <app>`; null when not run */
  readonly assessment: string | null
  /** `xcrun stapler validate <app>` passed; null when not run */
  readonly staplerOk: boolean | null
}

const DEVELOPER_ID = 'Developer ID Application:'

/**
 * The same rule electron-builder.config.js applies: the certificate decides whether the
 * build is signed, and the team id names who must have signed it. The config refuses a
 * partial credential set before packaging, so a set CSC_LINK implies the team id.
 */
export function expectedSigning(env: NodeJS.ProcessEnv): SigningExpectation {
  if (!env['CSC_LINK']) return { signed: false }
  const teamId = env['APPLE_TEAM_ID']
  if (!teamId) throw new Error('CSC_LINK is set but APPLE_TEAM_ID is not — supply all five Apple variables or none')
  return { signed: true, teamId }
}

export function parseCodesign(output: string): CodesignReport {
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/i.exec(output)?.[1]?.split(',') ?? []
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim())
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim()
  return {
    unsigned: /code object is not signed at all/.test(output),
    adhoc: flags.includes('adhoc') || /^Signature=adhoc$/m.test(output),
    hardenedRuntime: flags.includes('runtime'),
    authorities,
    teamId: team && team !== 'not set' ? team : null
  }
}

/** Everything wrong with a bundle for this expectation; empty when it is what it should be. */
export function bundleProblems(evidence: BundleEvidence, expectation: SigningExpectation): readonly string[] {
  const report = parseCodesign(evidence.codesign)
  if (!expectation.signed) {
    // no certificate was supplied, so nothing may have signed with one — a build signed by
    // whatever sits in a keychain would carry an identity nobody chose
    const identity = report.authorities[0] ?? report.teamId
    return identity === undefined || identity === null
      ? []
      : [`signed by "${identity}" although no Apple credentials were supplied — a keychain identity must not sign a build`]
  }
  const problems: string[] = []
  if (report.unsigned || report.adhoc) {
    problems.push('not signed with a certificate (ad-hoc or unsigned)')
  } else if (!report.authorities.some((a) => a.startsWith(DEVELOPER_ID))) {
    problems.push(`no Developer ID Application authority (found: ${report.authorities.join(' / ') || 'none'})`)
  }
  if (report.teamId !== expectation.teamId) {
    problems.push(`TeamIdentifier ${report.teamId ?? 'not set'}, expected ${expectation.teamId}`)
  }
  if (!report.hardenedRuntime) problems.push('hardened runtime flag missing')
  if (evidence.verifyOk !== true) problems.push('codesign --verify --deep --strict did not pass')
  if (evidence.staplerOk !== true) problems.push('no stapled notarization ticket (xcrun stapler validate did not pass)')
  if (evidence.assessment === null) {
    problems.push('Gatekeeper assessment not run')
  } else if (!/: accepted$/m.test(evidence.assessment) || !/^source=Notarized Developer ID$/m.test(evidence.assessment)) {
    problems.push(`Gatekeeper assessment: ${evidence.assessment.trim().split('\n').join('; ')}`)
  }
  return problems
}

/** One phrase for the report line: what the bundle carries. */
export function describeSignature(codesign: string): string {
  const report = parseCodesign(codesign)
  if (report.unsigned) return 'unsigned'
  if (report.adhoc && report.authorities.length === 0) return 'ad-hoc'
  const runtime = report.hardenedRuntime ? 'hardened runtime' : 'no hardened runtime'
  return `${report.authorities[0] ?? 'unknown identity'}, ${runtime}`
}
