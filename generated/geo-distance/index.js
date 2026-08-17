#!/usr/bin/env node
/**
 * MCP stdio server: 地理坐标计算工具,基于 geolib(geolib@3)。
 * 能力点:两点距离(快速/Vincenty 精确)、方位角+罗盘方向、坐标集合的中心点与外接框——
 * agent 做距离估算、导航方向描述、多点范围框定,一轮内完成,无需网络。
 *
 * 导入方式说明:geolib 的 CJS 主入口是 webpack UMD 打包产物,Node 的
 * cjs-module-lexer 识别不出具名导出;而 exports."default" 又指向 ESM 构建。
 * 命名空间导入 + `default ??` 回退对两种解析结果都成立。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as geolibNs from 'geolib';

const {
  getDistance, getPreciseDistance,
  getGreatCircleBearing, getRhumbLineBearing, getCompassDirection,
  getCenter, getBounds, isValidCoordinate,
} = geolibNs.default ?? geolibNs;

const server = new McpServer({ name: 'geo-distance', version: '0.0.1' });

const coordSchema = z.object({
  lat: z.number().describe('纬度(十进制度,-90 ~ 90)'),
  lon: z.number().describe('经度(十进制度,-180 ~ 180)'),
});
const toGeo = ({ lat, lon }) => ({ latitude: lat, longitude: lon });
const badCoord = (tool, label, c) => {
  if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)
    || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180
    || !isValidCoordinate(toGeo(c))) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${tool}: ${label} 坐标非法 (lat=${c.lat}, lon=${c.lon});纬度须在 ±90、经度须在 ±180 之间` }],
    };
  }
  return null;
};
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

server.registerTool('distance', {
  description:
    '计算两个地理坐标之间的大圆距离。输入起点/终点 { lat, lon }(十进制度);返回 JSON { meters, kilometers }。'
    + 'precise=true 用 Vincenty 椭球公式(长距离更准但更慢),默认用快速球面公式;'
    + 'accuracy 为结果取整粒度(米,默认 1,如 100 表示取整到百米)。坐标越界返回错误。',
  inputSchema: {
    from: coordSchema.describe('起点坐标'),
    to: coordSchema.describe('终点坐标'),
    precise: z.boolean().optional().describe('是否用 Vincenty 精确公式(默认 false)'),
    accuracy: z.number().positive().optional().describe('结果取整粒度,单位米(默认 1)'),
  },
}, async ({ from, to, precise, accuracy }) => {
  const bad = badCoord('distance', 'from', from) ?? badCoord('distance', 'to', to);
  if (bad) return bad;
  const fn = precise ? getPreciseDistance : getDistance;
  const meters = fn(toGeo(from), toGeo(to), accuracy ?? 1);
  return { content: [{ type: 'text', text: JSON.stringify({ meters, kilometers: round(meters / 1000, 3) }) }] };
});

server.registerTool('bearing', {
  description:
    '计算从起点到终点的初始方位角与罗盘方向。输入起点/终点 { lat, lon };返回 JSON '
    + '{ bearingDeg(0~360,正北为 0、顺时针,保留两位小数), compass(16 向罗盘方向,如 NE/SSE), method }。'
    + "method 可选 'great-circle'(大圆初始方位角,默认)或 'rhumb-line'(等角航线恒定方位角)。坐标越界返回错误。",
  inputSchema: {
    from: coordSchema.describe('起点坐标'),
    to: coordSchema.describe('终点坐标'),
    method: z.enum(['great-circle', 'rhumb-line']).optional().describe("方位角算法(默认 'great-circle')"),
  },
}, async ({ from, to, method }) => {
  const bad = badCoord('bearing', 'from', from) ?? badCoord('bearing', 'to', to);
  if (bad) return bad;
  const bearingFn = method === 'rhumb-line' ? getRhumbLineBearing : getGreatCircleBearing;
  const raw = bearingFn(toGeo(from), toGeo(to));
  const bearingDeg = round(((raw % 360) + 360) % 360, 2);
  const compass = getCompassDirection(toGeo(from), toGeo(to), bearingFn);
  return { content: [{ type: 'text', text: JSON.stringify({ bearingDeg, compass, method: method ?? 'great-circle' }) }] };
});

server.registerTool('center-and-bounds', {
  description:
    '计算一组地理坐标的几何中心点与外接经纬度框。输入坐标数组 [{ lat, lon }, ...](至少 1 个);返回 JSON '
    + '{ count, center: { lat, lon }, bounds: { minLat, maxLat, minLon, maxLon } }。'
    + '中心点为球面几何中心(点分布不均时偏向密集侧);任一坐标越界返回错误并指明下标。',
  inputSchema: {
    points: z.array(coordSchema).min(1).describe('坐标数组,至少 1 个点'),
  },
}, async ({ points }) => {
  for (let i = 0; i < points.length; i += 1) {
    const bad = badCoord('center-and-bounds', `points[${i}]`, points[i]);
    if (bad) return bad;
  }
  const geoPoints = points.map(toGeo);
  const center = getCenter(geoPoints);
  if (center === false) {
    return { isError: true, content: [{ type: 'text', text: 'center-and-bounds: 无法计算中心点(输入坐标无效)' }] };
  }
  const bounds = getBounds(geoPoints);
  const result = {
    count: points.length,
    center: { lat: center.latitude, lon: center.longitude },
    bounds: { minLat: bounds.minLat, maxLat: bounds.maxLat, minLon: bounds.minLng, maxLon: bounds.maxLng },
  };
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
