import { execFileSync, spawn } from 'node:child_process'

/**
 * A named pipe nobody writes to, for the tests that prove a reader skips one. Should a
 * read block on it anyway, a writer opens it a few seconds later and ends that read —
 * so a regression fails its timing assertion instead of hanging the suite, since a
 * blocked synchronous read stops the timers a test timeout would need. Returns the
 * cleanup that stops the writer.
 */
export function makeFifo(path: string): () => void {
  execFileSync('mkfifo', [path])
  const writer = spawn('sh', ['-c', 'sleep 3; : > "$0"', path], { stdio: 'ignore' })
  writer.unref()
  return () => {
    writer.kill()
  }
}
