# dsh-assembler — Vibe Assembly for DeepSeek Harness

把一句话需求组装成一个可用的 AI agent。`dsh-assembler` 是一个 DeepSeek Harness (DSH) 插件：用户用自然语言描述想要的 agent（"帮我组装一个能查订单、开工单、转人工的客服机器人"），组装器从**能力目录**中匹配能力、生成 **agent preset**（`agent.cordis.yml`），新会话选中该 preset 即可使用。

能力目录由**索引流水线**自动生长：AI 把 GitHub 开源库切成"工具级能力点"、生成 MCP 适配服务器、冒烟验证后入库——不写胶水代码，只写配置。

---

## 特性

- **双入口**：`/assemble <需求>` 命令（人类快捷方式）+ `assemble` 工具（agent 原生路径，调用轨迹自动渲染）
- **能力目录**：133 个目录条目 = 8 条静态 + 125 条 MCP 联邦（32 个 MCP 服务器 / 111 个零件工具），组装时实时联邦
- **零代码扩展**：往 `mcp-servers` 加一段配置 = 整组新能力（MCP 服务器自动联邦）
- **索引流水线**：AI 切分开源库 → 生成 MCP 适配 → 冒烟验证（`verified`）→ 入库，31 个库全部通过
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
│ capabilities.yml(目录) + MCP 联邦 → LLM 选型 → 生成 preset                   │
│   → ~/.dsh/.agent-presets/<id>/agent.cordis.yml                              │
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
│   ├── catalog.yml         # ★ 代码索引：31 个开源库的条目（repo/rev/tools）
│   └── reports/            # 每个库的冒烟验证报告
├── generated/              # ★ 零件库：31 个 MCP 适配服务器（每库一个目录）
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
| `mcp` | MCP 服务器工具（组装时自动联邦）| `mcp-email-send-send-email` 等 125 个 |

`mcp-servers` 段声明连接配置；`hostMounted: true` 表示服务器已在 host 平面挂载（工具全局可见，preset 不重复生成 mcp-client 行）。

当前规模：**31 个库 / 111 个零件工具 / 133 个目录条目**，覆盖：邮件收发、HTTP、HTML、CSV、Excel、PDF 生成与提取、Word、ZIP、模糊搜索、模板渲染、XML、图片处理、RSS、日历解析与生成、SQLite/PostgreSQL/MySQL、GitHub API、Markdown、OCR、二维码、货币、浏览器自动化。

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

## 已知限制

1. **同一 preset 的并发会话共用 serverName**：serverName 已按 preset id 哈希后缀命名空间化，跨 preset 不再冲突；残余限制是同一个 preset 同时开多个会话仍会撞名
2. **联邦顺序连接**：32 个服务器顺序连接约 10s（计划改为并行）
3. **目录选型压力**：130 条目下 LLM 选型仍准确，但更大规模需要按域分层
4. **组装映射调用默认使用 fast 模型**（`deepseek-v4-flash`，可经插件 `config.model` 覆盖），不继承会话的重模型配置（重模型曾导致单次组装约 10 分钟）
5. **二进制落盘缺口**：零件返回 base64，直接落盘二进制文件需要 base64 解码环节配合

## 开发

```bash
npm run link:dsh   # 链接 DSH peer 包（需要 DSH_SOURCE 环境变量或 ~/.dsh/source/current）
npm run build      # tsc 构建到 lib/
```

改 `lib/` 后需重启 DSH web 进程生效；改 `capabilities.yml` 无需重启（组装时实时读取）。

## 许可证

BSD-3-Clause。零件（`generated/`）适配的上游库许可证见 `index/catalog.yml` 各条目。
