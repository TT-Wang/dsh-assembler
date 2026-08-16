# dsh-assembler — Vibe Assembly for DeepSeek Harness

把一句话需求组装成一个可用的 AI agent。`dsh-assembler` 是一个 DeepSeek Harness (DSH) 插件：用户用自然语言描述想要的 agent（"帮我组装一个能查订单、开工单、转人工的客服机器人"），组装器从**能力目录**中匹配能力、生成 **agent preset**（`agent.cordis.yml`），新会话选中该 preset 即可使用。

能力目录由**索引流水线**自动生长：AI 把 GitHub 开源库切成"工具级能力点"、生成 MCP 适配服务器、冒烟验证后入库——不写胶水代码，只写配置。

---

## 特性

- **双入口**：`/assemble <需求>` 命令（人类快捷方式）+ `assemble` 工具（agent 原生路径，调用轨迹自动渲染）
- **装配即验证**：装配完成后自动派生一条冒烟探针任务，在绑定新 preset 的**真实会话**里跑一轮，按内容型验收标记判 PASS/FAIL；FAIL 触发一次带失败反馈的重新选型再探（find → assemble → **verify** 闭环，默认开启，`config.verify: false` 关闭）
- **能力目录**：134 个目录条目 = 8 条静态 + 126 条 MCP 联邦（33 个 MCP 服务器 / 112 个零件工具），组装时实时并行联邦
- **零代码扩展**：往 `mcp-servers` 加一段配置 = 整组新能力（MCP 服务器自动联邦）
- **索引流水线**：AI 切分开源库 → 生成 MCP 适配 → 冒烟验证（`verified`）→ 入库，32 个库全部通过（31 个上游 + 1 个第一方 `binary-write`）
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
│   ├── catalog.yml         # ★ 代码索引：32 个库的条目（repo/rev/tools,含第一方）
│   └── reports/            # 每个库的冒烟验证报告
├── generated/              # ★ 零件库：32 个 MCP 适配服务器（每库一个目录）
│   └── <id>/{package.json, index.js, smoke.mjs}
└── scripts/
    └── link-dsh.mjs        # 链接 DSH peer 包（@deepseek-ai/cordis 等）
```

## 能力目录（capabilities.yml）

三种能力来源：

| `via` | 来源 | 例子 |
|---|---|---|
| `package` | 本仓库/自有插件包的工具 | `crm-query`（dsh-cs-tools）|
| `harness` | DSH 内置工具 | `content-search`（dsh-tool-fs-search）|
| `mcp` | MCP 服务器工具（组装时自动联邦）| `mcp-email-send-send-email` 等 126 个 |

`mcp-servers` 段声明连接配置；`hostMounted: true` 表示服务器已在 host 平面挂载（工具全局可见，preset 不重复生成 mcp-client 行）。

当前规模：**32 个库（31 上游 + 1 第一方）/ 112 个零件工具 / 134 个目录条目**，覆盖：邮件收发、HTTP、HTML、CSV、Excel、PDF 生成与提取、Word、ZIP、模糊搜索、模板渲染、XML、图片处理、RSS、日历解析与生成、SQLite/PostgreSQL/MySQL、GitHub API、Markdown、OCR、二维码、货币、浏览器自动化、二进制落盘。

## 索引流水线（零件生产）

```
选库 → git clone(锁定 rev) → AI 全量阅读 → 切分 2~4 个能力点
  → 生成 MCP stdio 适配服务器(generated/<id>/)
  → npm install → 冒烟验证(listTools + 真实调用 + 错误路径)
  → 写验证报告(index/reports/<id>.json)
  → verified → 登记进 capabilities.yml 的 mcp-servers 段
```

- 上游源码**不 vendored**（按 rev 拉取，许可证合规）；`generated/` 只含我们生成的适配代码及少量冒烟夹具/字体资产（OFL）
- `verified: true` 仅在 listTools 成功且至少一次真实工具往返（成功或结构化报错）时授予
- 流水线由多 agent 编排（workflow）执行，每批 3~4 个库并行

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

基准:`npm run bench`(assembly-bench,20 条需求全闭环,标准 PASS ≥ 80%,结果落盘 `bench/results/`)。**实测(2026-08-16,15 单件 + 5 组合):首跑 19/20 PASS(95%),达标**;唯一非 PASS 是目录数据债——fs-search 零件的 presetRow 缺 rc 版新必填配置(与验证环无关),补配后该题复验 PASS(账本含复验记录)。探针任务全部由 fast 模型自主设计,含逐字回显标记(`SMOKE-2847-QR`)、欧式小数解析(`€2.573.693,75`)、跨零件组合链(CSV→SQLite 汇总、汇率→二维码)等真实验收。

## 已知限制

1. **同 preset 并发会话没有问题**（旧版此处的"并发撞名"限制是误判，已实证纠正）：harness 对每个 preset 文件代际只挂载一次 standing 组合，并发会话通过 scope parenting 共用同一实例——两个会话同时跑同一个装配 preset 各自完成，无 serverName 冲突。真正的残余限制是：**host 进程存活期内不释放被取代代际的 serverName**，所以手工编辑 preset 文件（字节变了、serverName 没变）后，同一 host 进程里的新会话会撞旧代际，重启 host 恢复。组装器自身的重发已按"文件字节哈希入 serverName 后缀 + 字节相同跳写盘"根治（任何字节差异自动换名，字节相同不换代）
2. **联邦耗时下限**：已并行化（默认 16 车道，`DSH_ASSEMBLER_FED_LANES` 可调），33 个服务器实测 11.2s（串行基线）→ 约 4.7s；地板是每个 stdio 零件的进程冷启动，再降需要索引缓存增量探测（规划中）
3. **目录选型压力**：134 条目下 LLM 选型仍准确，但更大规模需要按域分层
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
