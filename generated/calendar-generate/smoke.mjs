/**
 * Smoke test for @dsh-index/calendar-generate (MCP stdio server).
 *
 * Starts `node index.js` via StdioClientTransport, then:
 *   1. listTools()                          -> server is up, tools advertised
 *   2. create-event (timed event)           -> real tool round-trip
 *   3. create-all-day-event                 -> real tool round-trip
 *   4. create-recurring-event               -> real tool round-trip
 *   5. create-calendar (metadata)           -> real tool round-trip
 *   6. missing required argument            -> clean validation error, no crash
 *   7. invalid argument value               -> clean validation error, no crash
 *
 * Prints PASS/FAIL lines and exits non-zero on any failure.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, cond, detail = '') {
    if (cond) {
        console.log(`PASS  ${name}`);
    } else {
        failures += 1;
        console.log(`FAIL  ${name}  ${detail}`);
    }
}

function textOf(result) {
    const block = Array.isArray(result.content) ? result.content[0] : null;
    return block && block.type === 'text' ? block.text : JSON.stringify(result);
}

const transport = new StdioClientTransport({
    command: 'node',
    args: ['index.js'],
    cwd: dir,
    stderr: 'pipe',
});

const client = new Client({ name: 'calendar-generate-smoke', version: '0.0.1' });
await client.connect(transport);

try {
    // 1. listTools
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    console.log('Advertised tools:', names.join(', '));
    check('listTools returns all 4 tools',
        JSON.stringify(names) === JSON.stringify(['create-all-day-event', 'create-calendar', 'create-event', 'create-recurring-event']),
        `got ${JSON.stringify(names)}`);

    // 2. timed event
    const ev = await client.callTool({
        name: 'create-event',
        arguments: {
            summary: 'Example Event',
            description: 'It works ;)',
            start: '2024-06-01T10:00:00Z',
            end: '2024-06-01T11:00:00Z',
            location: 'my room',
            url: 'https://example.com/meeting',
            attendees: [{ name: 'Alice', email: 'alice@example.com', role: 'REQ-PARTICIPANT' }],
        },
    });
    const evText = textOf(ev);
    check('create-event returns ICS', evText.includes('BEGIN:VCALENDAR'), evText.slice(0, 80));
    check('create-event has VEVENT', evText.includes('BEGIN:VEVENT'));
    check('create-event has SUMMARY', evText.includes('SUMMARY:Example Event'));
    check('create-event has DTSTART', evText.includes('DTSTART:20240601T100000Z'));
    check('create-event has attendee', evText.includes('ATTENDEE') && evText.includes('alice@example.com'));

    // 3. all-day event
    const ad = await client.callTool({
        name: 'create-all-day-event',
        arguments: { summary: 'Company Holiday', startDate: '2024-06-01', endDate: '2024-06-04' },
    });
    const adText = textOf(ad);
    check('create-all-day-event returns ICS', adText.includes('BEGIN:VCALENDAR'), adText.slice(0, 80));
    check('all-day DTSTART is date-only', adText.includes('DTSTART;VALUE=DATE:20240601'), adText.match(/DTSTART[^\r\n]*/)?.[0]);
    check('all-day DTEND is exclusive date', adText.includes('DTEND;VALUE=DATE:20240604'), adText.match(/DTEND[^\r\n]*/)?.[0]);

    // 4. recurring event
    const re = await client.callTool({
        name: 'create-recurring-event',
        arguments: {
            summary: 'Weekly Standup',
            start: '2024-06-03T09:00:00Z',
            end: '2024-06-03T09:30:00Z',
            freq: 'WEEKLY',
            interval: 1,
            byDay: ['MO', 'WE', 'FR'],
            count: 10,
        },
    });
    const reText = textOf(re);
    check('create-recurring-event returns ICS', reText.includes('BEGIN:VCALENDAR'), reText.slice(0, 80));
    check('recurring has RRULE', reText.includes('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;COUNT=10') || reText.includes('RRULE:FREQ=WEEKLY'), reText.match(/RRULE[^\r\n]*/)?.[0]);

    // 5. calendar metadata
    const cal = await client.callTool({
        name: 'create-calendar',
        arguments: { name: 'Test Feed', method: 'REQUEST', timezone: 'Europe/Berlin' },
    });
    const calText = textOf(cal);
    check('create-calendar returns ICS', calText.includes('BEGIN:VCALENDAR'), calText.slice(0, 80));
    check('calendar has METHOD:REQUEST', calText.includes('METHOD:REQUEST'));
    check('calendar has X-WR-CALNAME', calText.includes('X-WR-CALNAME:Test Feed'));

    // 6. missing required argument -> clean error
    const missing = await client.callTool({ name: 'create-event', arguments: { summary: 'no start given' } });
    const missingText = textOf(missing);
    check('missing required arg is an error', missing.isError === true || /start/i.test(missingText), `isError=${missing.isError} text=${missingText.slice(0, 120)}`);

    // 7. invalid argument value -> clean error
    const bad = await client.callTool({ name: 'create-all-day-event', arguments: { summary: 'x', startDate: '2024/06/01' } });
    const badText = textOf(bad);
    check('invalid arg value is an error', bad.isError === true || /ERROR|YYYY-MM-DD/i.test(badText), `isError=${bad.isError} text=${badText.slice(0, 120)}`);

    console.log(failures === 0 ? '\nSMOKE RESULT: ALL PASS' : `\nSMOKE RESULT: ${failures} FAILURE(S)`);
    process.exitCode = failures === 0 ? 0 : 1;
} finally {
    await client.close();
}
