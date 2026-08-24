// embed-text 冒烟:凭证契约(未配 key 起得来、报可行动错误)+ 参数闸 + 端点自述。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const env = { ...process.env }; delete env.EMBED_API_KEY;
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env });
const client = new Client({ name: 'embed-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('凭证契约:未配 key 也能起、listTools 成功', tools.length === 2 && tools.includes('embed-texts'), tools.join(','));
  const info = JSON.parse((await client.callTool({ name: 'embed-info', arguments: {} })).content[0].text);
  check('自述端点/模型/凭证状态(不回显密钥)', info.base.includes('/v1') && info.credential === 'missing:EMBED_API_KEY' && !JSON.stringify(info).includes('sk-'));
  const call = await client.callTool({ name: 'embed-texts', arguments: { texts: ['你好'] } });
  check('未配 key → 可行动错误(点名 env + 端点 + 指路向量库)', call.isError === true && call.content[0].text.includes('EMBED_API_KEY') && call.content[0].text.includes('vector-store'), call.content[0].text.slice(0, 110));
  const empty = await client.callTool({ name: 'embed-texts', arguments: { texts: [] } });
  check('参数闸:空数组拒', empty.isError === true);
  if (process.env.EMBED_API_KEY) {
    const t2 = new StdioClientTransport({ command: 'node', args: ['index.js'], env: process.env });
    const c2 = new Client({ name: 'embed-live', version: '0.0.1' }); await c2.connect(t2);
    const r = JSON.parse((await c2.callTool({ name: 'embed-texts', arguments: { texts: ['苹果', '汽车'] } })).content[0].text);
    check('真调:两段文本出等维向量', r.count === 2 && r.dim > 0 && r.vectors[0].length === r.dim);
    await t2.close();
  } else console.log('SKIP | 真调(无 EMBED_API_KEY,凭证契约模式)');
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }
finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
