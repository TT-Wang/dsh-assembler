// smoke.mjs — smoke test for the @dsh-index/email-fetch MCP stdio server.
// Verifies: (1) server starts and lists tools, (2) zod parameter-validation errors
// (missing/wrongly-typed params) round-trip through the MCP protocol as InvalidParams,
// (3) a full tool invocation (against an unreachable IMAP endpoint) returns a clean
// structured error text, proving the handler + connection logic executes end-to-end.
// Real mailbox I/O needs a live IMAP server, which is out of scope for this offline test.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
    command: 'node',
    args: ['index.js']
});

const client = new Client({ name: 'email-fetch-smoke', version: '0.0.1' });

let failures = 0;
const check = (label, cond, detail) => {
    if (cond) {
        console.log(`PASS  ${label}`);
    } else {
        failures++;
        console.log(`FAIL  ${label}: ${detail}`);
    }
};

// callTool that never throws: returns { ok: true, text, isError } or { ok: false, error }
async function safeCall(name, args) {
    try {
        const r = await client.callTool({ name, arguments: args });
        const text = r.content && r.content[0] ? r.content[0].text : JSON.stringify(r);
        return { ok: true, text, isError: !!r.isError };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
}

const msg = r => (r.ok ? r.text : r.error);

try {
    await client.connect(transport);

    // 1. listTools
    const { tools } = await client.listTools();
    console.log('\n--- tools listed by server ---');
    for (const t of tools) {
        console.log(`  ${t.name}: ${(t.description || '').slice(0, 80)}...`);
    }
    check('listTools returned 4 tools', tools.length === 4, `expected 4, got ${tools.length}`);
    const names = tools.map(t => t.name).sort();
    check(
        'expected tool names present',
        JSON.stringify(names) === JSON.stringify(['fetch-message', 'list-mailboxes', 'list-message-summaries', 'search-messages']),
        `got ${JSON.stringify(names)}`
    );
    const withSchema = tools.filter(t => t.inputSchema && Object.keys(t.inputSchema.properties || {}).length >= 6);
    check('tools expose input schemas with connection params', withSchema.length === 4, `only ${withSchema.length}/4 have inputSchema`);

    // 2. zod validation: no args at all -> InvalidParams mentioning host
    console.log('\n--- call list-mailboxes with NO args (expect zod InvalidParams) ---');
    const r1 = await safeCall('list-mailboxes', {});
    console.log('result:', msg(r1));
    check('missing host/user/pass rejected by zod', /Invalid arguments for tool list-mailboxes/.test(msg(r1)) && /host/.test(msg(r1)), msg(r1));

    // 3. zod validation: partial args, missing uid on fetch-message
    console.log('\n--- call fetch-message with conn args but NO uid (expect zod InvalidParams) ---');
    const r2 = await safeCall('fetch-message', { host: 'imap.example.com', user: 'u', pass: 'p', mailbox: 'INBOX' });
    console.log('result:', msg(r2));
    check('missing uid rejected by zod', /Invalid arguments for tool fetch-message/.test(msg(r2)) && /uid/.test(msg(r2)), msg(r2));

    // 4. zod validation: uid must be a number
    console.log('\n--- call fetch-message with uid: "abc" (expect zod type error) ---');
    const r3 = await safeCall('fetch-message', { host: 'imap.example.com', user: 'u', pass: 'p', mailbox: 'INBOX', uid: 'abc' });
    console.log('result:', msg(r3));
    check('non-numeric uid rejected by zod', /Invalid arguments for tool fetch-message/.test(msg(r3)) && /expected number/.test(msg(r3)), msg(r3));

    // 5. Full invocation round-trip: unreachable IMAP endpoint -> handler returns clean error text
    console.log('\n--- call list-mailboxes against unreachable host 127.0.0.1:1 (expect clean Error text) ---');
    const r4 = await safeCall('list-mailboxes', { host: '127.0.0.1', port: 1, secure: false, user: 'u', pass: 'p' });
    console.log('result:', msg(r4).slice(0, 200));
    check('connection failure returns structured Error text from handler', /^Error: list-mailboxes failed/.test(msg(r4)), msg(r4));

    console.log('\n=== smoke result:', failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`, '===');
} catch (err) {
    failures++;
    console.error('SMOKE CRASH:', err);
} finally {
    await client.close().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
}
