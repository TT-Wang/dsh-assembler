// 冒烟验证：MCP Client 通过 stdio 连接本 server，验证 listTools + 真实工具调用 + 缺参/坏参校验 + 干净退出
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

let passed = 0, failed = 0;
function check(cond, label, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}

// 1) 生成测试输入：100x100 纯色 PNG（sharp 内存生成）
const src = await sharp({
  create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 30, b: 60 } }
}).png().toBuffer();
const srcB64 = src.toString('base64');
console.log(`[setup] 测试输入：100x100 PNG buffer（${src.length} bytes）`);

// 2) 连接
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);
console.log('[setup] StdioClientTransport 已连接 node index.js');

// 3) listTools
const tools = (await client.listTools()).tools;
const names = tools.map(t => t.name).sort();
check(names.length === 4, `listTools 返回 4 个工具`, `实际: ${JSON.stringify(names)}`);
for (const want of ['image-info', 'image-resize', 'image-convert', 'image-thumbnail']) {
  check(names.includes(want), `工具存在: ${want}`);
}
for (const t of tools) {
  check(typeof t.description === 'string' && t.description.length > 50, `工具 ${t.name} 有可用描述（>50字符，供 LLM 选择器阅读）`, `${t.description.length} chars`);
  check(t.inputSchema && Object.keys(t.inputSchema.properties || {}).length > 0, `工具 ${t.name} 声明了输入参数 schema`);
}

// 4) image-info：读元信息
const infoRes = await client.callTool({ name: 'image-info', arguments: { image: srcB64 } });
const infoText = infoRes.content?.[0]?.text ?? '';
check(!infoRes.isError && infoText.startsWith('{'), 'image-info 返回 JSON');
const info = infoText.startsWith('{') ? JSON.parse(infoText) : {};
check(info.format === 'png', 'image-info format=png', `实际 ${info.format}`);
check(info.width === 100 && info.height === 100, 'image-info width/height=100', `实际 ${info.width}x${info.height}`);
check(info.size === src.length, 'image-info size 与输入一致', `实际 ${info.size}`);

// 5) image-resize：50x50 → 解码输出并复核尺寸
const rsRes = await client.callTool({ name: 'image-resize', arguments: { image: srcB64, width: 50, height: 50 } });
const rsText = rsRes.content?.[0]?.text ?? '';
check(!rsRes.isError && rsText.startsWith('{'), 'image-resize 返回 JSON');
const rs = rsText.startsWith('{') ? JSON.parse(rsText) : {};
check(typeof rs.image === 'string' && rs.image.length > 0, 'image-resize 返回 base64 图片');
let rsMeta = null;
if (rs.image) rsMeta = await sharp(Buffer.from(rs.image, 'base64')).metadata();
check(rsMeta?.width === 50 && rsMeta?.height === 50, 'resize 输出实测 50x50', `实际 ${rsMeta?.width}x${rsMeta?.height}`);
check(rsMeta?.format === 'png', 'resize 默认保持原格式 png', `实际 ${rsMeta?.format}`);

// 6) image-resize：只给宽度，等比缩放（50 宽 → 50x50），并转 webp
const rs2 = await client.callTool({ name: 'image-resize', arguments: { image: srcB64, width: 40, format: 'webp', quality: 70 } });
const rs2o = JSON.parse(rs2.content?.[0]?.text ?? '{}');
let rs2Meta = null;
if (rs2o.image) rs2Meta = await sharp(Buffer.from(rs2o.image, 'base64')).metadata();
check(rs2o.format === 'webp' && rs2Meta?.format === 'webp', 'resize 转 webp 输出', `实际 ${rs2Meta?.format}`);
check(rs2Meta?.width === 40 && rs2Meta?.height === 40, 'resize 仅给宽度等比缩放 40x40', `实际 ${rs2Meta?.width}x${rs2Meta?.height}`);

// 7) image-convert：png → jpeg
const cvRes = await client.callTool({ name: 'image-convert', arguments: { image: srcB64, format: 'jpeg', quality: 85 } });
const cv = JSON.parse(cvRes.content?.[0]?.text ?? '{}');
let cvMeta = null;
if (cv.image) cvMeta = await sharp(Buffer.from(cv.image, 'base64')).metadata();
check(cv.format === 'jpeg' && cvMeta?.format === 'jpeg', 'convert png→jpeg 成功', `实际 ${cvMeta?.format}`);
check(cvMeta?.width === 100 && cvMeta?.height === 100, 'convert 保持尺寸 100x100', `实际 ${cvMeta?.width}x${cvMeta?.height}`);

// 8) image-thumbnail：40x40 cover
const thRes = await client.callTool({ name: 'image-thumbnail', arguments: { image: srcB64, width: 40, height: 40 } });
const th = JSON.parse(thRes.content?.[0]?.text ?? '{}');
let thMeta = null;
if (th.image) thMeta = await sharp(Buffer.from(th.image, 'base64')).metadata();
check(thMeta?.width === 40 && thMeta?.height === 40, 'thumbnail 输出实测 40x40', `实际 ${thMeta?.width}x${thMeta?.height}`);

// 9) image-thumbnail：contain 模式不裁剪
const th2 = await client.callTool({ name: 'image-thumbnail', arguments: { image: srcB64, width: 30, height: 60, fit: 'contain' } });
const th2o = JSON.parse(th2.content?.[0]?.text ?? '{}');
let th2Meta = null;
if (th2o.image) th2Meta = await sharp(Buffer.from(th2o.image, 'base64')).metadata();
check(th2Meta?.width === 30 && th2Meta?.height === 60, 'thumbnail contain 30x60（等比留边不裁剪）', `实际 ${th2Meta?.width}x${th2Meta?.height}`);

// 10) 缺参校验：image-info 无 image 参数 → SDK 层参数校验错误（isError 或 ERROR 文本）
const missing = await client.callTool({ name: 'image-info', arguments: {} });
const missingOk = missing.isError === true || /ERROR/.test(missing.content?.[0]?.text ?? '');
check(missingOk, '缺参调用 image-info 返回校验错误', `isError=${missing.isError} text=${(missing.content?.[0]?.text ?? '').slice(0, 80)}`);

// 11) 坏参校验：非法 base64 / 非图片数据
const bad = await client.callTool({ name: 'image-info', arguments: { image: 'aGVsbG8gd29ybGQ=' } }); // "hello world" 不是图片
check(bad.isError === true || /ERROR/.test(bad.content?.[0]?.text ?? ''), '非图片数据返回清晰错误', `text=${(bad.content?.[0]?.text ?? '').slice(0, 100)}`);

// 12) 业务校验：resize 无宽高 → ERROR 文本
const noSize = await client.callTool({ name: 'image-resize', arguments: { image: srcB64 } });
check(noSize.isError === true && /width 与 height/.test(noSize.content?.[0]?.text ?? ''), 'resize 缺宽高返回业务错误', `text=${(noSize.content?.[0]?.text ?? '').slice(0, 80)}`);

await client.close();

// 13) stdin 关闭后 server 干净退出（exit 0）
const exitCode = await new Promise((resolve) => {
  const p = spawn('node', ['index.js'], { stdio: ['pipe', 'ignore', 'inherit'] });
  const timer = setTimeout(() => { p.kill(); resolve('TIMEOUT'); }, 8000);
  p.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  p.stdin.end();
});
check(exitCode === 0, 'stdin 关闭后 server 以 exit 0 干净退出', `exit=${exitCode}`);

console.log(`\n==== smoke 结果：${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
