/**
 * @dsh-index/gpx-parse — MCP stdio server wrapping @we-gold/gpxjs 1.2.0.
 *
 * Tools (exposed to the dsh mcp-client as mcp__gpx-parse__<toolname>):
 *   - analyze-gpx    : GPX XML text -> per-track stats (distance km, elevation
 *                      gain/loss m, duration, per-km pace table) + file totals
 *   - extract-points : GPX XML text -> flat sample of track/route points
 *                      (lat, lon, ele, time) for downstream computation
 *
 * gpxjs computes distance (haversine, meters) and elevation (meters); time
 * math (duration, per-km pace) is derived here directly from point timestamps
 * so no unit assumption crosses the library boundary. Node has no DOMParser,
 * hence parseGPXWithCustomParser + xmldom-qsa (the combination the upstream
 * README prescribes for Node).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { parseGPXWithCustomParser } from '@we-gold/gpxjs'
import { DOMParser } from 'xmldom-qsa'

const server = new McpServer({
  name: 'gpx-parse',
  version: '0.0.1',
  instructions:
    'GPX track analysis powered by @we-gold/gpxjs. ' +
    'Use analyze-gpx to get distance, elevation gain/loss, duration and a per-km pace table from GPX XML text; ' +
    'use extract-points to pull raw track points (lat/lon/elevation/time) for custom computation.',
})

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

function parse(gpxText) {
  const [parsed, error] = parseGPXWithCustomParser(
    gpxText,
    (txt) => new DOMParser().parseFromString(txt, 'text/xml'),
  )
  if (error) throw error instanceof Error ? error : new Error(String(error))
  if (!parsed) throw new Error('GPX parsed to nothing (empty or not a GPX document)')
  return parsed
}

/** mm:ss (or h:mm:ss) from seconds. */
function fmtDuration(s) {
  const sec = Math.round(s)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const rest = sec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${m}:${String(rest).padStart(2, '0')}`
}

/**
 * Per-km pace table from cumulative meters + point times. Linear interpolation
 * at each km boundary; needs timestamps on the points, else returns [].
 */
function perKmTable(cumulative, points) {
  const times = points.map((p) => (p.time instanceof Date ? p.time.getTime() : null))
  if (times.some((t) => t === null) || times.length < 2) return []
  const rows = []
  let boundary = 1000
  let prevBoundaryTime = times[0]
  for (let i = 1; i < cumulative.length; i++) {
    while (cumulative[i] >= boundary) {
      const span = cumulative[i] - cumulative[i - 1]
      const frac = span > 0 ? (boundary - cumulative[i - 1]) / span : 0
      const tAtBoundary = times[i - 1] + frac * (times[i] - times[i - 1])
      const seconds = (tAtBoundary - prevBoundaryTime) / 1000
      rows.push({ km: rows.length + 1, seconds: Math.round(seconds), pace: `${fmtDuration(seconds)}/km` })
      prevBoundaryTime = tAtBoundary
      boundary += 1000
    }
  }
  return rows
}

/** One track/route -> stats object (routes share the Track shape in gpxjs). */
function trackStats(t) {
  const pts = t.points ?? []
  const first = pts.find((p) => p.time instanceof Date)
  const last = [...pts].reverse().find((p) => p.time instanceof Date)
  const durationS = first && last ? (last.time.getTime() - first.time.getTime()) / 1000 : null
  const distanceM = t.distance?.total ?? 0
  return {
    name: t.name ?? null,
    points: pts.length,
    distance_km: Math.round((distanceM / 1000) * 1000) / 1000,
    elevation_gain_m: t.elevation?.positive ?? null,
    elevation_loss_m: t.elevation?.negative ?? null,
    elevation_max_m: t.elevation?.maximum ?? null,
    elevation_min_m: t.elevation?.minimum ?? null,
    start_time: first ? first.time.toISOString() : null,
    end_time: last ? last.time.toISOString() : null,
    duration_s: durationS === null ? null : Math.round(durationS),
    duration: durationS === null ? null : fmtDuration(durationS),
    avg_pace: durationS !== null && distanceM > 0 ? `${fmtDuration(durationS / (distanceM / 1000))}/km` : null,
    per_km: perKmTable(t.distance?.cumulative ?? [], pts),
  }
}

// ---------------------------------------------------------------------------
// Tool 1: analyze-gpx
// ---------------------------------------------------------------------------
server.tool(
  'analyze-gpx',
  'Analyze GPX XML text. Returns JSON {name, tracks: [{name, points, distance_km, ' +
    'elevation_gain_m, elevation_loss_m, duration_s, duration, avg_pace, per_km: [{km, seconds, pace}]}], ' +
    'totals: {distance_km, elevation_gain_m, duration_s}}. Routes (<rte>) are analyzed like tracks. ' +
    'Distance is haversine over track points; the per-km pace table needs point timestamps and is empty without them.',
  {
    gpx: z.string().min(1, 'gpx must be non-empty GPX XML text').describe('The GPX file content (XML text, required).'),
  },
  async ({ gpx }) => {
    try {
      const parsed = parse(gpx)
      const units = [...(parsed.tracks ?? []), ...(parsed.routes ?? [])]
      if (units.length === 0) return fail('no <trk> or <rte> found in the GPX document')
      const tracks = units.map(trackStats)
      const totals = {
        distance_km: Math.round(tracks.reduce((s, t) => s + t.distance_km, 0) * 1000) / 1000,
        elevation_gain_m: tracks.reduce((s, t) => s + (t.elevation_gain_m ?? 0), 0),
        duration_s: tracks.every((t) => t.duration_s === null) ? null : tracks.reduce((s, t) => s + (t.duration_s ?? 0), 0),
      }
      return ok(JSON.stringify({ name: parsed.metadata?.name ?? null, tracks, totals }, null, 2))
    } catch (err) {
      return fail(`GPX analysis failed: ${errText(err)}`)
    }
  },
)

// ---------------------------------------------------------------------------
// Tool 2: extract-points
// ---------------------------------------------------------------------------
server.tool(
  'extract-points',
  'Extract raw points from GPX XML text as JSON {total, returned, points: [{lat, lon, ele, time}]}. ' +
    'Points come from all tracks and routes in document order; `limit` caps the returned sample (default 50) ' +
    'with even spacing across the full range so the shape of the whole track is preserved.',
  {
    gpx: z.string().min(1, 'gpx must be non-empty GPX XML text').describe('The GPX file content (XML text, required).'),
    limit: z.number().int().min(1).max(5000).optional()
      .describe('Max points to return, evenly sampled across the track. Default: 50.'),
  },
  async ({ gpx, limit }) => {
    try {
      const parsed = parse(gpx)
      const all = [...(parsed.tracks ?? []), ...(parsed.routes ?? [])].flatMap((t) => t.points ?? [])
      if (all.length === 0) return fail('no track/route points found in the GPX document')
      const cap = limit ?? 50
      const step = all.length <= cap ? 1 : all.length / cap
      const sampled = []
      for (let i = 0; i < all.length && sampled.length < cap; i += step) {
        const p = all[Math.floor(i)]
        sampled.push({
          lat: p.latitude,
          lon: p.longitude,
          ele: p.elevation ?? null,
          time: p.time instanceof Date ? p.time.toISOString() : null,
        })
      }
      return ok(JSON.stringify({ total: all.length, returned: sampled.length, points: sampled }, null, 2))
    } catch (err) {
      return fail(`GPX point extraction failed: ${errText(err)}`)
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[gpx-parse] server ready on stdio')
