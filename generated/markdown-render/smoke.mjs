/**
 * Smoke test for the @dsh-index/markdown-render MCP stdio server.
 * Connects as an MCP client, lists tools, then exercises real tool calls
 * and parameter validation, and exits non-zero on any failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
})

const client = new Client({ name: 'markdown-render-smoke', version: '0.0.1' })
await client.connect(transport)

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// 1. listTools
console.log('== listTools ==')
const { tools } = await client.listTools()
console.log(`  found ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`)
check('3 tools registered', tools.length === 3, `expected 3, got ${tools.length}`)

// 2. render-markdown — real conversion with GFM (table + task list + strikethrough)
console.log('\n== render-markdown ==')
const md = [
  '# Hello *world*',
  '',
  'A paragraph with a [link](https://example.com) and `code`.',
  '',
  '| Name | Value |',
  '| ---- | ----- |',
  '| a    | 1     |',
  '',
  '- [x] done task',
  '- [ ] open task',
  '',
  '~~struck~~ text',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n')
const rendered = await client.callTool({ name: 'render-markdown', arguments: { markdown: md } })
const html = rendered.content[0].text
console.log(html.slice(0, 600))
check('render-markdown returns text', typeof html === 'string' && html.length > 0)
check('render-markdown produces <h1>', /<h1[^>]*>/.test(html))
check('render-markdown produces <table>', html.includes('<table>'))
check('render-markdown produces task checkbox', html.includes('type="checkbox"'))
check('render-markdown produces <del>', html.includes('<del>'))
check('render-markdown produces <pre><code', html.includes('<pre><code'))
check('render-markdown escapes nothing unexpectedly', !html.includes('Error:'))

// 3. render-markdown-inline
console.log('\n== render-markdown-inline ==')
const inline = await client.callTool({
  name: 'render-markdown-inline',
  arguments: { markdown: '**bold** and `code` and a [link](https://example.com)' },
})
const inlineHtml = inline.content[0].text
console.log(inlineHtml)
check('inline renders <strong>', inlineHtml.includes('<strong>bold</strong>'))
check('inline renders <code>', inlineHtml.includes('<code>'))
check('inline has no <p> wrapper', !/^<p>/.test(inlineHtml))
check('inline renders <a>', inlineHtml.includes('<a href="https://example.com">'))

// 4. tokenize-markdown
console.log('\n== tokenize-markdown ==')
const toks = await client.callTool({ name: 'tokenize-markdown', arguments: { markdown: '# Title\n\nsome **bold** text' } })
const tokenJson = toks.content[0].text
const parsed = JSON.parse(tokenJson)
console.log(tokenJson.slice(0, 400))
check('tokenize returns valid JSON array', Array.isArray(parsed) && parsed.length > 0)
check('tokenize first token is heading', parsed[0].type === 'heading', `got ${parsed[0]?.type}`)
check('tokenize has a paragraph token', parsed.some((t) => t.type === 'paragraph'))

// 5. parameter validation — missing required arg
console.log('\n== parameter validation ==')
const missing = await client.callTool({ name: 'render-markdown', arguments: {} })
const missingText = missing.content?.[0]?.text ?? JSON.stringify(missing)
console.log(`  isError=${missing.isError} text=${missingText.slice(0, 160)}`)
check('missing arg flagged as error', missing.isError === true || /markdown/i.test(missingText))

// 6. parameter validation — wrong type
const wrongType = await client.callTool({ name: 'render-markdown', arguments: { markdown: 42 } })
const wrongText = wrongType.content?.[0]?.text ?? JSON.stringify(wrongType)
console.log(`  isError=${wrongType.isError} text=${wrongText.slice(0, 160)}`)
check('wrong type flagged as error', wrongType.isError === true || /markdown/i.test(wrongText))

await client.close()
console.log(`\nSMOKE ${failures === 0 ? 'OK' : `FAILED (${failures} failure(s))`}`)
process.exit(failures === 0 ? 0 : 1)
