# dsh-assembler 路线图 v2(2026-08-23 深夜全面升级)

> v1(阶段 0/1 已完成:检索形态转正、context 补全、动用率、共享考官、persona
> 骨架、契约回归程序)见 git 历史。本版吸收三个输入重写:①泛化 agent 裁定
> (调用 AI 能力帮人解决问题的应用 = 泛化 agent,模型不再是强制中枢);
> ②邻域调研(shadcn registry/低代码死因/AI 生成器软肋/Expo CNG/n8n trigger,
> docs/research/absorb-lowcode-appframeworks.md);③Boris Cherny 减法哲学
> (unhobbling/消融/验证中心/模型代际耦合)与本季自证(每次做减法都赢了)。

## 北极星

**泛化 agent(AI 应用)的 verified assembly。**
一句话差异化:他们生成代码或隐藏代码;我们供应经过验收的零件,并为每一次
组合签发证据。

## 宪法(凌驾各阶段)

1. **耐久资产排序**:场景战役库与 eval 甲具 > 零件生态与质检门 > 证据台账 >
   代码闸门与确定性发射 >> 契约散文(易腐品,按代际到期)。投资照此排。
2. **减法纪律**(Boris + 本季 F>B>C/D 实证):散文契约只在"复现失败"后加,
   且必须带适用模型代标注;换模型先跑消融(BARE 模式)再决定去留。
   该删的是教流程的散文,该留的是代码化的门与环境——Claude Code 删剩
   (安全/权限/静态分析/UI)与我们的不变底座(闸门/发射/考官/前端)同构。
3. **验证中心**:独立考官(交付合格证)+ 自验证(交付物带体检包)双轨。
4. **两层身份**:供应链(服务一切 agent,含主 agent)+ 铸造(只为交出去的:
   无人值守/他人用/交付)。铸造不是个人即时需求的默认动作。
5. **安全往代码压**:prompt 层防线易腐,机器闸(秘密不落盘/DDL 双执行/路径
   穿越拒绝/字节代际)耐久——新增能力一律优先做成代码闸。

## P0|减法与耐久化(Boris 层,半天~一晚)

- **BARE 消融模式**:`DSH_ASSEMBLER_BARE=1` 剥除全部契约散文(基线判据/接力棒/
  范例文本),只留代码闸——我们的 CLAUDE_CODE_SIMPLE。
- **契约到期制**:每条承重句标注适用模型代(如 `@gen:deepseek-v4`);换模型时
  默认到期,消融轮(BARE vs 现契约,8 场景战役)裁定去留。prompt-regression
  程序补上"删"的半边。
- **自检包**:验收 PASS 的探针沉淀进 preset(`selfcheck.json`:探针计划+重跑
  方式)——交付的 agent/用户改 persona、升零件后可自跑体检,不必回找考官。
  探针从一次性考卷升级为随行测试套件(Bun 重写的教训:自验证手段是长跑前提)。
- 验收门:BARE 模式 8 场景消融跑一轮,出"每条散文的真实边际"报告。

## P1|泛化第一台阶:数据通路出模型(1-2 晚)

- **服务零件转正**:零件可声明 HTTP 面(book-intake 模式一等公民化:目录
  schema、发射接线、质检门含 fire-and-assert);前端模板可直调零件服务——
  **上传/解析/入库等确定性流不再过模型**。
- **三岔口路由**进架构检查点:app 型→服务化装配(或如实建议写代码);个人
  即时→主 agent 自己干(必要时自装备,可行性探明);无人值守/他人用/交付→铸造。
- **trigger 零件 ×2**(cron/webhook,n8n 课):无人值守泛化 agent 的入口件。
- **AI 能力零件化**:prompt+模型配置包成服务件(摘要/分章/文案),应用无会话
  调 AI;persona 降维为对话零件的配置。
- 验收门:**读书助手 app 形态重装对照**(vs 模型中枢版):epub 上传成功率、
  交互延迟、token 成本三指标翻盘。

> **执行状态(2026-08-24)**:P2 追加落地"配方零件"(via:'recipe' 第六种零件,
> penguin-harness 调研的大模块吸收①):recipes/<id>/ = 完整可跑 app 模板+参数槽+
> 声明式考卷;emit_app 哑实例化(app.config.json 注入、语料自包含、ingest 预跑、
> recipe.lock.yml)+ verify_app 独立考官(自拉进程黑盒考,凭证缺→接口模式
> SKIPPED)+ 入库门(index-add.mjs recipe <id>,同一台考官跑 sample 自证,
> templateHash 字节代际闸)。首方 rag-qa 入库(蓝湖样例 PASS;真语料 E2E:22 份
> 文档→125 块,黑盒真答带引用 PASS)。这是 P3 战③(vs Lovable)的地基。
>
> **公理与双面化(2026-08-24 晚)**:定则"泛化 agent 的 verified assembly,形态是
> 装配出来的结果,不是入口处的分类"——交付体 = 一本账 + N 张脸 + 每脸一考官
> (docs/parts-taxonomy.md 流角色×脸分类法,90 件全量归类)。四件套落地并实战
> 13/13(docs/campaigns/two-faced-delivery.md):①sqlite 服务脸(页面直连账,
> 确定性流零模型)②record-desk 记录形配方(schema 自适应,DB_PATH 共账)
> ③verify_shared_data 双面交接考(app↔agent)④cron-trigger 触发器(wire 开真
> 会话,无人值守闭环)。采购地图立"三级采购:采→转→造"(docs/research/
> parts-sourcing-map.md),adopt 门待开。

## P2|生态吸收(调研层,一周量级)

- **registry 联邦 POC**:shadcn registry 适配器进 induction,收 1 个外部
  registry、经质检门装出 1 张真页面。
- **scaffold-as-part**:web app-shell 一枚(官方生成器包成零件,门=create+
  build+start 探针)。
- **deploy 零件一枚**(静态托管):补齐"秒级预览→一键部署"环路(生成器
  阵营的强项吸收)。
- **反锁定卖点进 README**:毕业不受惩罚(零件真代码/组合可 diff/执行层框架
  无关)——低代码死因清单当反面教材明写。
- 验收门:一句话需求→含外部 registry 零件的 AI 应用→验收 PASS→一键部署。

## P3|范式两战(证明层,与 P1/P2 交错)

- **正赛①同日对照**:同批 agent 型需求,verified assembly vs vibe coding
  (Claude Code 直写)双路并跑——首日质量/验收覆盖/行为边界/耗时。P0 完即可开。
- **正赛②第 30 天战**:生命周期模拟(需求变更序列+目录演进注入),同名重装
  vs 重新生成——维护成本、行为漂移、零件升级红利。范式命题最强形态,从未测过。
- **复仇赛③app 型对照**:P1/P2 落地后,读书助手级需求 vs Lovable 同题——
  verified assembly 对生成器的正面战。
- 验收门:三战各出战役文档,数据进 bench/results/,输赢如实记(负结果照发)。

## P4|飞轮与规模触发(常态背景)

- **证据飞轮**:检索行加台账战绩(入选 N/PASS M);动用率进排序(死重零件
  信号);相似案例注脚(历史 PASS 选型当 few-shot)。
- **装配器 MCP 化**:三工具+考官打包成 MCP 服务器——任何 harness(Claude Code
  等)可用,分发天花板脱离 DSH;装配器成为自己生态的一个零件。
- **规模触发**(挂条件不挂日期):目录 >2000 条→向量混合召回 + match 复活为
  精排;同功能 >5/簇→聚类折叠;零件不全在本机→注册表化+按需安装;目录数千条
  →D(对话专家)复议。
- **移动车道**(远期):Expo CNG 对齐(app-shell+config-plugin+EAS 零件),
  不手包 RN 库。
- **真凭证端到端**(待用户配 env 扣扳机,runbook 就绪)。

## 永不做

手工包裹每个框架;可视化画布编辑器(低代码的坟);自建基础设施;为当代模型
写永久散文(一律带到期日);把铸造当个人即时需求的默认动作;在探针指令里
内嵌大载荷(已机械禁止)。

## 顺序建议

P0 → P1(读书助手翻盘)→ P3①(同日对照)→ P2 → P3②③ → P4 常态转。
每一步照旧:实测 → 战役文档 → 台账 → 提交。
