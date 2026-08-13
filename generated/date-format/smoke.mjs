/**
 * 冒烟测试：连接本 MCP stdio server，列出工具并真实调用验证。
 * 运行: node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
})

const client = new Client({ name: 'date-format-smoke', version: '0.0.1' })

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args })
  return res
}

function firstText(res) {
  const t = res?.content?.find((c) => c.type === 'text')
  return t ? t.text : JSON.stringify(res)
}

try {
  await client.connect(transport)

  // 1. listTools
  const tools = await client.listTools()
  console.log('=== listTools ===')
  for (const t of tools.tools) {
    console.log(`- ${t.name}: ${(t.description || '').slice(0, 60)}...`)
  }
  console.log(`工具数量: ${tools.tools.length}`)

  // 2. format-date: 格式化当前时间
  const fmtNow = await callTool('format-date', { format: 'YYYY-MM-DD HH:mm:ss' })
  console.log('\n=== format-date(now) ===')
  console.log(firstText(fmtNow))

  // 3. format-date: 格式化指定时间 + UTC
  const fmtUtc = await callTool('format-date', { input: '2024-05-06T10:30:00Z', format: 'YYYY年MM月DD日 HH:mm:ss', utc: true })
  console.log('\n=== format-date(2024-05-06T10:30:00Z, utc) ===')
  console.log(firstText(fmtUtc))

  // 4. parse-date
  const parsed = await callTool('parse-date', { input: '2024-02-29T12:00:00+08:00' })
  console.log('\n=== parse-date(2024-02-29T12:00:00+08:00) ===')
  console.log(firstText(parsed))

  // 5. date-diff
  const diff = await callTool('date-diff', { dateA: '2024-05-06', dateB: '2024-05-01', unit: 'day' })
  console.log('\n=== date-diff(2024-05-06 vs 2024-05-01, day) ===')
  console.log(firstText(diff))

  // 6. date-manipulate: startOf month
  const manip = await callTool('date-manipulate', {
    operation: 'startOf',
    input: '2024-05-15T18:30:00',
    unit: 'month',
    format: 'YYYY-MM-DD HH:mm:ss',
  })
  console.log('\n=== date-manipulate(startOf month) ===')
  console.log(firstText(manip))

  // 7. 参数校验：缺参 parse-date
  const missing = await callTool('parse-date', {})
  console.log('\n=== parse-date(缺参) ===')
  console.log(firstText(missing))

  // 8. 参数校验：非法日期
  const invalid = await callTool('format-date', { input: 'not-a-date' })
  console.log('\n=== format-date(非法输入) ===')
  console.log(firstText(invalid))

  console.log('\nSMOKE OK')
  process.exit(0)
} catch (e) {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
}
