# 收录工单:num-to-chinese(nzh@1.0.14)

上游:https://github.com/cnwhy/nzh(BSD-2-Clause)
简介:数字转中文,大写,金额
源码副本:.cache/upstream/num-to-chinese/(顶层:README.md, bower.json, cn.js, demo, dist, docs, gulpfile.js, hk.js, index.html, lib, nzh.d.ts, nzh.js, package.json, src, test)

## 要写的两个文件(户型规范,参照 generated/binary-write/)

1. **index.js** — MCP stdio 适配服务器
   - McpServer({ name: 'num-to-chinese', version: '0.0.1' }) + StdioServerTransport
   - 切 2~4 个"工具级能力点":选这个库最常用、一轮对话内可完成的操作
   - registerTool:inputSchema 用 zod;description 中文、说清输入输出与边界
   - 错误路径返回 { isError: true, content: [{type:'text', text: ...}] },不抛裸异常
   - 只 import 锁定版本的 nzh(package.json 已精确锁 1.0.14),不访问网络除非能力本身是网络
2. **smoke.mjs** — 冒烟(check() 计数模式,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具至少一次**真实调用**并断言内容结果 → 至少一条错误路径被拒

## 完成后
   node scripts/index-add.mjs verify num-to-chinese     # 质检(不过不入库)
   node scripts/index-add.mjs register num-to-chinese   # 登记两个目录文件
