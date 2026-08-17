# dsh-assembler — Vibe Assembly for DeepSeek Harness

把一句话需求组装成一个可用的 AI agent。`dsh-assembler` 是一个 DeepSeek Harness (DSH) 插件：用户用自然语言描述想要的 agent（"帮我组装一个能查订单、开工单、转人工的客服机器人"），组装器从**能力目录**中匹配能力、生成 **agent preset**（`agent.cordis.yml`），新会话选中该 preset 即可使用。

能力目录由**索引流水线**自动生长：AI 把 GitHub 开源库切成"工具级能力点"、生成 MCP 适配服务器、冒烟验证后入库——不写胶水代码，只写配置。

---

## 特性

- **双入口**：`/assemble <需求>` 命令（人类快捷方式）+ `assemble` 工具（agent 原生路径，调用轨迹自动渲染）
- **装配即验证**：装配完成后自动派生一条冒烟探针任务，在绑定新 preset 的**真实会话**里跑一轮，按内容型验收标记判 PASS/FAIL；FAIL 触发一次带失败反馈的重新选型再探（find → assemble → **verify** 闭环，默认开启，`config.verify: false` 关闭）
- **能力目录**：158 个目录条目 = 8 条静态 + 150 条 MCP 联邦（44 个 MCP 服务器 / 136 个零件工具），组装时实时并行联邦
- **联邦索引缓存**：每个零件的工具清单按（连接配置 + 适配器文件指纹）缓存,命中零连接——冷 ~5s,热 **<0.01s**;适配器重新生成自动失效,7 天 TTL 兜底远程服务器
- **零件物料清单（BOM）**：每次装配随 preset 发射 `parts.lock.yml`——每个零件的上游 repo@rev、许可证、验证状态、实际挂载 serverName,装出的 agent 像依赖锁文件一样可审计
- **零代码扩展**：往 `mcp-servers` 加一段配置 = 整组新能力（MCP 服务器自动联邦）
- **索引流水线**：AI 切分开源库 → 生成 MCP 适配 → 冒烟验证（`verified`）→ 入库，43 个库全部通过（41 个上游 + 2 个第一方 `binary-write`/`crypto-hash`）
- **补件闭环**：需求超出目录时，返回可复制的 YAML 补件草案 + missing 报告
- **生成 persona**：目录无匹配 persona 时，LLM 生成针对性 persona 文本

## 架构

```
┌───────────────────────── 代码索引流水线（零件生产） ─────────────────────────┐
│ 开源库(GitHub) → AI 切分能力点 → 生成 MCP stdio 适配(generated/)             │
│   → npm install + 冒烟验证(verified) → 入库(index/catalog.yml)                │
└──────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌───────────────────────── 组装（能力消费） ───────────────────────────────────┐
│ capabilities.yml(目录) + MCP 并行联邦 → LLM 选型 → 生成 preset               │
│   → ~/.dsh/.agent-presets/<id>/agent.cordis.yml                              │
│   → 自动验证:派生探针任务 → 真实会话试跑 → PASS / FAIL(重选型一次)          │
└──────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌───────────────────────── 运行时 ─────────────────────────────────────────────┐
│ 新会话选中 preset → DSH 按行挂载插件(persona/mcp-client/…)                   │
│   → agent 真实调用零件工具（mcp__<server>__<tool>）                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

组装器是 Cordis 插件，组装产物是 Cordis 插件组合清单（preset 每一行 = 一个插件实例）；零件是外部 MCP 服务器进程，通过 `@deepseek-ai/dsh-mcp-client` 桥接。

## 快速开始

### 1. 安装

将插件加入 DSH profile 的 patch 层（示例：`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-assembler
      name: '@dsh-external/dsh-assembler'
```

`package.json` 依赖：`"@dsh-external/dsh-assembler": "link:/path/to/dsh-assembler"`。

### 2. 使用

**方式 A — 命令**（人类快捷方式）：

```
/assemble 帮我组装一个客服机器人，能查客户信息、创建工单、转人工 [--name customer-service-bot]
```

**方式 B — 直接说**（agent 原生路径，推荐）：在任意会话里说：

```
帮我组装一个能查订单、开工单、转人工的客服机器人
```

agent 会自动决定调用 `assemble` 工具，思维链 + 工具卡片 + 结果全部渲染。

### 3. 使用组装出的 agent

组装完成后新开会话，在 preset 选择器里选 `<id>` 即可。组装出的 agent 只挂载被选中的零件（窄工具表面），并在会话里真实调用它们。

## 目录结构

```
dsh-assembler/
├── src/
│   ├── index.ts            # 组装核心：目录加载/LLM 选型/预设生成/命令与工具注册
│   └── assemble-tool.ts    # assemble agent 工具定义
├── presets/
│   └── agent-template.yml  # preset 模板（{{persona}}/{{packageRows}}/{{extraRows}} 插槽）
├── capabilities.yml        # ★ 组装目录：能力条目 + mcp-servers 连接配置
├── index/
│   ├── catalog.yml         # ★ 代码索引：43 个库的条目（repo/rev/tools,含第一方）
│   └── reports/            # 每个库的冒烟验证报告
├── generated/              # ★ 零件库：43 个 MCP 适配服务器（每库一个目录）
│   └── <id>/{package.json, index.js, smoke.mjs}
└── scripts/
    ├── link-dsh.mjs        # 链接 DSH peer 包（@deepseek-ai/cordis 等）
    ├── index-add.mjs       # ★ 索引流水线 CLI：scaffold/verify/register/check-all
    └── assembly-bench.mjs  # 20 题装配质量基准
```

## 能力目录（capabilities.yml）

三种能力来源：

| `via` | 来源 | 例子 |
|---|---|---|
| `package` | 本仓库/自有插件包的工具 | `crm-query`（dsh-cs-tools）|
| `harness` | DSH 内置工具 | `content-search`（dsh-tool-fs-search）|
| `mcp` | MCP 服务器工具（组装时自动联邦）| `mcp-email-send-send-email` 等 150 个 |

`mcp-servers` 段声明连接配置；`hostMounted: true` 表示服务器已在 host 平面挂载（工具全局可见，preset 不重复生成 mcp-client 行）。

当前规模：**43 个库（41 上游 + 2 第一方）/ 136 个零件工具 / 158 个目录条目**，覆盖：邮件收发、HTTP、HTML、CSV、Excel、PDF 生成与提取、Word、ZIP、模糊搜索、模板渲染、XML、图片处理、RSS、日历解析与生成、SQLite/PostgreSQL/MySQL、GitHub API、Markdown、OCR、二维码、货币、浏览器自动化、二进制落盘、文本 diff/补丁、数学表达式求值与单位换算、cron 解析、电话号码、semver、YAML、拼音、简繁转换、HTML→Markdown、字符编码、哈希/HMAC/UUID。

## 索引流水线（零件生产,CLI 化）

收录一个新开源库 = 三条命令 + 中间由 agent 写适配。CLI 的设计前提是**调用方就是 agent**:确定性环节(取源、出工单、装依赖、质检、登记)全在 CLI 里,"切能力点 + 写适配代码"这一智能环节留给调用方——不内嵌 LLM 调用,每个子命令末行输出 JSON 判定,机器可判读。

```bash
node scripts/index-add.mjs scaffold kpdecker/jsdiff --pkg diff --id text-diff
#   → npm 元数据(锁版/许可证) + 浅取上游源码 + 生成骨架与工单 WORK-ORDER.md
#   (agent 按工单写 generated/text-diff/{index.js,smoke.mjs})
node scripts/index-add.mjs verify text-diff
#   → npm install → 冒烟(exit 0 必须)→ 独立 listTools 实探 → 写验证报告
node scripts/index-add.mjs register text-diff
#   → 幂等登记 index/catalog.yml + capabilities.yml;下次装配联邦自动看见
node scripts/index-add.mjs check-all   # 全量复检:跑每个零件的冒烟,可当回归门
node scripts/index-add.mjs coverage    # 能力覆盖图:语义判重用(候选先对图判 NEW/OVERLAP)
```

**去重两层**(目录是能力目录不是库目录,判重标准是能力点不是库名):① 机械硬门——scaffold 时同 id / 同 npm 包 / 同上游 repo 一律拒收(`--force yes` 逃生),dayjs 换个 id 再收会被"npm 包已被零件 date-format 收录"挡下;② 语义判重——候选对照 `coverage` 覆盖图判 NEW / OVERLAP,重叠能力点不收或只收不重叠部分(实例:convert-units 被 mathjs 的单位换算能力点覆盖而砍掉;moment/cheerio/axios/fast-diff/papaparse 因与既有零件同能力而拒收)。

**质检门在流水线里**:verify 不过,register 直接拒绝;报告非 pass 拒绝登记。首个 CLI 收录实测(text-diff,jsdiff@9.0.0):scaffold→写适配→verify(冒烟 7/7)→register,目录 134→137 条目,收录后首次联邦 0.28s(其余零件全缓存命中,只实探新件)。

- 上游源码**不 vendored**（浅取到 `.cache/upstream/` 供阅读,依赖按 npm 精确锁版,许可证登记入目录）；`generated/` 只含我们生成的适配代码及少量冒烟夹具/字体资产（OFL）
- `verified: true` 仅在 listTools 成功且至少一次真实工具往返（成功或结构化报错）时授予

## 端到端示例（已验证）

组装"数据分析与报表助手"后，在会话中要求：

> 用 SQLite 建表并插入两条订单，查询出来，用金额工具相加并格式化，生成一个 PDF 报告

组装出的 agent 实际执行了：

```
mcp__sqlite-query__execute     建表 + 插入（changes: 2）
mcp__sqlite-query__query       查询订单
mcp__currency-calc__currency-calc  金额相加 = $6,913.46
mcp__pdf-generate__create-pdf  生成 PDF（%PDF-1.7，1192 字节）
mcp__filesystem__write_file    写盘 /tmp/orders_report.pdf.base64.txt
```

过程中零件校验真实生效（空行参数被拒后 agent 自动修复；写盘越界被 filesystem 根目录边界拦截后自动改路径）。

## 装配即验证（实测输出）

vibe assembly 的承诺是 find → assemble → **verify**：装出来的 agent 不能只是"文件生成了"，得证明它真的能干活。装配完成后，组装器用 fast 模型从需求派生一条一轮可完成的探针任务（含内容型验收标记——计算值、逐字回显，拒绝 "done" 式自我宣称），走 host 公开线契约（HTTP RPC + events.mux）开一个绑定新 preset 的真实会话试跑，判定回复。实测（需求："能做货币汇率换算、也能生成二维码的助手"）：

```
自动验证:PASS — 探针「用 http-get 请求 https://open.er-api.com/v6/latest/USD，
读取返回 JSON 中的 rates.CNY 作为汇率；…」通过;
验收标记 [100 USD = ¥, CNY=, data:image/png;base64]
```

探针 agent 实际执行了:http-get 取实时汇率 → currency-calc 乘法 → currency-format 格式化(¥676.06) → qr-generate-data-url 生成二维码——四个零件、一次组合调用链,全部真实往返。FAIL 时组装器把失败原因喂回选型 LLM 重选一次零件再探;探针基础设施故障(如 headless 无 webServer)降级为"跳过",不拦装配。

## 零件物料清单（parts.lock.yml,实测输出节选）

装配不只发射 preset,还发射供应链账本——每个零件从哪来、锁在哪个版本、什么许可证、这个 preset 实际挂载成什么名字:

```yaml
preset: p2-bom-probe
requirement: 能生成二维码、也能做日期加减的助手
parts:
  - capability: mcp-qrcode-generate-qr-generate-png
    via: mcp
    server: qrcode-generate
    serverName: qrcode-generate-d0fb25cc   # 从 preset 字节读回,永远与实际挂载一致
    repo: soldair/node-qrcode
    rev: v1.5.3
    license: MIT
    verified: true
  - capability: mcp-date-format-date-manipulate
    repo: iamkun/dayjs
    rev: v1.11.11
    license: MIT
    ...
```

`hostMounted` 零件标注 `plane: host`(host 平面挂载,preset 不发行);harness 零件列出 `mounts`(插件包名)。写在验证环之后:重试换过零件时,锁文件记录的是**最终代际**。

基准:`npm run bench`(assembly-bench,20 条需求全闭环,标准 PASS ≥ 80%,结果落盘 `bench/results/`)。**实测(2026-08-16,15 单件 + 5 组合):首跑 19/20 PASS(95%),达标**;唯一非 PASS 是目录数据债——fs-search 零件的 presetRow 缺 rc 版新必填配置(与验证环无关),补配后该题复验 PASS(账本含复验记录)。探针任务全部由 fast 模型自主设计,含逐字回显标记(`SMOKE-2847-QR`)、欧式小数解析(`€2.573.693,75`)、跨零件组合链(CSV→SQLite 汇总、汇率→二维码)等真实验收。

## 已知限制

1. **同 preset 并发会话没有问题**（旧版此处的"并发撞名"限制是误判，已实证纠正）：harness 对每个 preset 文件代际只挂载一次 standing 组合，并发会话通过 scope parenting 共用同一实例——两个会话同时跑同一个装配 preset 各自完成，无 serverName 冲突。真正的残余限制是：**host 进程存活期内不释放被取代代际的 serverName**，所以手工编辑 preset 文件（字节变了、serverName 没变）后，同一 host 进程里的新会话会撞旧代际，重启 host 恢复。组装器自身的重发已按"文件字节哈希入 serverName 后缀 + 字节相同跳写盘"根治（任何字节差异自动换名，字节相同不换代）
2. **联邦耗时**：已解决——并行化（16 车道，`DSH_ASSEMBLER_FED_LANES` 可调）+ 索引缓存后,冷跑约 5s,**缓存命中 <0.01s**(实测 0.002s,33 服务器零连接)。失效键 = 连接配置哈希 + 适配器文件指纹(只 stamp 常规文件,目录参数如 `/tmp` 的 mtime 抖动不会假失效);`DSH_ASSEMBLER_FED_CACHE=0` 强制全实探,`DSH_ASSEMBLER_FED_TTL_MS` 调 TTL(默认 7 天,兜底远程服务器工具集漂移)
3. **目录选型压力**：158 条目下 LLM 选型仍准确，但更大规模需要按域分层
4. **组装映射调用默认使用 fast 模型**（`deepseek-v4-flash`，可经插件 `config.model` 覆盖），不继承会话的重模型配置（重模型曾导致单次组装约 10 分钟）
5. **自动验证依赖 webServer**：headless（无 web 面板）装配时探针无处可跑，自动验证降级为"跳过"，装配本身不受影响

## 开发

```bash
npm run link:dsh   # 链接 DSH peer 包（需要 DSH_SOURCE 环境变量或 ~/.dsh/source/current）
npm run build      # tsc 构建到 lib/
npm test           # 构建 + 命名/发射代际不变式 + 验证判定/幂等写盘 单元测试
npm run bench      # assembly-bench:20 条需求全闭环(需要已挂 assembler 的 web profile 在跑)
```

改 `lib/` 后需重启 DSH web 进程生效；改 `capabilities.yml` 无需重启（组装时实时读取）。

## 许可证

BSD-3-Clause。零件（`generated/`）适配的上游库许可证见 `index/catalog.yml` 各条目。
