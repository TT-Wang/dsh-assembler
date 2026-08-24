// im-bot 冒烟:mock 真推(三家消息体形状逐一核对)+ 凭证契约 + 钉钉加签 + 参数闸。
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);

// 本地 mock 群:记录收到的 body 与 query(验签名)
const seen = [];
const mock = createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    seen.push({ url: req.url, body: JSON.parse(b || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}/hook`;

const env = { ...process.env, IMBOT_MOCK_URL: MOCK, WECOM_WEBHOOK: MOCK, DINGTALK_WEBHOOK: MOCK, DINGTALK_SECRET: 'testsecret' };
delete env.FEISHU_WEBHOOK; // 留一家不配,考凭证契约
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env });
const client = new Client({ name: 'imbot-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:2 工具', tools.length === 2 && tools.includes('imbot-send'), tools.join(','));

  const info = J(await client.callTool({ name: 'imbot-info', arguments: {} }));
  check('自述:报配置状态但不回显 URL/密钥', info.providers.find((p) => p.provider === 'wecom').configured === true
    && info.providers.find((p) => p.provider === 'feishu').configured === false
    && info.dingtalkSigned === true && !JSON.stringify(info).includes('127.0.0.1') && !JSON.stringify(info).includes('testsecret'));

  const w = J(await client.callTool({ name: 'imbot-send', arguments: { provider: 'wecom', text: '装配器告警 IMB-1', atMobiles: ['13800000000'] } }));
  check('mock 真推:企微成功且消息体形状对', w.sent === true && seen.at(-1).body.msgtype === 'text'
    && seen.at(-1).body.text.content === '装配器告警 IMB-1' && seen.at(-1).body.text.mentioned_mobile_list[0] === '13800000000');

  const d = J(await client.callTool({ name: 'imbot-send', arguments: { provider: 'dingtalk', text: '钉钉测试 IMB-2', atAll: true } }));
  check('mock 真推:钉钉形状对(at.isAtAll)', d.sent === true && seen.at(-1).body.at.isAtAll === true && seen.at(-1).body.text.content === '钉钉测试 IMB-2');
  check('钉钉加签:URL 带 timestamp+sign(密钥不出现在 body)', /timestamp=\d+/.test(seen.at(-1).url) && /sign=/.test(seen.at(-1).url) && !JSON.stringify(seen.at(-1).body).includes('testsecret'));

  const f = await client.callTool({ name: 'imbot-send', arguments: { provider: 'feishu', text: '飞书未配' } });
  check('凭证契约:未配 FEISHU_WEBHOOK → 可行动错误(点名 env)', f.isError === true && f.content[0].text.includes('FEISHU_WEBHOOK'));

  check('参数闸:未知 provider 拒', (await client.callTool({ name: 'imbot-send', arguments: { provider: 'qq', text: 'x' } })).isError === true);
  check('参数闸:空正文拒', (await client.callTool({ name: 'imbot-send', arguments: { provider: 'mock', text: '  ' } })).isError === true);
  check('参数闸:超长拒', (await client.callTool({ name: 'imbot-send', arguments: { provider: 'mock', text: 'x'.repeat(5000) } })).isError === true);
} catch (e) { console.error('SMOKE CRASHED:', e); failures += 1; }
finally { try { await transport.close(); } catch {} mock.close(); }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
