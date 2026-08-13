// 冒烟验证：MCP Client 通过 stdio 连接本 server，验证 listTools + 真实 OCR 调用（英文/中文）+ 缺参/坏参校验 + 干净退出
// 测试图片由 sharp 渲染 SVG 文本生成（内存中，不落盘）
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import sharp from 'sharp';

let passed = 0, failed = 0;
const warns = [];
function check(cond, label, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`); }
}
function warn(label, extra = '') {
  warns.push(label);
  console.log(`  WARN  ${label}${extra ? ' — ' + extra : ''}`);
}

// 1) 生成测试输入：SVG 渲染出带文字的图片（英文 + 中文）
const svgEn = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="240">
  <rect width="100%" height="100%" fill="white"/>
  <text x="40" y="160" font-family="Arial, Helvetica, sans-serif" font-size="90" font-weight="bold" fill="black">HELLO WORLD 2024</text>
</svg>`;
const svgCn = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="240">
  <rect width="100%" height="100%" fill="white"/>
  <text x="40" y="165" font-family="PingFang SC, Hiragino Sans GB, Heiti SC, Arial, sans-serif" font-size="95" font-weight="bold" fill="black">你好，世界 2024</text>
</svg>`;
const pngEn = await sharp(Buffer.from(svgEn)).png().toBuffer();
const pngCn = await sharp(Buffer.from(svgCn)).png().toBuffer();
const b64En = pngEn.toString('base64');
const b64Cn = pngCn.toString('base64');
console.log(`[setup] 测试输入：英文图片 ${pngEn.length} bytes、中文图片 ${pngCn.length} bytes（sharp 渲染 SVG 生成）`);

// 2) 连接（OCR 首次调用要下载语言数据，client 请求超时放宽到 300s）
const transport = new StdioClientTransport({ command: 'node', args: ['index.js'] });
const client = new Client({ name: 'ocr-parse-smoke', version: '0.0.1' });
await client.connect(transport);
const T = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
const toolText = (res) => res.content?.[0]?.text ?? '';
console.log('[setup] StdioClientTransport 已连接 node index.js');

// 3) listTools
const tools = (await client.listTools()).tools;
const names = tools.map((t) => t.name).sort();
check(names.length === 3, 'listTools 返回 3 个工具', `实际: ${JSON.stringify(names)}`);
for (const want of ['ocr-languages', 'ocr-psm-modes', 'ocr-recognize']) {
  check(names.includes(want), `工具存在: ${want}`);
}
for (const t of tools) {
  check(typeof t.description === 'string' && t.description.length > 50, `工具 ${t.name} 有可用描述（>50字符）`, `${t.description.length} chars`);
  check(t.inputSchema && typeof t.inputSchema === 'object', `工具 ${t.name} 声明了输入参数 schema`);
}

// 4) ocr-languages：无输入，返回语言列表
const langRes = await T('ocr-languages');
const langText = toolText(langRes);
check(!langRes.isError && langText.startsWith('{'), 'ocr-languages 返回 JSON');
const langs = langText.startsWith('{') ? JSON.parse(langText) : {};
check(langs.count >= 100 && Array.isArray(langs.languages), 'ocr-languages 返回语言数量>=100', `count=${langs.count}`);
const codes = (langs.languages || []).map((l) => l.code);
check(codes.includes('eng') && codes.includes('chi_sim') && codes.includes('chi_tra'), 'ocr-languages 含 eng/chi_sim/chi_tra', `示例: ${codes.slice(0, 5).join(', ')}...`);

// 5) ocr-psm-modes：无输入，返回模式列表
const psmRes = await T('ocr-psm-modes');
const psmText = toolText(psmRes);
check(!psmRes.isError && psmText.startsWith('{'), 'ocr-psm-modes 返回 JSON');
const psmData = psmText.startsWith('{') ? JSON.parse(psmText) : {};
const psmVals = (psmData.modes || []).map((m) => m.value);
check(psmVals.length === 14 && psmVals.includes('6') && psmVals.includes('3') && psmVals.includes('7'), 'ocr-psm-modes 返回 14 种模式且含 3/6/7', `count=${psmVals.length}`);

// 6) ocr-recognize：英文识别（默认参数）
console.log('[ocr] 英文识别开始（首次调用会下载 eng 语言数据，可能需要几十秒）...');
const enRes = await T('ocr-recognize', { image: b64En });
const enText = toolText(enRes);
check(!enRes.isError && enText.startsWith('{'), 'ocr-recognize(eng) 返回 JSON', enRes.isError ? enText.slice(0, 120) : '');
const en = enText.startsWith('{') ? JSON.parse(enText) : {};
check(typeof en.text === 'string' && en.text.toUpperCase().includes('HELLO'), '英文识别文本含 HELLO', `text="${(en.text || '').trim().slice(0, 60)}"`);
check(en.text && en.text.includes('2024'), '英文识别文本含 2024', `text="${(en.text || '').trim().slice(0, 60)}"`);
check(typeof en.confidence === 'number' && en.confidence >= 0 && en.confidence <= 100, '返回 confidence(0-100)', `confidence=${en.confidence}`);
check(typeof en.version === 'string' && en.version.length > 0, '返回引擎 version', `version=${en.version}`);

// 7) ocr-recognize：psm=7（单行）+ output=text,blocks（结构化输出）
const en2 = await T('ocr-recognize', { image: b64En, langs: 'eng', psm: '7', output: 'text,blocks' });
const en2o = JSON.parse(toolText(en2) || '{}');
check(!en2.isError && Array.isArray(en2o.blocks) && en2o.blocks.length >= 1 && Array.isArray(en2o.blocks[0].paragraphs),
  'output=blocks 返回结构化块级数据', `blocks=${en2o.blocks?.length} paragraphs=${en2o.blocks?.[0]?.paragraphs?.length}`);
check(en2o.psm === '7', '返回 psm=7', `psm=${en2o.psm}`);

// 8) ocr-recognize：whitelist 只识别数字（HELLO WORLD 2024 → 只留 2024）
const en3 = await T('ocr-recognize', { image: b64En, langs: 'eng', psm: '7', whitelist: '0123456789' });
const en3o = JSON.parse(toolText(en3) || '{}');
check(!en3.isError && en3o.text && en3o.text.includes('2024') && !/[A-Za-z]/.test(en3o.text), 'whitelist 数字白名单生效（只剩 2024）', `text="${(en3o.text || '').trim().slice(0, 40)}"`);

// 9) 缺参校验：无 image 参数 → SDK 参数校验错误
const missing = await T('ocr-recognize');
check(missing.isError === true || /ERROR/.test(toolText(missing)), '缺参调用 ocr-recognize 返回校验错误', `isError=${missing.isError} text=${toolText(missing).slice(0, 80)}`);

// 10) 坏参校验：非图片 base64
const bad = await T('ocr-recognize', { image: 'aGVsbG8gd29ybGQ=' }); // "hello world" 不是图片
check(bad.isError === true && /ERROR/.test(toolText(bad)) && /图片/.test(toolText(bad)), '非图片数据返回清晰错误（提及图片格式）', `text=${toolText(bad).slice(0, 100)}`);

// 11) 业务校验：未知语言代码
const badLang = await T('ocr-recognize', { image: b64En, langs: 'zzz_unknown' });
check(badLang.isError === true && /未知语言代码/.test(toolText(badLang)), '未知语言代码返回业务错误', `text=${toolText(badLang).slice(0, 100)}`);

// 12) 业务校验：非法 psm
const badPsm = await T('ocr-recognize', { image: b64En, psm: '99' });
check(badPsm.isError === true && /未知 psm/.test(toolText(badPsm)), '非法 psm 返回业务错误', `text=${toolText(badPsm).slice(0, 100)}`);

// 13) 中文识别（软校验：chi_sim 数据下载或字体渲染失败记为 WARN，不判失败）
try {
  console.log('[ocr] 中文识别开始（chi_sim 语言数据下载中）...');
  const cnRes = await T('ocr-recognize', { image: b64Cn, langs: 'chi_sim' });
  const cn = JSON.parse(toolText(cnRes) || '{}');
  // tesseract 会在 CJK 字符间插入空格（如 "你 好 ， 世 界"），比对前先去除所有空白
  const cnNoWs = (cn.text || '').replace(/\s+/g, '');
  if (!cnRes.isError && cnNoWs.includes('你好')) {
    check(true, '中文识别文本含 你好', `text="${(cn.text || '').trim().slice(0, 40)}"`);
  } else if (cnRes.isError) {
    warn('中文识别返回错误（语言数据下载/引擎问题）', toolText(cnRes).slice(0, 120));
  } else {
    warn('中文识别完成但未识别出预期文本（可能字体渲染缺字形）', `text="${(cn.text || '').trim().slice(0, 60)}"`);
  }
} catch (err) {
  warn('中文识别调用异常', String(err.message || err).slice(0, 120));
}

await client.close();

// 14) stdin 关闭后 server 干净退出（exit 0，worker_threads 不得阻止退出）
const exitCode = await new Promise((resolve) => {
  const p = spawn('node', ['index.js'], { stdio: ['pipe', 'ignore', 'inherit'] });
  const timer = setTimeout(() => { p.kill(); resolve('TIMEOUT'); }, 15000);
  p.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  p.stdin.end();
});
check(exitCode === 0, 'stdin 关闭后 server 以 exit 0 干净退出', `exit=${exitCode}`);

console.log(`\n==== smoke 结果：${passed} passed, ${failed} failed, ${warns.length} warned ====`);
if (warns.length) console.log(`WARN 明细:\n  - ${warns.join('\n  - ')}`);
process.exit(failed === 0 ? 0 : 1);
