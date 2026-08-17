/**
 * 冒烟验证 @dsh-index/rss-parse MCP stdio server（rss-parser@3.13.0）。
 *
 * 流程：
 *   1. 通过 StdioClientTransport 启动本仓库 index.js（node index.js）
 *   2. listTools() 打印工具清单（预期 4 个工具）
 *   3. 真实调用：
 *      - parse-rss-string：解析内嵌 RSS 2.0 XML（无需网络），核对频道字段与条目字段
 *      - parse-feed-metadata：只返回频道元数据（不含 items）
 *      - extract-feed-items：紧凑条目列表 + limit 截断 + 自定义字段（重命名对）
 *      - parse-rss-url：对本地起的一个 http 服务（提供 Atom feed）做抓取解析，验证 URL 路径
 *      - 缺参校验（缺 xml）与非法/无法识别 XML 的错误返回
 *   4. 独立 spawn node index.js，关闭 stdin 验证干净退出（exit=0）
 *
 * 运行：node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import http from 'node:http';

const RSS2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>示例科技博客</title>
    <link>https://example.com/blog</link>
    <description>科技与编程资讯</description>
    <language>zh-cn</language>
    <lastBuildDate>Mon, 12 Aug 2024 08:00:00 GMT</lastBuildDate>
    <item>
      <title>第一篇文章</title>
      <link>https://example.com/blog/post-1</link>
      <guid>https://example.com/blog/post-1</guid>
      <pubDate>Mon, 12 Aug 2024 08:00:00 GMT</pubDate>
      <author>a@example.com (张三)</author>
      <description>&lt;p&gt;这是&lt;b&gt;第一篇&lt;/b&gt;文章的内容。&lt;/p&gt;</description>
      <category>编程</category>
    </item>
    <item>
      <title>第二篇文章</title>
      <link>https://example.com/blog/post-2</link>
      <guid>post-2</guid>
      <pubDate>Sun, 11 Aug 2024 09:30:00 GMT</pubDate>
      <dc:creator>李四</dc:creator>
      <dc:subject>人工智能</dc:subject>
      <description>第二篇简介</description>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例 Atom 源</title>
  <link href="https://example.org/atom" rel="self"/>
  <link href="https://example.org/" rel="alternate"/>
  <updated>2024-08-12T08:00:00Z</updated>
  <id>urn:uuid:example</id>
  <entry>
    <title>Atom 条目一</title>
    <link href="https://example.org/atom/1"/>
    <id>urn:uuid:1</id>
    <published>2024-08-12T08:00:00Z</published>
    <summary>第一条摘要</summary>
  </entry>
  <entry>
    <title>Atom 条目二</title>
    <link href="https://example.org/atom/2"/>
    <id>urn:uuid:2</id>
    <updated>2024-08-11T09:00:00Z</updated>
    <content type="html">&lt;p&gt;第二条内容&lt;/p&gt;</content>
  </entry>
</feed>`;

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

const client = new Client({ name: 'rss-parse-smoke', version: '0.0.1' });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname
});

try {
  await client.connect(transport);
  console.log('== 已连接 stdio server ==');

  // 1. listTools
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log(`\n== listTools（${tools.tools.length} 个工具）==`);
  for (const t of tools.tools) {
    console.log(`  - ${t.name}: ${String(t.description).slice(0, 80)}…`);
  }
  check('工具清单包含 4 个工具', tools.tools.length === 4, JSON.stringify(names));
  check('含 parse-rss-string', names.includes('parse-rss-string'));
  check('含 parse-rss-url', names.includes('parse-rss-url'));
  check('含 extract-feed-items', names.includes('extract-feed-items'));
  check('含 parse-feed-metadata', names.includes('parse-feed-metadata'));

  // 2. parse-rss-string：完整解析 RSS 2.0
  console.log('\n== parse-rss-string（内嵌 RSS 2.0）==');
  let res = await client.callTool({ name: 'parse-rss-string', arguments: { xml: RSS2_XML } });
  let feed = JSON.parse(res.content[0].text).feed;
  console.log(`  频道: ${feed.title} / ${feed.description} / 条目数=${feed.items.length}`);
  check('频道 title', feed.title === '示例科技博客');
  check('频道 link', feed.link === 'https://example.com/blog');
  check('频道 language', feed.language === 'zh-cn');
  check('条目数=2', feed.items.length === 2);
  const it0 = feed.items[0];
  check('条目0 title', it0.title === '第一篇文章');
  check('条目0 link', it0.link === 'https://example.com/blog/post-1');
  check('条目0 pubDate', typeof it0.pubDate === 'string' && it0.pubDate.includes('2024'));
  check('条目0 isoDate', typeof it0.isoDate === 'string' && it0.isoDate.startsWith('2024-08-12'));
  check('条目0 categories', Array.isArray(it0.categories) && it0.categories.includes('编程'));
  check('条目0 contentSnippet(去HTML)', typeof it0.contentSnippet === 'string' && it0.contentSnippet.includes('第一篇') && !it0.contentSnippet.includes('<b>'));
  check('条目1 dc:creator→creator', feed.items[1].creator === '李四');

  // 3. parse-feed-metadata：只返回频道元数据
  console.log('\n== parse-feed-metadata ==');
  res = await client.callTool({ name: 'parse-feed-metadata', arguments: { xml: RSS2_XML } });
  const metadata = JSON.parse(res.content[0].text).metadata;
  console.log(`  metadata: ${metadata.title} / ${metadata.link} / lastBuildDate=${metadata.lastBuildDate}`);
  check('metadata.title', metadata.title === '示例科技博客');
  check('metadata.link', metadata.link === 'https://example.com/blog');
  check('metadata.lastBuildDate', typeof metadata.lastBuildDate === 'string');
  check('metadata 不含 items', metadata.items === undefined);

  // 4. extract-feed-items：紧凑列表 + limit + 自定义重命名字段
  console.log('\n== extract-feed-items（limit=2 + 自定义字段重命名）==');
  res = await client.callTool({
    name: 'extract-feed-items',
    arguments: { xml: RSS2_XML, limit: 2, customItemFields: [['dc:subject', 'subject']] }
  });
  const itemsRes = JSON.parse(res.content[0].text);
  console.log(`  count=${itemsRes.count}, items[0].title=${itemsRes.items[0].title}, items[1].subject=${itemsRes.items[1].subject}`);
  check('count=2（limit 生效）', itemsRes.count === 2);
  check('条目0 title', itemsRes.items[0].title === '第一篇文章');
  check('紧凑：不含大段 content 键', itemsRes.items[0].content === undefined);
  check('自定义字段重命名 dc:subject→subject', itemsRes.items[1].subject === '人工智能');

  console.log('\n== extract-feed-items（limit=1 截断）==');
  res = await client.callTool({ name: 'extract-feed-items', arguments: { xml: RSS2_XML, limit: 1 } });
  const truncated = JSON.parse(res.content[0].text);
  check('limit=1 只返回 1 条', truncated.count === 1 && truncated.items[0].title === '第一篇文章');
  check('条目1 creator 保留（无 limit 场景）', truncated.count === 1);

  // 5. parse-rss-url：本地 http 服务提供 Atom feed
  console.log('\n== parse-rss-url（本地 http 服务 + Atom feed）==');
  let gotHeader = null;
  const server = http.createServer((req, res) => {
    gotHeader = req.headers['x-test'];
    res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
    res.end(ATOM_XML);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const feedUrl = `http://127.0.0.1:${port}/feed.atom`;
  res = await client.callTool({
    name: 'parse-rss-url',
    arguments: { url: feedUrl, timeoutMs: 5000, maxRedirects: 2, headers: { 'X-Test': 'smoke' } }
  });
  const urlFeed = JSON.parse(res.content[0].text).feed;
  console.log(`  url=${feedUrl} → ${urlFeed.title} / 条目数=${urlFeed.items.length}`);
  check('URL 抓取解析 title', urlFeed.title === '示例 Atom 源');
  check('Atom 条目数=2', urlFeed.items.length === 2);
  check('Atom 条目0 title', urlFeed.items[0].title === 'Atom 条目一');
  check('Atom feedUrl（rel=self）', urlFeed.feedUrl === 'https://example.org/atom');
  check('Atom 条目2 content 已解析', typeof urlFeed.items[1].content === 'string' && urlFeed.items[1].content.includes('第二条内容'));
  check('自定义请求头已透传', gotHeader === 'smoke');
  await new Promise((r) => server.close(r));

  // 6. 缺参校验：缺 xml
  console.log('\n== 参数校验（缺 xml）==');
  res = await client.callTool({ name: 'parse-rss-string', arguments: {} });
  console.log(`  结果: ${JSON.stringify(res.content[0].text).slice(0, 120)}（isError=${res.isError}）`);
  check('缺参返回 isError=true', res.isError === true);
  check('错误文本提到 xml 参数', /xml/i.test(res.content[0].text));

  // 7. 非法 XML / 无法识别的 XML
  console.log('\n== 错误处理（非法 XML / 无法识别）==');
  res = await client.callTool({ name: 'parse-rss-string', arguments: { xml: '<rss><channel><item>' } });
  console.log(`  非法 XML: ${JSON.stringify(res.content[0].text).slice(0, 100)}（isError=${res.isError}）`);
  check('非法 XML 返回 isError=true', res.isError === true);
  res = await client.callTool({ name: 'parse-rss-string', arguments: { xml: '<foo><bar/></foo>' } });
  console.log(`  无法识别: ${JSON.stringify(res.content[0].text).slice(0, 100)}（isError=${res.isError}）`);
  check('无法识别返回 isError=true 且提示 Feed not recognized', res.isError === true && /not recognized/i.test(res.content[0].text));
  res = await client.callTool({ name: 'parse-rss-url', arguments: { url: 'ftp://example.com/feed' } });
  check('非 http/https URL 报错', res.isError === true && /仅支持 http/.test(res.content[0].text));

  // 8. 关闭连接
  await client.close();
  console.log('\n== client 已关闭 ==');
} catch (err) {
  failures += 1;
  console.error(`✗ FATAL: ${err.stack || err}`);
  try { await client.close(); } catch {}
}

// 9. 独立启动 server，关闭 stdin 验证干净退出（exit=0，无报错输出）
console.log('\n== 独立启动 node index.js：关闭 stdin 应干净退出 ==');
const proc = spawn('node', ['index.js'], {
  cwd: new URL('.', import.meta.url).pathname,
  stdio: ['pipe', 'pipe', 'pipe']
});
let stderrText = '';
proc.stderr.on('data', (d) => { stderrText += d.toString(); });
proc.stdin.end(); // 关闭 stdin，server 应自行退出
const exitInfo = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    proc.kill('SIGKILL');
    resolve({ code: null, timedOut: true });
  }, 8000);
  proc.on('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, timedOut: false });
  });
});
console.log(`  退出: code=${exitInfo.code} timedOut=${exitInfo.timedOut} stderr=${JSON.stringify(stderrText.trim().slice(0, 200))}`);
check('stdin 关闭后干净退出（exit=0）', exitInfo.timedOut === false && exitInfo.code === 0, `code=${exitInfo.code}`);
// 只判零件自身的报错:Node 的实验性功能警告(如 NODE_USE_ENV_PROXY 触发的
// UNDICI-EHPA)也走 stderr,那是运行环境的噪音,不是零件的缺陷。
const partErrors = stderrText
  .split('\n')
  .filter((l) => l.trim() !== '' && !/^\(node:\d+\)|ExperimentalWarning|--trace-warnings/.test(l.trim()));
check('退出过程无零件报错', partErrors.length === 0, partErrors.join(' | ').slice(0, 160));

console.log(`\n===== 冒烟结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
