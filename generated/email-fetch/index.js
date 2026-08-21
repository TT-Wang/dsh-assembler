#!/usr/bin/env node
// @dsh-index/email-fetch — MCP stdio server for IMAP email fetching, built on imapflow v1.0.162 (ImapFlow).
// Exposes 4 tools: list-mailboxes, search-messages, fetch-message, list-message-summaries.
// Each tool opens its own IMAP connection with the credentials provided in the call,
// performs the operation, and closes the connection afterwards (logger is disabled
// so the IMAP library never writes to stdout, which would corrupt the MCP stdio protocol).
import imapflowPkg from 'imapflow';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const { ImapFlow } = imapflowPkg;

// ---------------------------------------------------------------------------
// Shared parameter schema (connection settings used by every tool)
// ---------------------------------------------------------------------------
// zod enforces required/typed fields before the handler runs: missing or wrongly
// typed values surface as a clear "Invalid arguments for tool ..." MCP error.
// 凭证宪法:密码只从零件进程环境读(IMAP_PASS),绝不做工具参数——参数会经
// 对话进 session 日志。host/user 为非秘密配置:可传参,缺省从 IMAP_HOST/IMAP_USER 读。
const connectionFields = {
    host: z.string().min(1).optional().describe('IMAP server hostname, e.g. "imap.gmail.com"; defaults to deployment env IMAP_HOST'),
    port: z.number().int().min(1).max(65535).optional().describe('IMAP server port (default env IMAP_PORT or 993)'),
    secure: z.boolean().optional().describe('Use TLS/SSL (default true)'),
    user: z.string().min(1).optional().describe('IMAP account username; defaults to deployment env IMAP_USER'),
    rejectUnauthorized: z.boolean().optional().describe('Reject self-signed/expired TLS certificates (default true)')
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Recursively convert IMAP response values (Buffer, Set, Map, Date, BigInt) into
// plain JSON-serializable values so we can embed them in the MCP text response.
function toPlain(value) {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Set) return Array.from(value);
    if (value instanceof Map) {
        const obj = {};
        for (const [k, v] of value) obj[String(k)] = toPlain(v);
        return obj;
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (Array.isArray(value)) return value.map(toPlain);
    if (typeof value === 'object') {
        const obj = {};
        for (const k of Object.keys(value)) obj[k] = toPlain(value[k]);
        return obj;
    }
    return value;
}

function textResult(text) {
    return { content: [{ type: 'text', text }] };
}

function errorResult(message) {
    // Structured, LLM-friendly error text; surfaced as a normal tool result so the
    // client always receives a readable message even for runtime failures.
    return textResult(`Error: ${message}`);
}

// Defensive parameter check (backup for anything zod did not catch, e.g. null args).
function validateConnArgs(args) {
    if (!args || typeof args !== 'object') return 'missing arguments object';
    const host = args.host ?? process.env.IMAP_HOST;
    const user = args.user ?? process.env.IMAP_USER;
    if (!host || typeof host !== 'string' || !host.trim()) return 'IMAP 服务器未配置:传 host 参数或在部署环境配 IMAP_HOST';
    if (!user || typeof user !== 'string' || !user.trim()) return 'IMAP 账号未配置:传 user 参数或在部署环境配 IMAP_USER';
    if (typeof process.env.IMAP_PASS !== 'string' || !process.env.IMAP_PASS.length) return 'IMAP 密码未配置:在部署环境配 IMAP_PASS(密码绝不作为工具参数传入)';
    return null;
}

// Open an authenticated ImapFlow connection. Throws on failure.
async function openClient(args) {
    const client = new ImapFlow({
        host: args.host ?? process.env.IMAP_HOST,
        port: args.port !== undefined ? args.port : (Number(process.env.IMAP_PORT) || 993),
        secure: args.secure !== undefined ? !!args.secure : true,
        logger: false, // critical: keep stdout clean for MCP stdio protocol
        auth: { user: args.user ?? process.env.IMAP_USER, pass: process.env.IMAP_PASS },
        tls: { rejectUnauthorized: args.rejectUnauthorized !== undefined ? !!args.rejectUnauthorized : true },
        connectionTimeout: 30000,
        socketTimeout: 120000
    });
    await client.connect();
    return client;
}

// Select a mailbox, run fn(lock), always release the lock and close the client.
async function withMailbox(args, mailboxPath, fn) {
    const client = await openClient(args);
    let lock = null;
    try {
        lock = await client.getMailboxLock(mailboxPath);
        return await fn(client);
    } finally {
        if (lock) lock.release();
        try {
            await client.logout();
        } catch {
            // connection may already be gone; ignore
        }
    }
}

const server = new McpServer({ name: 'email-fetch', version: '0.0.1' });

// ---------------------------------------------------------------------------
// Tool 1: list-mailboxes
// ---------------------------------------------------------------------------
server.tool(
    'list-mailboxes',
    'List all mailboxes (folders) of an IMAP account. Returns each mailbox with its path, name, path delimiter, IMAP flags, and special-use role (e.g. "\\Sent", "\\Trash", "\\Junk"). Use this first to discover which mailboxes exist before searching or fetching messages.',
    connectionFields,
    async args => {
        const connErr = validateConnArgs(args);
        if (connErr) return errorResult(connErr);
        try {
            const client = await openClient(args);
            try {
                const folders = await client.list();
                const plain = folders.map(f => ({
                    path: f.path,
                    name: f.name,
                    delimiter: f.delimiter,
                    flags: Array.from(f.flags || []),
                    specialUse: f.specialUse,
                    listed: f.listed,
                    subscribed: f.subscribed
                }));
                return textResult(JSON.stringify({ count: plain.length, mailboxes: plain }, null, 2));
            } finally {
                try { await client.logout(); } catch { /* ignore */ }
            }
        } catch (err) {
            return errorResult(`list-mailboxes failed: ${err.message || err}`);
        }
    }
);

// ---------------------------------------------------------------------------
// Tool 2: search-messages
// ---------------------------------------------------------------------------
server.tool(
    'search-messages',
    'Search messages inside an IMAP mailbox using IMAP search criteria and return the matching message UIDs (numbers). Criteria are passed as a plain object, e.g. { from: "alice@example.com", subject: "invoice", since: "2024-01-01", unseen: true }. Supported keys: all, seen, unseen, flagged, unflagged, answered, unanswered, deleted, draft, recent, new, old, larger (bytes), smaller (bytes), from, to, cc, bcc, subject, body, text, header (object mapping header names to values), keyword, unkeyword, before/on/since (date "YYYY-MM-DD"), sentBefore/sentOn/sentSince, uid (sequence/range string), modseq. Boolean flags (seen, flagged, ...) can be inverted with false. An empty criteria object matches ALL messages in the mailbox.',
    {
        ...connectionFields,
        mailbox: z.string().min(1).optional().describe('Mailbox path to search in (default "INBOX")'),
        criteria: z.record(z.string(), z.unknown()).optional().describe('IMAP search criteria object; empty object matches all messages')
    },
    async args => {
        const connErr = validateConnArgs(args);
        if (connErr) return errorResult(connErr);
        const mailbox = args.mailbox || 'INBOX';
        try {
            const uids = await withMailbox(args, mailbox, async client => {
                const result = await client.search(args.criteria && typeof args.criteria === 'object' ? args.criteria : {});
                return Array.isArray(result) ? result : [];
            });
            return textResult(JSON.stringify({ mailbox, count: uids.length, uids }, null, 2));
        } catch (err) {
            return errorResult(`search-messages failed (mailbox "${mailbox}"): ${err.message || err}`);
        }
    }
);

// ---------------------------------------------------------------------------
// Tool 3: fetch-message
// ---------------------------------------------------------------------------
server.tool(
    'fetch-message',
    'Fetch a single message from an IMAP mailbox by its UID (or message sequence number). Returns the raw message source, envelope (parsed from/to/subject/date), headers, body structure and metadata depending on which fields are requested. Envelope values are unicode strings; source/headers are returned as text.',
    {
        ...connectionFields,
        mailbox: z.string().min(1).optional().describe('Mailbox path to fetch from (default "INBOX")'),
        uid: z.number().int().min(1).describe('Message UID (or sequence number when seq is true) to fetch; required'),
        seq: z.boolean().optional().describe('If true, the uid parameter is interpreted as a message sequence number instead of a UID (default false)'),
        envelope: z.boolean().optional().describe('Include parsed ENVELOPE (from, to, subject, date, messageId) (default true)'),
        source: z.boolean().optional().describe('Include the full raw RFC822 message source as text (default false)'),
        headers: z.boolean().optional().describe('Include the raw message headers as text (default false)'),
        bodyStructure: z.boolean().optional().describe('Include the parsed BODYSTRUCTURE (MIME parts) (default false)'),
        internalDate: z.boolean().optional().describe('Include the internal (received) date (default true)'),
        size: z.boolean().optional().describe('Include the message size in bytes (default true)'),
        flags: z.boolean().optional().describe('Include the message flags (e.g. "\\Seen", "\\Flagged") (default true)'),
        labels: z.boolean().optional().describe('Include Gmail labels if the server supports X-GM-EXT-1 (default false)')
    },
    async args => {
        const connErr = validateConnArgs(args);
        if (connErr) return errorResult(connErr);
        const mailbox = args.mailbox || 'INBOX';
        const uid = args.uid;
        const seqMode = !!args.seq;
        try {
            const message = await withMailbox(args, mailbox, async client => {
                const query = {
                    uid: !seqMode,
                    envelope: args.envelope !== undefined ? !!args.envelope : true,
                    source: !!args.source,
                    headers: args.headers ? true : undefined,
                    bodyStructure: !!args.bodyStructure,
                    internalDate: args.internalDate !== undefined ? !!args.internalDate : true,
                    size: args.size !== undefined ? !!args.size : true,
                    flags: args.flags !== undefined ? !!args.flags : true,
                    labels: !!args.labels
                };
                return await client.fetchOne(uid.toString(), query, { uid: !seqMode });
            });
            if (!message) {
                return errorResult(`fetch-message: message with ${seqMode ? 'sequence number' : 'UID'} ${uid} not found in mailbox "${mailbox}"`);
            }
            return textResult(JSON.stringify({ mailbox, message: toPlain(message) }, null, 2));
        } catch (err) {
            return errorResult(`fetch-message failed (mailbox "${mailbox}", uid ${uid}): ${err.message || err}`);
        }
    }
);

// ---------------------------------------------------------------------------
// Tool 4: list-message-summaries
// ---------------------------------------------------------------------------
server.tool(
    'list-message-summaries',
    'List message summaries (envelope + uid + flags + internal date + size) for a range of messages in an IMAP mailbox. Use this to browse a mailbox: get an overview of subjects/senders/dates before deciding which full message to fetch with fetch-message. The range follows IMAP syntax, e.g. "1:*" (all), "1:50" (first fifty), "100:*" (from 100 to the end). Results are capped by the limit parameter.',
    {
        ...connectionFields,
        mailbox: z.string().min(1).optional().describe('Mailbox path to browse (default "INBOX")'),
        range: z.string().min(1).optional().describe('Message range, IMAP sequence syntax (default "1:*")'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of summaries to return (default 100, max 500)')
    },
    async args => {
        const connErr = validateConnArgs(args);
        if (connErr) return errorResult(connErr);
        const mailbox = args.mailbox || 'INBOX';
        const range = typeof args.range === 'string' && args.range.length ? args.range : '1:*';
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 100, 1), 500);
        try {
            const summaries = await withMailbox(args, mailbox, async client => {
                const out = [];
                for await (const message of client.fetch(range, {
                    uid: true,
                    envelope: true,
                    flags: true,
                    internalDate: true,
                    size: true
                })) {
                    const { envelope, uid, flags, internalDate, size, seq, modseq } = message;
                    out.push({ uid, seq, size, internalDate, flags: Array.from(flags || []), modseq: modseq !== undefined ? modseq.toString() : undefined, envelope });
                    if (out.length >= limit) break;
                }
                return out;
            });
            return textResult(JSON.stringify({ mailbox, range, returned: summaries.length, messages: toPlain(summaries) }, null, 2));
        } catch (err) {
            return errorResult(`list-message-summaries failed (mailbox "${mailbox}", range "${range}"): ${err.message || err}`);
        }
    }
);

// ---------------------------------------------------------------------------
// Start the stdio transport
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
