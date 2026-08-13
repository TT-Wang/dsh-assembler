// Smoke test for @dsh-index/qrcode-generate MCP stdio server.
// Covers: listTools, real tool round-trips (PNG magic number, data URL, SVG, terminal),
// and missing-parameter validation.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const results = []
function check (name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
})

const client = new Client({ name: 'qrcode-generate-smoke', version: '0.0.1' })

try {
  await client.connect(transport)
  console.log('connected to server\n')

  // 1) listTools
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name).sort()
  console.log('tools:', names.join(', '))
  check('listTools returns 4 tools', tools.length === 4, `count=${tools.length}`)
  check('tool qr-generate-png present', names.includes('qr-generate-png'))
  check('tool qr-generate-data-url present', names.includes('qr-generate-data-url'))
  check('tool qr-generate-svg present', names.includes('qr-generate-svg'))
  check('tool qr-generate-terminal present', names.includes('qr-generate-terminal'))

  // 2) qr-generate-png round trip: base64 -> PNG magic 89504E47
  const png = await client.callTool({
    name: 'qr-generate-png',
    arguments: { text: 'https://example.com/hello', errorCorrectionLevel: 'H', width: 128 }
  })
  const pngText = png.content.find((c) => c.type === 'text')?.text ?? ''
  let pngOk = false
  let pngDetail = ''
  try {
    const buf = Buffer.from(pngText, 'base64')
    const magic = buf.subarray(0, 4).toString('hex').toUpperCase()
    pngOk = magic === '89504E47'
    pngDetail = `magic=${magic} bytes=${buf.length}`
  } catch (e) {
    pngDetail = 'decode failed: ' + e.message
  }
  check('qr-generate-png returns base64 PNG with magic 89504E47', pngOk, pngDetail)

  // 3) qr-generate-data-url round trip
  const du = await client.callTool({
    name: 'qr-generate-data-url',
    arguments: { text: 'HELLO-123', version: 4, margin: 2 }
  })
  const duText = du.content.find((c) => c.type === 'text')?.text ?? ''
  check(
    'qr-generate-data-url returns data:image/png;base64,...',
    duText.startsWith('data:image/png;base64,'),
    `prefix=${duText.slice(0, 30)}...`
  )

  // 4) qr-generate-svg round trip
  const svg = await client.callTool({
    name: 'qr-generate-svg',
    arguments: { text: 'SVG TEST', darkColor: '#ff0000' }
  })
  const svgText = svg.content.find((c) => c.type === 'text')?.text ?? ''
  check('qr-generate-svg returns <svg markup', svgText.trimStart().startsWith('<svg'), `len=${svgText.length}`)

  // 5) qr-generate-terminal round trip
  const term = await client.callTool({
    name: 'qr-generate-terminal',
    arguments: { text: 'TERMINAL', small: true }
  })
  const termText = term.content.find((c) => c.type === 'text')?.text ?? ''
  const hasBlockChar = /[▀▄█▌ ]/.test(termText)
  check('qr-generate-terminal returns block-char art', hasBlockChar, `lines=${termText.split('\n').length}`)

  // 6) missing required param -> tool-level error
  const miss = await client.callTool({ name: 'qr-generate-png', arguments: {} })
  const missText = miss.content.find((c) => c.type === 'text')?.text ?? ''
  const isErr = miss.isError === true || /error/i.test(missText)
  check('missing text param yields error', isErr, missText.slice(0, 80))

  // 7) invalid option value -> clear error, not a crash
  const bad = await client.callTool({
    name: 'qr-generate-png',
    arguments: { text: 'x', version: 99 }
  })
  const badText = bad.content.find((c) => c.type === 'text')?.text ?? ''
  check('invalid version yields error text', bad.isError === true || /error/i.test(badText), badText.slice(0, 80))

  await client.close()
} catch (err) {
  console.error('SMOKE FATAL:', err)
  process.exitCode = 1
} finally {
  await transport.close().catch(() => {})
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) process.exitCode = 1
}
