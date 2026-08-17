#!/usr/bin/env node
/** 冒烟:listTools → TOML→JSON 具体值+日期 → JSON→TOML→再解析 往返一致 → 非法 TOML 带行号被拒 → 不可表示值被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');
// 键序无关的规范化比较(json-to-toml 会重排键序,不能拿原始字符串硬比)
const canon = (v) => (Array.isArray(v)
  ? v.map(canon)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v);
const deepEq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

// TOML → JSON:具体值断言(解析 JSON 后比较,不依赖缩进/空白)
const tomlDoc = [
  'title = "demo"',
  'born = 1979-05-27T07:32:00Z',
  '',
  '[server]',
  'host = "localhost"',
  'port = 8080',
  'tags = ["a", "b"]',
].join('\n');
const r1 = await client.callTool({ name: 'toml-to-json', arguments: { toml: tomlDoc } });
const obj1 = JSON.parse(text(r1));
check('title/host/port/tags 逐项正确',
  obj1.title === 'demo' && obj1.server.host === 'localhost' && obj1.server.port === 8080
    && JSON.stringify(obj1.server.tags) === '["a","b"]',
  text(r1).replace(/\s+/g, ' ').slice(0, 120));
check('日期转成 ISO 字符串', typeof obj1.born === 'string' && obj1.born.includes('1979-05-27T07:32:00'), String(obj1.born));

// JSON → TOML → 再解析:往返一致(拿再解析的对象与第一轮 JSON 投影规范化比较)
const r2 = await client.callTool({ name: 'json-to-toml', arguments: { json: JSON.stringify(obj1) } });
check('json-to-toml 产出 TOML 文本', r2.isError !== true && /title\s*=\s*"demo"/.test(text(r2)), text(r2).replace(/\s+/g, ' ').slice(0, 120));
const r3 = await client.callTool({ name: 'toml-to-json', arguments: { toml: text(r2) } });
const obj3 = JSON.parse(text(r3));
check('往返一致(键序无关深比较)', deepEq(obj1, obj3),
  deepEq(obj1, obj3) ? '' : `${JSON.stringify(canon(obj1))} vs ${JSON.stringify(canon(obj3))}`.slice(0, 200));

// 错误路径 1:非法 TOML 被拒,错误信息带行号
const r4 = await client.callTool({ name: 'toml-to-json', arguments: { toml: 'ok = 1\nport = \nnext = 2' } });
check('非法 TOML 被拒 (isError)', r4.isError === true, text(r4).replace(/\s+/g, ' ').slice(0, 100));
check('错误信息带行号', /第 \d+ 行/.test(text(r4)), text(r4).replace(/\s+/g, ' ').slice(0, 100));

// 错误路径 2:数组里的 null 不可表示,被拒
const r5 = await client.callTool({ name: 'json-to-toml', arguments: { json: '{"a":[1,null,3]}' } });
check('数组含 null 被拒 (isError)', r5.isError === true, text(r5).slice(0, 80));

// 错误路径 3:顶层不是对象被拒
const r6 = await client.callTool({ name: 'json-to-toml', arguments: { json: '[1,2,3]' } });
check('顶层数组被拒 (isError)', r6.isError === true, text(r6).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
