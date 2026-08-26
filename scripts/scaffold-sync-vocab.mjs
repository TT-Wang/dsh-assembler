#!/usr/bin/env node
// scaffold-sync-vocab — 把 vendor-registry/shadcn/* 的组件源码同步进 scaffold-react
// scaffold 模板的 src/components/ui/(词汇表本体)。改写两类路径:
//   @/registry/new-york-v4/ui/<x> → @/components/ui/<x>(shadcn 仓内交叉导入)
// 同步是显式动作:跑完模板字节变了 → scaffold.yml 升 version → 重过入库门。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(REPO, 'vendor-registry', 'shadcn')
const DST = join(REPO, 'scaffold', 'template', 'src', 'components', 'ui')

if (!existsSync(SRC)) { console.error('vendor-registry/shadcn 不存在——先 registry-add 进货'); process.exit(1) }
mkdirSync(DST, { recursive: true })

let n = 0
for (const comp of readdirSync(SRC)) {
  const uiDir = join(SRC, comp, 'registry', 'new-york-v4', 'ui')
  if (!existsSync(uiDir)) continue
  for (const f of readdirSync(uiDir)) {
    if (!f.endsWith('.tsx') && !f.endsWith('.ts')) continue
    const text = readFileSync(join(uiDir, f), 'utf8')
      .replace(/@\/registry\/new-york-v4\/ui\//g, '@/components/ui/')
    writeFileSync(join(DST, basename(f)), text)
    n += 1
  }
}
console.log(`synced ${n} vocabulary files → ${DST.replace(REPO + '/', '')}`)
