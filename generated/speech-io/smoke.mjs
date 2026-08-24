// speech-io 冒烟:4 工具 · TTS 真出音频(无凭证)· 服务脸真回 mp3 字节 · ASR 凭证契约。
import { mkdtempSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${ok ? '' : ' | ' + d}`); if (!ok) failures++; };
const J = (r) => JSON.parse(r.content[0].text);

const wd = mkdtempSync(join(tmpdir(), 'speech-'));
const env = { ...process.env, PART_WORKDIR: wd };
delete env.SPEECH_API_KEY; // 凭证契约那一半必须在"没配"状态下考
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env });
const client = new Client({ name: 'speech-smoke', version: '0.0.1' });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('listTools:4 工具(info/speak/transcribe/delete)', tools.length === 4 && tools.includes('speak') && tools.includes('transcribe'), tools.join(','));

  // 模型脸:TTS 真跑(无凭证)
  const spoken = J(await client.callTool({ name: 'speak', arguments: { text: '装配器语音验收:字节不过模型。', name: 'probe.mp3' } }));
  check('模型脸:TTS 真出音频且只回路径不回字节', spoken.bytes > 3000 && spoken.path.endsWith('probe.mp3') && spoken.name === 'probe.mp3' && existsSync(spoken.path), JSON.stringify(spoken).slice(0, 120));
  check('模型脸:空文本拒绝', (await client.callTool({ name: 'speak', arguments: { text: '  ' } })).isError === true);

  // 凭证契约:ASR 未配 key → 起得来、可行动错误、点名 env、并说明 TTS 不受影响
  const asr = await client.callTool({ name: 'transcribe', arguments: { path: spoken.path } });
  check('凭证契约:ASR 未配 key 给可行动错误(点名 env,且说明 TTS 照常)', asr.isError === true && asr.content[0].text.includes('SPEECH_API_KEY') && asr.content[0].text.includes('TTS'), asr.content[0].text.slice(0, 120));

  // 服务脸:真回 mp3 字节 + 鉴权 + 取回既有音频
  const info = J(await client.callTool({ name: 'speech-info', arguments: {} }));
  check('服务脸:info 报端点与两半凭证状态', info.url.startsWith('http://127.0.0.1:') && info.tts.credential === 'none' && info.asr.credential.startsWith('missing:'));
  check('服务脸:错 token 401', (await fetch(`${info.url}/speak?text=x`, { headers: { 'x-service-token': 'no' } })).status === 401);
  const H = { 'x-service-token': info.token };
  const spk = await fetch(`${info.url}/speak?${new URLSearchParams({ text: '服务脸直取音频' })}`, { headers: H });
  const buf = Buffer.from(await spk.arrayBuffer());
  check('服务脸:GET /speak 直回 audio/mpeg 字节', spk.ok && spk.headers.get('content-type') === 'audio/mpeg' && buf.length > 3000 && buf.subarray(0, 3).toString('hex').length === 6, `${spk.status} ${buf.length}B`);
  const got = await fetch(`${info.url}/audio/probe.mp3`, { headers: H });
  const back = Buffer.from(await got.arrayBuffer());
  check('服务脸:取回既有音频字节与落盘一致', got.ok && back.length === statSync(spoken.path).size && Buffer.compare(back, readFileSync(spoken.path)) === 0);
  const esc = await (await fetch(`${info.url}/audio/${encodeURIComponent('../secret')}`, { headers: H })).json();
  check('服务脸:穿越拒绝', typeof esc.error === 'string');
  const up = await (await fetch(`${info.url}/transcribe/rec.mp3`, { method: 'POST', headers: H, body: buf })).json();
  check('服务脸:直传录音落盘 + 无 key 时如实报缺(接口先就位)', up.savedTo?.endsWith('rec.mp3') && String(up.error ?? '').includes('SPEECH_API_KEY'));
} catch (e) {
  console.error('SMOKE CRASHED:', e); failures += 1;
} finally { try { await transport.close(); } catch {} }
console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
