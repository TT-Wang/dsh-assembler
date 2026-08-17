# 收录工单(服务型):scholar-search

服务:https://api.crossref.org
提供方:Crossref + arXiv — 数据许可:CC0-1.0 / arXiv terms — 条款:https://www.crossref.org/documentation/retrieve-metadata/rest-api/
速率限制:polite pool:带 UA 与联系方式

## 要写的两个文件(户型规范,参照 generated/text-diff/ 与 generated/http-request/)

1. **index.js** — MCP stdio 适配服务器,用内置 fetch 调上述服务(不引第三方 HTTP 客户端)
   - 切 2~4 个能力点:选这个服务最有业务价值、一轮内可完成的操作
   - **网络零件铁律**:
     * 每次请求带超时(AbortSignal.timeout,建议 15s)与明确 User-Agent
       `dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)`——
       Nominatim/SEC 等服务强制要求 UA,缺了会被封
     * 非 2xx、超时、JSON 解析失败一律返回 { isError: true, ... } 且**说明是哪个服务出了什么问题**,绝不抛裸异常
     * 尊重速率限制(polite pool:带 UA 与联系方式);不做并发扇出
     * 只读:不调用任何写端点
   - 返回体裁剪成 agent 用得上的字段(别把整个 JSON 倒回上下文)
2. **smoke.mjs** — 冒烟(check() 计数,最后 process.exit(failures))
   - listTools 数量断言 → 每个工具**真实网络调用**并断言内容型结果 → 至少一条错误路径(非法参数或不存在的资源)
   - 断言要抗数据漂移:天气/汇率/行情这类值天天变,断言**结构与量纲**(字段存在、数值在合理区间、单位正确),不断言具体数值
