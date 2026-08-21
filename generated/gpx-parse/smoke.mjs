/**
 * Smoke test for @dsh-index/gpx-parse MCP stdio server.
 * Connects a real MCP client, lists tools, and exercises both tools with a
 * fixture of KNOWN geometry — asserts real numbers, not just "it started".
 *
 * Fixture: 3 points spaced 0.009° latitude apart (≈ 1000.7 m each, haversine),
 * elevation 100 → 150 → 130 (gain 50, loss 20), timestamps 0/360/720 s.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function textOf(result) {
  const t = result && result.content && result.content[0]
  return t ? t.text : JSON.stringify(result)
}

let failures = 0
function check(name, okv, detail = '') {
  console.log(`  ${okv ? '✓' : '✗ FAIL'} ${name}${okv ? '' : ` — ${detail}`}`)
  if (!okv) failures++
}

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="smoke" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>smoke-run</name></metadata>
  <trk><name>morning</name><trkseg>
    <trkpt lat="30.000" lon="120.000"><ele>100</ele><time>2026-08-21T00:00:00Z</time></trkpt>
    <trkpt lat="30.009" lon="120.000"><ele>150</ele><time>2026-08-21T00:06:00Z</time></trkpt>
    <trkpt lat="30.018" lon="120.000"><ele>130</ele><time>2026-08-21T00:12:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] })
const client = new Client({ name: 'gpx-parse-smoke', version: '0.0.1' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`TOOLS (${tools.length}):`)
for (const t of tools) console.log(`- ${t.name}: ${(t.description || '').slice(0, 80)}...`)
console.log('---')
check('两个工具都在', tools.length === 2 && tools.some((t) => t.name === 'analyze-gpx') && tools.some((t) => t.name === 'extract-points'))

// 1) analyze-gpx: real numbers from known geometry
const r1 = await client.callTool({ name: 'analyze-gpx', arguments: { gpx: GPX } })
console.log('analyze-gpx:')
console.log(textOf(r1))
console.log('---')
const a = JSON.parse(textOf(r1))
const t0 = a.tracks[0]
check('轨迹名解析', a.tracks.length === 1 && t0.name === 'morning', JSON.stringify(a.tracks.map((t) => t.name)))
check('总里程 ≈ 2.0 km(哈弗辛实算)', t0.distance_km > 1.99 && t0.distance_km < 2.02, String(t0.distance_km))
check('爬升 50 m / 下降 20 m', t0.elevation_gain_m === 50 && t0.elevation_loss_m === 20, `${t0.elevation_gain_m}/${t0.elevation_loss_m}`)
check('总耗时 720 s', t0.duration_s === 720, String(t0.duration_s))
check('每公里配速表 2 行', t0.per_km.length === 2, JSON.stringify(t0.per_km))
check('配速 ≈ 6:00/km', t0.per_km[0].seconds > 355 && t0.per_km[0].seconds < 365 && t0.per_km[0].pace.includes('/km'), JSON.stringify(t0.per_km[0]))
check('totals 汇总一致', a.totals.distance_km === t0.distance_km && a.totals.elevation_gain_m === 50, JSON.stringify(a.totals))

// 2) extract-points: full fidelity below limit
const r2 = await client.callTool({ name: 'extract-points', arguments: { gpx: GPX } })
console.log('extract-points:')
console.log(textOf(r2))
console.log('---')
const p = JSON.parse(textOf(r2))
check('3 点全回传', p.total === 3 && p.returned === 3, JSON.stringify(p))
check('点带 ele 与 time', p.points[0].ele === 100 && p.points[0].time === '2026-08-21T00:00:00.000Z', JSON.stringify(p.points[0]))

// 3) limit 采样
const r3 = await client.callTool({ name: 'extract-points', arguments: { gpx: GPX, limit: 2 } })
const p3 = JSON.parse(textOf(r3))
check('limit=2 采样', p3.total === 3 && p3.returned === 2, JSON.stringify(p3))

// 4) 坏输入走可读错误(不是崩溃)
const r4 = await client.callTool({ name: 'analyze-gpx', arguments: { gpx: 'not xml at all' } })
check('坏输入返回可读错误', r4.isError === true && textOf(r4).startsWith('Error:'), textOf(r4).slice(0, 80))

await client.close()
console.log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
