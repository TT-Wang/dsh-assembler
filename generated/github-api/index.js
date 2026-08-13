// MCP stdio server adapter for octokit/rest.js v20.1.1 (MIT)
// Capability id: github-api
// Tools: get-user, get-repo, list-org-repos, search-repositories
//
// 依赖 @octokit/rest（GitHub REST API 官方客户端）。
// 认证：可选的 GITHUB_TOKEN 环境变量；未提供时以匿名身份调用（仅限公开数据，受速率限制）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Octokit } from '@octokit/rest'

const server = new McpServer({
  name: 'github-api',
  version: '0.0.1'
})

const auth = process.env.GITHUB_TOKEN
const octokit = new Octokit(auth ? { auth } : {})

const MAX_TEXT = 20000 // 响应文本截断上限，防止超大响应撑爆 MCP 消息

function truncate(text) {
  const s = String(text)
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n…[响应过长，已截断]' : s
}

function ok(text) {
  return { content: [{ type: 'text', text: truncate(text) }] }
}

// 统一把 Octokit 抛出的错误转成清晰文本。HttpError 带 status（如 404/401/403/422）。
function errText(err) {
  const status = err && typeof err.status === 'number' ? ` (HTTP ${err.status})` : ''
  const message = err && err.message ? err.message : String(err)
  return `GitHub API 错误${status}: ${message}`
}

// ---- 工具 1：get-user -------------------------------------------------------
server.tool(
  'get-user',
  '获取 GitHub 用户的公开资料（GET /users/{username}）。返回登录名、姓名、头像、bio、关注者数、公开仓库数等字段。用于查询任意 GitHub 用户的基本信息，无需认证（受速率限制）。',
  {
    username: z.string().min(1, 'username 不能为空').describe('GitHub 用户名，例如 "octokit"')
  },
  async (args) => {
    if (!args.username || typeof args.username !== 'string' || args.username.trim() === '') {
      return { content: [{ type: 'text', text: '参数错误: username 为必填字符串' }] }
    }
    try {
      const { data } = await octokit.rest.users.getByUsername({ username: args.username.trim() })
      return ok(JSON.stringify(data, null, 2))
    } catch (err) {
      return { content: [{ type: 'text', text: errText(err) }] }
    }
  }
)

// ---- 工具 2：get-repo -------------------------------------------------------
server.tool(
  'get-repo',
  '获取 GitHub 仓库的元数据（GET /repos/{owner}/{repo}）。返回仓库描述、默认分支、star/fork 数、语言、许可证、最近推送时间等。用于查看任意公开仓库的信息，无需认证（受速率限制）。',
  {
    owner: z.string().min(1, 'owner 不能为空').describe('仓库所属用户或组织，例如 "octokit"'),
    repo: z.string().min(1, 'repo 不能为空').describe('仓库名，例如 "rest.js"')
  },
  async (args) => {
    if (!args.owner || typeof args.owner !== 'string' || args.owner.trim() === '') {
      return { content: [{ type: 'text', text: '参数错误: owner 为必填字符串' }] }
    }
    if (!args.repo || typeof args.repo !== 'string' || args.repo.trim() === '') {
      return { content: [{ type: 'text', text: '参数错误: repo 为必填字符串' }] }
    }
    try {
      const { data } = await octokit.rest.repos.get({ owner: args.owner.trim(), repo: args.repo.trim() })
      return ok(JSON.stringify(data, null, 2))
    } catch (err) {
      return { content: [{ type: 'text', text: errText(err) }] }
    }
  }
)

// ---- 工具 3：list-org-repos -------------------------------------------------
server.tool(
  'list-org-repos',
  '列出 GitHub 组织的公开仓库（GET /orgs/{org}/repos）。可筛选仓库类型与排序，返回仓库名、描述、语言、star 数等列表。用于盘点一个组织下有哪些仓库，无需认证（受速率限制）。',
  {
    org: z.string().min(1, 'org 不能为空').describe('组织名，例如 "octokit"'),
    type: z.enum(['all', 'public', 'private', 'forks', 'sources', 'member']).optional()
      .describe('仓库类型筛选，匿名访问时只有 public 可用；默认 all'),
    sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional()
      .describe('排序方式，默认 created'),
    per_page: z.number().int().min(1).max(100).optional()
      .describe('每页条数，1-100，默认 30')
  },
  async (args) => {
    if (!args.org || typeof args.org !== 'string' || args.org.trim() === '') {
      return { content: [{ type: 'text', text: '参数错误: org 为必填字符串' }] }
    }
    try {
      const { data } = await octokit.rest.repos.listForOrg({
        org: args.org.trim(),
        ...(args.type ? { type: args.type } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.per_page ? { per_page: args.per_page } : {})
      })
      const summary = data.map((r) => `- ${r.full_name}  [★${r.stargazers_count}] ${r.language ?? ''} ${r.description ?? ''}`.trimEnd())
      return ok(`组织 ${args.org.trim()} 的仓库（${data.length} 个）:\n${summary.join('\n')}`)
    } catch (err) {
      return { content: [{ type: 'text', text: errText(err) }] }
    }
  }
)

// ---- 工具 4：search-repositories -------------------------------------------
server.tool(
  'search-repositories',
  '按 GitHub 搜索语法搜索公开仓库（GET /search/repositories）。支持 qualifier，例如 "topic:octokit"、"language:javascript"、"stars:>100"。返回仓库全名、描述、star 数、语言、URL 等。无需认证（匿名限速 10 次/分钟）。',
  {
    q: z.string().min(1, 'q 不能为空').describe('搜索查询，支持 GitHub 搜索语法，例如 "octokit language:typescript"'),
    sort: z.enum(['stars', 'forks', 'help-wanted-issues', 'updated']).optional()
      .describe('排序字段，默认按最佳匹配'),
    order: z.enum(['asc', 'desc']).optional().describe('排序方向，默认 desc'),
    per_page: z.number().int().min(1).max(100).optional()
      .describe('每页条数，1-100，默认 30')
  },
  async (args) => {
    if (!args.q || typeof args.q !== 'string' || args.q.trim() === '') {
      return { content: [{ type: 'text', text: '参数错误: q 为必填搜索字符串' }] }
    }
    try {
      const { data } = await octokit.rest.search.repos({
        q: args.q.trim(),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.order ? { order: args.order } : {}),
        ...(args.per_page ? { per_page: args.per_page } : {})
      })
      const summary = data.items.map((r) => `- ${r.full_name}  [★${r.stargazers_count}] ${r.language ?? ''} ${r.description ?? ''}`.trimEnd())
      return ok(`搜索结果（共 ${data.total_count} 个，显示 ${data.items.length} 个）:\n${summary.join('\n')}`)
    } catch (err) {
      return { content: [{ type: 'text', text: errText(err) }] }
    }
  }
)

await server.connect(new StdioServerTransport())
