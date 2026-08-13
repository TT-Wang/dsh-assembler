/**
 * @dsh-index/calendar-parse — MCP stdio server wrapping node-ical 0.19.0 (jens-maus/node-ical).
 *
 * Tools (exposed to the dsh mcp-client as mcp__calendar-parse__<toolname>):
 *   - parse-ics       : ICS/ICAL calendar text -> structured JSON (events, todos, journals, alarms, timezones)
 *   - parse-ics-file  : parse a local .ics file on disk -> same structured JSON
 *   - fetch-ics-url   : fetch an ICS/ICAL feed from a remote URL and parse it -> same structured JSON
 *
 * All parsing happens in-process via node-ical (moment-timezone + rrule for recurrence
 * expansion). Every tool returns a JSON document with a `counts` overview plus the full
 * `components` map keyed by UID. Date/time fields are normalized to { value: <ISO 8601>,
 * tz: <TZID or null> } so timezone information survives JSON serialization; RRULE objects
 * are rendered as their RFC 5545 rule string.
 *
 * NOTE: with @modelcontextprotocol/sdk 1.30 the server.tool() params schema must be a
 * ZodRawShape (a plain object of zod fields) — wrapping the fields in z.object({...})
 * makes the SDK throw "expected a Zod schema or ToolAnnotations". The zod fields below
 * are therefore passed as a raw shape; the SDK builds and validates the z.object itself.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import ical from 'node-ical'

const server = new McpServer({
  name: 'calendar-parse',
  version: '0.0.1',
  instructions:
    'iCalendar (ICS/ICAL) parsing powered by node-ical 0.19.0. ' +
    'Use parse-ics to extract events/todos/alarms from ICS text, parse-ics-file to read a local ' +
    '.ics file from disk, and fetch-ics-url to download and parse a remote calendar feed. ' +
    'All tools return {counts, components}: counts summarizes component types, components maps ' +
    'each UID to its parsed record; datetimes are {value: ISO 8601, tz: TZID-or-null}.',
})

/** Standard MCP text result. */
function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/** Standard MCP error result (returned, not thrown, so the client always gets a readable message). */
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Recursively normalize a parsed node-ical component tree for JSON output:
 *  - Date instances (node-ical attaches a `.tz` timezone id to them) become
 *    { value: <ISO 8601 string>, tz: <TZID | null> } so the timezone survives JSON.
 *  - RRule instances (rrule library) become their RFC 5545 rule string via toString().
 *  - Everything else (arrays, plain objects, primitives) is preserved.
 * A WeakSet guards against accidental reference cycles.
 */
function normalize(value, seen = new WeakSet()) {
  if (value instanceof Date) {
    return { value: value.toISOString(), tz: typeof value.tz === 'string' ? value.tz : null }
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalize(v, seen))
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    // Non-plain objects (e.g. rrule's RRule) -> serialize via their string form.
    const ctor = value.constructor && value.constructor.name
    if (ctor !== 'Object' && ctor !== 'Array' && typeof value.toString === 'function') {
      return String(value)
    }
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, seen)
    return out
  }
  return value
}

/** Build the standard tool result document from a parsed calendar object. */
function buildResult(parsed) {
  const counts = {}
  for (const comp of Object.values(parsed)) {
    const t = comp && comp.type ? String(comp.type) : 'UNKNOWN'
    counts[t] = (counts[t] || 0) + 1
    // Count nested alarms (VALARM) inside events/todos as well.
    if (Array.isArray(comp.alarms) && comp.alarms.length > 0) {
      counts.VALARM = (counts.VALARM || 0) + comp.alarms.length
    }
  }
  const doc = {
    counts,
    totalComponents: Object.keys(parsed).length,
    components: normalize(parsed),
  }
  return JSON.stringify(doc, null, 2)
}

/** Validate that the parsed calendar actually contains components. */
function requireComponents(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('parse produced no output object')
  }
  const keys = Object.keys(parsed).filter((k) => parsed[k] && parsed[k].type)
  if (keys.length === 0) {
    throw new Error('no calendar components found: input does not look like valid iCalendar (ICS) data')
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Tool 1: parse-ics
// ---------------------------------------------------------------------------
server.tool(
  'parse-ics',
  'Parse iCalendar (ICS/ICAL) text into structured JSON using node-ical. Returns ' +
    '{counts, totalComponents, components}: counts tallies component types (VEVENT, VTODO, ' +
    'VJOURNAL, VFREEBUSY, VTIMEZONE, VALARM...), components maps each UID to its parsed record ' +
    'with fields like summary, description, location, start/end (as {value: ISO 8601, tz: TZID}), ' +
    'status, organizer, attendees, rrule (recurrence rule string), recurrences (expanded ' +
    'occurrences), and alarms. Ideal for extracting events/todos from ICS strings embedded in ' +
    'files, emails, or API payloads. Feed the raw ICS text (including BEGIN:VCALENDAR / END:VCALENDAR).',
  {
    ics: z
      .string()
      .min(1, 'ics must be a non-empty string containing iCalendar data')
      .describe('Raw iCalendar (ICS/ICAL) text to parse, e.g. an embedded BEGIN:VCALENDAR ... END:VCALENDAR string (required).'),
  },
  async ({ ics }) => {
    try {
      const parsed = requireComponents(ical.parseICS(ics))
      return ok(buildResult(parsed))
    } catch (err) {
      return fail(`could not parse ICS input: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 2: parse-ics-file
// ---------------------------------------------------------------------------
server.tool(
  'parse-ics-file',
  'Parse a local .ics / .ical file on disk into the same structured JSON as parse-ics ' +
    '({counts, totalComponents, components}, keyed by UID). The path must exist and be readable ' +
    'by this process. Useful when the calendar data already lives in the filesystem and avoids ' +
    're-sending the file content through the tool boundary.',
  {
    path: z
      .string()
      .min(1, 'path must be a non-empty string')
      .describe('Absolute or relative filesystem path to the .ics/.ical file to read and parse (required).'),
  },
  async ({ path }) => {
    try {
      const parsed = requireComponents(ical.sync.parseFile(path))
      return ok(buildResult(parsed))
    } catch (err) {
      return fail(`could not read/parse file "${path}": ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 3: fetch-ics-url
// ---------------------------------------------------------------------------
server.tool(
  'fetch-ics-url',
  'Fetch an iCalendar (ICS/ICAL) feed from a remote URL (HTTP GET via axios) and parse it into ' +
    'the same structured JSON as parse-ics ({counts, totalComponents, components}, keyed by UID). ' +
    'The URL should point directly at a .ics/.ical file or a calendar subscription endpoint ' +
    '(e.g. Google Calendar private-ics links, WebDAV calendar feeds). ' +
    'NOTE: this tool performs an outbound network request; it needs network access and the ' +
    'endpoint must be reachable without authentication (or publicly accessible).',
  {
    url: z
      .string()
      .url('url must be a valid absolute URL, e.g. https://example.com/calendar.ics')
      .describe('Absolute URL of the ICS/ICAL feed to download and parse (required).'),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe('HTTP request timeout in milliseconds. Default: 15000 (15s).'),
  },
  async ({ url, timeoutMs }) => {
    try {
      const parsed = requireComponents(await ical.async.fromURL(url, { timeout: timeoutMs ?? 15000 }))
      return ok(buildResult(parsed))
    } catch (err) {
      return fail(`could not fetch/parse "${url}": ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Transport wiring: clean start and clean exit.
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Graceful shutdown on SIGINT/SIGTERM.
  const shutdown = async (signal) => {
    try {
      await server.close()
    } catch {
      /* already closed */
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // When stdin closes (parent process ended / pipe closed) exit cleanly.
  process.stdin.on('end', () => {
    server.close().catch(() => {})
    setTimeout(() => process.exit(0), 50)
  })
}

main().catch((err) => {
  console.error(`[calendar-parse] fatal: ${errText(err)}`)
  process.exit(1)
})
