/**
 * Writes Cockpit's notification sounds to resources/sounds/ from their definitions in
 * sounds-core.mts. The files are committed (electron-builder ships them outside the asar,
 * where afplay can read them); rerun after changing a definition and commit the result.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeWav, loudness, render, SAMPLE_RATE, SOUND_NAMES } from './sounds-core.mts'

const dir = join(import.meta.dirname, '..', 'resources', 'sounds')
mkdirSync(dir, { recursive: true })
for (const name of SOUND_NAMES) {
  const samples = render(name)
  const file = join(dir, `${name}.wav`)
  writeFileSync(file, encodeWav(samples))
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  console.log(
    `${file}: ${(samples.length / SAMPLE_RATE).toFixed(2)}s, ` +
      `loudest 50ms ${loudness(samples).toFixed(1)} dBFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`
  )
}
