# 收录工单:math-eval(mathjs@15.2.0)

上游:https://github.com/josdejong/mathjs(Apache-2.0)
简介:Math.js is an extensive math library for JavaScript and Node.js. It features a flexible expression parser with support for symbolic computation, comes with a large set of built-in functions and constants, and offers an integrated solution to work with dif
源码副本:.cache/upstream/math-eval/(顶层:AUTHORS, CODE_OF_CONDUCT.md, CONTRIBUTING.md, HISTORY.md, LICENSE, NOTICE, README.md, SECURITY.md, bin, docs, examples, gulpfile.js, hyperexecute.yaml, misc, package-lock.json, package.json, src, tea.yaml, test, tools, tsconfig.json, types)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'math-eval', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 mathjs(package.json 已精确锁 15.2.0),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify math-eval     # 质检(不过不入库)
   node scripts/index-add.mjs register math-eval   # 登记两个目录文件
