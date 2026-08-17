#!/usr/bin/env node
/**
 * Lockfile portability gate.
 *
 * The peer packages are symlinked into node_modules for local development
 * (`npm run link:dsh`). npm does not know it did not create those links, so the
 * next `npm install` records each one — and its whole transitive closure — as a
 * file link keyed by a path on THIS machine. The lockfile then resolves only
 * here: on any other checkout `npm ci` reaches for a harness snapshot directory
 * that does not exist. It shipped that way once, silently, because nothing
 * looked.
 *
 * So: a lockfile may name the registry and nothing else. If this gate fires,
 * regenerate rather than hand-edit — `rm -rf node_modules package-lock.json &&
 * npm install`, then `npm run link:dsh` — and keep that order, because the link
 * step must come after the install that writes the lock.
 *
 * Usage: node scripts/lock-check.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'))

const offenders = []
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  const resolved = entry.resolved ?? ''
  // A key that climbs out of the repo, an entry flagged as a link, or a
  // resolution that is not an https registry URL: all three mean the same
  // thing — this row describes a directory on one particular disk.
  if (key.startsWith('..') || key.startsWith('/')) offenders.push(`${key} — key escapes the repo`)
  else if (entry.link === true) offenders.push(`${key} — recorded as a link to ${resolved || '(unstated)'}`)
  else if (resolved !== '' && !resolved.startsWith('https://')) offenders.push(`${key} — resolves to ${resolved}`)
}

if (offenders.length > 0) {
  console.error(`lock-check: package-lock.json carries ${offenders.length} machine-local entr${offenders.length === 1 ? 'y' : 'ies'}:`)
  for (const line of offenders.slice(0, 20)) console.error(`  ${line}`)
  if (offenders.length > 20) console.error(`  … and ${offenders.length - 20} more`)
  console.error('regenerate: rm -rf node_modules package-lock.json && npm install && npm run link:dsh')
  process.exit(1)
}

const total = Object.keys(lock.packages ?? {}).length
console.log(`lock-check: OK — ${total} entries, all registry-resolved`)
