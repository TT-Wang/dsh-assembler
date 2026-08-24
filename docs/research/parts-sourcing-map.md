# 零件采购地图:开源富矿 × 我们的收编门(2026-08-24)

> 问题:90 件的库是否单薄?开源世界有哪些"零件富矿"?
> 结论:**库不按总数论薄厚,按角色看——变换器/事实源相对充裕,出口/集成与四个
> 能力域是真缺口;而开源侧的矿大到不可能也不应该"进货",正确姿势是矿脉登记 +
> 按需开采,把 gaps 工单从"造件"升级为"三级采购"。**

## 一、矿脉盘点(2026-08 实测数字)

| 矿脉 | 规模 | 与我们的接口 | 开采成本 |
|---|---|---|---|
| **MCP 注册表**(Glama / mcp.so / 官方 registry / Smithery / PulseMCP) | 索引 2 万~3.7 万个 server;PulseMCP 人工审过的 ~1.18 万是质量线 | **同协议零包裹**:mcp-servers 配置直接联邦(filesystem 官方件已在用) | 最低——缺的只是"收编现成 MCP server"的门(嗅探+smoke+锁 rev/条款) |
| **OpenAPI 目录**(APIs.guru) | 3,992 份机器可读 spec / 2,529 个 API / 10.9 万端点 | **from-spec 管道直接吃**(fde 交付已实战) | 低——批量车道现成 |
| **免费 API 清单**(public-apis 等) | 730~800+ 个 / 48 类 | 服务型零件的选题池(我们 19 件服务型全是这么来的) | 低 |
| **agent 集成平台**(Composio) | 1,089 个 toolkit / 2 万+工具(也发 MCP) | 当**需求侧热力图**用:它的类目=市场已验证的集成需求 | 参照系,非直接进货 |
| **工作流集成**(n8n) | 400+ 核心节点 / 1000+ 集成 | 同上:类目当缺口对照表;trigger 设计已借过课 | 参照系 |
| **UI registry**(shadcn 生态) | 数百个社区 registry | registry-add 已通(button POC) | 已通 |

## 二、"覆盖全部能力"是伪目标,胖头覆盖率才是真指标

尾部无限(2 万个 MCP server 长尾全是重复与玩具)。按我们的角色分类对照矿脉类目,
头部缺口如下:

**真缺口(市场类目里高频、我们没有):**
- **出口/集成类**(最薄:n8n 千级 vs 我们 6 件):企微/钉钉消息、Notion/飞书文档
  写入、日历写入(CalDAV/Google)、云存储(S3/OSS/WebDAV/网盘)、支付(Stripe 级)
- **判断器域整块缺失**:TTS/ASR(读书助手静默降级实证过的缺口)、翻译、
  **embedding+向量检索**(RAG 质量升级线、目录规模触发的前置件)
- **事实源补头**:地图路线/POI、A 股行情、快递物流
- **触发器**:cron-trigger(分类法盘出)、邮件触发(IMAP idle)

**不缺(别被总数吓到):**变换器 40 件已覆盖交付实战全部命中;事实源 20 件覆盖
四轮战役所需;这两类共 60 件是"单脸终审",继续堆是虚胖。

## 三、纪律:为什么不进货

1. **目录即检索空间**:每个条目都进装配时的选型视野,垃圾条目污染 BM25 检索
   与价签的信噪比——库的价值密度比件数重要。
2. **每件都有持有成本**:smoke 门、供应链锁、凭证声明、联邦缓存……收一件养一件。
3. **规模触发已有裁定**:>2000 条才上向量混合召回;现在千级批量进货 = 提前把
   检索逼进下一档复杂度,收益却在长尾。
4. **按需收编是实证过的流程**(fde-real-delivery:拿真 API 当客户,现场 from-spec
   收编)。

## 四、落地:三级采购取代"直接造件"

**改 gaps 工单的教义**(具体可做):选型报缺口时,工单第一段从"造零件的入库
命令"升级为三级采购清单——

1. **采**:查 MCP 注册表(PulseMCP/官方 registry 优先,人工审过)有没有现成
   server → 走"收编现成 MCP server"门(见下)
2. **转**:有官方/公开 OpenAPI spec → `index-add.mjs from-spec` 现有管道
3. **造**:都没有 → 现行 scaffold/verify/register 造件管道

**需要新开的一扇门**:`index-add.mjs adopt <npm-mcp-package>`——收编现成 MCP
server:npm 装包锁版本 → 嗅探 listTools → smoke(真调一发可离线验证的工具)→
凭证声明(names only)→ 供应链条款登记 → 入目录。与自造件同一供应链纪律,
省掉的是写胶水的活。

**优先采购清单(按头部缺口 × 矿里有现货排序):**
cron-trigger(造,小件)→ TTS/ASR(采,注册表现货多)→ embedding+向量检索
(采/造,兼做目录规模触发的前置)→ 对象存储 S3 兼容(采)→ 日历写入(采)→
企微/钉钉(采,国内交付刚需)→ 翻译(采)→ Notion/飞书文档写(采)。

## 来源

- [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) 等多份 awesome 清单
- [Best MCP Registries in 2026(TrueFoundry)](https://www.truefoundry.com/blog/best-mcp-registries)、[Best MCP Marketplaces & Registries](https://designrevision.com/blog/best-mcp-marketplaces-and-registries)——Glama ~3.7 万 / mcp.so ~2 万 / Smithery 6 千+ / PulseMCP ~1.18 万(人工审)
- [Composio 平台对比页](https://composio.dev/content/ai-agent-integration-platforms)——1,089 toolkits / 2 万+ 工具(2026-08-11)
- [n8n 集成数考证](https://vps.us/blog/how-many-n8n-integrations/)——400+ 核心节点 / 1000+ 集成
- [APIs.guru metrics](https://api.apis.guru/v2/metrics.json)——3,992 specs / 108,837 端点(实时接口取数)
- [public-apis/public-apis](https://github.com/public-apis/public-apis)——730+ 免费 API / 48 类
