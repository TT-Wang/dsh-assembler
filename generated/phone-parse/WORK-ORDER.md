# 收录工单:phone-parse(libphonenumber-js@1.13.11)

上游:https://github.com/catamphetamine/libphonenumber-js(MIT)
简介:A simpler (and smaller) rewrite of Google Android's libphonenumber library in javascript
源码副本:.cache/upstream/phone-parse/(顶层:AUTHORS, CHANGELOG.md, CODE_OF_CONDUCT.md, LICENSE, LICENSE.Apache, METADATA.md, PhoneNumberMetadata.xml, README.md, autoupdate.cmd, autoupdate.sh, build-scripts, core, custom.d.ts, custom.js, examples.mobile.json, examples.mobile.json.d.ts, index.cjs, index.cjs.js, index.d.ts, index.es6.exports, index.es6.js, index.js, jest.config.json, max, metadata.full.json.d.ts, metadata.max.json.d.ts, metadata.min.json.d.ts, metadata.mobile.json.d.ts, min, mobile, package-lock.json, package.json, project.sublime-project, rollup.config.mjs, source, test, types.d.ts, website)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'phone-parse', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 libphonenumber-js(package.json 已精确锁 1.13.11),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify phone-parse     # 质检(不过不入库)
   node scripts/index-add.mjs register phone-parse   # 登记两个目录文件
