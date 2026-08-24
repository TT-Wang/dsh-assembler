// cron-trigger 冒烟:5 工具 + 登记/列出/取消 + cron 校验 + 持久化 + fire-task
// 真打(对一个 mock wire:本地起 HTTP 假 host,断言 session.create/prompt 都到)。
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${ok ? '' : ' | ' + detail}`);
	if (!ok) failures += 1;
};
const J = (r) => JSON.parse(r.content[0].text);

// mock wire:记录收到的调用
const seen = [];
const mock = createServer((req, res) => {
	let body = '';
	req.on('data', (d) => { body += d; });
	req.on('end', () => {
		const j = JSON.parse(body || '{}');
		seen.push({ method: j.method, payload: j.payload });
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ result: { ok: true, value: { sessionId: 'mock-session-1' } } }));
	});
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

const wd = mkdtempSync(join(tmpdir(), 'cron-smoke-'));
const transport = new StdioClientTransport({
	command: 'node', args: ['index.js'],
	env: { ...process.env, PART_WORKDIR: wd, CRON_WIRE_PORT: String(mockPort) },
});
const client = new Client({ name: 'cron-smoke', version: '0.0.1' });

try {
	await client.connect(transport);
	const tools = (await client.listTools()).tools;
	check('listTools:5 工具', tools.length === 5, `got ${tools.length}`);

	const bad = J(await client.callTool({ name: 'schedule-task', arguments: { cron: 'not a cron', prompt: 'x', presetId: 'p' } }));
	check('坏 cron 表达式拒收且报因', typeof bad.error === 'string' && bad.error.includes('cron'));

	const s1 = J(await client.callTool({ name: 'schedule-task', arguments: { cron: '0 9 1 * *', prompt: '生成上月月报并落库', presetId: 'demo-preset', id: 'monthly-report' } }));
	check('登记返回未来 3 次触发时间', s1.scheduled === 'monthly-report' && Array.isArray(s1.next3) && s1.next3.length === 3);
	check('任务持久化落盘', existsSync(join(wd, 'cron-tasks.json')) && JSON.parse(readFileSync(join(wd, 'cron-tasks.json'), 'utf8'))[0].id === 'monthly-report');

	const dup = J(await client.callTool({ name: 'schedule-task', arguments: { cron: '0 9 1 * *', prompt: 'x', presetId: 'p', id: 'monthly-report' } }));
	check('重复 id 拒收', typeof dup.error === 'string');

	const fired = J(await client.callTool({ name: 'fire-task', arguments: { id: 'monthly-report' } }));
	check('fire-task 真打 wire 并回 sessionId', fired.fired === 'monthly-report' && fired.sessionId === 'mock-session-1');
	check('mock 收到 session.create + session.prompt', seen.some((s) => s.method === 'session.create' && s.payload.agentPreset === 'demo-preset') && seen.some((s) => s.method === 'session.prompt'));
	const promptSeen = seen.find((s) => s.method === 'session.prompt');
	check('注入的任务带无人值守纪律头', JSON.stringify(promptSeen.payload).includes('自动触发') && JSON.stringify(promptSeen.payload).includes('生成上月月报'));

	const ls = J(await client.callTool({ name: 'list-tasks', arguments: {} }));
	check('list 报 fires=1 与下次触发', ls.tasks[0].fires === 1 && typeof ls.tasks[0].nextFireAt === 'string');

	const cx = J(await client.callTool({ name: 'cancel-task', arguments: { id: 'monthly-report' } }));
	check('cancel 生效', cx.cancelled === 'monthly-report' && J(await client.callTool({ name: 'list-tasks', arguments: {} })).tasks.length === 0);
} catch (e) {
	console.error('SMOKE CRASHED:', e);
	failures += 1;
} finally {
	try { await transport.close(); } catch { /* ignore */ }
	mock.close();
}

console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failure(s))`}`);
process.exit(failures === 0 ? 0 : 1);
