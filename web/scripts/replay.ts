// Replay a field-test log offline: npx tsx scripts/replay.ts <log.jsonl> [options]
// Feeds the logged detections and tilt through the same tracker, geometry, and alert policy as the app, with
// config.ts (or overrides), and writes the alerts it would produce. With no overrides the alerts must match the walk.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compareAlerts, loggedAlerts, parseLog, replayLog, serializeLog } from '../src/telemetry/replay'
import type { AudioMode } from '../src/telemetry/replay'

const USAGE = `Usage: npx tsx scripts/replay.ts <log.jsonl> [options]

  --overrides <file.json>   values to change in config.ts, same shape, e.g. {"alerts":{"urgentDistanceM":2}}
  --use-logged-config       start from the CONFIG stored in the log instead of the current config.ts
  --audio logged|simulated  how audio outcomes reach the policy (default: logged when nothing is overridden)
  --out <file.jsonl>        where to write the replayed log (default: <log folder>/replay/<log name>)
  --check                   exit with code 1 if the replayed alerts differ from the logged ones`

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

const args = process.argv.slice(2)
const flags = new Set(['--use-logged-config', '--check'])
const options = new Map<string, string>()
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (flags.has(arg)) options.set(arg, 'true')
  else if (arg.startsWith('--')) {
    const value = args[++i]
    if (value === undefined) fail(`${arg} needs a value`)
    options.set(arg, value)
  } else positional.push(arg)
}
if (positional.length !== 1) fail('Give exactly one log file')
const [logPath] = positional

const audio = options.get('--audio')
if (audio !== undefined && audio !== 'logged' && audio !== 'simulated') fail('--audio must be logged or simulated')
let overrides: Record<string, unknown> | undefined
const overridesPath = options.get('--overrides')
if (overridesPath) {
  try {
    overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    fail(`Cannot read overrides ${overridesPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const events = parseLog(readFileSync(logPath, 'utf8'))
const result = replayLog(events, {
  overrides,
  useLoggedConfig: options.has('--use-logged-config'),
  audio: audio as AudioMode | undefined,
})

const outPath = options.get('--out') ?? join(dirname(logPath), 'replay', basename(logPath))
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, serializeLog(result.events))

const comparison = compareAlerts(loggedAlerts(events), result.alerts)
console.log(`Replayed ${result.frames} frames (audio: ${result.audio}${overrides ? ', with overrides' : ''}).`)
console.log(`Alerts: ${comparison.logged} logged, ${comparison.replayed} replayed; dropped before audio: ${result.drops.length}.`)
if (comparison.same) console.log('The replayed alerts match the logged alerts.')
else {
  console.log(`${comparison.differences.length} difference(s):`)
  for (const line of comparison.differences) console.log(`  ${line}`)
}
console.log(`Wrote ${outPath}`)
if (options.has('--check') && !comparison.same) process.exit(1)
