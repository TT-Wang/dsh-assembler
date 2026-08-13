/**
 * @dsh-index/markdown-render — MCP stdio server wrapping marked 12.0.2 (MIT).
 *
 * Tools (exposed to the dsh mcp-client as mcp__markdown-render__<toolname>):
 *   - render-markdown        : Markdown source -> HTML string (GFM-aware)
 *   - render-markdown-inline : inline Markdown fragment -> HTML, no <p> wrapper
 *   - tokenize-markdown      : Markdown source -> JSON token stream (lexer output)
 *
 * marked is a pure-JS, dependency-free parser; all work happens synchronously
 * in-process, so these tools work offline with no external services.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { marked } from 'marked'

const server = new McpServer({
  name: 'markdown-render',
  version: '0.0.1',
  instructions:
    'Markdown processing powered by marked 12.0.2. Use render-markdown to convert a full Markdown document ' +
    'to HTML (GFM tables, task lists, strikethrough, autolinks supported), render-markdown-inline for short ' +
    'inline fragments without a wrapping <p> tag, and tokenize-markdown to inspect the parsed token stream as JSON.',
})

/** Standard MCP text result. */
function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/** Standard MCP error result (returned, not thrown, so the client always gets a readable message). */
function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Tool 1: render-markdown — full Markdown document -> HTML
// ---------------------------------------------------------------------------
server.tool(
  'render-markdown',
  'Convert a Markdown source string to an HTML string using marked v12.0.2. ' +
    'Handles headings, paragraphs, lists, code blocks (with fenced code), blockquotes, links, images, emphasis, ' +
    'and GFM extensions (tables, strikethrough, autolinks, task lists) when gfm is enabled (default). ' +
    'Params: markdown (required, string, the Markdown source to render); ' +
    'gfm (optional, boolean, default true — enable GitHub-flavored Markdown: tables, task lists, strikethrough, autolinks); ' +
    'breaks (optional, boolean, default false — requires gfm; convert single line breaks to <br>); ' +
    'pedantic (optional, boolean, default false — conform to quirks of markdown.pl). ' +
    'Returns the rendered HTML as a text string.',
  {
    markdown: z.string().min(1, 'markdown is required and must be a non-empty string'),
    gfm: z.boolean().optional(),
    breaks: z.boolean().optional(),
    pedantic: z.boolean().optional(),
  },
  async ({ markdown, gfm, breaks, pedantic }) => {
    try {
      const options = {}
      if (gfm !== undefined) options.gfm = gfm
      if (breaks !== undefined) options.breaks = breaks
      if (pedantic !== undefined) options.pedantic = pedantic
      const html = await marked.parse(markdown, options)
      return ok(html)
    } catch (err) {
      return fail(`render-markdown failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 2: render-markdown-inline — inline fragment -> HTML (no <p> wrapper)
// ---------------------------------------------------------------------------
server.tool(
  'render-markdown-inline',
  'Convert an inline Markdown fragment (no block-level elements) to an HTML string without an enclosing ' +
    '<p> tag, using marked v12.0.2 parseInline. ' +
    'Best for short spans like "**bold** text", "`code`", or "a [link](https://example.com)" where you want ' +
    'the raw inline HTML (e.g. <strong>bold</strong> text). Block syntax such as headings or lists is ignored. ' +
    'Params: markdown (required, string, the inline Markdown fragment to render); ' +
    'gfm (optional, boolean, default true — enable GitHub-flavored inline features like autolinks and strikethrough). ' +
    'Returns the rendered inline HTML as a text string.',
  {
    markdown: z.string().min(1, 'markdown is required and must be a non-empty string'),
    gfm: z.boolean().optional(),
  },
  async ({ markdown, gfm }) => {
    try {
      const options = {}
      if (gfm !== undefined) options.gfm = gfm
      const html = await marked.parseInline(markdown, options)
      return ok(html)
    } catch (err) {
      return fail(`render-markdown-inline failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 3: tokenize-markdown — Markdown -> JSON token stream (lexer output)
// ---------------------------------------------------------------------------
server.tool(
  'tokenize-markdown',
  'Lex a Markdown source string into its parsed token stream and return it as a JSON array, using the ' +
    'marked v12.0.2 lexer. Each token has a "type" (e.g. heading, paragraph, list, code, table, text, strong, ' +
    'link) plus type-specific fields ("raw", "text", "depth", "tokens", ...). ' +
    'Useful for inspecting how Markdown is parsed, counting structure, or feeding tokens to another stage. ' +
    'Params: markdown (required, string, the Markdown source to tokenize). ' +
    'Returns a JSON-formatted array of tokens as a text string.',
  {
    markdown: z.string().min(1, 'markdown is required and must be a non-empty string'),
  },
  async ({ markdown }) => {
    try {
      const tokens = await marked.lexer(markdown)
      return ok(JSON.stringify(tokens, null, 2))
    } catch (err) {
      return fail(`tokenize-markdown failed: ${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Connect (stdio)
// ---------------------------------------------------------------------------
await server.connect(new StdioServerTransport())
