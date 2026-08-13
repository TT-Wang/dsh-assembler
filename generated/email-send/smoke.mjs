/**
 * smoke.mjs — 冒烟验证 @dsh-index/email-send MCP server。
 * 用 stdio client 连接本 server，listTools 后真实调用：
 *   1) send-email (transport=json，无需 SMTP 服务器) → 期望返回 messageId
 *   2) parse-email-addresses（纯本地解析）→ 期望返回结构化地址
 *   3) send-email 缺参调用 → 期望参数校验报错（isError）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js']
});

const client = new Client({ name: 'email-send-smoke', version: '0.0.1' });
await client.connect(transport);

let failures = [];

// ---- 1) listTools ----
const { tools } = await client.listTools();
console.log('== listTools ==');
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description.slice(0, 80)}`);
}
if (!tools.some((t) => t.name === 'send-email')) {
  failures.push('listTools 缺少 send-email');
}

// ---- 2) send-email via jsonTransport ----
console.log('\n== call send-email (transport=json) ==');
const r1 = await client.callTool({
  name: 'send-email',
  arguments: {
    transport: 'json',
    from: 'sender@example.com',
    to: ['recipient@example.com', 'bcc-target@example.com'],
    subject: 'Smoke test email',
    text: 'Hello from dsh email-send smoke test',
    html: '<p>Hello from <b>dsh</b></p>'
  }
});
const t1 = r1.content.map((c) => c.text).join('\n');
console.log(t1);
let parsed1;
try {
  parsed1 = JSON.parse(t1);
} catch {
  failures.push('send-email 返回不是 JSON');
}
if (!parsed1 || parsed1.ok !== true || !parsed1.messageId) {
  failures.push('send-email 未返回 messageId');
} else {
  console.log(`  -> messageId = ${parsed1.messageId}`);
}
if (r1.isError) failures.push('send-email 返回 isError');

// ---- 3) parse-email-addresses ----
console.log('\n== call parse-email-addresses ==');
const r2 = await client.callTool({
  name: 'parse-email-addresses',
  arguments: { addresses: 'John Doe <john@example.com>, jane@example.com' }
});
const t2 = r2.content.map((c) => c.text).join('\n');
console.log(t2);
let parsed2;
try {
  parsed2 = JSON.parse(t2);
} catch {
  failures.push('parse-email-addresses 返回不是 JSON');
}
if (!Array.isArray(parsed2) || parsed2.length !== 2 || !parsed2[0].address) {
  failures.push('parse-email-addresses 解析结果不符合预期');
}

// ---- 4) 缺参调用验证参数校验 ----
console.log('\n== call send-email with missing required params (expect validation error) ==');
const r3 = await client.callTool({ name: 'send-email', arguments: {} });
console.log(JSON.stringify(r3));
const t3 = r3.content.map((c) => c.text).join('\n');
if (!r3.isError && !/校验|required|invalid/i.test(t3)) {
  failures.push('缺参调用未触发参数校验');
} else {
  console.log('  -> 参数校验生效（isError=true 或返回校验错误信息）');
}

await client.close();
transport.close();

if (failures.length) {
  console.error('\nSMOKE FAILED:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nSMOKE OK');
process.exit(0);
