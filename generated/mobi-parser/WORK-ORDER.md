# 收录工单:mobi-parser(@lingo-reader/mobi-parser@0.4.6)

上游:https://github.com/hhk-png/lingo-reader(MIT)
简介:A mobi and kf8 parser
源码副本:.cache/upstream/mobi-parser/(顶层:CONTRIBUTING.md, LICENSE, README-zh.md, README.md, bump.config.ts, docs, eslint.config.mjs, example, images, package.json, packages, pnpm-lock.yaml, pnpm-workspace.yaml, reader-html, rollup.config.mjs, tsconfig.json, vitest.config.ts)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'mobi-parser', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 @lingo-reader/mobi-parser(package.json 已精确锁 0.4.6),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify mobi-parser     # 质检(不过不入库)
   node scripts/index-add.mjs register mobi-parser   # 登记两个目录文件
