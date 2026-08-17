# dsh-assembler — Vibe Assembly for DeepSeek Harness

[English](README.md) | 中文

**把一句话需求装配成一个能干活的 AI agent,并且交得出去。**

`dsh-assembler` 是一个 DeepSeek Harness (DSH) 插件。用户用自然语言描述想要的 agent("帮我做一个能查订单、开工单、转人工的客服机器人"),装配器从**能力目录**匹配零件、发射 **agent preset**、然后**在真实会话里试跑验收**——新会话选中该 preset 即可使用。

能力目录由**索引流水线**自动生长:开源库、公开 API、客户自有接口、客户知识,都能一条命令收进目录,过质检门才入库。不写胶水代码,只写配置。

**服务对象是 FDE(前线部署工程师)**:交付物不是一个 preset,是一个带客户知识、接客户系统、有完整供应链账本与验收报告的**方案包**——换个客户改参数换凭证即可重建。

---

## 现在的规模与成绩

| | 数字 | 证据 |
|---|---|---|
| 能力目录 | **79 个 MCP 服务器 / 215 个登记工具 / 237 个可装配条目**(联邦实探 229 条 mcp + 8 条静态) | `index/catalog.yml` |
| 零件构成 | 65 库型 + 13 服务型 + 4 第一方 | 同上 |
| 零件质检 | **80/80 冒烟通过**(含 2 个客户零件) | `npm run index:check` |
| 装配质量 | **44/45 (98%)**;L3 多轮流程题 **5/5** | `bench/results/2026-08-17-*.json` |
| 选型稳定性 | 目录 137 → 227 条目(+47%)基线题**零退化** | 三轮 bench 账本对照 |
| 装配耗时 | 中位 **56 秒**(单轮 52s / 多轮场景 182s) | 同上 |
| 单元测试 | 3 套全绿(命名代际 / 验收判定 / 联邦缓存) | `npm test` |

---

## 特性

- **双入口**:`/assemble <需求>` 命令(人类快捷方式)+ `assemble` 工具(agent 原生路径,调用轨迹自动渲染)
- **装配即验证**:装配完成后自动派生验收探针,在绑定新 preset 的**真实会话**里试跑,按内容型验收标记判 PASS/FAIL;FAIL 触发一次带失败反馈的重新选型再探(find → assemble → **verify** 闭环)
- **多轮场景探针**:派生器自行决定探针形态——纯计算需求出单轮题,跨轮需求(记账/归档/追踪)出 2-4 轮场景脚本,**同一会话**里逐轮验收,后面的轮次查询前面轮次写入的状态。全程黑盒:只看回复,不看轨迹
- **方案包(FDE 交付单元)**:`solutions/<name>/solution.yml` 声明一次交付的全部——几个 agent、用哪份目录、部署参数、客户知识。`solution apply` 一条命令按清单装配并逐个验收;`solution handover` 从每个 preset 的 BOM **自动长出**交付报告。多租户 = 换 `--param` 换凭证,不分叉清单
- **知识包(`via: knowledge`)**:客户手册/SOP/产品目录作为**静态教材**进目录,过**检索命中门**(探针问题检不出预期片段就拒收),装配时**拷进 preset 的 `kb/`**——交付物自包含
- **凭证契约(接口先就位,key 后补)**:零件只**声明**需要哪个环境变量及用途,**值永不进 preset**;未配时零件照常启动、`listTools` 成功、调用返回**可行动错误**;装配侧对应为"装配成功 + 探针 SKIPPED + 配置指引"。可选凭证(如 GitHub 公开读)走匿名降级不拦验证
- **客户私有目录**:`catalogs/<client>/` 自带 `generated/`、`index/`、`capabilities.yml`——A 客户的零件**不会出现在** B 客户的装配里,隔离靠**分文件**而非过滤条件
- **服务型零件**:13 个实时数据服务已接入(天气/汇率/地理编码/节假日/宏观数据/美股财报/学术检索/维基事实/研究图谱/包情报…)。库型锁 `repo@rev`,服务型锁**条款 + 速率限制 + 数据许可**,同样进 BOM
- **零件物料清单(BOM)**:每次装配随 preset 发射 `parts.lock.yml`——每个零件的出处、许可、验证状态、实际挂载名、知识包来源版本、待配凭证清单
- **联邦索引缓存**:零件工具清单按(连接配置 + 适配器文件指纹)缓存,冷 ~5s → 热 **0.002s**
- **persona lint**:机械核查 persona(点名的工具必须在挂载面里、禁止"第 N 步"编舞句式、长度界)
- **设计宪法**:[DESIGN.md](DESIGN.md)(设计宪法,中文)—— 三件本分、负面清单、三条边界判据。新功能先过判据

---

## 架构

```
┌───────── 索引流水线(供应链) ──────────────────────────────────────────┐
│ 开源库 / 公开 API / 客户接口 spec / 客户知识                            │
│   → 切能力点 → MCP 适配 → 质检门(冒烟 / 检索命中)→ 入目录             │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── 装配(能力消费) ─────────────────────────────────────────────┐
│ capabilities.yml(公共或客户目录) + 并行联邦 → LLM 选型                │
│   → 发射 preset + BOM + 知识包拷入 kb/                                  │
│   → 自动验证:派生探针(单轮或多轮场景)→ 真实会话试跑 → PASS/FAIL     │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── 交付(FDE) ─────────────────────────────────────────────────┐
│ solution apply(按清单装配全部 agent)                                  │
│   → solution handover:交付报告(验收/参数/待配凭证/知识/BOM/重建命令) │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── 运行时(harness 的领土) ────────────────────────────────────┐
│ 新会话选中 preset → DSH 按行挂载插件 → agent 真实调用零件工具          │
└─────────────────────────────────────────────────────────────────────────┘
```

装配器是 Cordis 插件,产物是 Cordis 插件组合清单(preset 每行 = 一个插件实例);零件是外部 MCP 服务器进程,通过 `@deepseek-ai/dsh-mcp-client` 桥接。**装配器只在装配时存在**——会话跑起来后它的进程死掉,一切照常。

---

## 快速开始

### 1. 安装

加入 DSH profile 的 patch 层(示例 `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-assembler
      name: '@dsh-external/dsh-assembler'
```

`package.json` 依赖:`"@dsh-external/dsh-assembler": "link:/path/to/dsh-assembler"`。

服务型零件若需部署方联系方式(SEC 强制 UA、Crossref/OpenAlex polite pool),复制 `.env.example` 为 `.env` 并填自己的邮箱——**不是凭证,但也不该硬编码任何人的地址**。

### 2. 装配一个 agent

```
/assemble 帮我组装一个客服机器人,能查客户信息、创建工单、转人工 [--name customer-service-bot] [--param timezone=Asia/Shanghai]
```

或直接在任意会话里说"帮我组装一个能查订单、开工单、转人工的客服机器人"——agent 会自动调用 `assemble` 工具,思维链 + 工具卡片 + 结果全部渲染。

### 3. 交付一个方案(FDE 路径)

```bash
npm run solution -- init acme-service --client acme     # 起清单
# 编辑 solutions/acme-service/solution.yml 的 agents
npm run solution -- apply solutions/acme-service/solution.yml --port 3096
npm run solution -- handover solutions/acme-service/solution.yml
```

产出 `HANDOVER.md`:交付了哪些 agent 与验收结论、部署参数、**待配凭证清单**、知识包来源版本、供应链 BOM、重建命令。全部从工件里长出来,**没有一处靠人填写**。

---

## 目录结构

```
dsh-assembler/
├── src/
│   ├── index.ts            # 装配核心:目录加载/选型/发射/BOM/参数/凭证/知识
│   ├── verify.ts           # 装配即验证:探针派生(单轮/多轮场景)+ 真实会话驱动
│   ├── persona-lint.ts     # persona 机械核查
│   └── assemble-tool.ts    # assemble agent 工具定义
├── capabilities.yml        # ★ 公共组装目录:能力条目 + mcp-servers + requiredSecrets
├── index/                  # ★ 公共零件索引(出处/许可/条款)+ 冒烟报告
├── generated/              # ★ 零件库:78 个 MCP 适配服务器(每零件一目录)
├── catalogs/<client>/      # ★ 客户私有目录:自带 generated/ index/ capabilities.yml knowledge/
├── solutions/<name>/       # ★ 方案包:solution.yml + last-apply.json + HANDOVER.md
├── bench/results/          # 装配质量基准账本(run-tagged,git 收录)
├── presets/
│   └── agent-template.yml  # preset 模板({{persona}}/{{packageRows}}/{{extraRows}}/{{param:k}})
└── scripts/
    ├── index-add.mjs       # ★ 索引流水线 CLI
    ├── solution.mjs        # ★ 方案包 CLI
    ├── assembly-bench.mjs  # 45 题装配质量基准
    └── link-dsh.mjs        # 链接 DSH peer 包
```

---

## 能力目录

四种能力来源:

| `via` | 来源 | 例子 |
|---|---|---|
| `package` | 本仓库/自有插件包的工具 | `crm-query` |
| `harness` | DSH 内置工具 | `content-search` |
| `mcp` | MCP 服务器工具(装配时自动联邦) | `mcp-weather-forecast-current-weather` 等 229 条 |
| `knowledge` | 客户静态教材(装配时拷入 `kb/`) | `acme-policies-kb` |

当前覆盖:邮件收发、HTTP、HTML、CSV/YAML/TOML/XML、Excel、PDF 生成与提取、Word/PPT、ZIP、模糊搜索、模板渲染、图片处理、RSS、日历与 RRULE、SQLite/PostgreSQL/MySQL、GitHub API、Markdown、OCR、条码/二维码、货币精算、浏览器自动化、二进制落盘、文本 diff、数学与单位换算、cron、电话号码、semver、拼音/简繁/分词/中文大写、编码转换、哈希/HMAC/UUID、JMESPath、JSON Schema、字符串校验、测试数据、颜色、地理距离、EXIF、文件类型、JWT、IP/CIDR、转写 slug、gzip/brotli、DNS,以及 **13 个实时数据服务**(天气/汇率/地理编码/节假日/世界银行/SEC EDGAR/Crossref+arXiv/Wikipedia+Wikidata/OpenAlex/npm+PyPI/飞书/Slack/GitHub Issues)。

---

## 索引流水线(收录 CLI)

设计前提是**调用方就是 agent**:CLI 只做确定性环节(取源、出工单、装依赖、质检、登记),"切能力点 + 写适配代码"留给调用方。每个子命令末行输出 JSON 判定,机器可判读。

```bash
# 收开源库
npm run index:add -- kpdecker/jsdiff --pkg diff --id text-diff
npm run index:verify -- text-diff        # install → 冒烟(exit 0 必须)→ 独立 listTools → 报告
npm run index:register -- text-diff      # 幂等登记;下次装配联邦自动看见

# 收公开 API(锁条款/速率/数据许可,而非版本)
node scripts/index-add.mjs scaffold - --service https://api.open-meteo.com/v1 --id weather-forecast \
  --provider 'Open-Meteo' --license CC-BY-4.0 --terms https://open-meteo.com/en/terms --rate-limit '免费非商用无限制'

# 接客户系统(FDE 日常):吃 OpenAPI → 端点清单工单 → 客户私有目录
node scripts/index-add.mjs from-spec <spec-url|file> --id <id> --client acme \
  --requires-secret "TOKEN:用途说明,可含逗号;OTHER:第二个"

# 收客户知识(过检索命中门)
node scripts/index-add.mjs knowledge <文档目录> --id acme-policies --client acme --version 2026-08
# 写 probes.json(问题 + 预期片段)后:
node scripts/index-add.mjs knowledge-verify acme-policies --client acme

# 全自动:一条命令收录(需要在跑的 web profile)
npm run index:auto -- sindresorhus/slugify --pkg @sindresorhus/slugify --id url-slugify

npm run index:check     # 全量回归:跑每个零件的冒烟(离线时网络零件记 SKIPPED 并单独计数)
node scripts/index-add.mjs coverage   # 能力覆盖图:语义判重用
```

**质检门在流水线里**:verify 不过,register 直接拒绝。**去重两层**——机械硬门(同 id / 同 npm 包 / 同上游 repo)+ coverage 覆盖图语义判重(记录在案的拒收:moment/cheerio/axios/fast-diff/papaparse 与既有零件同能力,convert-units 被 mathjs 覆盖,ua-parser-js v2 改 AGPL 许可证风险)。

---

## 实测输出

### 装配即验证(多轮场景)

需求"记账助手,把每笔收支记到本地账本,之后可以查询和汇总"——派生器**自主选择了 3 轮场景**:

```
自动验证:PASS — 多轮场景「证明记账助手能把收支持久化到 SQLite,并在后续轮次中查询和汇总」共 3 轮,逐轮通过
  第1轮 ✓ 「记一笔收入:项目款 8899 元,备注 INV-7781…」标记 [INV-7781, 8899]
  第2轮 ✓ 「再记一笔支出:办公用品 1200 元,备注 OFFICE-2201…」标记 [OFFICE-2201, 1200]
  第3轮 ✓ 「查询本地账本,列出所有记录并汇总收支」标记 [INV-7781, OFFICE-2201, 8899]
```

第 3 轮查的是前两轮写入的状态——**这才是状态真的活过了轮次**。对照组"数学计算助手"正确地留在单轮(26s)。

### 凭证的四种状态

```
# 缺必需凭证:装配成功,探针 SKIPPED,给出配置指引
自动验证:跳过(待配置凭证:SLACK_BOT_TOKEN——装配正确但无法实调外部服务,配好后重跑装配即可验证)
所需凭证:SLACK_BOT_TOKEN(待配置) — Slack Bot User OAuth Token(xoxb- 开头)

# 可选凭证:走匿名路径照常验证通过
自动验证:PASS — 探针「对公开仓库 octocat/Hello-World 做一次巡检…」通过
所需凭证:GITHUB_TOKEN(可选,未配则降级)
```

### 零件物料清单(节选)

```yaml
preset: p2-bom-probe
parts:
  - capability: mcp-qrcode-generate-qr-generate-png
    server: qrcode-generate
    serverName: qrcode-generate-d0fb25cc   # 从 preset 字节读回,永远与实际挂载一致
    repo: soldair/node-qrcode
    rev: v1.5.3
    license: MIT
    verified: true
  - capability: mcp-weather-forecast-current-weather
    kind: service
    service: https://api.open-meteo.com/v1
    terms: https://open-meteo.com/en/terms
    rateLimit: 免费非商用无限制;商用需订阅
knowledge:
  - id: acme-policies
    docs: 2
    source: ACME 客服中心知识库导出
    version: 2026-08
```

---

## 基准:assembly-bench

```bash
npm run bench     # 45 题全闭环(需要在跑的 web profile),标准 PASS ≥ 80%,结果落 bench/results/
```

**三轮账本(全部 git 收录,可复算)**:

| 轮次 | 题量 | 结果 | 目录规模 |
|---|---|---|---|
| 08-16 | 20 | 19/20 (95%) | 137 条目 |
| 08-17 一轮 | 40 | 35/40 (88%) | 196 条目 |
| **08-17 二轮** | **45** | **44/45 (98%)** | **227 条目** |

- **基线题 1-20 全程 19-20/20**:目录扩大 47% 选型零退化(两个数据点),按域分层的触发条件未满足
- **L3 流程题 5/5**,且 5/5 由派生器自主判为多轮场景
- 记分纪律:**首跑不改**;修因后的复验单独入账。首轮 5 个 FAIL 逐个验尸后全部转 PASS——3 个是探针设计噪声(标记过精 / deriver 用了过时世界知识 / 大 payload 超时),1 个是零件设计类缺陷(二进制内联返回让 agent 逐字搬运 base64,720s → 76s),1 个是误诊的自我更正

---

## 已知限制

1. **陌生人措辞未验证**:所有 bench 题由维护者书写,天然贴合目录用语。真实用户的模糊表达("搞个处理投诉的东西")尚未成套测过——这是最可能暴露问题的方向
2. **L3 样本量小**:多轮流程题只有 5 道,且都是记账级复杂度。企业级流程(跨系统 + 领域规则 + 多步判断)复杂度高一个数量级,尚无证据
3. **目录规模外推未验证**:到 227 条目选型不退化有实测,再翻倍(400+)是推断
4. **自动验证依赖 webServer**:headless 装配时探针无处可跑,降级为"跳过",装配本身不受影响
5. **preset 手工编辑后同进程冲突**:host 在进程存活期内不释放被取代代际的 serverName。装配器自己的重发已根治(文件字节哈希入 serverName + 字节相同跳写盘),但手工改文件后需重启 host
6. **结构性天花板**:装配器管能力获取与验收,**判断力永远归模型**——装得出"必然留下工单的退款助手",装不出"知道该不该退款的助手"

---

## 开发

```bash
npm run link:dsh   # 链接 DSH peer 包(需要 DSH_SOURCE 或 ~/.dsh/source/current)
npm run build      # tsc 构建到 lib/
npm test           # 构建 + 三套单测(命名代际不变式 / 验收判定与 BOM / 联邦缓存)
npm run index:check   # 全量零件冒烟回归
npm run bench      # 45 题装配基准
```

改 `lib/` 后需重启 DSH web 进程生效;改 `capabilities.yml` 无需重启(装配时实时读取)。

网络零件的环境要点(实测教训,写进了工单模板):Node 的 `fetch` 忽略 `HTTP(S)_PROXY` 除非 `NODE_USE_ENV_PROXY=1`,且 MCP SDK 的 `StdioClientTransport` **只透传白名单环境变量**——流水线已统一处理,自己写冒烟时记得传 `NETWORK_ENV`。

---

## 许可证

BSD-3-Clause。零件适配的上游库许可证见 `index/catalog.yml` 各条目;服务型零件的数据许可与条款同样逐条记录在案。
