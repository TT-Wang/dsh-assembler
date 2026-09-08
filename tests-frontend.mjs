#!/usr/bin/env node
/**
 * 前端车道单测:模板库健全性、填参发射(确定性/复用 no-op)、注入载荷按上下文
 * 转义回归(HTML 区 escape、JS/CFG 区整值 JSON)、路由解析的安全包含闸
 * (id/asset 双正则 + resolve 越界拒绝)。全部离线。
 */
import {
  listFrontendTemplates, emitFrontend, fillTemplate, resolveFrontendFile, shortTitle, listAssemblyProgress,
  FRONTEND_ROUTE, DEFAULT_FRONTEND_TEMPLATE,
} from './lib/index.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${String(extra).slice(0, 110)}` : ''}`)
  if (!cond) failures += 1
}

// ── 1. 模板库健全性:四张模板都在,且都带完整 wire 接线 ─────────────────────
const templates = listFrontendTemplates()
check('模板库含七张模板', ['approval-desk', 'chat-console', 'dashboard', 'data-desk', 'file-desk', 'form-desk', 'kanban'].every((t) => templates.includes(t)), templates.join(','))
check('_ 开头目录不算模板(_vendor/_console 是基础设施)', !templates.includes('_vendor') && !templates.includes('_console'))
check('兜底模板存在于库中', templates.includes(DEFAULT_FRONTEND_TEMPLATE))
// SDK 蒸馏(2026-08-25):通信层住进 _vendor/assembler-sdk.js,模板可二选一——
// 引 SDK(新形态)或自带 wire 三件套(特化页过渡形态);槽位与 turn 语义必须在。
const sdkSrc = readFileSync(join('frontends', '_vendor', 'assembler-sdk.js'), 'utf8')
check('SDK:wire 三件套 + 服务脸 + 围栏出声 + IME 守卫齐备', ['session.create', 'session.prompt', 'events.mux', 'turn/end', '/.service', 'extractFence', 'isComposing'].every((k) => sdkSrc.includes(k)))
for (const t of templates) {
  const html = readFileSync(join('frontends', t, 'index.html'), 'utf8')
  // 双代 wire 核收编后(BACKLOG 0.9),页面经 SDK 的两种合法形态:createClient 全托管,或 wire.rpc/wire.stream 薄转发
  const viaSdk = html.includes('_vendor/assembler-sdk.js') && (html.includes('AssemblerSDK.createClient') || html.includes('AssemblerSDK.wire.'))
  const inline = html.includes('session.create') && html.includes('session.prompt') && html.includes('events.mux') && html.includes('turn/end')
  const wired = (viaSdk || inline) && html.includes('{{presetId}}') && html.includes('{{cfg}}')
  check(`模板 ${t}:通信层就位(SDK 或内联)+ 槽位齐全`, wired)
  // CF-1 收敛闸:JS 区不再逐字段拼单引号裸值,只留 {{cfg}} 整值槽(整值经
  // JSON 序列化注入);{{title}}/{{presetId}}/{{requirement}} 只许出现在 HTML 区。
  check(`模板 ${t}:CFG 收敛为 {{cfg}} 整值槽(无裸 {{workdir}}/JS 单引号槽)`, html.includes('const CFG = {{cfg}};') && !html.includes('{{workdir}}') && !html.includes("'{{presetId}}'"))
  check(`模板 ${t}:亮暗双主题`, html.includes('prefers-color-scheme'))
  check(`模板 ${t}:引用本地 vendor 组件库`, html.includes('_vendor/core.min.css') && html.includes('_vendor/utilities.min.css') && html.includes('uk-theme-zinc'))
}

// ── 2. 填参与发射 ──────────────────────────────────────────────────────────
check('短标题:切在第一个自然断句,不出残句', shortTitle('中英双语读书助手:用户上传书籍源文件(EPUB/TXT/MD),自动解析') === '中英双语读书助手' && shortTitle('记账 agent:随手记收支') === '记账 agent' && shortTitle('') === 'agent')
check('fillTemplate 逐槽替换', fillTemplate('a {{x}} b {{y}} {{x}}', { x: '1', y: '2' }) === 'a 1 b 2 1')
check('未提供的槽位置空', fillTemplate('[{{nope}}]', {}) === '[]')

const root = mkdtempSync(join(tmpdir(), 'fe-test-'))
const dir = join(root, 'my-agent')
mkdirSync(dir, { recursive: true })
const fe1 = emitFrontend({ template: 'chat-console', presetDir: dir, presetId: 'my-agent', requirement: '记账助手,把每笔收支记到本地账本', workdir: join(dir, 'workspace') })
check('发射落盘 index.html', existsSync(join(dir, 'frontend', 'index.html')) && fe1.changed === true)
const emitted = readFileSync(join(dir, 'frontend', 'index.html'), 'utf8')
check('槽位已填(presetId 以 JSON 整值进了 CFG)', emitted.includes('"presetId":"my-agent"') && !emitted.includes('{{presetId}}') && !emitted.includes('{{cfg}}'))
check('workdir 绝对路径以 JSON 转义形态进了 CFG(原样字节可寻)', emitted.includes(JSON.stringify(join(dir, 'workspace')).slice(1, -1)))
const m1 = statSync(join(dir, 'frontend', 'index.html')).mtimeMs
const fe2 = emitFrontend({ template: 'chat-console', presetDir: dir, presetId: 'my-agent', requirement: '记账助手,把每笔收支记到本地账本', workdir: join(dir, 'workspace') })
check('同输入重发 = no-op(复用轮零扰动)', fe2.changed === false && statSync(join(dir, 'frontend', 'index.html')).mtimeMs === m1)
let threw = false
try { emitFrontend({ template: 'no-such-tpl', presetDir: dir, presetId: 'x', requirement: 'r', workdir: '/tmp' }) } catch { threw = true }
check('未知模板抛错(由调用方决定降级)', threw)

// ── 2b. 注入载荷回归(A3,CF-1):HTML 区与 JS/CFG 区按目标上下文转义 ────────
const xss = mkdtempSync(join(tmpdir(), 'fe-xss-'))
const xdir = join(xss, 'agent-x')
mkdirSync(xdir, { recursive: true })
// 载荷矩阵:HTML 区 <img onerror>/</div><script> 越界;JS 区撇号破串、
// 反斜杠序列、换行、</script> 收尾越界——全是要害现场的原型。
const evilPresetId = "x');alert(1);//"
const evilRequirement = '<img onerror=alert(1) src=x> R&D;助手说明</div><script>alert(1)</script>'
const evilWorkdir = "C:\\proj\\x');alert(1);//\n</script><script>alert(1)</script>"
const hx1 = emitFrontend({ template: 'chat-console', presetDir: xdir, presetId: evilPresetId, requirement: evilRequirement, workdir: evilWorkdir })
check('恶意载荷发射成功(不抛错、有写入)', hx1.changed === true)
const h = readFileSync(join(xdir, 'frontend', 'index.html'), 'utf8')
// JS 区:CFG 收敛为单行整值 JSON——解析回原值即证明撇号/反斜杠/换行/< 全部被
// JSON 转义(无破串、无语法破坏);'<' → \u003c 使 </script 序列在文件里不存在。
const cfm = /^const CFG = (\{.*\});$/m.exec(h)
let cfgRound = false
try { const v = JSON.parse(cfm[1]); cfgRound = v.presetId === evilPresetId && v.workdir === evilWorkdir } catch { /* 解析失败 = 页面脚本已破 */ }
check('JS 区:CFG 整值 JSON 逐字节解析回原值(撇号/反斜杠/换行/尖括号不破串)', cfm !== null && cfgRound)
check('JS 区:payload 的 < 全数转义为 \\u003c,无 </script 越界序列', cfm !== null && cfm[1].includes('\\u003c/script') && !h.includes('</script><script>'))
// HTML 区:摘掉 CFG 行后检验——原样事件句柄/截断语句必须不存在,转义形态在。
const htmlPart = h.replace(/^const CFG = \{.*\};$/m, '')
check('HTML 区:<img onerror 载荷转义,原样事件句柄不存在', !htmlPart.includes('<img onerror') && htmlPart.includes('&lt;img onerror=alert(1) src=x&gt;'))
check('HTML 区:短标题里的 < 同样转义', htmlPart.includes('&lt;img onerror=ale'))
check('HTML 区:撇号 &#39; 转义,截断语句不存在', !htmlPart.includes("');alert(1)") && htmlPart.includes('x&#39;);alert(1);//'))
check('HTML 区:& 先转义且不二次编码', htmlPart.includes('R&amp;D') && !htmlPart.includes('&amp;amp;'))
check('HTML 区:</div><script> 越界整体转义', htmlPart.includes('&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;'))
const xmtime = statSync(join(xdir, 'frontend', 'index.html')).mtimeMs
const hx2 = emitFrontend({ template: 'chat-console', presetDir: xdir, presetId: evilPresetId, requirement: evilRequirement, workdir: evilWorkdir })
check('恶意载荷重发 = no-op(转义字节确定性)', hx2.changed === false && statSync(join(xdir, 'frontend', 'index.html')).mtimeMs === xmtime)
// 九张模板逐一过同一恶意载荷:CFG 收敛 + 无残留槽 + 可解析回原值
for (const t of templates) {
  const td = join(xss, `tpl-${t}`)
  mkdirSync(td, { recursive: true })
  emitFrontend({ template: t, presetDir: td, presetId: evilPresetId, requirement: evilRequirement, workdir: evilWorkdir })
  const th = readFileSync(join(td, 'frontend', 'index.html'), 'utf8')
  const tm = /^const CFG = (\{.*\});$/m.exec(th)
  let tRound = false
  try { const v = JSON.parse(tm[1]); tRound = v.presetId === evilPresetId && v.workdir === evilWorkdir } catch { /* 解析失败即破坏 */ }
  check(`模板 ${t}:恶意载荷发射后 CFG 可解析回原值、无残留槽`, tm !== null && tRound && !th.includes('{{'))
}

// ── 3. 路由解析:安全包含闸 ────────────────────────────────────────────────
const R = (p) => resolveFrontendFile(root, p)
const okHit = R(`${FRONTEND_ROUTE}/my-agent`)
check('裸 id → frontend/index.html', okHit !== null && okHit.file.endsWith('my-agent/frontend/index.html') && okHit.mime.startsWith('text/html'))
check('显式资产名可取', R(`${FRONTEND_ROUTE}/my-agent/index.html`) !== null)
check('非法 id(大写)拒绝', R(`${FRONTEND_ROUTE}/My-Agent`) === null)
check('非法 id(下划线)拒绝', R(`${FRONTEND_ROUTE}/my_agent`) === null)
check('遍历:.. 段拒绝', R(`${FRONTEND_ROUTE}/../secrets`) === null)
check('遍历:编码 %2e%2e 拒绝', R(`${FRONTEND_ROUTE}/my-agent/%2e%2e`) === null)
check('遍历:资产含斜杠拒绝', R(`${FRONTEND_ROUTE}/my-agent/a%2fb.html`) === null)
check('遍历:点开头资产拒绝', R(`${FRONTEND_ROUTE}/my-agent/.env`) === null)
check('嵌套资产可取(scaffold dist 的 assets/ 子目录)', R(`${FRONTEND_ROUTE}/my-agent/assets/index-abc.js`)?.file.endsWith('my-agent/frontend/assets/index-abc.js') === true)
check('嵌套段仍拒 ..、点头文件与超深路径', R(`${FRONTEND_ROUTE}/my-agent/assets/../secret`) === null && R(`${FRONTEND_ROUTE}/my-agent/assets/.env`) === null && R(`${FRONTEND_ROUTE}/my-agent/a/b/c/d/e`) === null)
check('前缀不符拒绝', R('/other/my-agent') === null)
check('mime:js 正确', R(`${FRONTEND_ROUTE}/my-agent/app.js`)?.mime.includes('javascript') === true)
// _vendor 共享段
const v = R(`${FRONTEND_ROUTE}/_vendor/core.min.css`)
check('_vendor 资产可取且指向共享目录', v !== null && v.file.endsWith('frontends/_vendor/core.min.css') && v.mime.includes('css'))
check('_vendor 遍历拒绝', R(`${FRONTEND_ROUTE}/_vendor/%2e%2e`) === null && R(`${FRONTEND_ROUTE}/_vendor/.hidden`) === null)
check('_vendor 子目录可取(守卫内嵌套,遍历仍拒)', R(`${FRONTEND_ROUTE}/_vendor/pack/x.js`) !== null && R(`${FRONTEND_ROUTE}/_vendor/pack/../x.js`) === null)
// 直播台数据函数
import('node:fs').then(() => {})
const pr = join(root)
writeFileSync(join(dir, 'progress.log'), '12:00:00 ══ assemble my-agent 开始 ══\n12:00:01 选型完成\n')
const prog = listAssemblyProgress(pr)
check('直播台列出有 progress.log 的 preset', prog.length === 1 && prog[0].id === 'my-agent' && prog[0].tail.includes('选型完成'))
check('直播台带 mtime(秒)', Number.isInteger(prog[0].mtime) && prog[0].mtime > 1_700_000_000)

// 浏览器半区构建产物:ModuleLoader 制式 + 注册/弹出 API 引用齐全
const clientJs = readFileSync('lib/client.js', 'utf8')
check('client half:ModuleLoader 包裹 + 包名 id', clientJs.startsWith('window.__ModuleLoader__.load(') && clientJs.includes('@dsh-external/dsh-assembler'))
check('client half:registerTab + openTab + 直播台数据源', clientJs.includes('registerTab') && clientJs.includes('openTab') && clientJs.includes('/assembler/ui/_console/data'))
check('client half:react 走外部共享(不自带)', clientJs.includes('require("react")') && clientJs.length < 20000)
check('client half:两块都进侧栏(直播台 + agent 操作台)', clientJs.includes('dsh-assembler:console') && clientJs.includes('dsh-assembler:agent') && clientJs.includes('presetId'))

rmSync(root, { recursive: true, force: true })
rmSync(xss, { recursive: true, force: true })

// ── 4. wire 开流失败路径:已建会话必须被 cancel(A4/CW-2,离线假 host) ───────
// wire.ts 在 npm test 链里无直连单测(04 报告盲区 3),这里用假 host 补上最要命
// 的一条:session/create 成功、开流失败——legacy 的 events.mux 连不上、new-wire
// 的 remote.mux 逻辑流被网关拒——openWireSession 必须 reject 且 cancel 抵达 host。
{
  const { openWireSession } = await import('./lib/wire.js')
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  const wsFrame = (text) => {
    const p = Buffer.from(text, 'utf8')
    const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 0xff])
    return Buffer.concat([h, p])
  }
  const waitFor = async (pred) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 25)); return pred() }
  const teardown = async (server, sockets) => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)) }

  // ── legacy:不答 WS 升级 → events.mux 开流失败 → cancel(点号端点) ──
  {
    const seen = { create: 0, cancel: 0 }
    const sockets = new Set()
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const url = req.url ?? ''
        const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
        if (url === '/api/agentPreset.list') return reply({ result: { ok: true, value: {} } })
        if (url === '/api/session.create') { seen.create += 1; return reply({ result: { ok: true, value: { sessionId: 'legacy-s' } } }) }
        if (url === '/api/session.cancel') { seen.cancel += 1; return reply({ result: { ok: true, value: {} } }) }
        res.statusCode = 404; res.end('{}')
      })
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    let rejected = null
    try { await openWireSession(server.address().port, { events: true }) } catch (e) { rejected = e instanceof Error ? e.message : String(e) }
    const cancelled = await waitFor(() => seen.cancel >= 1)
    check('wire legacy:events.mux 开流失败即 reject 且 session.cancel 抵达 host', seen.create === 1 && cancelled && rejected !== null)
    check('wire legacy:失败原样上抛(带开流失败证据)', rejected !== null && (/events\.mux/.test(rejected) || /内建 WebSocket/.test(rejected)))
    await teardown(server, sockets)
  }

  // ── new:remote.mux 升级成功但逻辑流被网关拒(session/follow openStream 失败)→ cancel(斜杠端点) ──
  {
    const seen = { create: 0, cancel: 0, token: 0 }
    const sockets = new Set()
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const url = req.url ?? ''
        const reply = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
        if (req.method === 'GET' && url.startsWith('/?token=')) { seen.token += 1; res.statusCode = 303; res.setHeader('set-cookie', 'sid=new1'); return res.end() }
        if (url === '/api/agentPreset.list') { res.statusCode = 401; return res.end('{}') }
        if (url === '/api/session/create') { seen.create += 1; return reply({ result: { ok: true, value: { sessionId: 'new-s' } } }) }
        if (url === '/api/session/cancel') { seen.cancel += 1; return reply({ result: { ok: true, value: {} } }) }
        res.statusCode = 404; res.end('{}')
      })
    })
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    // 真 101 升级 + remote.mux 协议:凡收到 open 帧即回网关 error 帧(开流必败)
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'] ?? ''
      const accept = createHash('sha1').update(key + GUID).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      let acc = Buffer.alloc(0)
      socket.on('data', (d) => {
        acc = Buffer.concat([acc, d])
        for (;;) {
          if (acc.length < 2) return
          const b1 = acc[0]
          const b2 = acc[1]
          let len = b2 & 0x7f
          let off = 2
          if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10 }
          const masked = (b2 & 0x80) !== 0
          if (masked) off += 4
          if (acc.length < off + len) return
          const payload = Buffer.from(acc.subarray(off, off + len))
          if (masked) { const m = acc.subarray(off - 4, off); for (let i = 0; i < len; i += 1) payload[i] ^= m[i % 4] }
          acc = acc.subarray(off + len)
          if ((b1 & 0x0f) !== 1) continue
          let frame = null
          try { frame = JSON.parse(payload.toString('utf8')) } catch { continue }
          if (frame?.type === 'open' && typeof frame?.streamId === 'string') {
            socket.write(wsFrame(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'denied', message: 'fake gateway deny (test)' } })))
          }
        }
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const homeTmp = mkdtempSync(join(tmpdir(), 'fe-wire-home-'))
    const oldHome = process.env.DSH_HOME
    const oldTok = process.env.DSH_ASSEMBLER_TOKEN_URL
    process.env.DSH_HOME = homeTmp
    process.env.DSH_ASSEMBLER_TOKEN_URL = `http://127.0.0.1:${String(server.address().port)}/?token=ab12`
    let rejected = null
    try { await openWireSession(server.address().port, { events: true }) } catch (e) { rejected = e instanceof Error ? e.message : String(e) }
    const cancelled = await waitFor(() => seen.cancel >= 1)
    process.env.DSH_HOME = oldHome
    process.env.DSH_ASSEMBLER_TOKEN_URL = oldTok
    rmSync(homeTmp, { recursive: true, force: true })
    check('wire new:session/follow 被网关拒即 reject 且 session/cancel 抵达 host', seen.create === 1 && cancelled && rejected !== null)
    check('wire new:失败原样上抛(网关报错逐字带出)', rejected !== null && ((rejected.includes('session/follow') && rejected.includes('fake gateway deny')) || /内建 WebSocket/.test(rejected)))
    await teardown(server, sockets)
  }
}

console.log(`\n==== 前端车道单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
