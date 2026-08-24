# 零件库分类法:流角色 × 脸(2026-08-24 全量盘点)

> 前提公理:**泛化 agent 的 verified assembly,形态是装配出来的结果,不是入口处的
> 分类。** 要让形态可推导,装配器必须知道每个零件:①在流里扮演什么角色;②现在
> 有几张脸、应该有几张脸;③直连的价格。本文档 = 方法论 + 90 件全量归类 + 双面化
> 优先级 + 盘出的缺口。

## 一、方法论

### 脸(mounting surface):能力被谁调用

| 脸 | 调用方 | 载体 | 现状 |
|---|---|---|---|
| **模型脸** | 会话循环里的 agent | MCP 工具 | 90/90 全有(零件本性) |
| **服务脸** | 页面 / 机器 / 别的进程,**不经模型** | 127.0.0.1 HTTP(serviceAnnounce) | 1.5/90(book-intake;webhook-intake 天生) |
| **app 镜像** | 独立 app 内部 | 纪律同源的薄壳模块(如 ai.mjs) | 1(ai-call) |
| **人脸** | 眼睛 | 前端模板 | 8 张 |
| **图纸** | emit_app | 配方 | 1 张 |

### 三问判据(每个零件、每个新入库件都过一遍)

- **Q1** 页面或机器有没有**不经模型**调它的动机?
  没有 → 模型脸单脸,**终审,不再议**。服务脸不是荣誉,是端口+安全面+考官的
  持续成本,只配给有真实直连动机的角色。
- **Q2** 有动机,数据是大字节吗?
  是 → 走**公共文件通道**(book-intake 泛化),不自长脸。字节口的解析/生成件
  本来就是"路径进路径出",字节从不过模型;页面缺的只是"把文件放进工作区/取
  出来"这一段,一张公共通道脸治全体。
- **Q3** 它持有交付体的**状态**(账)吗?
  持有 → 服务脸最高优先。状态锚的服务脸是双面交付(app 面+会话面共一本账)的
  物理基础。

### 流角色(8 类)

角色回答"这个零件在流谱里是哪一段",与脸的应然一一对应:

| 角色 | 定义 | 脸的应然 |
|---|---|---|
| 状态锚 | 持有交付体的账 | 模型脸 + **服务脸(必须)** |
| 字节口 | 大字节进出(解析/生成文件) | 模型脸(路径式)+ **共享公共文件通道** |
| 事实源 | 取外部世界的真相 | 模型脸单脸(app 要事实自己 fetch) |
| 变换器 | 纯函数(格式/文本/计算) | 模型脸单脸(app 要变换自己内嵌,如 rag-qa 内嵌 BM25) |
| 判断器 | AI 能力本身 | 模型脸 + **app 镜像**(成对维护) |
| 触发器 | 机器发起的入口 | **机器脸天生**;缺触发面考官 |
| 出口 | 对世界做动作(发信/发消息/开单) | 模型脸为主(判断后行动);无人值守直连缓议 |
| 工装/装备 | 装配期工具、人格、示例 | 不参与流角色 |

## 二、90 件全量归类

### 采购批新增(2026-08-25,7 件;脸按三问判据定,不按"有就好")

| 件 | 角色 | 脸 | 判据 |
|---|---|---|---|
| `speech-io` | 判断器(TTS 无凭证/ASR 凭证契约) | 模型脸 + **服务脸** | Q2:音频是大字节,必须直传直取 |
| `vector-store` | 状态锚(本地向量索引) | 模型脸 + **服务脸** | Q3:持有账;页面语义搜索是确定性流 |
| `embed-text` | 判断器 | 模型脸 | Q1:页面无直调动机(向量交给库) |
| `translate-text` | 变换器 | 模型脸 | Q1 终审单脸 |
| `route-plan` | 事实源 | 模型脸 | Q1 终审单脸 |
| `im-bot` | 出口(企微/钉钉/飞书) | 模型脸 | 出口=判断后行动,不直连 |
| `object-store` | 字节口(工作区↔云端) | 模型脸(路径进出)+ presign | Q2:字节走 presign URL,既不过模型也不过 host |
| `kg-memory`(采) | 状态锚(知识图谱) | 模型脸 | 收编件,上游只有工具面 |

按脸验收甲具:`bench/verify-faces.mjs`(模型脸 5/5 · 服务脸 3/3 · 凭证契约 4/4)。

### 状态锚(3)

`sqlite-query`(我们的账,双面战略核心)· `mysql-query` `postgres-query`(客户
自有库:只读习惯、永不自动 DDL——服务脸不做,客户库的直连是客户自己的事)

### 字节口(17)——共享一张公共文件通道,不各自长脸

解析侧:`pdf-extract` `docx-extract` `mobi-parser` `zip-archive`(读)`ocr-parse`
`exif-read` `file-type-detect` `gpx-parse` `image-process`(信息/转换)
生成侧:`pdf-generate` `pdf-report` `docx-generate` `pptx-generate`
`excel-read-write` `binary-write` `compress-gzip`
通道本尊:`book-intake` ✦(已有上传脸 + epub/文本解析;泛化候选)

### 事实源(20)——模型脸单脸,终审

`weather-forecast` `currency-rates` `geocode` `public-holidays` `worldbank-data`
`sec-filings` `scholar-search` `wiki-facts` `research-graph` `package-registry`
`osv-vulns` `deps-graph` `hn-search` `bluesky-feed` `github-api`(读)
`email-fetch` `rss-parse` `calendar-parse` `dns-lookup`
`http-request`(通用取数;http-post 有出口性,归此并注明)

### 变换器(40)——模型脸单脸,终审(占库 44%:这不是欠账,是纪律)

格式:`csv-parse` `yaml-convert` `toml-parse` `xml-parse` `json-query`
`json-schema-validate` `html-parse` `html-to-text` `html-to-markdown`
`markdown-render` `readability-extract` `text-encoding`
文本:`text-diff` `template-render` `fuzzy-search` `string-validate`
`safe-filename` `url-slugify` `transliterate` `word-segment` `pinyin-convert`
`chinese-convert` `num-to-chinese`
计算:`math-eval` `number-format` `currency-calc` `date-format` `cron-parse`
`semver-check` `geo-distance` `color-convert` `rrule-expand` `phone-parse`
`ip-utils` `jwt-decode` `crypto-hash` `fake-data`
小字节生成(data-url 级,归变换器):`qrcode-generate` `barcode-generate`
`calendar-generate`

### 判断器(1)

`ai-call`(模型脸)+ `ai.mjs`(app 镜像,已在 rag-qa 配方内)——**成对维护**:
改纪律(key 只走 env / maxTokens 地板)两边同步。

### 触发器(1 + 1 缺)

`webhook-intake`(机器脸天生)· **缺:`cron-trigger`**(目录里 `cron-parse` 只会
解析表达式,不会按点开火——无人值守形态的第二入口件,盘点盘出的第一缺口)

### 出口(6)

`email-send` `sms-gateway` `feishu-messaging` `slack-messaging`
`github-issues`(create 侧;list/get 属事实侧)`browser-automate`(动作侧;
extract 属事实侧)

### 工装 / 装备 / 示例(不参与流角色)

工装:`app-scaffold` `static-deploy`;人脸:前端模板 ×8;图纸:`recipe-rag-qa`;
知识包:`genui-fence-spec-kb`;harness 内建:`web-lookup` `content-search`;
人格装备:`file-manager-persona` `cs-persona`;示例件:`crm-query`
`ticket-create` `human-handoff`(demo 域)

## 三、双面化优先级(从流谱需求倒推,只有四件事)

1. **状态锚服务脸**:`sqlite-query` 长 HTTP CRUD 面(读/写/汇总,路径钉 workspace
   data.db,CORS 同源)——存量所有"有页有账"的 preset 立刻甩掉确定性流的模型税;
   双面交付(app+会话共账)的物理基础。**最高杠杆。**
2. **公共文件通道**:`book-intake` 泛化为 `file-channel`(上传/下载/列目录,
   通用化今天的 upload-info 模式)——页面喂文件/取文件一次治全体字节口,
   17 件解析/生成件保持路径式模型脸不动。
3. **触发器补件**:`cron-trigger` 入库 + **触发面考官**(打一发事件、验一个后果)
   ——无人值守形态的最后两块。
4. **判断器双脸制度化**:ai-call 的 app 镜像从"配方里的文件"升格为目录记录的
   成对工件(供应链知道它们是同一能力的两张脸)。

**明确不做**:变换器/事实源的服务脸(Q1 无动机,60 件全部终审单脸);客户库
(mysql/postgres)的服务脸(客户的直连是客户的事)。

**数字自检**:状态锚 3 + 字节口 17 + 事实源 20 + 变换器 40 + 判断器 1 + 触发器 1
+ 出口 6 + 工装 2(app-scaffold/static-deploy)= 90 件全覆盖,无遗漏无重复
(configs 里另有:人脸模板 8、知识包 1、harness 内建 2、人格装备 2、示例件 3、
配方 1——不占零件计数)。

## 四、机械化提议(待裁)

`role:` 字段进 `index/catalog.yml`(供应链档案,不动 capabilities.yml 联邦面),
检索行可显示角色;新零件入库时 index-add 要求答三问、填 role。先跑一轮战役验证
这套角色在流谱分解里真被用到,再机械化。
