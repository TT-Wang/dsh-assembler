/**
 * spec 进料单元测试:客户给的是他手上那份 spec,不是我们偏好的那份。
 *
 * 两条不变量,都是真实客户 spec(OSV.dev 是 swagger 2.0)暴露出来的:
 *   1. base URL 两种方言都要读出来——OpenAPI 3 的 servers[].url,
 *      swagger 2.0 的 schemes + host + basePath(省略 schemes 即 https)。
 *   2. 要 body 的端点必须被标成要 body——OpenAPI 3 在 requestBody,
 *      swagger 2.0 在 parameters 里 in: 'body'。漏判会让工单写"无 body",
 *      照着造出来的零件根本发不出请求。
 */
import { specBaseUrl, inventoryEndpoints } from './scripts/spec-intake.mjs'

let failed = 0
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
  if (!cond) failed++
}
const eq = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${good ? '✓' : '✗'} ${name}${good ? '' : `  期望 ${JSON.stringify(expected)},实得 ${JSON.stringify(actual)}`}`)
  if (!good) failed++
}

// ── base URL ───────────────────────────────────────────────────────────────
eq('OpenAPI 3:取 servers[0].url',
  specBaseUrl({ servers: [{ url: 'https://api.example.com/v2' }, { url: 'https://staging' }] }),
  'https://api.example.com/v2')

eq('swagger 2.0:host + basePath 拼出来(OSV 的真实形状:只有 host)',
  specBaseUrl({ swagger: '2.0', host: 'api.osv.dev' }),
  'https://api.osv.dev')

eq('swagger 2.0:带 basePath',
  specBaseUrl({ swagger: '2.0', host: 'api.example.com', basePath: '/v1' }),
  'https://api.example.com/v1')

eq('swagger 2.0:basePath 尾斜杠不重复',
  specBaseUrl({ swagger: '2.0', host: 'h', basePath: '/v1/' }),
  'https://h/v1')

eq('swagger 2.0:省略 schemes 默认 https',
  specBaseUrl({ swagger: '2.0', host: 'h' }),
  'https://h')

eq('swagger 2.0:schemes 含 https 时优先 https(不取数组首位 http)',
  specBaseUrl({ swagger: '2.0', schemes: ['http', 'https'], host: 'h' }),
  'https://h')

eq('swagger 2.0:只有 http 就如实用 http(不假装升级)',
  specBaseUrl({ swagger: '2.0', schemes: ['http'], host: 'h' }),
  'http://h')

eq('servers 优先于 swagger2 字段(混写的 spec 以 3 为准)',
  specBaseUrl({ servers: [{ url: 'https://three' }], host: 'two' }),
  'https://three')

ok('两种方言都没说 → undefined(由调用方标"需手工确认",不猜)',
  specBaseUrl({ paths: {} }) === undefined)
ok('host 为空串不当成有效 host',
  specBaseUrl({ host: '' }) === undefined)
ok('servers 存在但 url 全为空 → 回落到 host',
  specBaseUrl({ servers: [{}], host: 'h' }) === 'https://h')

// ── hasBody ────────────────────────────────────────────────────────────────
// OSV.dev 的真实端点形状:swagger 2.0,body 在 parameters 里。
const osvLike = {
  swagger: '2.0',
  host: 'api.osv.dev',
  paths: {
    '/v1/query': {
      post: {
        tags: ['OSV'],
        summary: 'Query vulnerabilities for a particular project at a given commit or version.',
        parameters: [{ name: 'body', in: 'body', required: true, schema: {} }],
      },
    },
    '/v1/vulns/{id}': {
      get: { tags: ['OSV'], parameters: [{ name: 'id', in: 'path', required: true }] },
    },
  },
}
const osvGroups = inventoryEndpoints(osvLike)
const osvOps = osvGroups.get('OSV')
eq('OSV 形状:归到 tag OSV,两个端点', [osvGroups.size, osvOps.length], [1, 2])
ok('swagger2 的 in:body 被判为 hasBody', osvOps.find((e) => e.path === '/v1/query').hasBody === true)
eq('body 参数不混进 params 列表(它不是 query/path 旋钮)',
  osvOps.find((e) => e.path === '/v1/query').params, [])
ok('GET 无 body', osvOps.find((e) => e.path === '/v1/vulns/{id}').hasBody === false)
eq('path 参数照常列出并标必需',
  osvOps.find((e) => e.path === '/v1/vulns/{id}').params, ['id*(path)'])

const oa3 = {
  openapi: '3.0.0',
  paths: { '/things': { post: { requestBody: { content: {} }, parameters: [{ name: 'q', in: 'query' }] } } },
}
const oa3op = inventoryEndpoints(oa3).get('default')[0]
ok('OpenAPI 3 的 requestBody 仍被判为 hasBody', oa3op.hasBody === true)
eq('无 tags 归到 default', [...inventoryEndpoints(oa3).keys()], ['default'])
eq('query 参数保留', oa3op.params, ['q(query)'])

// path-level parameters must merge with operation-level ones
const shared = {
  paths: {
    '/x/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { parameters: [{ name: 'verbose', in: 'query' }] },
    },
  },
}
eq('path 级与 operation 级参数合并',
  inventoryEndpoints(shared).get('default')[0].params, ['id*(path)', 'verbose(query)'])

ok('paths 缺失时安全返回空组', inventoryEndpoints({}).size === 0)

console.log(`\n==== spec 进料单元测试: ${failed === 0 ? '全部通过 ✅' : `${failed} 条失败 ❌`} ====`)
process.exit(failed === 0 ? 0 : 1)
