// Regenerate the synthetic test log and its labels in field-tests/fixture/: npx tsx scripts/make-fixture.ts
// The fixture is a simulated walk (no camera), run through the real pipeline and logger. Rerun it when the log
// format changes, then check that `npx tsx scripts/replay.ts field-tests/fixture/walk-fixture.jsonl --check` passes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FIXTURE_WALK_ID, simulateWalk } from '../src/telemetry/fixtureWalk'

const dir = fileURLToPath(new URL('../../field-tests/fixture/', import.meta.url))
mkdirSync(dir, { recursive: true })
const walk = simulateWalk()
writeFileSync(`${dir}${FIXTURE_WALK_ID}.jsonl`, walk.lines.map((line) => `${line}\n`).join(''))
const header = 'walk_id,obstacle_id,spoken_name,t_visible_s,t_reached_s,in_path,notes'
const rows = walk.labels.map((l) => [l.walk_id, l.obstacle_id, l.spoken_name, l.t_visible_s, l.t_reached_s, l.in_path, l.notes].join(','))
writeFileSync(`${dir}labels.csv`, `${[header, ...rows].join('\n')}\n`)
console.log(`Wrote ${walk.lines.length} log lines and ${walk.labels.length} labels to ${dir}`)
