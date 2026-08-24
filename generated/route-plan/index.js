#!/usr/bin/env node
/**
 * route-plan — 路径规划与行程矩阵(地图缺口的"路线"半边;geocode 零件管"地址→坐标")。
 *
 * 上游 OSRM 公共演示实例(router.project-osrm.org,零凭证)。与 geocode 零件用
 * Nominatim 同款纪律:公共演示服务 = 自律使用、带 UA、不得重载;自建实例经
 * OSRM_BASE 切换即可(交付给客户时通常换成客户自己的实例)。
 * 归类:事实源(单脸终审,不长服务脸)。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = process.env.OSRM_BASE || 'https://router.project-osrm.org';
const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)';
const PROFILES = new Set(['driving', 'walking', 'cycling']);
const server = new McpServer({ name: 'route-plan', version: '0.0.1' });
const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
const err = (m) => ({ isError: true, content: [{ type: 'text', text: `route-plan: ${m}` }] });

const validPt = (p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x))
  && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
const fmt = (pts) => pts.map((p) => `${p[0]},${p[1]}`).join(';');

async function osrm(service, profile, coords, params) {
  const u = new URL(`${BASE}/${service}/v1/${profile}/${fmt(coords)}`);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
  const j = await res.json();
  if (j.code !== 'Ok') throw new Error(`上游:${j.code}${j.message ? ` — ${String(j.message).slice(0, 120)}` : ''}`);
  return j;
}

server.registerTool('route-info', {
  description: '报告当前 OSRM 端点与可用出行方式(driving/walking/cycling)。坐标一律 [经度, 纬度](与 geocode 零件的输出顺序一致)。',
  inputSchema: {},
}, async () => text({ base: BASE, profiles: [...PROFILES], coordinateOrder: '[lon, lat]', pairsWith: 'geocode(地址→坐标)' }));

server.registerTool('plan-route', {
  description: '规划一条经过若干点的路线,返回总距离(米)、总时长(秒)与分段转向指引。坐标 [经度, 纬度],2..25 个点。',
  inputSchema: {
    coordinates: z.array(z.array(z.number())).describe('路径点数组,如 [[116.39,39.90],[121.47,31.23]]'),
    profile: z.string().optional().describe('driving(默认)/walking/cycling'),
    steps: z.boolean().optional().describe('是否返回转向指引,默认 true'),
  },
}, async ({ coordinates, profile, steps }) => {
  const p = PROFILES.has(profile) ? profile : 'driving';
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 25) return err('coordinates 需 2..25 个点');
  const bad = coordinates.findIndex((c) => !validPt(c));
  if (bad >= 0) return err(`第 ${bad + 1} 个点非法(需 [经度 -180..180, 纬度 -90..90])`);
  try {
    const j = await osrm('route', p, coordinates, { overview: 'false', steps: steps === false ? 'false' : 'true' });
    const r = j.routes[0];
    return text({
      profile: p,
      distanceMeters: Math.round(r.distance),
      durationSeconds: Math.round(r.duration),
      legs: (r.legs ?? []).map((leg) => ({
        distanceMeters: Math.round(leg.distance),
        durationSeconds: Math.round(leg.duration),
        steps: (leg.steps ?? []).slice(0, 60).map((s) => ({
          name: s.name || null, distanceMeters: Math.round(s.distance),
          maneuver: s.maneuver?.type ?? null, modifier: s.maneuver?.modifier ?? null,
        })),
      })),
    });
  } catch (e) { return err(String(e && e.message || e).slice(0, 200)); }
});

server.registerTool('travel-matrix', {
  description: '多点之间的行程时长/距离矩阵(排班、就近派单、路线取舍用)。坐标 [经度, 纬度],2..12 个点。',
  inputSchema: {
    coordinates: z.array(z.array(z.number())),
    profile: z.string().optional(),
  },
}, async ({ coordinates, profile }) => {
  const p = PROFILES.has(profile) ? profile : 'driving';
  if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 12) return err('coordinates 需 2..12 个点(矩阵是平方级,公共实例请自律)');
  const bad = coordinates.findIndex((c) => !validPt(c));
  if (bad >= 0) return err(`第 ${bad + 1} 个点非法`);
  try {
    const j = await osrm('table', p, coordinates, { annotations: 'duration,distance' });
    return text({
      profile: p,
      durationsSeconds: (j.durations ?? []).map((row) => row.map((v) => (v === null ? null : Math.round(v)))),
      distancesMeters: (j.distances ?? []).map((row) => row.map((v) => (v === null ? null : Math.round(v)))),
    });
  } catch (e) { return err(String(e && e.message || e).slice(0, 200)); }
});

await server.connect(new StdioServerTransport());
