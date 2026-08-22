# 收录工单(服务型):sms-gateway

服务:https://dysmsapi.aliyuncs.com/
提供方:阿里云短信 / 腾讯云短信 / 通用HTTP网关 — 数据许可:商用API,按云厂商服务条款 — 条款:https://help.aliyun.com/zh/sms/ ; https://cloud.tencent.com/document/product/382
速率限制:依账号配额(阿里云默认约1000条/日)

## 要写的两个文件(户型规范,参照 generated/text-diff/ 与 generated/http-request/)

1. **index.js** — MCP stdio 适配服务器,用内置 fetch 调上述服务(不引第三方 HTTP 客户端)
   - 切 2~4 个能力点:选这个服务最有业务价值、一轮内可完成的操作
   - **网络零件铁律**:
     * 每次请求带超时(AbortSignal.timeout,建议 15s)与明确 User-Agent
       `dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)`——
       Nominatim/SEC 等服务强制要求 UA,缺了会被封
     * 非 2xx、超时、JSON 解析失败一律返回 { isError: true, ... } 且**说明是哪个服务出了什么问题**,绝不抛裸异常
     * 尊重速率限制(依账号配额(阿里云默认约1000条/日));不做并发扇出
     * **传输层韧性(两条)**:① 瞬时抖动(socket 重置/DNS/TLS 打嗝)先原路重试一次
       (约 400ms 退避)——实测网络零件会偶发单次失败、单跑三次全过,不重试就是假红;
       ② 仍失败则显式绕开代理再试一次
       —— 同一机器上不同域名对代理的要求可能相反(实测:www.sec.gov 必须走代理,
       data.sec.gov 走代理会断 TLS)。写法参照 generated/sec-filings/index.js 的
       fetchWithProxyFallback;HTTP 错误码不重试(403 是答复,不是断路)
     * 只读:不调用任何写端点
   - 返回体裁剪成 agent 用得上的字段(别把整个 JSON 倒回上下文)
   - **需要凭证时的零凭证降级(硬规范)**:凭证从**自己进程的环境变量**读(如
     process.env.FEISHU_APP_ID),绝不写进代码、绝不接受工具参数传入。未配置时:
     * listTools 必须照常成功(接口先就位,key 后补——FDE 交付的常态)
     * 调用返回 isError 且**说清缺哪个变量、去哪配**,不崩溃、不静默假装成功
     * 冒烟必须覆盖这条路径:未配凭证时断言"能启动 + listTools 成功 + 调用给出可行动错误"
2. **smoke.mjs** — 冒烟(check() 计数,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具**真实网络调用**并断言内容型结果 → 至少一条错误路径(非法参数或不存在的资源)
   - 断言要抗数据漂移:天气/汇率/行情这类值天天变,断言**结构与量纲**(字段存在、数值在合理区间、单位正确),不断言具体数值
   - **必须把代理环境显式传给零件子进程**:MCP SDK 的 StdioClientTransport 默认只透传
     白名单 env(HOME/PATH/USER…),HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中。
     不传的话零件在代理网络下只报 "fetch failed",看着像零件坏了、其实是网络路径断了。
     写法:构造一个 NETWORK_ENV = { ...process.env },当检测到 HTTPS_PROXY/HTTP_PROXY
     而 NODE_USE_ENV_PROXY 未设时补上 NODE_USE_ENV_PROXY='1',再传给
     new StdioClientTransport({ command, args, env: NETWORK_ENV })。
     参照 generated/geocode/smoke.mjs 顶部的现成写法照抄。
