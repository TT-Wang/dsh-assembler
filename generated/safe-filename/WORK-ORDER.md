# 收录工单:safe-filename(filenamify@7.0.2)

上游:https://github.com/sindresorhus/filenamify(MIT)
简介:Convert a string to a valid safe filename
源码副本:.cache/upstream/safe-filename/(顶层:filenamify-path.d.ts, filenamify-path.js, filenamify.d.ts, filenamify.js, index.d.ts, index.js, license, package.json, readme.md, test.js)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'safe-filename', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 filenamify(package.json 已精确锁 7.0.2),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify safe-filename     # 质检(不过不入库)
   node scripts/index-add.mjs register safe-filename   # 登记两个目录文件
