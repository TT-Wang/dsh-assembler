#!/usr/bin/env node
/**
 * MCP stdio server: 图片 EXIF/GPS 元数据读取,基于 exifr@7。
 * 能力点:agent 拿到一张照片(base64 或工作区路径)就能读出相机型号、
 * 拍摄时间、GPS 坐标、曝光参数等,一轮内完成。
 *
 * 安全:path 模式解析后的路径必须留在进程 cwd(会话工作区)内,越出即拒。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
// exifr 的 npm main 指向 CJS 打包(dist/full.umd.cjs),README 认可的 Node 用法
// 即默认导入;兜底 .default 形状。
import exifrPkg from 'exifr';

const exifr = exifrPkg?.parse ? exifrPkg : exifrPkg.default;

const server = new McpServer({ name: 'exif-read', version: '0.0.1' });

/** 常用字段挑选顺序(存在才输出)。 */
const SUMMARY_KEYS = [
  'Make', 'Model', 'LensModel', 'DateTimeOriginal', 'CreateDate',
  'ISO', 'FNumber', 'ExposureTime', 'FocalLength', 'Orientation',
  'ExifImageWidth', 'ExifImageHeight', 'latitude', 'longitude',
];

/** JSON 化前清洗:Date → ISO 字符串,二进制视图 → 占位说明,递归处理。 */
function sanitize(v) {
  if (v instanceof Date) return v.toISOString();
  if (ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`;
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  }
  return v;
}

const RAW_CAP = 4000;

server.registerTool('read-exif', {
  description:
    '读取图片的 EXIF/GPS/基本元数据。输入 base64 图片字节或工作区内路径(二选一,恰好给一个);'
    + '支持 jpg/tiff/heic/png 等。返回 JSON:summary 挑常用字段(Make/Model/DateTimeOriginal/'
    + 'ISO/FNumber/GPS latitude+longitude 等,存在才给),raw 是全量解析结果(超长截断)。'
    + '图片合法但无 EXIF 时返回 hasExif:false 的结构化说明(非错误);'
    + '字节不是可解析的图片格式、路径越出工作区、base64 非法时返回错误。',
  inputSchema: {
    base64: z.string().optional().describe('图片内容的 base64 编码(与 path 二选一)'),
    path: z.string().optional().describe('图片路径,相对当前工作区,禁止越出(与 base64 二选一)'),
  },
}, async ({ base64, path }) => {
  if ((base64 === undefined) === (path === undefined)) {
    return { isError: true, content: [{ type: 'text', text: 'read-exif: base64 与 path 必须恰好提供一个' }] };
  }
  let bytes;
  if (path !== undefined) {
    const root = process.cwd();
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + sep)) {
      return { isError: true, content: [{ type: 'text', text: `read-exif: path escapes the workspace: ${path}` }] };
    }
    try {
      bytes = readFileSync(target);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `read-exif: 读文件失败: ${e.message}` }] };
    }
  } else {
    const clean = base64.replace(/\s+/g, '');
    if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
      return { isError: true, content: [{ type: 'text', text: 'read-exif: base64 无法解码(非法字符或长度)' }] };
    }
    bytes = Buffer.from(clean, 'base64');
  }

  let parsed;
  try {
    parsed = await exifr.parse(bytes); // 默认解析 IFD0 + EXIF + GPS,GPS 已换算成十进制 latitude/longitude
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `read-exif: 不是可解析的图片格式: ${e.message}` }] };
  }
  if (parsed == null) {
    const out = { hasExif: false, note: '图片可解析,但没有 EXIF 元数据(截图/网图常见)', byteLength: bytes.length };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }

  const cleanParsed = sanitize(parsed);
  const summary = {};
  for (const k of SUMMARY_KEYS) if (cleanParsed[k] !== undefined) summary[k] = cleanParsed[k];
  let raw = JSON.stringify(cleanParsed);
  if (raw.length > RAW_CAP) raw = `${raw.slice(0, RAW_CAP)}…(truncated, ${raw.length} chars total)`;
  const out = { hasExif: true, byteLength: bytes.length, summary, raw };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
