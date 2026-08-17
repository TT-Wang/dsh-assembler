# 收录工单:ip-utils(ipaddr.js@2.5.0)

上游:https://github.com/whitequark/ipaddr.js(MIT)
简介:A library for manipulating IPv4 and IPv6 addresses in JavaScript.
源码副本:.cache/upstream/ip-utils/(顶层:Changes.md, LICENSE, README.md, eslint.config.mjs, lib, package.json, test)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'ip-utils', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 ipaddr.js(package.json 已精确锁 2.5.0),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify ip-utils     # 质检(不过不入库)
   node scripts/index-add.mjs register ip-utils   # 登记两个目录文件
