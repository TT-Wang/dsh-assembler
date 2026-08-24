#!/usr/bin/env node
// 按脸验收(2026-08-25 采购批):零件分类法说"每个能力可以长几张脸",这份甲具
// 就按脸逐一实证——同一件零件,该有的脸都真调一遍,没有的脸不假装有。
//   模型脸  独立连上零件真调一发(不信 smoke 自报)
//   服务脸  HTTP 直连:鉴权、真字节/真结果
//   凭证契约 未配 env 时:起得来、listTools 成功、调用回可行动错误(点名 env)
// 用法:node bench/verify-faces.mjs
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rows = []
const rec = (part, face, ok, evidence) => {
  rows.push({ part, face, ok, evidence })
  console.log(`${ok ? '✅' : '❌'} ${part.padEnd(15)} ${face.padEnd(10)} ${evidence}`)
}
const J = (r) => JSON.parse(r.content[0].text)

async function open(part, env = {}) {
  const wd = mkdtempSync(join(tmpdir(), `faces-${part}-`))
  const t = new StdioClientTransport({
    command: 'node',
    args: [join(REPO, 'generated', part, 'index.js')],
    env: { ...process.env, PART_WORKDIR: wd, ...env },
  })
  const c = new Client({ name: `faces-${part}`, version: '0.0.1' })
  await c.connect(t)
  return { c, t, wd }
}

// ── speech-io:模型脸(TTS 真出音频)+ 服务脸(直回 mp3 字节)+ 凭证契约(ASR)──
{
  const { c, t } = await open('speech-io', { SPEECH_API_KEY: '' })
  const spoken = J(await c.callTool({ name: 'speak', arguments: { text: '按脸验收:音频字节不过模型。', name: 'faces.mp3' } }))
  rec('speech-io', '模型脸', spoken.bytes > 3000 && existsSync(spoken.path) && spoken.path.endsWith('faces.mp3'), `TTS 真出 ${spoken.bytes} 字节,只回路径`)
  const info = J(await c.callTool({ name: 'speech-info', arguments: {} }))
  const H = { 'x-service-token': info.token }
  const spk = await fetch(`${info.url}/speak?${new URLSearchParams({ text: '服务脸直取' })}`, { headers: H })
  const buf = Buffer.from(await spk.arrayBuffer())
  const unauth = await fetch(`${info.url}/speak?text=x`, { headers: { 'x-service-token': 'wrong' } })
  rec('speech-io', '服务脸', spk.headers.get('content-type') === 'audio/mpeg' && buf.length > 3000 && unauth.status === 401, `直回 audio/mpeg ${buf.length} 字节;错 token 401`)
  const asr = await c.callTool({ name: 'transcribe', arguments: { path: spoken.path } })
  rec('speech-io', '凭证契约', asr.isError === true && asr.content[0].text.includes('SPEECH_API_KEY'), 'ASR 未配 key:起得来、点名 env、TTS 不受影响')
  await t.close()
}

// ── vector-store:模型脸(相似度真排序)+ 服务脸(页面零模型语义搜索)──────────
{
  const { c, t } = await open('vector-store')
  await c.callTool({ name: 'vector-add', arguments: { collection: 'faces', items: [
    { id: 'x', vector: [1, 0, 0], text: '水果' }, { id: 'y', vector: [0, 1, 0], text: '交通' },
  ] } })
  const s = J(await c.callTool({ name: 'vector-search', arguments: { collection: 'faces', vector: [0.98, 0.02, 0], topK: 1 } }))
  rec('vector-store', '模型脸', s.hits[0].id === 'x' && s.hits[0].score > 0.9, `相似度真排序,命中 ${s.hits[0].id}@${s.hits[0].score}`)
  const info = J(await c.callTool({ name: 'vector-info', arguments: {} }))
  const r = await (await fetch(`${info.url}/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': info.token },
    body: JSON.stringify({ collection: 'faces', vector: [0, 1, 0], topK: 1 }),
  })).json()
  const unauth = await fetch(`${info.url}/collections`, { headers: { 'x-service-token': 'wrong' } })
  rec('vector-store', '服务脸', r.hits?.[0]?.id === 'y' && unauth.status === 401, `HTTP 直搜命中 ${r.hits?.[0]?.id};错 token 401`)
  await t.close()
}

// ── translate-text / route-plan:模型脸真调上游 ───────────────────────────────
{
  const { c, t } = await open('translate-text')
  const tr = J(await c.callTool({ name: 'translate', arguments: { text: '零件已验收', from: 'zh', to: 'en' } }))
  rec('translate-text', '模型脸', /[a-zA-Z]{3,}/.test(tr.translated), `真调:「${tr.source}」→「${tr.translated}」`)
  await t.close()
}
{
  const { c, t } = await open('route-plan')
  const r = J(await c.callTool({ name: 'plan-route', arguments: { coordinates: [[116.397, 39.909], [117.208, 39.135]] } }))
  rec('route-plan', '模型脸', r.distanceMeters > 80000 && r.distanceMeters < 250000, `真调 OSRM:北京→天津 ${Math.round(r.distanceMeters / 1000)}km / ${Math.round(r.durationSeconds / 60)}min`)
  await t.close()
}

// ── im-bot:模型脸(mock 真推,消息体形状)+ 凭证契约(未配的那家)────────────
{
  const { createServer } = await import('node:http')
  const seen = []
  const mock = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => { seen.push(JSON.parse(b || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"errcode":0}') })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${mock.address().port}/hook`
  const { c, t } = await open('im-bot', { WECOM_WEBHOOK: url, FEISHU_WEBHOOK: '' })
  const sent = J(await c.callTool({ name: 'imbot-send', arguments: { provider: 'wecom', text: '按脸验收 FACE-OK' } }))
  rec('im-bot', '模型脸', sent.sent === true && seen.at(-1).text.content === '按脸验收 FACE-OK', 'mock 群真收到,企微消息体形状正确')
  const f = await c.callTool({ name: 'imbot-send', arguments: { provider: 'feishu', text: 'x' } })
  rec('im-bot', '凭证契约', f.isError === true && f.content[0].text.includes('FEISHU_WEBHOOK'), '未配的那家:可行动错误、点名 env')
  await t.close(); mock.close()
}

// ── embed-text / object-store:凭证契约(接口先就位)────────────────────────────
for (const [part, tool, args, envName] of [
  ['embed-text', 'embed-texts', { texts: ['x'] }, 'EMBED_API_KEY'],
  ['object-store', 's3-list', { bucket: 'b' }, 'S3_ACCESS_KEY'],
]) {
  const { c, t } = await open(part, { EMBED_API_KEY: '', S3_ACCESS_KEY: '', S3_SECRET_KEY: '', S3_ENDPOINT: '' })
  const tools = (await c.listTools()).tools.map((x) => x.name)
  const call = await c.callTool({ name: tool, arguments: args })
  rec(part, '凭证契约', tools.length > 0 && call.isError === true && call.content[0].text.includes(envName),
    `未配凭证:listTools ${tools.length} 个工具照常、调用点名 ${envName}`)
  await t.close()
}

// ── file-channel(上一批)也纳入按脸复核:服务脸字节完整 ───────────────────────
{
  const { c, t } = await open('file-channel')
  const info = J(await c.callTool({ name: 'file-channel-info', arguments: {} }))
  const H = { 'x-service-token': info.token }
  const payload = Buffer.from([...Array(1024).keys()].map((i) => i % 256))
  await fetch(`${info.url}/upload/faces.bin`, { method: 'POST', headers: H, body: payload })
  const back = Buffer.from(await (await fetch(`${info.url}/file/faces.bin`, { headers: H })).arrayBuffer())
  rec('file-channel', '服务脸', Buffer.compare(payload, back) === 0, `直传取回 ${back.length} 字节逐位一致`)
  await t.close()
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
const byFace = rows.reduce((m, r) => { (m[r.face] ??= []).push(r); return m }, {})
console.log('\n═══ 按脸汇总 ═══')
for (const [face, list] of Object.entries(byFace)) {
  console.log(`${face}:${list.filter((x) => x.ok).length}/${list.length} — ${list.map((x) => x.part).join(', ')}`)
}
const passed = rows.filter((r) => r.ok).length
console.log(`\n总计 ${passed}/${rows.length}`)
process.exit(passed === rows.length ? 0 : 1)
