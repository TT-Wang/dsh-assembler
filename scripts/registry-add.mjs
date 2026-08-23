#!/usr/bin/env node
/**
 * registry-add — shadcn 系 registry 条目联邦进目录(P2 生态吸收)。
 *
 * 协议出处:shadcn registry-item.json(name/type/title/description/files[]/
 * dependencies/registryDependencies/…)——业界零件分发协议的最佳先例:分发
 * 源码而非编译包。本适配器把一个远程条目收进 vendor-registry/<ns>/<name>/,
 * 供应链入 index/registry.lock.yml(url/type/依赖/许可证/收录时间)。
 *
 * 质检门(机械):schema 形状、文件 target 路径穿越拒绝、files 非空且都带
 * content(远程 file-content 模式)。消费侧:app-shell/前端车道把这些源码
 * 当素材编译进应用(React 组件不能直接当我们的静态模板,诚实分层)。
 *
 * 用法:node scripts/registry-add.mjs <item-json-url> [--ns <namespace>] [--dry]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 形状与安全校验(纯函数,单测覆盖):返回问题清单,空 = 过。 */
export function validateRegistryItem(item) {
  const problems = []
  if (item === null || typeof item !== 'object') return ['not an object']
  if (typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.name)) problems.push('name 缺失或非 kebab-case')
  if (typeof item.type !== 'string' || !item.type.startsWith('registry:')) problems.push('type 缺失或非 registry:*')
  const files = Array.isArray(item.files) ? item.files : []
  if (files.length === 0) problems.push('files 为空')
  for (const [i, f] of files.entries()) {
    const rel = typeof f?.target === 'string' && f.target !== '' ? f.target : (typeof f?.path === 'string' ? f.path : '')
    if (rel === '') { problems.push(`files[${i}] 缺 path/target`); continue }
    const norm = rel.replace(/\\/g, '/')
    if (norm.startsWith('/') || norm.split('/').includes('..')) problems.push(`files[${i}] 路径越界:${rel}`)
    if (typeof f.content !== 'string') problems.push(`files[${i}] 缺 content(需 file-content 模式的条目)`)
  }
  return problems
}

/** 落盘目标名:target 优先(去掉可能的前导 ~/)。 */
export function fileTargetOf(f) {
  const rel = (typeof f.target === 'string' && f.target !== '' ? f.target : f.path).replace(/\\/g, '/')
  return rel.replace(/^~\//, '').replace(/^\.\//, '')
}

async function main() {
  const args = process.argv.slice(2)
  const url = args.find((a) => !a.startsWith('--'))
  const ns = args.includes('--ns') ? args[args.indexOf('--ns') + 1] : 'shadcn'
  const dry = args.includes('--dry')
  if (!url) {
    console.error('usage: node scripts/registry-add.mjs <registry-item-json-url> [--ns <namespace>] [--dry]')
    process.exit(2)
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) { console.error(`fetch ${res.status}`); process.exit(1) }
  const item = await res.json()
  const problems = validateRegistryItem(item)
  if (problems.length > 0) {
    console.error('质检门未过:\n- ' + problems.join('\n- '))
    process.exit(1)
  }
  const dest = join(REPO, 'vendor-registry', ns, item.name)
  const landed = []
  for (const f of item.files) {
    const rel = fileTargetOf(f)
    const p = join(dest, rel)
    if (!resolve(p).startsWith(resolve(dest))) { console.error(`越界:${rel}`); process.exit(1) }
    if (!dry) {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.content)
    }
    landed.push(rel)
  }
  // 供应链锁:出处/类型/依赖入档(BOM 精神:每根线记出处)。
  const lockPath = join(REPO, 'index', 'registry.lock.yml')
  const row = [
    `- name: ${ns}/${item.name}`,
    `  type: ${item.type}`,
    `  url: ${JSON.stringify(url)}`,
    `  files: [${landed.map((x) => JSON.stringify(x)).join(', ')}]`,
    ...(Array.isArray(item.dependencies) && item.dependencies.length > 0 ? [`  dependencies: [${item.dependencies.map((d) => JSON.stringify(String(d))).join(', ')}]`] : []),
    ...(Array.isArray(item.registryDependencies) && item.registryDependencies.length > 0 ? [`  registryDependencies: [${item.registryDependencies.map((d) => JSON.stringify(String(d))).join(', ')}]`] : []),
    `  fetchedAt: ${JSON.stringify(new Date().toISOString())}`,
  ].join('\n')
  if (!dry) {
    const head = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '# 外部 registry 条目供应链锁(registry-add 维护)\n'
    if (!head.includes(`- name: ${ns}/${item.name}\n`)) writeFileSync(lockPath, head.replace(/\n*$/, '\n') + row + '\n')
  }
  console.log(JSON.stringify({ ok: true, name: `${ns}/${item.name}`, type: item.type, files: landed, dest: dry ? '(dry)' : dest }, null, 2))
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
