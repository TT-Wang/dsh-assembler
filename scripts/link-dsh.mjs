#!/usr/bin/env node
/**
 * Link the DeepSeek Harness peer packages into node_modules for local development.
 * Same pattern as dsh-cs-tools: peers are host-provided; symlink from the checkout.
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
for (const [name, rel] of Object.entries(PEERS)) {
  const target = join(root, rel)
  const link = join(modulesDir, name)
  if (!existsSync(target)) {
    console.warn(`skip ${name}: ${target} missing`)
    continue
  }
  if (existsSync(link)) {
    try {
      const stat = lstatSync(link)
      if (stat.isSymbolicLink() && readlinkSync(link) === target) continue
    } catch { /* fall through and replace */ }
    rmSync(link, { recursive: true, force: true })
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  console.log(`linked ${name} -> ${target}`)
}
// js-yaml (plain dep for catalog parsing) and tsx (dev runner)
for (const [name, pkg] of Object.entries({
  'js-yaml': 'node_modules/js-yaml',
  'tsx': 'node_modules/tsx',
})) {
  const target = join(root, pkg)
  const link = join(modulesDir, name)
  if (!existsSync(target)) {
    console.warn(`skip ${name}: ${target} missing`)
    continue
  }
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
  }
  console.log(`linked ${name} -> ${target}`)
}
console.log('done')
