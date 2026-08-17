#!/usr/bin/env node
/** 冒烟:listTools → 单条转写(内置替换/音译/驼峰/自定义分隔/西里尔/locale/保留 Unicode)
 *  → 批量唯一化(重复去重 + 计数器每次重置)→ 定制替换与保留字符 → 三条错误路径被拒。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const text = (r) => r.content.map((b) => b.text ?? '').join('');

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname] });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
check('listTools 返回 3 个工具', tools.tools.length === 3, tools.tools.map((t) => t.name).join(','));

// ── slugify:核心转写 ────────────────────────────────────────────────
const s1 = await client.callTool({ name: 'slugify', arguments: { text: 'I ♥ Dogs' } });
check('内置替换 ♥→love', text(s1) === 'i-love-dogs', text(s1));
const s2 = await client.callTool({ name: 'slugify', arguments: { text: 'Déjà Vu!' } });
check('重音音译 Déjà→deja', text(s2) === 'deja-vu', text(s2));
const s3 = await client.callTool({ name: 'slugify', arguments: { text: 'fooBar 123 $#%' } });
check('驼峰分词 + 数字保留', text(s3) === 'foo-bar-123', text(s3));
const s4 = await client.callTool({ name: 'slugify', arguments: { text: 'BAR and baz', separator: '_' } });
check('自定义分隔符 _', text(s4) === 'bar_and_baz', text(s4));
const s5 = await client.callTool({ name: 'slugify', arguments: { text: 'BAR and baz', separator: '' } });
check('空分隔符直接拼接', text(s5) === 'barandbaz', text(s5));
const s6 = await client.callTool({ name: 'slugify', arguments: { text: 'я люблю единорогов' } });
check('西里尔音译', text(s6) === 'ya-lyublyu-edinorogov', text(s6));
const s7 = await client.callTool({ name: 'slugify', arguments: { text: 'Räksmörgås', locale: 'sv' } });
check('locale=sv 语言相关音译', text(s7) === 'raksmorgas', text(s7));
const s8 = await client.callTool({ name: 'slugify', arguments: { text: 'Déjà Vu', transliterate: false } });
check('transliterate=false 保留原字符', text(s8) === 'déjà-vu', text(s8));

// ── slugify-unique:批量唯一化 ───────────────────────────────────────
const u1 = await client.callTool({ name: 'slugify-unique', arguments: { texts: ['foo bar', 'foo bar', 'foo bar'] } });
check('重复项追加 -2/-3', text(u1) === JSON.stringify(['foo-bar', 'foo-bar-2', 'foo-bar-3']), text(u1));
const u2 = await client.callTool({ name: 'slugify-unique', arguments: { texts: ['foo bar', 'foo bar', 'foo bar'] } });
check('计数器每次调用重置(可复现)', text(u2) === JSON.stringify(['foo-bar', 'foo-bar-2', 'foo-bar-3']), text(u2));
const u3 = await client.callTool({ name: 'slugify-unique', arguments: { texts: ['Example', 'Example', 'fooBar'] } });
check('混合输入:驼峰 + 顺序保持', text(u3) === JSON.stringify(['example', 'example-2', 'foo-bar']), text(u3));

// ── slugify-custom:定制替换与保留字符 ───────────────────────────────
const c1 = await client.callTool({ name: 'slugify-custom', arguments: { text: 'foo@unicorn', customReplacements: [['@', ' at ']] } });
check('自定义替换 @→at', text(c1) === 'foo-at-unicorn', text(c1));
const c2 = await client.callTool({ name: 'slugify-custom', arguments: { text: 'I ♥ Dogs', customReplacements: [['♥', ' adore ']] } });
check('自定义替换覆盖内置 ♥', text(c2) === 'i-adore-dogs', text(c2));
const c3 = await client.callTool({ name: 'slugify-custom', arguments: { text: '_foo_bar', preserveLeadingUnderscore: true } });
check('保留前导下划线', text(c3) === '_foo-bar', text(c3));
const c4 = await client.callTool({ name: 'slugify-custom', arguments: { text: 'foo-bar-', preserveTrailingDash: true } });
check('保留尾随连字符', text(c4) === 'foo-bar-', text(c4));
const c5 = await client.callTool({ name: 'slugify-custom', arguments: { text: 'foo_bar#baz', preserveCharacters: ['#'] } });
check('保留 # 字符', text(c5) === 'foo-bar#baz', text(c5));

// ── 错误路径 ─────────────────────────────────────────────────────────
const e1 = await client.callTool({ name: 'slugify', arguments: { text: '' } });
check('空文本被 zod 拒绝', e1.isError === true, JSON.stringify(e1).slice(0, 120));
const e2 = await client.callTool({ name: 'slugify-custom', arguments: { text: 'foo', preserveCharacters: ['-'] } });
check('preserveCharacters 与 separator 冲突被拒', e2.isError === true && /separator character/i.test(text(e2)), text(e2));
const e3 = await client.callTool({ name: 'slugify-unique', arguments: { texts: [] } });
check('空列表被 zod 拒绝', e3.isError === true, JSON.stringify(e3).slice(0, 120));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
