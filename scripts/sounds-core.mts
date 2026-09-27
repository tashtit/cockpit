/**
 * Cockpit's notification sounds, synthesized: every sample comes from the numbers in this
 * file, so the sounds are the app's own — nothing recorded, sampled or licensed, and
 * nothing to list in the third-party notices. IO-free; `npm run sounds` (build-sounds.mts)
 * writes them to resources/sounds/, and tests/sounds.test.ts fails when the committed
 * files and this file disagree.
 *
 * Each sound is a few strikes on one struck body — a glass bar, a tuned tine, a wooden
 * bar. A strike is what a mallet does: a few milliseconds of contact noise through the
 * body's own band, then the body's modes ringing, each at its own rate, the high ones
 * dying first and every one leaving a slow second stage behind (the tail that makes a
 * struck thing sound struck rather than switched off). Softer strikes are darker. The
 * strikes sit a little apart in stereo, and a small Freeverb-style room holds them.
 */

export const SAMPLE_RATE = 48_000

/** One mode of the body: a multiple of the note's pitch, its level, how fast it dies (seconds to 1/e). */
type Mode = { readonly ratio: number; readonly gain: number; readonly decay: number }

type Body = {
  readonly modes: readonly Mode[]
  /** The slow second stage: `share` of each mode rings on `stretch` times longer */
  readonly ring: { readonly share: number; readonly stretch: number }
  /** The mallet's contact: noise through a resonant band at `hz`, gone in `decay` seconds */
  readonly contact: { readonly hz: number; readonly q: number; readonly gain: number; readonly decay: number }
  /** How much a softer strike loses its upper modes: 0 none, 1 a lot */
  readonly soften: number
}

type Strike = {
  /** Seconds from the start */
  readonly at: number
  readonly hz: number
  readonly gain: number
  /** Where it sits, -1 left to 1 right */
  readonly pan: number
  /** How far the pitch sags by the end of the note, as a fraction of `hz` */
  readonly sag?: number
}

type Design = {
  readonly body: Body
  readonly strikes: readonly Strike[]
  readonly seconds: number
  readonly room: { readonly rt60: number; readonly mix: number }
  /**
   * Target loudness, LUFS (momentary, the loudest 400ms). On that scale macOS's Glass
   * measures -22.6 and Basso -26.5: the finish sits at Glass, a question a hair above it,
   * and a failure between the two — quieter than good news would be odd, but no alarm.
   */
  readonly loudness: number
  /** Seeds the contact noise, so a rerun writes the same file */
  readonly seed: number
}

/** Equal-tempered pitch, A4 = 440 */
const note = (semitonesFromA4: number): number => 440 * 2 ** (semitonesFromA4 / 12)

export const SOUNDS = {
  /**
   * A turn finished: two strikes on a glass bar a fifth apart, rising (E5 → B5), the
   * first a little left, the second a little right. 2.756 and 5.404 are a free bar's
   * own upper modes (a glockenspiel's), and the fundamental rings against a slightly
   * sharp twin for a slow shimmer.
   */
  finish: {
    body: {
      modes: [
        { ratio: 1, gain: 1, decay: 0.2 },
        { ratio: 1.0021, gain: 0.32, decay: 0.25 },
        { ratio: 2, gain: 0.07, decay: 0.13 },
        { ratio: 2.756, gain: 0.13, decay: 0.07 },
        { ratio: 5.404, gain: 0.045, decay: 0.024 }
      ],
      ring: { share: 0.14, stretch: 1.8 },
      contact: { hz: 3400, q: 1.1, gain: 0.22, decay: 0.0035 },
      soften: 0.5
    },
    strikes: [
      { at: 0, hz: note(7), gain: 0.72, pan: -0.22 },
      { at: 0.11, hz: note(14), gain: 1, pan: 0.22 }
    ],
    seconds: 1.65,
    room: { rt60: 0.9, mix: 0.2 },
    loudness: -22.5,
    seed: 0x0f1a15
  },
  /**
   * An agent is waiting on you: a tap-tap and a lift on a kalimba-like tine (B5, B5, D♯6),
   * ending on the leading tone of the finish sound's key — unresolved, like a question.
   * 6.267 is a clamped tine's second mode, which gives the pluck its metallic edge; the
   * second tap is softer, so it is darker too.
   */
  asks: {
    body: {
      modes: [
        { ratio: 1, gain: 1, decay: 0.18 },
        { ratio: 2, gain: 0.05, decay: 0.09 },
        { ratio: 6.267, gain: 0.08, decay: 0.015 }
      ],
      ring: { share: 0.15, stretch: 1.8 },
      contact: { hz: 2200, q: 1.4, gain: 0.26, decay: 0.003 },
      soften: 0.7
    },
    strikes: [
      { at: 0, hz: note(14), gain: 0.72, pan: -0.08 },
      { at: 0.09, hz: note(14), gain: 0.5, pan: -0.08 },
      { at: 0.2, hz: note(18), gain: 1, pan: 0.16 }
    ],
    seconds: 1.5,
    room: { rt60: 0.75, mix: 0.17 },
    loudness: -22,
    seed: 0xa5c5
  },
  /**
   * A turn failed or a pull request went red: two soft-mallet strikes on a wooden bar a
   * minor third apart, falling (F♯4 → D♯4), the second sagging a little — plainly not the
   * finish sound, without sounding like an alarm. 3.93 and 9.2 are a tuned marimba bar's
   * upper modes. (Not G → E: those open NBC's registered G-E-C chime, and no sound here
   * should.)
   */
  fail: {
    body: {
      modes: [
        { ratio: 1, gain: 1, decay: 0.18 },
        { ratio: 3.93, gain: 0.16, decay: 0.04 },
        { ratio: 9.2, gain: 0.035, decay: 0.01 }
      ],
      ring: { share: 0.25, stretch: 1.7 },
      contact: { hz: 950, q: 0.9, gain: 0.3, decay: 0.005 },
      soften: 0.5
    },
    strikes: [
      { at: 0, hz: note(-3), gain: 1, pan: -0.14 },
      { at: 0.15, hz: note(-6), gain: 0.95, pan: 0.08, sag: 0.02 }
    ],
    seconds: 1.4,
    room: { rt60: 0.6, mix: 0.14 },
    loudness: -23.5,
    seed: 0xfa11
  }
} as const satisfies Record<string, Design>

export type SoundName = keyof typeof SOUNDS
export const SOUND_NAMES = Object.keys(SOUNDS) as readonly SoundName[]

/** Two channels of samples in [-1, 1] */
export type Stereo = { readonly left: Float64Array; readonly right: Float64Array }

/** Onset ramp: long enough not to click, short enough to still sound struck */
const ATTACK_S = 0.003
/** Fade at the very end, so the file stops on silence whatever the reverb is still doing */
const TAIL_FADE_S = 0.15
/** How fast a sagging pitch gets most of the way down */
const SAG_S = 0.15

/** Raised-cosine ramp from 0 to 1 over `span` samples */
const ramp = (i: number, span: number): number => (i >= span ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * i) / span))

/** Marsaglia's xorshift32, as numbers in [-1, 1): deterministic noise for the mallet's contact */
function noise(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 2 ** 31 - 1
  }
}

/** Equal-power pan: how much of a centred signal each side gets */
const panGains = (pan: number): readonly [number, number] => {
  const angle = ((pan + 1) * Math.PI) / 4
  return [Math.cos(angle), Math.sin(angle)]
}

/** One strike, mono, starting at sample 0 */
function strike(s: Strike, body: Body, rand: () => number): Float64Array {
  const out = new Float64Array(Math.round(4 * SAMPLE_RATE))
  const attack = Math.round(ATTACK_S * SAMPLE_RATE)
  const sag = s.sag ?? 0
  const { share, stretch } = body.ring
  let end = 0
  for (const m of body.modes) {
    // a soft strike barely excites the high modes: level falls with how far up the mode is
    const level = s.gain * m.gain * s.gain ** (body.soften * Math.log2(m.ratio))
    let phase = 0
    for (let i = 0; i < out.length; i++) {
      const t = i / SAMPLE_RATE
      const env = (1 - share) * Math.exp(-t / m.decay) + share * Math.exp(-t / (m.decay * stretch))
      const a = level * ramp(i, attack) * env
      if (a < 1e-6 && i > attack) {
        end = Math.max(end, i)
        break
      }
      out[i] += a * Math.sin(phase)
      phase += (2 * Math.PI * s.hz * m.ratio * (1 - sag * (1 - Math.exp(-t / SAG_S)))) / SAMPLE_RATE
    }
  }
  // the contact: noise through a band-pass (RBJ's cookbook biquad, constant peak gain)
  const c = body.contact
  const w = (2 * Math.PI * c.hz) / SAMPLE_RATE
  const alpha = Math.sin(w) / (2 * c.q)
  const a0 = 1 + alpha
  const [b0, b2, a1, a2] = [alpha / a0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0]
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  const span = Math.round(c.decay * 8 * SAMPLE_RATE)
  const onset = Math.round(0.0005 * SAMPLE_RATE)
  for (let i = 0; i < span; i++) {
    const x = rand() * ramp(i, onset) * Math.exp(-i / SAMPLE_RATE / c.decay)
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2
    ;[x2, x1, y2, y1] = [x1, x, y1, y]
    out[i] += c.gain * s.gain * y
  }
  return out.subarray(0, Math.max(end, span))
}

/** Freeverb's comb and allpass lengths (samples at 44.1kHz): mutually prime, so no echo lines up with another */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASSES = [556, 441, 341, 225]
/** Freeverb's right channel runs every line this much longer, which is what makes the room wide */
const STEREO_SPREAD = 23
/** How much each comb's feedback is low-passed: highs die first, as in a real room, and no attack echoes back sharp */
const DAMP = 0.4

/**
 * One side of a Freeverb: eight damped feedback combs in parallel, then four allpasses in
 * series to smear their echoes into a smooth tail. Freeverb (Jezar at Dreampoint, 2000)
 * is public domain; only its tuning numbers come from it, the filters are written here.
 */
function roomSide(input: Float64Array, rt60: number, spread: number): Float64Array {
  const at = (n: number): number => Math.round(((n + spread) * SAMPLE_RATE) / 44_100)
  const wet = new Float64Array(input.length)
  for (const n of COMBS) {
    const d = at(n)
    const feedback = 10 ** (-3 * (d / SAMPLE_RATE / rt60))
    const line = new Float64Array(input.length)
    let low = 0
    for (let i = 0; i < input.length; i++) {
      const out = i >= d ? line[i - d] : 0
      low = out * (1 - DAMP) + low * DAMP
      line[i] = input[i] + low * feedback
      wet[i] += out / COMBS.length
    }
  }
  for (const n of ALLPASSES) {
    const d = at(n)
    const line = new Float64Array(input.length)
    for (let i = 0; i < wet.length; i++) {
      const out = i >= d ? line[i - d] : 0
      line[i] = wet[i] + out * 0.5
      wet[i] = out - wet[i]
    }
  }
  return wet
}

/** ITU-R BS.1770 K-weighting at 48kHz: a +4dB shelf above ~1.5kHz, then a high-pass — how loud a sound seems, not how big it is */
const K_STAGES = [
  { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] }
] as const
const MOMENTARY_S = 0.4

function kWeighted(x: Float64Array): Float64Array {
  let y = x
  for (const { b, a } of K_STAGES) {
    const out = new Float64Array(y.length)
    let [x1, x2, y1, y2] = [0, 0, 0, 0]
    for (let i = 0; i < y.length; i++) {
      const v = b[0] * y[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
      ;[x2, x1, y2, y1] = [x1, y[i], y1, v]
      out[i] = v
    }
    y = out
  }
  return y
}

/** Loudness in LUFS: BS.1770's momentary loudness (400ms windows), the loudest window */
export function loudness(sound: Stereo): number {
  const [l, r] = [kWeighted(sound.left), kWeighted(sound.right)]
  const win = Math.round(MOMENTARY_S * SAMPLE_RATE)
  const hop = Math.round(0.01 * SAMPLE_RATE)
  let loudest = 0
  for (let at = 0; at < l.length; at += hop) {
    let sum = 0
    for (let i = at; i < Math.min(at + win, l.length); i++) sum += l[i] * l[i] + r[i] * r[i]
    loudest = Math.max(loudest, sum / win)
  }
  return -0.691 + 10 * Math.log10(loudest)
}

/** The sound at its design loudness, ending on silence */
export function render(name: SoundName): Stereo {
  const d: Design = SOUNDS[name]
  const length = Math.round(d.seconds * SAMPLE_RATE)
  const dry: [Float64Array, Float64Array] = [new Float64Array(length), new Float64Array(length)]
  d.strikes.forEach((s, n) => {
    const mono = strike(s, d.body, noise(d.seed + n))
    const start = Math.round(s.at * SAMPLE_RATE)
    const [gl, gr] = panGains(s.pan)
    for (let i = 0; start + i < length && i < mono.length; i++) {
      dry[0][start + i] += gl * mono[i]
      dry[1][start + i] += gr * mono[i]
    }
  })
  const send = dry[0].map((v, i) => (v + dry[1][i]) / 2)
  const [wl, wr] = [roomSide(send, d.room.rt60, 0), roomSide(send, d.room.rt60, STEREO_SPREAD)]
  const left = dry[0].map((v, i) => v + d.room.mix * wl[i])
  const right = dry[1].map((v, i) => v + d.room.mix * wr[i])
  const fade = Math.round(TAIL_FADE_S * SAMPLE_RATE)
  for (let i = 0; i < fade; i++) {
    left[length - 1 - i] *= ramp(i, fade)
    right[length - 1 - i] *= ramp(i, fade)
  }
  const gain = 10 ** ((d.loudness - loudness({ left, right })) / 20)
  return { left: left.map((v) => v * gain), right: right.map((v) => v * gain) }
}

/** 16-bit PCM stereo WAV, the one format afplay and every audio tool reads without question */
export function encodeWav(sound: Stereo): Uint8Array {
  const frames = sound.left.length
  const bytes = new Uint8Array(44 + frames * 4)
  const v = new DataView(bytes.buffer)
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i)
  }
  const pcm = (x: number): number => Math.round(Math.max(-1, Math.min(1, x)) * 32767)
  tag(0, 'RIFF')
  v.setUint32(4, bytes.length - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 2, true) // stereo
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, SAMPLE_RATE * 4, true)
  v.setUint16(32, 4, true)
  v.setUint16(34, 16, true)
  tag(36, 'data')
  v.setUint32(40, frames * 4, true)
  for (let i = 0; i < frames; i++) {
    v.setInt16(44 + i * 4, pcm(sound.left[i]), true)
    v.setInt16(46 + i * 4, pcm(sound.right[i]), true)
  }
  return bytes
}

/** Samples back out of a WAV `encodeWav` wrote — what the test compares the committed files by */
export function decodeWav(bytes: Uint8Array): Stereo {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frames = v.getUint32(40, true) / 4
  const left = new Float64Array(frames)
  const right = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    left[i] = v.getInt16(44 + i * 4, true) / 32767
    right[i] = v.getInt16(46 + i * 4, true) / 32767
  }
  return { left, right }
}
