/**
 * Cockpit's notification sounds, synthesized: every sample comes from the numbers in this
 * file, so the sounds are the app's own — nothing recorded, sampled or licensed, and
 * nothing to list in the third-party notices. IO-free; `npm run sounds` (build-sounds.mts)
 * writes them to resources/sounds/, and tests/sounds.test.ts fails when the committed
 * files and this file disagree.
 *
 * Each sound is a pair of struck notes. A note is a handful of sine partials — the modes a
 * struck bar rings in — each fading at its own rate, the high ones fastest, so the attack
 * is bright and the tail is round. A small Freeverb-style reverb puts them in a room.
 */

export const SAMPLE_RATE = 48_000

/** One mode of a struck bar: a multiple of the note's pitch, its level, how fast it dies (seconds to 1/e). */
type Partial = { readonly ratio: number; readonly gain: number; readonly decay: number }

type Strike = {
  /** Seconds from the start */
  readonly at: number
  readonly hz: number
  readonly gain: number
  /** How far the pitch sags by the end of the note, as a fraction of `hz` */
  readonly sag?: number
}

type Design = {
  readonly strikes: readonly Strike[]
  readonly partials: readonly Partial[]
  readonly seconds: number
  readonly room: { readonly rt60: number; readonly mix: number }
  /** The loudest 50ms, dBFS — matched to the macOS sound each one replaced, so neither jumps out */
  readonly loudness: number
}

/** Equal-tempered pitch, A4 = 440 */
const note = (semitonesFromA4: number): number => 440 * 2 ** (semitonesFromA4 / 12)

export const SOUNDS = {
  /**
   * A turn finished, or an agent is asking: two bright bar strikes a fifth apart, rising
   * (E5 → B5). The fundamental rings against a slightly sharp twin for a slow shimmer; the
   * 2.76 and 5.40 modes are a free bar's own and give the strike its glassy tick.
   */
  finish: {
    strikes: [
      { at: 0, hz: note(7), gain: 0.72 },
      { at: 0.11, hz: note(14), gain: 1 }
    ],
    partials: [
      { ratio: 1, gain: 1, decay: 0.42 },
      { ratio: 1.0016, gain: 0.3, decay: 0.55 },
      { ratio: 2, gain: 0.16, decay: 0.2 },
      { ratio: 2.76, gain: 0.1, decay: 0.08 },
      { ratio: 5.4, gain: 0.05, decay: 0.018 }
    ],
    seconds: 1.15,
    room: { rt60: 0.7, mix: 0.16 },
    loudness: -19.5
  },
  /**
   * A turn failed or a pull request went red: two warm, short wooden strikes a minor third
   * apart, falling (G4 → E4), the second sagging a little — plainly not the finish sound,
   * without sounding like an alarm. 3.93 and 9.2 are a tuned marimba bar's upper modes.
   */
  fail: {
    strikes: [
      { at: 0, hz: note(-2), gain: 1 },
      { at: 0.15, hz: note(-5), gain: 0.95, sag: 0.02 }
    ],
    partials: [
      { ratio: 1, gain: 1, decay: 0.28 },
      { ratio: 3.93, gain: 0.2, decay: 0.05 },
      { ratio: 9.2, gain: 0.06, decay: 0.012 }
    ],
    seconds: 0.8,
    room: { rt60: 0.5, mix: 0.12 },
    loudness: -20.5
  }
} as const satisfies Record<string, Design>

export type SoundName = keyof typeof SOUNDS
export const SOUND_NAMES = Object.keys(SOUNDS) as readonly SoundName[]

/** Onset ramp: long enough not to click, short enough to still sound struck */
const ATTACK_S = 0.004
/** Fade at the very end, so the file stops on silence whatever the reverb is still doing */
const TAIL_FADE_S = 0.08
/** How fast a sagging pitch gets most of the way down */
const SAG_S = 0.15

/** Raised-cosine ramp from 0 to 1 over `span` samples */
const ramp = (i: number, span: number): number => (i >= span ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * i) / span))

function strike(out: Float64Array, s: Strike, partials: readonly Partial[]): void {
  const start = Math.round(s.at * SAMPLE_RATE)
  const attack = Math.round(ATTACK_S * SAMPLE_RATE)
  const sag = s.sag ?? 0
  for (const p of partials) {
    let phase = 0
    for (let i = 0; start + i < out.length; i++) {
      const t = i / SAMPLE_RATE
      const level = s.gain * p.gain * ramp(i, attack) * Math.exp(-t / p.decay)
      if (level < 1e-6 && i > attack) break
      out[start + i] += level * Math.sin(phase)
      const hz = s.hz * p.ratio * (1 - sag * (1 - Math.exp(-t / SAG_S)))
      phase += (2 * Math.PI * hz) / SAMPLE_RATE
    }
  }
}

/** Freeverb's comb and allpass lengths (samples at 44.1kHz): mutually prime, so no echo lines up with another */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASSES = [556, 441, 341, 225]
/** How much each comb's feedback is low-passed: highs die first, as in a real room, and no attack echoes back sharp */
const DAMP = 0.4

/**
 * A mono Freeverb: eight damped feedback combs in parallel, then four allpasses in series
 * to smear their echoes into a smooth tail. `rt60` is how long the tail takes to fall by
 * 60dB; `mix` is how much of it is heard beside the dry sound.
 */
function room(dry: Float64Array, rt60: number, mix: number): Float64Array {
  const at = (n: number): number => Math.round((n * SAMPLE_RATE) / 44_100)
  const wet = new Float64Array(dry.length)
  for (const n of COMBS) {
    const d = at(n)
    const feedback = 10 ** (-3 * (d / SAMPLE_RATE / rt60))
    const line = new Float64Array(dry.length)
    let low = 0
    for (let i = 0; i < dry.length; i++) {
      const out = i >= d ? line[i - d] : 0
      low = out * (1 - DAMP) + low * DAMP
      line[i] = dry[i] + low * feedback
      wet[i] += out / COMBS.length
    }
  }
  for (const n of ALLPASSES) {
    const d = at(n)
    const line = new Float64Array(dry.length)
    for (let i = 0; i < wet.length; i++) {
      const out = i >= d ? line[i - d] : 0
      line[i] = wet[i] + out * 0.5
      wet[i] = out - wet[i]
    }
  }
  return dry.map((v, i) => v + mix * wet[i])
}

const WINDOW_S = 0.05

/** RMS of the loudest 50ms window (half-overlapped), in dBFS */
export function loudness(samples: Float64Array): number {
  const win = Math.round(WINDOW_S * SAMPLE_RATE)
  let loudest = 0
  for (let at = 0; at + win <= samples.length; at += win / 2) {
    let sum = 0
    for (let i = at; i < at + win; i++) sum += samples[i] * samples[i]
    loudest = Math.max(loudest, Math.sqrt(sum / win))
  }
  return 20 * Math.log10(loudest)
}

/** The sound as samples in [-1, 1], at its design loudness and ending on silence */
export function render(name: SoundName): Float64Array {
  const d: Design = SOUNDS[name]
  const dry = new Float64Array(Math.round(d.seconds * SAMPLE_RATE))
  for (const s of d.strikes) strike(dry, s, d.partials)
  const out = room(dry, d.room.rt60, d.room.mix)
  const fade = Math.round(TAIL_FADE_S * SAMPLE_RATE)
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= ramp(i, fade)
  const gain = 10 ** ((d.loudness - loudness(out)) / 20)
  return out.map((v) => v * gain)
}

/** 16-bit PCM mono WAV, the one format afplay and every audio tool reads without question */
export function encodeWav(samples: Float64Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const v = new DataView(bytes.buffer)
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  v.setUint32(4, bytes.length - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, SAMPLE_RATE * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true)
  }
  return bytes
}

/** Samples back out of a WAV `encodeWav` wrote — what the test compares the committed files by */
export function decodeWav(bytes: Uint8Array): Float64Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = v.getUint32(40, true) / 2
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) out[i] = v.getInt16(44 + i * 2, true) / 32767
  return out
}
