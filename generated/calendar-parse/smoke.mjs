/**
 * Smoke test for @dsh-index/calendar-parse MCP stdio server.
 *
 * Connects an MCP Client to `node index.js`, then:
 *   1. listTools -> expect exactly the 3 advertised tools
 *   2. parse-ics with an embedded BEGIN:VCALENDAR string (VEVENT + VTODO + VALARM)
 *   3. parse-ics with missing required param ics -> schema validation error
 *   4. parse-ics with garbage input -> clear error text (isError)
 *   5. parse-ics-file with a temp .ics file on disk
 *   6. fetch-ics-url against a public ICS feed (network)
 *
 * Exits 0 only when every step passes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EXPECTED_TOOLS = ['parse-ics', 'parse-ics-file', 'fetch-ics-url']

const EMBEDDED_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//dsh-smoke//EN',
  'BEGIN:VEVENT',
  'UID:evt-001@dsh',
  'DTSTAMP:20240101T000000Z',
  'DTSTART:20240410T090000Z',
  'DTEND:20240410T100000Z',
  'SUMMARY:Team standup',
  'DESCRIPTION:Daily sync',
  'LOCATION:Zoom',
  'STATUS:CONFIRMED',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Standup in 15m',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:todo-001@dsh',
  'DTSTAMP:20240101T000000Z',
  'DUE:20240412T170000Z',
  'SUMMARY:Submit timesheet',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n')

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] })
const client = new Client({ name: 'calendar-parse-smoke', version: '0.0.1' })

try {
  await client.connect(transport)
  console.log('[1] connected to stdio server')

  // ---- 1. listTools ----
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  check(
    'listTools exposes the 3 expected tools',
    JSON.stringify(names) === JSON.stringify([...EXPECTED_TOOLS].sort()),
    `got: ${names.join(', ')}`
  )
  for (const n of EXPECTED_TOOLS) {
    const t = tools.tools.find((x) => x.name === n)
    check(`tool ${n} has a description for LLM selection`, !!t && typeof t.description === 'string' && t.description.length > 40)
  }

  // ---- 2. parse-ics real call ----
  const res = await client.callTool({ name: 'parse-ics', arguments: { ics: EMBEDDED_ICS } })
  const text = res.content.map((c) => c.text).join('')
  const parsed = JSON.parse(text)
  check('parse-ics returns VEVENT count 1', parsed.counts.VEVENT === 1, `got ${parsed.counts.VEVENT}`)
  check('parse-ics returns VTODO count 1', parsed.counts.VTODO === 1, `got ${parsed.counts.VTODO}`)
  check('parse-ics counts nested VALARM', parsed.counts.VALARM === 1, `got ${parsed.counts.VALARM}`)
  const evt = parsed.components['evt-001@dsh']
  check('parse-ics extracts event summary', evt && evt.summary === 'Team standup', evt && evt.summary)
  check(
    'parse-ics normalizes start datetime to {value, tz}',
    evt && evt.start && evt.start.value === '2024-04-10T09:00:00.000Z',
    evt && evt.start && JSON.stringify(evt.start)
  )
  const todo = parsed.components['todo-001@dsh']
  check('parse-ics extracts todo (type VTODO)', todo && todo.type === 'VTODO' && todo.summary === 'Submit timesheet', todo && todo.summary)
  check('parse-ics preserves location', evt && evt.location === 'Zoom')

  // ---- 3. missing required param ----
  let missingErr = 'no error'
  try {
    const bad = await client.callTool({ name: 'parse-ics', arguments: {} })
    missingErr = bad.isError ? 'returned isError result' : 'UNEXPECTED SUCCESS'
  } catch (e) {
    missingErr = `threw: ${e.message || e}`
  }
  check('parse-ics without ics param is rejected (schema validation)', /error|invalid|expected|required/i.test(missingErr), missingErr.slice(0, 120))

  // ---- 4. garbage input ----
  const garbage = await client.callTool({ name: 'parse-ics', arguments: { ics: 'hello world, not ical' } })
  const gText = garbage.content.map((c) => c.text).join('')
  check('parse-ics garbage input returns clear error text', garbage.isError === true && /no calendar components|Error/.test(gText), gText.slice(0, 120))

  // ---- 5. parse-ics-file ----
  const tmpFile = path.join(os.tmpdir(), 'dsh-smoke-calendar.ics')
  fs.writeFileSync(
    tmpFile,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//dsh-smoke//file//EN',
      'BEGIN:VEVENT',
      'UID:file-evt-001@dsh',
      'DTSTAMP:20240101T000000Z',
      'DTSTART;VALUE=DATE:20241225',
      'DTEND;VALUE=DATE:20241226',
      'SUMMARY:Holiday (all-day)',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
  )
  const fres = await client.callTool({ name: 'parse-ics-file', arguments: { path: tmpFile } })
  const fText = fres.content.map((c) => c.text).join('')
  const fparsed = JSON.parse(fText)
  const fevt = fparsed.components['file-evt-001@dsh']
  check('parse-ics-file reads & parses local .ics', fres.isError !== true && fevt && fevt.summary === 'Holiday (all-day)', fevt && fevt.summary)
  check('parse-ics-file parses all-day date (datetype=date)', fevt && fevt.datetype === 'date', fevt && fevt.datetype)
  const missingFile = await client.callTool({ name: 'parse-ics-file', arguments: { path: '/nonexistent/nope.ics' } })
  check('parse-ics-file missing file returns clear error', missingFile.isError === true, (missingFile.content[0].text || '').slice(0, 100))

  // ---- 6. fetch-ics-url ----
  // raw.githubusercontent.com is blocked by this environment's egress policy, so verify the
  // tool's full axios-fetch -> parse -> return pipeline against a local HTTP server serving a
  // real ICS fixture (test1.ics from the upstream repo). This exercises the same code path.
  const icsFixture = fs.readFileSync('/Users/tongtao/.dsh/index-work/calendar-parse/test/test1.ics', 'utf8')
  const httpServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' })
    res.end(icsFixture)
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const localUrl = `http://127.0.0.1:${httpServer.address().port}/test1.ics`
  try {
    const ures = await client.callTool({ name: 'fetch-ics-url', arguments: { url: localUrl, timeoutMs: 10000 } })
    const uText = ures.content.map((c) => c.text).join('')
    if (ures.isError) {
      check('fetch-ics-url fetches & parses remote feed', false, uText.slice(0, 160))
    } else {
      const uparsed = JSON.parse(uText)
      const evts = Object.values(uparsed.components).filter((c) => c.type === 'VEVENT')
      check('fetch-ics-url fetches & parses remote feed into VEVENTs', evts.length > 0, `fetched ${evts.length} events over HTTP`)
      const named = evts.find((e) => e.summary && /Dyncon/.test(e.summary))
      check('fetch-ics-url extracts a known event (Dyncon 2011)', !!named, named && named.summary)
    }
  } catch (e) {
    check('fetch-ics-url fetches & parses remote feed', false, `tool error: ${e.message || e}`)
  } finally {
    httpServer.close()
  }

  // ---- cleanup ----
  fs.rmSync(tmpFile, { force: true })
  await client.close()
} catch (e) {
  fail++
  console.error('SMOKE FATAL:', e)
} finally {
  try {
    transport.close()
  } catch {
    /* ignore */
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
