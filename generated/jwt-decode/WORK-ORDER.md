# 收录工单:jwt-decode(jose@6.2.9)

上游:https://github.com/panva/jose(MIT)
简介:JWA, JWS, JWE, JWT, JWK, JWKS for Node.js, Browser, Cloudflare Workers, Deno, Bun, and other Web-interoperable runtimes
源码副本:.cache/upstream/jwt-decode/(顶层:CHANGELOG.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, LICENSE.md, README.md, SECURITY.md, ava.config.mjs, cookbook, docs, jsr.json, package-lock.json, package.json, patches, playwright.config.ts, sponsor, src, tap, test, test-d, tools, tsconfig, tsconfig.json, typedoc.json)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'jwt-decode', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 jose(package.json 已精确锁 6.2.9),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify jwt-decode     # 质检(不过不入库)
   node scripts/index-add.mjs register jwt-decode   # 登记两个目录文件
