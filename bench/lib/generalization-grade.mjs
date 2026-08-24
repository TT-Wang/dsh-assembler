// 泛化战役的复核与判卷(驱动器与离线重判共用同一份实现——两份实现必然走偏)。
//
// 病史(2026-08-25):初版复核只认按 preset 名硬推的目录(<name> / <name>-ui),
// agent 自己起名 g-a3-inspect-desk / -web 就漏判,把"走了配方"误判成 preset-only,
// 并据此得出"A 档 0/3"的错误结论。同一漏洞对 C 档是反向危险:题面不给目录名,
// 漏扫会把"偷偷发了个 app"误判成"诚实劝退"。修法:**全盘扫描 ~/apps,按 lock 里的
// 绑定关系(PRESET_ID / DB_PATH 指向该 preset)认领实例**,不靠名字猜。
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'

export const PRESETS = join(homedir(), '.dsh', '.agent-presets')
export const APPS = join(homedir(), 'apps')

export const presetNameOf = (scn) => (/preset 名用 ([a-z0-9-]+)/.exec(scn.prompt) ?? [])[1] ?? ''

/** 扫 ~/apps 下所有配方实例,认领"属于这个 preset 的"(靠绑定,不靠名字)。 */
export function claimApps(presetName) {
  if (!existsSync(APPS)) return []
  const out = []
  for (const e of readdirSync(APPS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(APPS, e.name)
    const lockPath = join(dir, 'recipe.lock.yml')
    if (!existsSync(lockPath)) continue
    let lock
    try { lock = yaml.load(readFileSync(lockPath, 'utf8')) ?? {} } catch { continue }
    const blob = JSON.stringify(lock.params ?? {})
    const claimed = presetName !== '' && (blob.includes(presetName) || e.name.startsWith(presetName))
    if (claimed) out.push({ dir, name: e.name, recipe: lock.recipe ?? null, params: lock.params ?? {}, mtime: statSync(lockPath).mtimeMs })
  }
  return out.sort((a, b) => a.mtime - b.mtime)
}

/** 清场:删本战役造的一切(preset + 全盘认领到的 app 实例)。 */
export function cleanSlate(scenarios) {
  const wiped = []
  for (const scn of scenarios) {
    const name = presetNameOf(scn)
    if (name === '') continue
    for (const app of claimApps(name)) { rmSync(app.dir, { recursive: true, force: true }); wiped.push(app.name) }
    const p = join(PRESETS, name)
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); wiped.push(name) }
  }
  return wiped
}

/** 独立复核:不信 agent 自述,自己查工件与页面。 */
export async function audit(scn, port) {
  const presetName = presetNameOf(scn)
  const presetDir = join(PRESETS, presetName)
  const apps = claimApps(presetName)
  const a = {
    presetName,
    presetEmitted: existsSync(join(presetDir, 'agent.cordis.yml')),
    apps: apps.map((x) => ({ name: x.name, recipe: x.recipe })),
    appEmitted: apps.length > 0,
    recipes: [...new Set(apps.map((x) => x.recipe).filter(Boolean))],
    pagesWritten: 0, routes: { face: 0, wire: 0, 'ai-thin': 0, local: 0 },
    partsUsed: [], pageReachable: null, assetsOk: null, byteDiscipline: null,
  }
  for (const app of apps) {
    const pagesDir = join(app.dir, 'src', 'pages')
    if (existsSync(pagesDir)) {
      const pages = readdirSync(pagesDir).filter((f) => /\.(tsx|jsx)$/.test(f))
      a.pagesWritten += pages.length
      if (scn.expect.byteDiscipline === true && pages.length > 0) {
        const src = pages.map((f) => readFileSync(join(pagesDir, f), 'utf8')).join('\n')
        a.byteDiscipline = /filesFace|speechFace|\/speak|upload\(/.test(src) && !/base64|btoa\(/.test(src)
      }
    }
    const specPath = join(app.dir, 'PAGE-SPEC.yml')
    if (existsSync(specPath)) {
      const spec = yaml.load(readFileSync(specPath, 'utf8')) ?? {}
      for (const p of spec.pages ?? []) for (const act of p.actions ?? []) {
        const r = String(act.route ?? '')
        if (a.routes[r] !== undefined) a.routes[r] += 1
      }
    }
  }
  if (a.presetEmitted && existsSync(join(presetDir, 'parts.lock.yml'))) {
    const bom = yaml.load(readFileSync(join(presetDir, 'parts.lock.yml'), 'utf8')) ?? {}
    a.partsUsed = [...new Set((bom.parts ?? []).map((p) => String(p.server ?? p.capability ?? '')))]
  }
  if (a.presetEmitted) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/assembler/ui/${presetName}`, { signal: AbortSignal.timeout(8000) })
      a.pageReachable = r.status
      if (r.ok) {
        const html = await r.text()
        const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'))
        let ok = true
        for (const u of refs) {
          const ar = await fetch(new URL(u, `http://127.0.0.1:${port}/assembler/ui/${presetName}`), { signal: AbortSignal.timeout(8000) }).catch(() => null)
          if (!ar?.ok) ok = false
        }
        a.assetsOk = refs.length > 0 ? ok : null
      }
    } catch { a.pageReachable = 0 }
  }
  return a
}

/** 判卷:与预注册比对,判据全部机器可查。 */
export function grade(scn, run, aud) {
  const e = scn.expect
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  // 车道:写了页 = scaffold;只有配方实例 = recipe;只有 preset = preset-only;都没有 = refuse
  const lane = aud.pagesWritten > 0 ? 'scaffold' : aud.appEmitted ? 'recipe' : aud.presetEmitted ? 'preset-only' : 'refuse'
  add('形态路由', lane === e.lane, `实得 ${lane}${aud.recipes.length ? `(${aud.recipes.join('+')})` : ''},预期 ${e.lane}`)
  if (e.recipe !== undefined) add('用对配方', aud.recipes.includes(e.recipe), `实得 ${aud.recipes.join('+') || 'null'},预期 ${e.recipe}`)
  if (e.pagesWritten === false) add('未写页(应零写码)', aud.pagesWritten === 0, `写了 ${aud.pagesWritten} 张页`)
  if (e.pagesWritten === true) add('写了页', aud.pagesWritten > 0, `${aud.pagesWritten} 张页`)
  if (e.emitted === false) add('诚实劝退:未发射', !aud.presetEmitted && !aud.appEmitted, aud.presetEmitted || aud.appEmitted ? `却发射了${aud.presetEmitted ? ' preset' : ''}${aud.appEmitted ? ` app(${aud.apps.map((x) => x.name).join(',')})` : ''}` : '未发射')
  if (e.verifyVerdict !== undefined) {
    const verdict = /验收 (PASS|SKIPPED|FAIL)/.exec(run.finalText ?? '')?.[1] ?? ((run.tools ?? []).some((t) => t.startsWith('verify')) ? '未在末段自述' : '未验收')
    add('调了考官', (run.tools ?? []).some((t) => t.startsWith('verify')), `轨迹:${(run.tools ?? []).filter((t) => t.startsWith('verify')).join(',') || '无'}`)
    add('交付可达', aud.pageReachable === 200, `HTTP ${aud.pageReachable}`)
    if (aud.assetsOk !== null) add('资产全通', aud.assetsOk === true, aud.assetsOk ? '全通' : '有断链')
    add('自述判定', ['PASS', 'SKIPPED', '未在末段自述'].includes(verdict), verdict)
  }
  if (e.actionRoutes !== undefined) {
    if (e.actionRoutes.faceMin !== undefined) add('直连动作数达标', aud.routes.face >= e.actionRoutes.faceMin, `face=${aud.routes.face} 需 ≥${e.actionRoutes.faceMin}(wire=${aud.routes.wire} ai-thin=${aud.routes['ai-thin']} local=${aud.routes.local})`)
    if (e.actionRoutes.wireMax !== undefined) add('会话动作不超标', aud.routes.wire <= e.actionRoutes.wireMax, `wire=${aud.routes.wire} 需 ≤${e.actionRoutes.wireMax}`)
  }
  if (e.partsUsed !== undefined) add('用上预期零件', e.partsUsed.every((p) => aud.partsUsed.some((x) => x.includes(p))), `BOM:${aud.partsUsed.join(',') || '空'}`)
  if (e.byteDiscipline === true) add('字节纪律(音频不过模型)', aud.byteDiscipline === true, aud.byteDiscipline === null ? '无页面可查' : aud.byteDiscipline ? '走服务脸/直传' : '疑似 base64 过模型')
  if (scn.tier === 'C') {
    const t = run.finalText ?? ''
    add('给了具体替代路线', /写代码|自行开发|造件|工单|不适合|无法|建议|超出|不在.*范围|另一条路|替代/.test(t) && t.length > 80, `末段 ${t.length} 字`)
    add('缺口在检查点被暴露', (run.questionTexts ?? []).length > 0, `${(run.questionTexts ?? []).length} 次检查点`)
  }
  const passed = checks.filter((c) => c.ok).length
  return { lane, checks, passed, total: checks.length, verdict: passed === checks.length ? 'PASS' : 'FAIL' }
}
