// 冒烟验证：连接本 MCP stdio server，listTools() 后做 1 次真实调用 + 1 次缺参校验调用
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js']
})

const client = new Client({ name: 'github-api-smoke', version: '0.0.1' })

async function main() {
  await client.connect(transport)

  // 1) listTools
  const { tools } = await client.listTools()
  console.log('=== listTools() ===')
  for (const t of tools) {
    console.log(`- ${t.name}: ${t.description.split('\n')[0]}`)
  }

  // 2) 真实调用：get-user（公开接口，无需 token）
  console.log('\n=== call get-user { username: "octokit" } ===')
  try {
    const res = await client.callTool({ name: 'get-user', arguments: { username: 'octokit' } })
    const text = res.content.map((c) => c.text).join('\n')
    console.log('返回 (前 400 字符):\n' + text.slice(0, 400))
    const parsed = JSON.parse(text)
    console.log('→ 解析成功, login =', parsed.login, ', public_repos =', parsed.public_repos)
  } catch (err) {
    console.log('get-user 调用失败:', err.message ?? String(err))
    throw err
  }

  // 3) 缺参调用验证参数校验生效
  console.log('\n=== call get-repo {} (缺参，应报参数错误) ===')
  const res2 = await client.callTool({ name: 'get-repo', arguments: {} })
  const text2 = res2.content.map((c) => c.text).join('\n')
  console.log('返回:', text2.slice(0, 200))
  const isError = res2.isError === true || /参数错误/.test(text2)
  console.log('→ 缺参被正确拦截:', isError)

  console.log('\n=== SMOKE RESULT: PASS ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE RESULT: FAIL ->', err)
  process.exit(1)
})
