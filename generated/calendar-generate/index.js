/**
 * @dsh-index/calendar-generate — MCP stdio server wrapping ical-generator v7.1.0
 *
 * Generates RFC 5545 iCalendar (.ics) strings:
 *   - create-calendar        : calendar skeleton / feed metadata (name, method, timezone, ...)
 *   - create-event           : single timed or all-day event (full event options)
 *   - create-all-day-event   : all-day event built from date-only strings (YYYY-MM-DD)
 *   - create-recurring-event : event with an RRULE (freq/interval/count/until/byDay/...)
 *
 * Every tool returns the complete .ics text as a text content block.
 * Errors are returned as clear error text (never thrown out of the tool).
 *
 * Run: node index.js   (stdio transport; exits cleanly when stdin closes)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import ical from 'ical-generator';
import { z } from 'zod';

const server = new McpServer({
    name: 'calendar-generate',
    version: '0.0.1',
});

/** Wrap a handler so any exception becomes a readable error text result. */
function safe(fn) {
    return async (args) => {
        try {
            const text = await fn(args);
            return {
                content: [{ type: 'text', text }],
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text', text: `ERROR: ${msg}` }],
                isError: true,
            };
        }
    };
}

/* ------------------------------------------------------------------ *
 * Shared small schemas
 * ------------------------------------------------------------------ */

const weekdayEnum = z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']);
const statusEnum = z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']);
const methodEnum = z.enum([
    'PUBLISH', 'REQUEST', 'REPLY', 'ADD', 'CANCEL',
    'REFRESH', 'COUNTER', 'DECLINECOUNTER',
]);

const isoDateTime = z.string().refine(
    (s) => !Number.isNaN(Date.parse(s)),
    'must be an ISO 8601 date/time string (e.g. "2024-06-01T10:00:00Z" or "2024-06-01T10:00:00+02:00")'
);

const isoDateOnly = z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    'must be a date-only string "YYYY-MM-DD"'
);

const attendeeSchema = z.object({
    name: z.string().describe('Display name of the attendee').optional(),
    email: z.string().email().describe('Email address of the attendee (required)'),
    role: z.enum(['CHAIR', 'REQ-PARTICIPANT', 'OPT-PARTICIPANT', 'NON-PARTICIPANT'])
        .describe('Attendee participation role').optional(),
    status: z.enum(['ACCEPTED', 'DECLINED', 'TENTATIVE', 'DELEGATED', 'NEEDS-ACTION'])
        .describe('Attendance status').optional(),
    rsvp: z.boolean().describe('Whether a reply is requested').optional(),
    type: z.enum(['INDIVIDUAL', 'GROUP', 'RESOURCE', 'ROOM', 'UNKNOWN'])
        .describe('Attendee type (cal-address)').optional(),
});

const alarmSchema = z.object({
    type: z.enum(['display', 'audio', 'email'])
        .describe('Alarm action: popup (display), sound (audio) or email').optional(),
    triggerBeforeMinutes: z.number().positive()
        .describe('Trigger this many minutes BEFORE the event start').optional(),
    triggerAfterMinutes: z.number().positive()
        .describe('Trigger this many minutes AFTER the event start').optional(),
    description: z.string().describe('Alarm message text').optional(),
    summary: z.string().describe('Subject for email alarms').optional(),
    repeat: z.object({
        times: z.number().int().positive().describe('How often the alarm repeats'),
        interval: z.number().int().positive().describe('Delay between repeats, in minutes'),
    }).describe('Repeat the alarm').optional(),
}).refine((a) => !(a.triggerBeforeMinutes && a.triggerAfterMinutes),
    'use only one of triggerBeforeMinutes / triggerAfterMinutes');

/* ------------------------------------------------------------------ *
 * Tool 1: create-calendar
 * ------------------------------------------------------------------ */

server.tool(
    'create-calendar',
    'Build a standalone iCalendar (.ics) file with calendar-level metadata and NO events. ' +
    'Returns the full RFC 5545 VCALENDAR text. Use this to create a calendar feed skeleton ' +
    'or to set shared properties (name, method, timezone, url, prodId) before/without adding events. ' +
    'For calendars containing events, prefer create-event / create-all-day-event / create-recurring-event, ' +
    'which return a complete calendar with one event inside.',
    {
        name: z.string().describe('Calendar display name (X-WR-CALNAME)').optional(),
        description: z.string().describe('Calendar description (X-WR-CALDESC)').optional(),
        method: methodEnum.describe('iTIP method: PUBLISH (default) for a plain feed, REQUEST for invitations').optional(),
        timezone: z.string().describe('IANA timezone id, e.g. "Europe/Berlin" (emits VTIMEZONE-free TZID usage)').optional(),
        url: z.string().url().describe('URL of the calendar (optional)').optional(),
        prodId: z.string().describe('Product identifier (PRODID). Defaults to the library product id').optional(),
        scale: z.string().describe('Calendar scale (CALSCALE), usually "GREGORIAN"').optional(),
        ttl: z.number().int().positive().describe('Refresh interval in seconds (X-PUBLISHED-TTL)').optional(),
        source: z.string().describe('Source URL of the calendar (SOURCE property)').optional(),
    },
    safe((args) => {
        const cal = ical({
            name: args.name,
            description: args.description,
            method: args.method,
            timezone: args.timezone,
            url: args.url,
            prodId: args.prodId,
            scale: args.scale,
            ttl: args.ttl,
            source: args.source,
        });
        return cal.toString();
    })
);

/* ------------------------------------------------------------------ *
 * Tool 2: create-event
 * ------------------------------------------------------------------ */

server.tool(
    'create-event',
    'Create a calendar containing ONE event and return the complete .ics text. ' +
    'Supports timed events (start/end), all-day events (allDay: true), timezones, attendees, ' +
    'alarms, categories, organizer, status and custom X-properties. ' +
    'start is required; end defaults to start + 1 hour if omitted. ' +
    'For date-only all-day events use create-all-day-event; for recurring events use create-recurring-event.',
    {
        summary: z.string().describe('Event title / summary (shown in the calendar)').optional(),
        start: isoDateTime.describe('Event start time, ISO 8601 (required)'),
        end: isoDateTime.describe('Event end time, ISO 8601. Defaults to start + 1 hour').optional(),
        allDay: z.boolean().describe('True for an all-day (date-only) event; start/end are treated as dates').optional(),
        floating: z.boolean().describe('True for a floating (timezone-less local) time').optional(),
        timezone: z.string().describe('IANA timezone id, e.g. "Asia/Shanghai"').optional(),
        description: z.string().describe('Event description text').optional(),
        location: z.string().describe('Location name, e.g. "Room 301, HQ"').optional(),
        url: z.string().url().describe('Event URL (e.g. meeting link)').optional(),
        status: statusEnum.describe('Event status').optional(),
        priority: z.number().int().min(0).max(9).describe('Priority 0-9 (1 highest, 5 normal, 9 lowest)').optional(),
        organizer: z.object({
            name: z.string().describe('Organizer display name').optional(),
            email: z.string().email().describe('Organizer email (required)'),
        }).describe('Event organizer').optional(),
        attendees: z.array(attendeeSchema).describe('List of attendees').optional(),
        categories: z.array(z.string()).describe('Event categories / tags').optional(),
        alarms: z.array(alarmSchema).describe('Reminder alarms for this event').optional(),
        x: z.record(z.string()).describe('Custom X- properties, e.g. {"X-MY-FIELD": "value"}').optional(),
    },
    safe((args) => {
        const cal = ical();
        const eventData = {
            summary: args.summary,
            start: args.start,
            end: args.end,
            allDay: args.allDay,
            floating: args.floating,
            timezone: args.timezone,
            description: args.description,
            location: args.location,
            url: args.url,
            status: args.status,
            priority: args.priority,
            organizer: args.organizer,
            attendees: args.attendees,
            categories: args.categories,
            x: args.x,
            alarms: args.alarms
                ? args.alarms.map((a) => {
                    const alarm = {
                        type: a.type,
                        description: a.description,
                        summary: a.summary,
                        repeat: a.repeat
                            ? { times: a.repeat.times, interval: a.repeat.interval }
                            : undefined,
                    };
                    if (a.triggerBeforeMinutes) {
                        alarm.triggerBefore = a.triggerBeforeMinutes * 60; // seconds
                    } else if (a.triggerAfterMinutes) {
                        alarm.triggerAfter = a.triggerAfterMinutes * 60; // seconds
                    }
                    return alarm;
                })
                : undefined,
        };
        cal.createEvent(eventData);
        return cal.toString();
    })
);

/* ------------------------------------------------------------------ *
 * Tool 3: create-all-day-event
 * ------------------------------------------------------------------ */

server.tool(
    'create-all-day-event',
    'Create a calendar containing ONE all-day (multi-day) event and return the complete .ics text. ' +
    'Times are date-only: startDate (required, inclusive) and endDate (optional, EXCLUSIVE) as "YYYY-MM-DD". ' +
    'The output uses DTSTART;VALUE=DATE / DTEND;VALUE=DATE. ' +
    'Use this for holidays, birthdays, deadlines or multi-day trips.',
    {
        summary: z.string().describe('Event title (required for a meaningful event)').optional(),
        startDate: isoDateOnly.describe('First day of the event, "YYYY-MM-DD" (required, inclusive)'),
        endDate: isoDateOnly.describe('Day AFTER the event ends, "YYYY-MM-DD" (exclusive). ' +
            'Omit for a single-day event; for a 3-day event starting 2024-06-01 pass 2024-06-04').optional(),
        timezone: z.string().describe('IANA timezone id, e.g. "Asia/Shanghai"').optional(),
        description: z.string().describe('Event description text').optional(),
        location: z.string().describe('Location name').optional(),
        url: z.string().url().describe('Event URL').optional(),
        status: statusEnum.describe('Event status').optional(),
        categories: z.array(z.string()).describe('Event categories / tags').optional(),
    },
    safe((args) => {
        const cal = ical();
        const eventData = {
            summary: args.summary,
            start: args.startDate,
            end: args.endDate,
            allDay: true,
            timezone: args.timezone,
            description: args.description,
            location: args.location,
            url: args.url,
            status: args.status,
            categories: args.categories,
        };
        cal.createEvent(eventData);
        return cal.toString();
    })
);

/* ------------------------------------------------------------------ *
 * Tool 4: create-recurring-event
 * ------------------------------------------------------------------ */

server.tool(
    'create-recurring-event',
    'Create a calendar containing ONE recurring event and return the complete .ics text. ' +
    'Emits an RRULE from the repetition parameters: freq (required), interval, count, until, ' +
    'byDay (weekdays), byMonth, byMonthDay, bySetPos and startOfWeek. ' +
    'Use this for weekly meetings, monthly reports, daily standups, etc.',
    {
        summary: z.string().describe('Event title (required for a meaningful event)').optional(),
        start: isoDateTime.describe('First occurrence start time, ISO 8601 (required)'),
        end: isoDateTime.describe('First occurrence end time, ISO 8601. Defaults to start + 1 hour').optional(),
        freq: z.enum(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
            .describe('Recurrence frequency (required)'),
        interval: z.number().int().positive().describe('Repeat every N units of freq (default 1)').optional(),
        count: z.number().int().positive().describe('Stop after this many occurrences').optional(),
        until: isoDateTime.describe('Repeat until this date/time (inclusive)').optional(),
        byDay: z.array(weekdayEnum).describe('Weekdays for WEEKLY rules, e.g. ["MO","WE","FR"]').optional(),
        byMonth: z.array(z.number().int().min(1).max(12)).describe('Months (1-12) for yearly rules').optional(),
        byMonthDay: z.array(z.number().int().min(-31).max(31)).describe('Days of month (1-31, negative counts from end)').optional(),
        bySetPos: z.array(z.number().int()).describe('Ordinal position within the period (e.g. [-1] = last)').optional(),
        startOfWeek: weekdayEnum.describe('Week start day for WEEKLY rules (default MO)').optional(),
        allDay: z.boolean().describe('True for an all-day recurring event').optional(),
        timezone: z.string().describe('IANA timezone id, e.g. "Europe/London"').optional(),
        description: z.string().describe('Event description text').optional(),
        location: z.string().describe('Location name').optional(),
        url: z.string().url().describe('Event URL').optional(),
    },
    safe((args) => {
        const cal = ical();
        const repeating = {
            freq: args.freq,
            interval: args.interval,
            count: args.count,
            until: args.until,
            byDay: args.byDay,
            byMonth: args.byMonth,
            byMonthDay: args.byMonthDay,
            bySetPos: args.bySetPos,
            startOfWeek: args.startOfWeek,
        };
        cal.createEvent({
            summary: args.summary,
            start: args.start,
            end: args.end,
            allDay: args.allDay,
            timezone: args.timezone,
            description: args.description,
            location: args.location,
            url: args.url,
            repeating,
        });
        return cal.toString();
    })
);

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
