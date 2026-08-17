#!/usr/bin/env node
/**
 * 冒烟:listTools → search-apis(真实搜索 + 裁剪与上限)→ get-api-info(真实提供方 + 结构化未找到)
 * → list-providers(真实名单 + filter 生效)→ 错误路径(本地拦截,不发请求)。
 *
 * 断言只压"结构 + 量纲 + 语义",不压具体值:APIs.guru 的收录数天天涨(实测 2026-08-17
 * 是 2529 个 API / 677 个提供方),某个接口的版本号、更新时间、描述也会变。
 * 所以数量一律用**下界**断言(">= 2000"),绝不写 "=== 2529"。
 *
 * 注:第一次 search-apis 要下载约 8.8MB 的全量目录,慢是预期的;
 * 第二次应命中进程内缓存(cacheHit=true),这条也顺带断言了。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中——不传的话零件在代理网络下
// 只会报 "fetch failed",看起来像零件坏了,其实是网络路径断了。
const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) {
    e.NODE_USE_ENV_PROXY = '1';
  }
  return e;
})();


let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
const skip = (label, why) => console.log(`  ↷ SKIP ${label} — ${why}`);
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
const isUrl = (s) => typeof s === 'string' && /^https:\/\//.test(s);

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

// ---- listTools --------------------------------------------------------------
// 凭证是可选的(APIs.guru 匿名可用),但无论配没配,listTools 都必须成功。
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort().join(',');
check('listTools 返回 3 个工具', tools.tools.length === 3, names);
check('工具名与预期一致', names === 'get-api-info,list-providers,search-apis', names);
check('每个工具都有非空 description', tools.tools.every((t) => typeof t.description === 'string' && t.description.length > 20));
check(`listTools 在 APISGURU_TOKEN ${process.env.APISGURU_TOKEN ? '已配置' : '未配置'} 时照常成功`, tools.tools.length > 0);

// ---- search-apis ------------------------------------------------------------
console.log('  (首次搜索需下载约 8.8MB 全量目录,慢属预期)');
const r1 = await call('search-apis', { query: 'github', limit: 5 });
const s1 = json(r1);
check('search-apis 返回可解析 JSON 且非错误', s1 !== null && r1.isError !== true, text(r1).slice(0, 120));
check('query 回显为 github', s1?.query === 'github', String(s1?.query));
check('results 是数组且不超过 limit=5', Array.isArray(s1?.results) && s1.results.length <= 5, String(s1?.results?.length));
check('count 与 results 长度自洽', s1?.count === s1?.results?.length, `${s1?.count} vs ${s1?.results?.length}`);
check('totalMatched >= 返回条数(告知被截断了多少)', typeof s1?.totalMatched === 'number' && s1.totalMatched >= (s1?.results?.length ?? 0), String(s1?.totalMatched));
check('目录规模 >= 2000(下界断言,收录数只涨不跌)', typeof s1?.directorySize === 'number' && s1.directorySize >= 2000, String(s1?.directorySize));

const hit = s1?.results?.[0];
check('命中条目带 name(目录唯一键)', typeof hit?.name === 'string' && hit.name.length > 0, String(hit?.name));
check('命中条目带 title', typeof hit?.title === 'string' && hit.title.length > 0, String(hit?.title));
check('命中条目带可下载的 swaggerUrl', isUrl(hit?.swaggerUrl), String(hit?.swaggerUrl).slice(0, 70));
check('命中条目带 version', hit?.version !== undefined && hit.version !== null, String(hit?.version));
check('categories 是数组', Array.isArray(hit?.categories), JSON.stringify(hit?.categories));
check('关键词确实出现在命中条目里(name/title/provider 之一)', /github/i.test(`${hit?.name} ${hit?.title} ${hit?.provider}`), `${hit?.name} | ${hit?.title}`);
check('description 已截断到 <=250 字符(不整包透传)', (s1?.results ?? []).every((x) => x.description === undefined || x.description.length <= 250), String(hit?.description?.length));
check('裁剪掉了 x-logo / x-origin 等重字段', (s1?.results ?? []).every((x) => !('x-logo' in x) && !('info' in x) && !('versions' in x)), Object.keys(hit ?? {}).join(','));

// 第二次搜索应命中进程内缓存(否则每次搜索都要重下 8.8MB)。
const r2 = await call('search-apis', { query: 'weather', limit: 3 });
const s2 = json(r2);
check('第二次搜索命中全量目录缓存', s2?.cacheHit === true, `cacheHit=${s2?.cacheHit}`);
check('不同关键词得到不同结果集', Array.isArray(s2?.results) && s2.results.length >= 1 && s2.results[0]?.name !== hit?.name, `${s2?.results?.[0]?.name}`);
check('limit=3 生效', (s2?.results?.length ?? 0) <= 3, String(s2?.results?.length));

// 搜不到 → 结构化空结果,不是错误。
const r3 = await call('search-apis', { query: 'zzzqqqxxxnotanapi12345' });
const s3 = json(r3);
check('搜不到:totalMatched=0 且不是 isError', s3?.totalMatched === 0 && r3.isError !== true, `isError=${r3.isError}`);
check('搜不到:results 为空数组并给出 hint', Array.isArray(s3?.results) && s3.results.length === 0 && typeof s3?.hint === 'string');

// ---- get-api-info -----------------------------------------------------------
// provider 不硬编码猜测:用上面搜索结果里真实存在的 provider。
const provider = hit?.provider ?? 'github.com';
const r4 = await call('get-api-info', { provider });
const g1 = json(r4);
check(`get-api-info(${provider}) 命中且非错误`, g1?.found === true && r4.isError !== true, text(r4).slice(0, 100));
check('provider 回显正确', g1?.provider === provider, String(g1?.provider));
check('totalApis 是正整数', Number.isInteger(g1?.totalApis) && g1.totalApis >= 1, String(g1?.totalApis));
check('apis 是数组且不超过默认 limit=25', Array.isArray(g1?.apis) && g1.apis.length <= 25, String(g1?.apis?.length));
check('count 与 apis 长度自洽', g1?.count === g1?.apis?.length, `${g1?.count}`);
const a1 = g1?.apis?.[0];
check('接口条目带 title 与 swaggerUrl', typeof a1?.title === 'string' && isUrl(a1?.swaggerUrl), `${a1?.title}`);
check('接口条目带 openapiVer', typeof a1?.openapiVer === 'string' && a1.openapiVer.length > 0, String(a1?.openapiVer));
// {provider}.json 是已拍平的形状:不该冒出 versions/preferred(拿 list.json 的解析器读它会炸)。
check('已按拍平形状解析(无 versions/preferred 残留)', (g1?.apis ?? []).every((x) => !('versions' in x) && !('preferred' in x)), Object.keys(a1 ?? {}).join(','));

// 指定 api:用上一步真实返回的键名,不硬编码。
if (typeof a1?.name === 'string') {
  const r5 = await call('get-api-info', { provider, api: a1.name });
  const g2 = json(r5);
  check('按 api 全键精确定位:命中 1 条', g2?.found === true && g2?.count === 1, `${g2?.count}`);
  check('定位到的正是该键', g2?.apis?.[0]?.name === a1.name, String(g2?.apis?.[0]?.name));
} else {
  skip('按 api 精确定位断言', '上一步没拿到可用的 api 键名');
}

// 不存在的 provider → 结构化未找到(404 的响应体是 HTML,这里同时验证了"先看状态码再解析")。
const r6 = await call('get-api-info', { provider: 'no-such-provider-xyz.example' });
const g3 = json(r6);
check('不存在的 provider:found=false 且不是 isError', g3?.found === false && r6.isError !== true, `isError=${r6.isError}`);
check('不存在的 provider:未误报成 JSON 解析失败', !/不是合法 JSON/.test(text(r6)), text(r6).slice(0, 80));
check('不存在的 provider:给出 hint', typeof g3?.hint === 'string' && g3.hint.length > 0);

// 存在的 provider + 不存在的 api → 结构化未找到,并列出可选项。
const r7 = await call('get-api-info', { provider, api: 'definitely-no-such-api-xyz' });
const g4 = json(r7);
check('provider 存在但 api 不存在:found=false 且不是 isError', g4?.found === false && r7.isError !== true, `isError=${r7.isError}`);
check('并列出 availableApis 供纠正', Array.isArray(g4?.availableApis) && g4.availableApis.length >= 1, String(g4?.availableApis?.length));

// ---- list-providers ---------------------------------------------------------
const r8 = await call('list-providers', { limit: 10 });
const p1 = json(r8);
check('list-providers 返回可解析 JSON 且非错误', p1 !== null && r8.isError !== true, text(r8).slice(0, 100));
check('totalProviders >= 500(下界断言,收录数只涨不跌)', typeof p1?.totalProviders === 'number' && p1.totalProviders >= 500, String(p1?.totalProviders));
check('providers 是数组且不超过 limit=10', Array.isArray(p1?.providers) && p1.providers.length <= 10, String(p1?.providers?.length));
check('每个提供方都是非空字符串', (p1?.providers ?? []).every((x) => typeof x === 'string' && x.length > 0), (p1?.providers ?? []).slice(0, 3).join(','));
check('被截断时 truncated=true', p1?.truncated === true && p1?.matched > p1?.providers?.length, `${p1?.matched} > ${p1?.providers?.length}`);

const r9 = await call('list-providers', { filter: 'google' });
const p2 = json(r9);
check('filter=google 命中 >=1 个提供方', (p2?.matched ?? 0) >= 1, String(p2?.matched));
check('filter 结果全部包含该子串', (p2?.providers ?? []).length > 0 && (p2?.providers ?? []).every((x) => x.toLowerCase().includes('google')), (p2?.providers ?? []).slice(0, 3).join(','));
check('filter 后 matched <= totalProviders', p2?.matched <= p2?.totalProviders, `${p2?.matched} <= ${p2?.totalProviders}`);

const r10 = await call('list-providers', { filter: 'zzzqqqxxxnoprovider' });
const p3 = json(r10);
check('filter 无命中:matched=0 且不是 isError', p3?.matched === 0 && r10.isError !== true, `isError=${r10.isError}`);

// ---- 错误路径(本地拦截,不发请求)------------------------------------------
const e1 = await call('search-apis', { query: '   ' });
check('空 query 被拒(isError)', e1.isError === true && text(e1).includes('query'), text(e1).slice(0, 80));

const e2 = await call('search-apis', { query: 'github', limit: 999 });
check('limit=999 被拒(isError)', e2.isError === true && text(e2).includes('limit'), text(e2).slice(0, 80));

const e3 = await call('get-api-info', { provider: '' });
check('空 provider 被拒(isError)', e3.isError === true && text(e3).includes('provider'), text(e3).slice(0, 80));

const e4 = await call('get-api-info', { provider: '../../etc/passwd' });
check('provider 含路径分隔符被拒(isError,不拼进 URL)', e4.isError === true && text(e4).includes('provider'), text(e4).slice(0, 80));

const e5 = await call('list-providers', { limit: 0 });
check('limit=0 被拒(isError)', e5.isError === true && text(e5).includes('limit'), text(e5).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
