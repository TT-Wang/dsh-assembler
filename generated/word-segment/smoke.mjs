#!/usr/bin/env node
/** 冒烟:listTools → 经典歧义句分词(工信处/科室/交换机)→ 词性标注 → 高频关键词提取(停用词/标点被剔除)→ 空文本拒绝。 */
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
check('listTools 返回 2 个工具', tools.tools.length === 2, tools.tools.map((t) => t.name).join(','));

const sentence = '工信处女干事每月经过下属科室都要亲口交代24口交换机等技术性器件的安装工作。';
const r1 = await client.callTool({ name: 'segment-text', arguments: { text: sentence } });
const words = JSON.parse(text(r1));
check('分词返回非空数组', Array.isArray(words) && words.length > 5, `${words.length} 词`);
check("经典歧义句切出'工信处'", words.includes('工信处'), words.slice(0, 8).join('/'));
check("切出'科室'与'交换机'", words.includes('科室') && words.includes('交换机'));

const r2 = await client.callTool({ name: 'segment-text', arguments: { text: sentence, withPos: true } });
const tagged = JSON.parse(text(r2));
const jiaohuanji = tagged.find((t) => t.w === '交换机');
check('词性标注含 w/pos 字段', jiaohuanji !== undefined && typeof jiaohuanji.pos === 'string' && jiaohuanji.pos.length > 0,
  jiaohuanji ? `交换机 <${jiaohuanji.pos}> <${jiaohuanji.tag}>` : JSON.stringify(tagged.slice(0, 3)));

const r3 = await client.callTool({ name: 'extract-keywords', arguments: { text: '苹果好吃,苹果营养,我天天吃苹果。香蕉也不错。', topN: 5 } });
const keywords = JSON.parse(text(r3));
check('关键词提取返回非空数组', Array.isArray(keywords) && keywords.length > 0 && keywords.length <= 5, JSON.stringify(keywords));
check("高频词'苹果'居首且计数≥2", keywords[0]?.word === '苹果' && keywords[0]?.count >= 2, JSON.stringify(keywords[0]));
check('关键词不含标点', keywords.every((k) => !/[,。、,.!?!?]/.test(k.word)));
check('词频降序排列', keywords.every((k, i) => i === 0 || keywords[i - 1].count >= k.count));

const r4 = await client.callTool({ name: 'segment-text', arguments: { text: '' } });
check('空文本被拒', r4.isError === true || JSON.stringify(r4).includes('为空'), text(r4).slice(0, 40));

const r5 = await client.callTool({ name: 'extract-keywords', arguments: { text: '   ' } });
check('全空白文本被拒(关键词)', r5.isError === true || JSON.stringify(r5).includes('为空'), text(r5).slice(0, 40));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
