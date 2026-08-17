#!/usr/bin/env node
/**
 * Link the DeepSeek Harness peer packages into node_modules for local development.
 * Same pattern as dsh-cs-tools: peers are host-provided; symlink from the checkout.
 *
 * Only the peers listed below are managed here. Plain dependencies (js-yaml) belong
 * to npm and must not be borrowed from the harness — a borrowed copy survives every
 * `npm install` and silently pins itself to whichever checkout was current the day
 * the link was made.
 *
 * Usage: npm run link:dsh
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Peer package name -> its path inside the harness checkout. */
const PEERS = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
}

function resolveHarnessRoot() {
  if (process.env.DSH_SOURCE) return process.env.DSH_SOURCE
  for (const candidate of [
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'source/current'),
    join(homedir(), '.dsh/source/current'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('dsh checkout not found — set DSH_SOURCE')
}

const root = resolveHarnessRoot()
const modulesDir = join(REPO, 'node_modules')
mkdirSync(modulesDir, { recursive: true })

/**
 * Point `node_modules/<name>` at `target`, replacing whatever is there.
 * A link that already exists but resolves elsewhere is REPLACED, not kept:
 * a checkout that moves (or a `source/current` that flips to a new release)
 * would otherwise leave the old target in place and go on serving a previous
 * generation's code from under a current-looking name.
 */
function ensureLink(name, target) {
  const link = join(modulesDir, name)
  if (!existsSync(target)) {
    console.warn(`skip ${name}: ${target} missing`)
    return
  }
  if (existsSync(link) || isDanglingLink(link)) {
    try {
      const stat = lstatSync(link)
      if (stat.isSymbolicLink() && readlinkSync(link) === target) return
    } catch { /* fall through and replace */ }
    rmSync(link, { recursive: true, force: true })
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  console.log(`linked ${name} -> ${target}`)
}

/** A symlink whose target has vanished: invisible to existsSync, still in the way of symlinkSync. */
function isDanglingLink(link) {
  try {
    return lstatSync(link).isSymbolicLink()
  } catch {
    return false
  }
}

for (const [name, rel] of Object.entries(PEERS)) ensureLink(name, join(root, rel))
console.log('done')
