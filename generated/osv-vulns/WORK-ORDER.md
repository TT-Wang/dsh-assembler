# 收录工单(客户接口):osv-vulns

来源 spec:https://osv.dev/docs/osv_service_v1.swagger.json
接口标题:OSV 1.0
Base URL:https://api.osv.dev
客户:northwind(零件写入 catalogs/northwind/,与公共目录隔离)

## 端点清单(共 4 个,已按 tag 归组)

### OSV(4 个端点)
  - POST /v1/query +body — Query vulnerabilities for a particular project at a given commit or version.
  - POST /v1/querybatch +body — Query vulnerabilities (batched) for given package versions and commits. This currently allows a maximum of 1000 package 
  - GET /v1/vulns/{id} [id*(path)] — Return a `Vulnerability` object for a given OSV ID.
  - POST /v1experimental/determineversion +body — Determine the version of the provided hash values.

## 要写的两个文件

1. **index.js** — MCP stdio 适配服务器(照抄 generated/geocode/index.js 的户型)
   - **从上面清单里挑 2~5 个最有业务价值的端点**做成工具:一个工具 = 一个 agent 说得清楚的完整动作,不要把端点一对一翻译成工具
   - 用内置 fetch;超时 AbortSignal.timeout(15000);明确 User-Agent;返回体裁剪
   - 非 2xx / 超时 / 解析失败一律 { isError: true, ... } 并说清是哪个接口什么问题
   - 传输层失败重试一次并绕开代理(参照 generated/sec-filings/index.js 的 fetchWithProxyFallback)
   - **凭证从自己进程的环境变量读**,绝不写进代码、绝不当工具参数;未配时 listTools 照常成功、调用给出可行动错误
   - **写操作**(POST/PUT/DELETE)的 description 必须以【写操作,会真实修改客户系统】开头
2. **smoke.mjs** — 冒烟(check() 计数,process.exit(failures))
   - listTools 断言 + 每个工具真实调用(或零凭证降级路径)+ 错误路径
   - 用 NETWORK_ENV 写法把代理环境传给子进程(见 generated/geocode/smoke.mjs)
   - 断言结构与量纲,不断言易变的具体值
