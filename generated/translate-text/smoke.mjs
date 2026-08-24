// translate-text 冒烟:真调上游(中英双向)+ 参数闸 + 批量。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env: process.env });
const client = new Client({ name: 'tr-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:translate + translate-batch', tools.length === 2 && tools.includes('translate-batch'), tools.join(','));
  const en = J(await client.callTool({ name: 'translate', arguments: { text: '今天天气很好', from: 'zh', to: 'en' } }));
  check('真调:中→英出英文', /[a-zA-Z]{3,}/.test(en.translated) && en.translated.length > 3, en.translated);
  const zh = J(await client.callTool({ name: 'translate', arguments: { text: 'The parts are verified', from: 'en', to: 'zh' } }));
  check('真调:英→中出中文', /[一-鿿]/.test(zh.translated), zh.translated);
  const b = J(await client.callTool({ name: 'translate-batch', arguments: { texts: ['苹果', '汽车'], from: 'zh', to: 'en' } }));
  check('批量:两段顺序返回', b.count === 2 && b.results.length === 2 && b.results[0].source === '苹果');
  check('参数闸:超长拒', (await client.callTool({ name: 'translate', arguments: { text: 'x'.repeat(600), from: 'zh', to: 'en' } })).isError === true);
  check('参数闸:非法语言码拒', (await client.callTool({ name: 'translate', arguments: { text: 'x', from: 'chinese', to: 'en' } })).isError === true);
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }
finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
