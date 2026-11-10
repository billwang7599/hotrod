// What this machine lets tests do. A run inside a Kothar session (a worker running the tests) is already in
// Kothar's macOS sandbox, and a sandboxed process can't apply a second sandbox, run the setuid /bin/ps or write
// /tmp. Tests that need one of these skip with the reason instead of failing.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { TestContext } from 'vitest'

const INSIDE = 'likely because the tests run inside a sandbox already, such as a Kothar session'

const probeSandbox = () => {
  if (process.platform !== 'darwin') return undefined
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
    encoding: 'utf8',
  })
  if (probe.status === 0) return undefined
  return `sandbox-exec can't apply a sandbox here (${(probe.stderr || String(probe.error)).trim()}), ${INSIDE}`
}

const probePs = () => {
  const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(process.pid)], { encoding: 'utf8' })
  if (probe.status === 0 && probe.stdout.trim() !== '') return undefined
  return `ps can't run here (${(probe.stderr || String(probe.error)).trim()}), ${INSIDE}`
}

const probeTmp = () => {
  try {
    rmSync(mkdtempSync('/tmp/kothar-probe-'), { recursive: true, force: true })
    return undefined
  } catch (error) {
    return `/tmp isn't writable here (${(error as Error).message}), ${INSIDE}`
  }
}

export const cantSandbox = probeSandbox()
export const cantPs = probePs()
export const cantWriteTmp = probeTmp()

// Skips the test, with every reason given, when any of them is set. Skipped tests show the reason in the report.
// On CI (the CI variable set) it fails instead: CI machines aren't sandboxed, so a missing ps or /tmp there is a
// broken runner, not a reason to pass quietly. The sandbox check is macOS-only and never set elsewhere, and the
// macOS-only tests skip on Linux with skipIf before reaching here.
export const needs = (context: TestContext, ...reasons: (string | undefined)[]) => {
  const missing = reasons.filter(Boolean).join('; ')
  if (!missing) return
  if (process.env.CI) throw new Error(`This test can't run on CI: ${missing}`)
  context.skip(missing)
}
