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
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertYaml } from './yaml-write.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 形状与安全校验(纯函数,单测覆盖):返回问题清单,空 = 过。 */
export function validateRegistryItem(item) {
  const problems = []
  if (item === null || typeof item !== 'object') return ['not an object']
  if (typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(item.name)) problems.push('name 缺失或非 kebab-case')
  if (typeof item.type !== 'string' || !item.type.startsWith('registry:')) {
    problems.push('type 缺失或非 registry:*')
  } else if (!/^registry:[A-Za-z0-9._/-]+$/.test(item.type)) {
    // 结构安全化(m3):type 原样插进供应链锁行——含换行/控制字符/第二个冒号/
    // 空格的值可以在锁文件里注入 YAML 结构,逐字符白名单先拒。
    problems.push(`type 含非法字符(registry: 后只允许 字母/数字/._-/):${JSON.stringify(item.type)}`)
  }
  const files = Array.isArray(item.files) ? item.files : []
  if (files.length === 0) problems.push('files 为空')
  for (const [i, f] of files.entries()) {
    const rel = typeof f?.target === 'string' && f.target !== '' ? f.target : (typeof f?.path === 'string' ? f.path : '')
    if (rel === '') { problems.push(`files[${i}] 缺 path/target`); continue }
    const norm = rel.replace(/\\/g, '/')
    if (norm.startsWith('/') || norm.split('/').includes('..')) problems.push(`files[${i}] 路径越界:${rel}`)
    // 控制字符(换行/ESC 等)会污染落盘目录名并让锁行/审计文本失真,先拒。
    if (/[\u0000-\u001f\u007f]/.test(rel)) problems.push(`files[${i}] 路径含控制字符:${JSON.stringify(rel)}`)
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
  // --ns 白名单(m3):只认字母/数字/连字符组成的路径段、段间一个斜杠——ns 直接
  // 拼落盘目录与锁行 name,空段/'..'/反斜杠/控制字符一律先拒,报可行动的错。
  if (!/^[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*$/.test(String(ns ?? ''))) {
    console.error(`--ns 非法:${JSON.stringify(String(ns ?? ''))}——只允许 字母数字/连字符 路径段,段间一个斜杠(如 shadcn 或 acme/ui)`)
    process.exit(1)
  }
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
  // 越界防线(m3,双保险):--ns 已白名单,resolve 后仍必须落在
  // vendor-registry/ 内——防未来校验改动时 ns 逃出仓库。
  const vendorRoot = join(REPO, 'vendor-registry')
  const dest = join(vendorRoot, ns, item.name)
  const destRoot = resolve(dest)
  if (!destRoot.startsWith(resolve(vendorRoot) + sep)) {
    console.error(`越界:目标不在 vendor-registry/ 下:${dest}`)
    process.exit(1)
  }
  const landed = []
  for (const f of item.files) {
    const rel = fileTargetOf(f)
    const p = join(dest, rel)
    // 文件级二道防线:解析后必须仍在条目目录内(首道是 validateRegistryItem 的
    // '..' 拒绝);带分隔符的前缀比较,防 "a/b" 误认 "a/b2/x" 同目录。
    if (!resolve(p).startsWith(destRoot + sep)) { console.error(`越界:${rel}`); process.exit(1) }
    landed.push(rel)
  }
  // 供应链锁:出处/类型/依赖入档(BOM 精神:每根线记出处)。
  // name/type 已白名单;url/files/dependencies/license/fetchedAt 一律
  // JSON.stringify 双引号形态——换行/控制字符/引号被转义,进不了 YAML 结构。
  // 整份锁文本落盘前再过 assertYaml 解析闸(与 register 的 writeYaml 同纪律,
  // m3:挡还没见过的破法)。闸在写任何文件之前——拒绝即零副作用。
  const lockPath = join(REPO, 'index', 'registry.lock.yml')
  let lockFull = null
  if (!dry) {
    const head = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '# 外部 registry 条目供应链锁(registry-add 维护)\n'
    if (!head.includes(`- name: ${ns}/${item.name}\n`)) {
      const row = [
        `- name: ${ns}/${item.name}`,
        `  type: ${item.type}`,
        `  url: ${JSON.stringify(url)}`,
        `  files: [${landed.map((x) => JSON.stringify(x)).join(', ')}]`,
        ...(Array.isArray(item.dependencies) && item.dependencies.length > 0 ? [`  dependencies: [${item.dependencies.map((d) => JSON.stringify(String(d))).join(', ')}]`] : []),
        ...(Array.isArray(item.registryDependencies) && item.registryDependencies.length > 0 ? [`  registryDependencies: [${item.registryDependencies.map((d) => JSON.stringify(String(d))).join(', ')}]`] : []),
        // m3:锁行补 license(文件头宣称记录许可证,旧版从不写;条目没带就不写)。
        ...(typeof item.license === 'string' && item.license !== '' ? [`  license: ${JSON.stringify(item.license)}`] : []),
        `  fetchedAt: ${JSON.stringify(new Date().toISOString())}`,
      ].join('\n')
      lockFull = head.replace(/\n*$/, '\n') + row + '\n'
      try {
        assertYaml(lockFull, 'index/registry.lock.yml')
      } catch (error) {
        console.error(`拒绝写入锁文件:${error.message}——这是 registry-add 的 bug,任何文件都未被改动`)
        process.exit(1)
      }
    }
  }
  for (const f of item.files) {
    if (dry) continue
    const p = join(dest, fileTargetOf(f))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, f.content)
  }
  if (lockFull !== null) writeFileSync(lockPath, lockFull)
  console.log(JSON.stringify({ ok: true, name: `${ns}/${item.name}`, type: item.type, files: landed, dest: dry ? '(dry)' : dest }, null, 2))
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
