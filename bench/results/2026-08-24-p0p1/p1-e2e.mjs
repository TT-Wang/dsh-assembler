// P1 验收门 e2e:app 形态读书助手——浏览器角色全链路(要端点→字节直传→路径解析)。
// 对照基线 = 模型中枢版的实测(base64 过模型必坏,ledger 在案 816s FAIL)。
import { createRequire } from 'node:module'
const require2 = createRequire('/Users/tongtao/code/dsh-assembler/generated/book-intake/index.js')
const AdmZip = require2('adm-zip')
import { writeFileSync, readFileSync } from 'node:fs'

const PORT = 3096, PRESET = 'jj-reading'
const t0 = Date.now()
const mark = (s) => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${s}`)

// 1. 造真 epub(两章,书名微尘集)
const zip = new AdmZip()
zip.addFile('mimetype', Buffer.from('application/epub+zip'))
zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'))
zip.addFile('OEBPS/content.opf', Buffer.from('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>微尘集</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'))
zip.addFile('OEBPS/ch1.xhtml', Buffer.from('<html><body><h1>夜航</h1><p>船在夜里走。</p></body></html>'))
zip.addFile('OEBPS/ch2.xhtml', Buffer.from('<html><body><h1>灯下</h1><p>灯下读旧信。</p></body></html>'))
const epub = zip.toBuffer()
mark(`epub 就绪(${epub.length} 字节)`)

const rpc = async (m, p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `p1-${Date.now()}-${Math.random().toString(36).slice(2)}`, method: m, payload: p }), signal: AbortSignal.timeout(30000) })
  const j = await r.json()
  if (!j.result?.ok) throw new Error(`${m}: ${JSON.stringify(j.result?.error ?? '').slice(0, 200)}`)
  return j.result.value
}
const WORKDIR = `/Users/tongtao/.dsh/.agent-presets/${PRESET}/workspace`
const { sessionId } = await rpc('session.create', { cwd: WORKDIR, agentPreset: PRESET })
const frames = []
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/events.mux`)
ws.onmessage = (m) => { try { const f = JSON.parse(String(m.data)); if (f.payload?.type === 'session/event' && f.payload.sessionId === sessionId) frames.push(f.payload.event) } catch {} }
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

async function turn(text, timeoutMs = 240000) {
  const ends = frames.filter((e) => e.type === 'turn/end').length
  const start = frames.length
  await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    if (frames.filter((e) => e.type === 'turn/end').length > ends) {
      return frames.slice(start).filter((e) => e.type === 'assistant/message')
        .map((e) => { const c = e.data?.message?.content ?? []; return Array.isArray(c) ? c.map((b) => b?.type === 'text' ? b.text : '').join('') : '' }).join('\n')
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error(`turn 超时 ${timeoutMs}ms`)
}

// 2. 要端点(页面同款问法)
const tA = Date.now()
const r1 = await turn('请调用 upload-info 工具,把它返回的 JSON 原样放进回复末尾的 ```json 围栏(不增删字段),不要执行其他操作。', 180000)
const fence = [...r1.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)
const info = JSON.parse(fence[1])
if (!info.url || !info.url.startsWith('http://127.0.0.1')) throw new Error('端点非法: ' + JSON.stringify(info).slice(0, 120))
mark(`端点到手(${((Date.now()-tA)/1000).toFixed(1)}s):${info.url}`)

// 3. 字节直传(浏览器角色,不经模型)
const tB = Date.now()
const up = await fetch(info.url + 'weichen.epub', { method: 'POST', body: epub })
const uj = await up.json()
if (!up.ok || !uj.path) throw new Error('直传失败: ' + JSON.stringify(uj))
mark(`直传落盘(${Date.now()-tB}ms):${uj.path}(${uj.bytes ?? epub.length} 字节)`)

// 4. 路径解析入库 + 内容断言(标记:书名+第二章标题+正文词)
const tC = Date.now()
const r2 = await turn('工作区 uploads/weichen.epub 是刚直传的一本 epub 电子书。请解析它:自动分章节、把元数据与正文入库,然后报出书名、第二章标题、以及第二章正文第一句。', 240000)
const hit = (s) => r2.includes(s)
const passed = hit('微尘集') && hit('灯下') && hit('灯下读旧信')
mark(`解析轮完成(${((Date.now()-tC)/1000).toFixed(1)}s)标记:微尘集${hit('微尘集')?'✓':'✗'} 灯下${hit('灯下')?'✓':'✗'} 正文${hit('灯下读旧信')?'✓':'✗'}`)
console.log('回复摘录:', r2.slice(0, 300).replace(/\n/g, ' '))
try { await rpc('session.cancel', { sessionId }) } catch {}
ws.close()
console.log(passed ? `\nP1 验收门:PASS(总 ${((Date.now()-t0)/1000).toFixed(1)}s;字节全程未经模型)` : '\nP1 验收门:FAIL')
process.exit(passed ? 0 : 1)
