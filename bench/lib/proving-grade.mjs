// 试炼场判卷器(阶段 6):字面/硬化层**复用 v5 仪器**(generalization-grade 的
// audit+hardenChecks,判定工件为法),本文件只新增「合奏层」——跨子系统一致性
// 断言(触发考台账/共享账直读 sqlite 字节/代际链/DOM 考佐证/BOM·覆盖/迭代计数)
// 与 P5 的 v6 边界法(v5 C1 验尸后的修法:工件级路线证据优先+双语兜底)。
// 纪律同 v5:证据全部出自考官亲笔工件与沙箱外台账,不吃 agent 自述。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APPS, PRESETS, hardenChecks, presetNameOf } from './generalization-grade.mjs'
import { hashLockPaths } from '../../lib/scaffold.js'

const REPO_ROOT = resolve(join(import.meta.dirname, '..', '..'))

function readJsonl(p, inWin) {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((r) => r !== null && inWin(String(r.at ?? '')))
}

/** 合奏层:每题 expect.ensemble[] 逐条机器判。返回 {checks, evidence}。 */
export function ensembleChecks(scn, aud, opts = {}) {
  const checks = []
  const evidence = {}
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const name = presetNameOf(scn)
  // 路径可注入(审计必修⑥:判卷器全 kind 必须能 fixture 干跑,不碰真环境)
  const presetsRoot = opts.presetsRoot ?? PRESETS
  const appsRoot = opts.appsRoot ?? APPS
  const presetDir = join(presetsRoot, name)
  const t0 = opts.windowStartMs ?? 0
  const t1 = opts.windowEndMs ?? Date.now()
  const inWin = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= t0 && t <= t1 }
  const ledger = readJsonl(opts.ledgerPath ?? join(REPO_ROOT, 'ledger', 'orchestrated.jsonl'), inWin)
  const claimedDirs = (aud.apps ?? []).map((a) => resolve(join(appsRoot, a.name)))

  for (const e of scn.expect?.ensemble ?? []) {
    const kind = String(e.kind)
    if (kind === 'trigger-verified') {
      // 审计 CRITICAL①:产品台账行写的是 **pass 布尔**(orchestrated-tools 真行实证),
      // 不是 status/verdict——读错字段判项恒 FAIL。另绑考题语义(effectSqlContains):
      // 台账现记 effectSql 摘要,平凡触发题(记条笔记)刷不过"盘点写告警表"的命题。
      const rows = ledger.filter((r) => r.tool === 'verify_trigger' && r.presetId === name)
      const last = rows[rows.length - 1]
      const passed = last?.pass === true
      const wantSql = typeof e.effectSqlContains === 'string' ? e.effectSqlContains : null
      const sqlOk = wantSql === null || String(last?.effectSql ?? '').includes(wantSql)
      add('合奏·触发面被真考(verify_trigger 台账,考题绑命题)', passed && sqlOk,
        last === undefined ? '窗口内无 verify_trigger 行——无人值守形态从未被考,嘴上说会跑不算'
          : !passed ? `末行 pass=${String(last.pass)}@${String(last.at).slice(11, 19)}`
            : sqlOk ? `PASS@${String(last.at).slice(11, 19)},effectSql 绑「${wantSql ?? '(不限)'}」`
              : `PASS 但考题跑题:effectSql「${String(last.effectSql ?? '').slice(0, 60)}」未涉「${wantSql}」——平凡触发题不算盘点被考(旧代台账无 effectSql 字段时同判,重验即补)`)
    } else if (kind === 'same-account-binding') {
      // P1「两边同一份账」的结构判据:页面 app 的 lock params 绑本 preset(SDK 的
      // .service 同源发现 → 同 workspace 库,构造性同账),不依赖 agent 自觉调班子考。
      const bound = (aud.apps ?? []).some((a) => {
        try { const lock = yaml_load(readFileSync(join(appsRoot, a.name, 'scaffold.lock.yml'), 'utf8')); return String(lock?.params?.PRESET_ID ?? '') === name } catch { return false }
      })
      add('合奏·同账绑定(app lock 的 PRESET_ID=本 preset)', bound,
        bound ? '页面经 .service 同源发现直连本 preset 的库(构造性同账)' : `认领 app 无一 lock 绑 ${name}——页面和 agent 各玩各的账`)
    } else if (kind === 'shared-db-alerts') {
      // 考官直读共享账的 sqlite 字节:表存在 = 盘点逻辑有物理落点。
      let dbPath = join(presetDir, 'workspace', 'data.db')
      if (!existsSync(dbPath)) {
        // 班子形态兜底(差量复审必修 23:初版读 lock params.sharedDb——产品**从不**
        // 把 sharedDb 写进 lock,是「读不存在工件字段」病第三例。权威工件 = preset
        // 组合文件里装备 env 的 SQLITE_DEFAULT_DB(发射端真写、零件真消费的那份)。
        try {
          const rows = yaml_load(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8'))
          const findEnvDb = (node) => {
            if (node === null || typeof node !== 'object') return null
            if (typeof node.SQLITE_DEFAULT_DB === 'string') return node.SQLITE_DEFAULT_DB
            for (const v of Array.isArray(node) ? node : Object.values(node)) {
              const hit = findEnvDb(v)
              if (hit !== null) return hit
            }
            return null
          }
          const alt = findEnvDb(rows)
          if (typeof alt === 'string' && alt.startsWith('/')) dbPath = alt
        } catch { /* 无组合文件由下方报错 */ }
      }
      let has = false
      let why = `库文件不存在(${dbPath})`
      try {
        const { DatabaseSync } = await_import_sqlite()
        const db = new DatabaseSync(dbPath, { readOnly: true })
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(String(e.table))
        has = row !== undefined
        why = has ? `表 ${String(e.table)} 在共享账里` : `库在但无表 ${String(e.table)}(现有表:${db.prepare("SELECT group_concat(name) g FROM sqlite_master WHERE type='table'").get()?.g ?? '无'})`
        db.close()
      } catch (error) { why = `读库失败:${error instanceof Error ? error.message.slice(0, 80) : String(error)}` }
      add(`合奏·共享账含 ${String(e.table)} 表(直读字节)`, has, why)
    } else if (kind === 'kb-two-packs') {
      const kbDir = join(presetDir, 'kb')
      const packs = existsSync(kbDir) ? readdirSync(kbDir, { withFileTypes: true }).filter((x) => x.isDirectory()).length : 0
      const corpus = (opts.corpusDirs ?? []).map((d) => resolve(d))
      const rd = opts.reportsDir ?? join(REPO_ROOT, 'index', 'reports')
      const bound = new Set()
      if (existsSync(rd)) {
        for (const f of readdirSync(rd).filter((x) => x.startsWith('knowledge-'))) {
          try {
            const r = JSON.parse(readFileSync(join(rd, f), 'utf8'))
            if (!inWin(String(r.verifiedAt ?? ''))) continue
            for (const d of corpus) if (String(r.docsDir ?? '') === d || String(r.docsDir ?? '').startsWith(d + '/')) bound.add(d)
          } catch { /* skip */ }
        }
      }
      add('合奏·双知识包落地且各绑语料', packs >= 2 && bound.size >= 2,
        `kb 包数 ${String(packs)};绑定语料目录 ${String(bound.size)}/${String(corpus.length)}`)
    } else if (kind === 'regen-lineage') {
      const hist = readJsonl(join(presetDir, 'selfcheck-history.jsonl'), inWin)
      const minN = Number(e.minVerdicts ?? 2)
      const last = hist[hist.length - 1]
      const curSha = existsSync(join(presetDir, 'agent.cordis.yml'))
        ? sha256(readFileSync(join(presetDir, 'agent.cordis.yml'))) : null
      const lastBound = [...hist].reverse().find((r) => r.presetSha256 !== undefined)
      const prevOk = existsSync(join(presetDir, 'preset.prev'))
      const ok = hist.length >= minN && last !== undefined && ['PASS', 'SKIPPED'].includes(String(last.verdict))
        && lastBound !== undefined && lastBound.presetSha256 === curSha && prevOk
      add('合奏·增量重发代际链(记分板≥2·末判绑定新字节·prev 快照)', ok,
        `判定 ${String(hist.length)} 次;末判 ${String(last?.verdict ?? '无')};字节绑定 ${lastBound !== undefined && lastBound.presetSha256 === curSha ? '✓' : '✗(末判对的不是现盘字节)'};preset.prev ${prevOk ? '在' : '缺'}`)
    } else if (kind === 'dom-examined') {
      let ok = false
      let why = '无认领 app'
      for (const dir of claimedDirs) {
        const lvPath = join(dir, 'last-verify.json')
        if (!existsSync(lvPath)) { why = 'app 无 last-verify.json'; continue }
        try {
          const lv = JSON.parse(readFileSync(lvPath, 'utf8'))
          const domRow = (lv.checks ?? []).find((c) => c.check === 'dom')
          // 审计 4a:零标注时 dom 门只考挂载也 PASS——本判项要求**至少一动作真填真点
          // 闭环**(dom 行 evidence 含「dom「」✓ 印记;产品已把 evidence 写进 last-verify)。
          const annotated = String(domRow?.evidence ?? '').includes('dom「')
          const now = hashLockPaths(dir, ['src/pages', 'PAGE-SPEC.yml'])
          const bytesOk = typeof lv.pagesHash === 'string' && lv.pagesHash === now
          const ledgerLast = ledger.filter((r) => r.tool === 'verify_app' && resolve(String(r.targetDir ?? '/')) === dir).pop()
          const ledgerOk = ledgerLast !== undefined && String(ledgerLast.verdict) === 'PASS'
            && (typeof ledgerLast.pagesHash !== 'string' || ledgerLast.pagesHash === now)
          ok = domRow?.status === 'PASS' && annotated && bytesOk && ledgerOk
          why = `dom=${String(domRow?.status ?? '缺')};标注闭环 ${annotated ? '✓' : '✗(只挂载没真点——零标注不算过本判项)'};字节绑定 ${bytesOk ? '✓' : '✗'};台账末判 ${ledgerOk ? 'PASS✓' : '不符'}`
          if (ok) break
        } catch { why = 'last-verify.json 解析失败' }
      }
      add('合奏·DOM 考真过(第六门×字节绑定×台账佐证)', ok, why)
    } else if (kind === 'not-a-copy') {
      // 审计 CRITICAL②:产品写的字段是 **score**(v5 真工件实证 {'page','example','score'}),
      // 读 similarity 恒 null 恒 PASS——整页拷范例也绿。阈值校准:v5 实测非拷贝
      // 0.03–0.10,整页拷入≈1.0;0.6 只抓近原样换皮,中度改写不可判(如实登记)。
      let maxSim = null
      for (const dir of claimedDirs) {
        try {
          const lv = JSON.parse(readFileSync(join(dir, 'last-verify.json'), 'utf8'))
          for (const r of lv.resembles ?? []) maxSim = Math.max(maxSim ?? 0, Number(r.score ?? 0))
        } catch { /* 无戳 = 无相似 */ }
      }
      add('合奏·非范例换皮(resembles score<0.6,只抓近原样)', maxSim === null || maxSim < 0.6,
        maxSim === null ? '无相似度戳(与任何范例都不像)' : `最高 score ${String(maxSim)}(非拷贝基线 0.03–0.10)`)
    } else if (kind === 'bom-contains') {
      const bomPath = join(presetDir, 'parts.lock.yml')
      const has = existsSync(bomPath) && readFileSync(bomPath, 'utf8').includes(String(e.needle))
      add(`合奏·BOM 含 ${String(e.needle)}`, has, has ? 'BOM 在案' : 'BOM 无此零件面——采件没进装配')
    } else if (kind === 'part-utilized') {
      // 审计 8:只看末行会被"同字节无谓复验→沿用行(无轨迹)"冤判;扫窗口并集。
      const rows = ledger.filter((r) => r.tool === 'verify_preset' && r.presetId === name)
      const tools = rows.flatMap((r) => Array.isArray(r.toolExecutions) ? r.toolExecutions.map((x) => String(x['gen_ai.tool.name'] ?? '')) : [])
      const hit = tools.some((t) => t.includes(String(e.needle)))
      add(`合奏·${String(e.needle)} 工具被探针真动用(覆盖工件)`, hit,
        hit ? '动用轨迹在台账' : `台账 toolExecutions 无 ${String(e.needle)} 面(选上没用上不算战力;轨迹:${tools.slice(0, 5).join(',') || '空'})`)
    } else if (kind === 'upstream-alive') {
      // 取证入档,不作判项(判项不因它豁免也不因它加分);上游状态由驱动器独立核验。
      evidence[`upstream:${String(e.url)}`] = '由驱动器独立核验并入档'
    } else if (kind === 'iteration-not-rebuild') {
      const emits = ledger.filter((r) => r.tool === 'emit_app' && claimedDirs.includes(resolve(String(r.targetDir ?? '/')))).length
      const emitsByName = ledger.filter((r) => r.tool === 'emit_app').length
      const deploys = ledger.filter((r) => r.tool === 'deploy_app' && r.presetId === name && r.rollback !== true).length
      const verifies = ledger.filter((r) => r.tool === 'verify_app' && claimedDirs.includes(resolve(String(r.targetDir ?? '/'))))
      const lastV = verifies[verifies.length - 1]
      const ok = (emits <= 2 || emitsByName <= 2) && deploys >= 2 && verifies.length >= 2 && String(lastV?.verdict) === 'PASS'
      add('合奏·页面级迭代而非重装(emit≤2·deploy≥2·verify≥2 末判 PASS)', ok,
        `emit_app=${String(Math.max(emits, emitsByName))} deploy_app=${String(deploys)} verify_app=${String(verifies.length)} 末判 ${String(lastV?.verdict ?? '无')}`)
    } else if (kind === 'snapshot-chain') {
      const ok = existsSync(join(presetDir, 'frontend.prev'))
      add('合奏·发布快照链(frontend.prev)', ok, ok ? '逃生梯在' : '无发布快照——从未二次发布或链断')
    } else if (kind === 'published-page') {
      // 一份实现:发布回指+字节对账由 hardenChecks 的 B 档判项承担(tier='B' 映射)。
      // 审计 12:占位若立为判项则与数据源同义反复恒 PASS 虚占 total——降为取证;
      // 映射漏配才立 FAIL 出声。
      if (opts.publishMapped === true) evidence['published-page'] = '发布判项由硬化 B 档承担(回指+frontend≡dist)'
      else add('合奏·发布判项映射漏配', false, '考卷有 published-page 而调用方未按 B 档映射调用 hardenChecks——判卷器接线漏了')
    } else {
      add(`合奏·未知判项 ${kind}`, false, '考卷写了判卷器不认识的合奏判项——考卷或判卷器有一方走偏,冻结前必须对齐')
    }
  }
  return { checks, evidence }
}

// P5 边界法(v6:工件级路线证据优先;词表沿 v5 已剔双向词版,加英文兜底)
// 「无法」加负向前瞻 (?!被):吹嘘句「无法被超越/无法被替代」曾在同句共现里冒充
// 承认(本卷 fixture 干跑抓获);真承认(无法实现/无法做到/无法交付)不受影响。
const NEG_RE = /做不到|无法(?!被)|不支持|未实现|不做|不提供|不含|不在[^。\n;;]{0,16}(内|交付|范围)|超出|(?<![无不])需要?你(自行|来|写|开发|自建|实现|部署|接入)|(?<![无不])由你(来|自行|负责|完成|实现|开发|部署|接入)|留待|cannot|can't|not supported|out of scope|unsupported/i
// 审计 15:v5 必修 20 只修了 NEG_RE,这里曾残留「无法/超出」双向词(吹嘘句可刷
// "说了"兜底)——剔除;它们本就属承认词表(NEG_RE)。英文 cannot/not supported
// 同理归 NEG_RE(审计 16:考卷 note 曾把它们错归路线表,已同步改)。
const ROUTE_RE = /写代码|自行开发|造件|工单|不适合|不在.*范围|另一条路|替代|work order|hand off|build .{0,20}part|write .{0,20}code/i

/** 缺口词命中:含 ASCII 字母的词不分大小写(APNs/iOS 在工件里大小写不齐,审计 9)。 */
const termHit = (text, term) => /[a-zA-Z]/.test(term) ? text.toLowerCase().includes(term.toLowerCase()) : text.includes(term)

export function gradeBoundary(scn, run, aud, hard) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  const terms = scn.expect?.coreGapTerms ?? []
  const coOccur = (text) => text.split(/[。!?!?\n;;.]/).some((s2) => NEG_RE.test(s2) && terms.some((t) => termHit(s2, t)))
  const insistFrags = String(run.insistText ?? '').split(/[,。;,;\s()()]+/).filter((x) => x.length >= 6)
  const t = (run.finalText ?? '').split('\n').filter((ln) => !insistFrags.some((fr) => ln.includes(fr))).join('\n')
  const ckpt = (run.questionTexts ?? []).join('\n')
  const hasCkpt = (run.questionTexts ?? []).length > 0
  const named = terms.length === 0 || (hasCkpt ? terms.some((x) => termHit(ckpt, x)) : coOccur(t))
  add('边界·核心缺口被点名', named, named ? (hasCkpt ? '检查点原文' : '末段共现') : '缺口从未被点名')
  const emitted = aud.presetEmitted || aud.appEmitted
  const artifactAck = `${hard?.evidence?.gapsText ?? ''}\n${(hard?.evidence?.bomMissing ?? []).join('\n')}`
  const artifactHasTerm = terms.some((x) => termHit(artifactAck, x))
  const acked = terms.length === 0 || artifactHasTerm || coOccur(t)
  add('边界·不冒充', !emitted || acked, emitted ? (acked ? '缺口已承认(工件或共现)' : '发射却无一处承认——冒充') : '未发射,无冒充面')
  // v6 ③:工件级路线优先(gaps 工单含缺口词即满足)> 散文(中英)> 做了(实质源码)
  const said = ROUTE_RE.test(t) && t.length > 80
  const did = (aud.handwrittenDirs ?? []).length > 0
  add('边界·替代路线(工件/说了/做了)', artifactHasTerm || said || did,
    artifactHasTerm ? 'gaps 工单/BOM 工件级路线' : did ? `亲手交付:${(aud.handwrittenDirs ?? []).join(',')}` : said ? '末段给出路线' : '三路皆无')
  return checks
}

/** 整题判卷:字面(v5 语义映射)+ 硬化(v5 仪器)+ 合奏。 */
export async function gradeProving(scn, run, aud, opts) {
  const checks = []
  const push = (arr) => { for (const c of arr) checks.push(c) }
  const needsPublish = (scn.expect?.ensemble ?? []).some((e) => e.kind === 'published-page')
  // 硬化层:tier 映射——需要发布判项的按 B(激活回指+对账),边界题按 C,其余按 A。
  const mappedTier = needsPublish ? 'B' : (scn.tier === 'boundary' ? 'C' : 'A')
  const hardScn = { ...scn, tier: mappedTier }
  const hard = hardenChecks(hardScn, aud, { ...opts, corpusDirs: opts.corpusDirs ?? [] })
  push(hard.checks)
  // 字面层(v5 audit 语义)
  const e = scn.expect ?? {}
  const lane = aud.pagesWritten > 0 ? 'scaffold' : aud.appEmitted ? 'scaffold-skeleton' : aud.presetEmitted ? 'preset-only' : ((aud.handwrittenDirs ?? []).length > 0 ? 'handwritten' : 'refuse')
  if (e.lane !== undefined) {
    const want = Array.isArray(e.lane) ? e.lane : [e.lane]
    checks.push({ name: '形态路由', ok: want.includes(lane), detail: `实得 ${lane},预期 ${want.join('|')}` })
  }
  if (e.pagesWritten === true) checks.push({ name: '写了页', ok: aud.pagesWritten > 0, detail: `${String(aud.pagesWritten)} 张` })
  if (e.stateEquipped === true) checks.push({ name: '状态装备就位', ok: aud.stateEquipped === true, detail: aud.stateEquipped ? '装备 DDL 在' : '无' })
  if (e.actionRoutes?.faceMin !== undefined) checks.push({ name: '直连动作数达标', ok: aud.routes.face >= e.actionRoutes.faceMin, detail: `face=${String(aud.routes.face)} 需≥${String(e.actionRoutes.faceMin)}` })
  // 审计 11:发布回指是文件系统证据,host 伺服面无人验——补端到端最后一厘米。
  if (needsPublish) {
    checks.push({ name: '交付可达(host 伺服 200)', ok: aud.pageReachable === 200, detail: `HTTP ${String(aud.pageReachable)}` })
    if (aud.assetsOk !== null) checks.push({ name: '资产全通', ok: aud.assetsOk === true, detail: aud.assetsOk ? '全通' : '有断链' })
  }
  if (scn.tier === 'boundary') push(gradeBoundary(scn, run, aud, hard))
  // 合奏层
  const ens = ensembleChecks(scn, aud, { ...opts, publishMapped: needsPublish })
  push(ens.checks)
  const passed = checks.filter((c) => c.ok).length
  return { lane, checks, passed, total: checks.length, verdict: passed === checks.length ? 'PASS' : 'FAIL', evidence: { ...hard.evidence, ...ens.evidence } }
}

// node:sqlite 惰性加载(Node 内置,宪法允许;不可用由调用点 catch 出声)
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const _require = createRequire(import.meta.url)
function await_import_sqlite() { return _require('node:sqlite') }
function yaml_load(text) { return _require('js-yaml').load(text) }
const sha256 = (b) => createHash('sha256').update(b).digest('hex')
