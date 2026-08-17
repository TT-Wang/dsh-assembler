#!/usr/bin/env node
/**
 * 冒烟:listTools → 路径模式读上游夹具图(Canon img_1771.jpg)断言 Make/Model/拍摄时间 →
 * base64 模式同图结果一致 → 无 EXIF 图返回结构化空说明 → 纯文本字节被拒 →
 * 越出工作区路径被拒 → 坏 base64 被拒。
 * 夹具从 .cache/upstream/exif-read/test/fixtures/ 拷进本目录再走路径模式(服务器 cwd 固定为本目录)。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const trim = (v) => String(v ?? '').trim();

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', '..', '.cache', 'upstream', 'exif-read', 'test', 'fixtures');
const exifBytes = readFileSync(join(fixtureDir, 'img_1771.jpg')); // Canon PowerShot S40,带 EXIF
const noExifBytes = readFileSync(join(fixtureDir, 'noexif.jpg'));
const copyName = '.smoke-fixture.jpg';
writeFileSync(join(here, copyName), exifBytes);

const transport = new StdioClientTransport({ command: 'node', args: [join(here, 'index.js')], cwd: here });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

try {
  const tools = await client.listTools();
  check('listTools 返回 1 个工具', tools.tools.length === 1, tools.tools.map((t) => t.name).join(','));

  // 路径模式
  const r1 = await client.callTool({ name: 'read-exif', arguments: { path: copyName } });
  const e1 = JSON.parse(text(r1));
  check('路径模式 hasExif=true', e1.hasExif === true);
  check('Make/Model/DateTimeOriginal 至少一个存在',
    Boolean(e1.summary?.Make || e1.summary?.Model || e1.summary?.DateTimeOriginal),
    JSON.stringify(e1.summary ?? {}).slice(0, 120));
  check('Make 是 Canon(空白宽容)', trim(e1.summary?.Make) === 'Canon', JSON.stringify(e1.summary?.Make));

  // base64 模式,同一张图 → 关键字段一致
  const r2 = await client.callTool({ name: 'read-exif', arguments: { base64: exifBytes.toString('base64') } });
  const e2 = JSON.parse(text(r2));
  check('base64 模式 hasExif=true', e2.hasExif === true);
  check('两种模式 Make/Model/拍摄时间一致',
    trim(e1.summary?.Make) === trim(e2.summary?.Make)
    && trim(e1.summary?.Model) === trim(e2.summary?.Model)
    && trim(e1.summary?.DateTimeOriginal) === trim(e2.summary?.DateTimeOriginal),
    `${trim(e2.summary?.Model)} @ ${trim(e2.summary?.DateTimeOriginal)}`);

  // 无 EXIF 的合法 jpg → 结构化空说明,非错误
  const r3 = await client.callTool({ name: 'read-exif', arguments: { base64: noExifBytes.toString('base64') } });
  const e3 = JSON.parse(text(r3));
  check('无 EXIF 图返回 hasExif=false 说明', r3.isError !== true && e3.hasExif === false && Boolean(e3.note), e3.note);

  // 纯文本字节 → 不是可解析图片,被拒
  const r4 = await client.callTool({ name: 'read-exif', arguments: { base64: Buffer.from('this is just plain text, not an image at all').toString('base64') } });
  check('纯文本字节被拒(isError)', r4.isError === true, text(r4).slice(0, 80));

  // 越出工作区的路径被拒
  const r5 = await client.callTool({ name: 'read-exif', arguments: { path: '../outside.jpg' } });
  check('越出工作区路径被拒', r5.isError === true && text(r5).includes('escapes'), text(r5).slice(0, 80));

  // 坏 base64 被拒
  const r6 = await client.callTool({ name: 'read-exif', arguments: { base64: '%%%not-base64%%%' } });
  check('坏 base64 被拒', r6.isError === true, text(r6).slice(0, 80));
} finally {
  await client.close();
  rmSync(join(here, copyName), { force: true });
}

console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
