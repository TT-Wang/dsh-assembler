// MCP stdio server: QR code generation tools.
// Backend: node-qrcode (soldair/node-qrcode v1.5.3, MIT) — https://github.com/soldair/node-qrcode
// Capability: qrcode-generate
//
// Exposed tools (all kebab-case, input -> output):
//   qr-generate-png       text -> PNG binary (returned as base64 string)
//   qr-generate-data-url  text -> data:image/png;base64,... URL (embeddable in <img src>)
//   qr-generate-svg       text -> SVG markup string
//   qr-generate-terminal  text -> UTF-8 block-character terminal art
//
// Binary/image output (PNG) is returned base64-encoded; consumers must decode
// before writing to a file.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import QRCode from 'qrcode'

// ---------------------------------------------------------------------------
// Shared option schema — describes parameters for LLM tool selection.
// ---------------------------------------------------------------------------

const commonOptions = {
  errorCorrectionLevel: z
    .enum(['L', 'M', 'Q', 'H'])
    .optional()
    .describe(
      'Error correction level: L (~7%), M (~15%, default), Q (~25%), H (~30%). ' +
        'Higher levels survive more damage but shrink capacity.'
    ),
  version: z
    .number()
    .int()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'QR Code symbol version 1-40 (size grows from 21x21 modules). ' +
        'Omit to let the library auto-pick the smallest suitable version.'
    ),
  margin: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Quiet zone (white border) width in modules. Default 4.'),
  width: z
    .number()
    .int()
    .min(21)
    .optional()
    .describe('Output image width in pixels (>= 21). If set, it overrides scale.'),
  scale: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Scale factor: pixels per module. Default 4. Ignored when width is set.')
}

const colorOptions = {
  darkColor: z
    .string()
    .regex(/^#?[0-9a-fA-F]{3,8}$/, 'darkColor must be a hex color like #000000 or #000000ff')
    .optional()
    .describe('Dark module RGBA hex color (e.g. #000000). Default black.'),
  lightColor: z
    .string()
    .regex(/^#?[0-9a-fA-F]{3,8}$/, 'lightColor must be a hex color like #ffffff or #ffffffff')
    .optional()
    .describe('Light module RGBA hex color (e.g. #ffffff). Default white.')
}

const commonWithColors = { ...commonOptions, ...colorOptions }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toOptions (opts) {
  const out = {}
  if (opts.errorCorrectionLevel) out.errorCorrectionLevel = opts.errorCorrectionLevel.toUpperCase()
  if (opts.version !== undefined) out.version = opts.version
  if (opts.margin !== undefined) out.margin = opts.margin
  if (opts.width !== undefined) out.width = opts.width
  if (opts.scale !== undefined) out.scale = opts.scale
  if (opts.darkColor !== undefined || opts.lightColor !== undefined) {
    out.color = {}
    if (opts.darkColor !== undefined) out.color.dark = opts.darkColor
    if (opts.lightColor !== undefined) out.color.light = opts.lightColor
  }
  return out
}

function textResult (text) {
  return { content: [{ type: 'text', text }] }
}

function errorResult (err) {
  const msg = err && err.message ? err.message : String(err)
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
}

async function guard (fn) {
  try {
    return await fn()
  } catch (err) {
    return errorResult(err)
  }
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: '@dsh-index/qrcode-generate',
  version: '0.0.1'
})

server.tool(
  'qr-generate-png',
  'Generate a QR code as a PNG image. Accepts arbitrary text (URLs, phone numbers, plain text, up to ~2953 bytes at error level L). ' +
    'Returns the PNG binary data as a base64-encoded string — decode it before saving to a file. ' +
    'Use this tool when the caller needs an actual image file/buffer.',
  { text: z.string().min(1).describe('The text/URL/data to encode into the QR code.'), ...commonWithColors },
  async (params) =>
    guard(async () => {
      const buf = await QRCode.toBuffer(params.text, toOptions(params))
      return textResult(buf.toString('base64'))
    })
)

server.tool(
  'qr-generate-data-url',
  'Generate a QR code as a data URL string in the form "data:image/png;base64,....". ' +
    'The returned string can be used directly as an <img src="..."> value or embedded in HTML/CSS — no decoding needed. ' +
    'Choose this over qr-generate-png when the target is a web page or a document renderer.',
  { text: z.string().min(1).describe('The text/URL/data to encode into the QR code.'), ...commonWithColors },
  async (params) =>
    guard(async () => {
      const url = await QRCode.toDataURL(params.text, toOptions(params))
      return textResult(url)
    })
)

server.tool(
  'qr-generate-svg',
  'Generate a QR code as a standalone SVG markup string (vector, infinitely scalable, no raster artifacts). ' +
    'The returned string is the raw <svg>...</svg> XML — write it to a .svg file or embed inline. ' +
    'Colors accept any CSS color value (e.g. "#ff0000", "red", "rgb(0,0,0)").',
  {
    text: z.string().min(1).describe('The text/URL/data to encode into the QR code.'),
    ...commonOptions,
    darkColor: z.string().optional().describe('Dark module CSS color (default black).'),
    lightColor: z.string().optional().describe('Light module CSS color (default white).')
  },
  async (params) =>
    guard(async () => {
      const opts = toOptions(params)
      opts.type = 'svg'
      const svg = await QRCode.toString(params.text, opts)
      return textResult(svg)
    })
)

server.tool(
  'qr-generate-terminal',
  'Render a QR code as UTF-8 block characters for display in a terminal or monospace text context. ' +
    'The output is a plain-text/ANSI-free string of half-block characters; it is scannable from the screen. ' +
    'Set small=true for a compact rendering (uses unicode half-blocks, best for narrow terminals).',
  {
    text: z.string().min(1).describe('The text/URL/data to encode into the QR code.'),
    small: z
      .boolean()
      .optional()
      .describe('Use the compact "small" terminal rendering (default false).'),
    ...commonOptions
  },
  async (params) =>
    guard(async () => {
      const opts = toOptions(params)
      opts.type = 'terminal'
      if (params.small) opts.small = true
      const out = await QRCode.toString(params.text, opts)
      return textResult(out)
    })
)

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
