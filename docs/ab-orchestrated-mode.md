# A/B 实验设计:编排模式(orchestrated)vs 流水线模式(现状)

状态:**已实现,首轮 10 场景 A/B 已跑完——B 臂胜**(质量 10/10 vs 9/10、墙钟 −32%、
主 agent 思考 −24%、真义警两臂均 0)。终表与判读见 docs/campaigns/ab-orchestrated-10.md;
转正前待补:草图通过率、FDE 探底、复跑确认方差。2026-08-23。
本文档是实现的唯一依据——写到不依赖对话上下文也能直接开工的程度。

## 实现落点(2026-08-23)

- 三工具:src/orchestrated-tools.ts(match_catalog / emit_preset / verify_preset,
  全部薄封装现有机制;emit 另收 sharedDb 绝对路径参数 = B 臂 FDE 最小使能)。
- flag:DSH_ASSEMBLER_MODE=orchestrated 注册三件并**不注册** assemble/assemble_solution
  (两臂互斥);默认模式行为零变化。
- 流程契约双腿:工具描述(教流程)+ 每个结果尾部【接力棒】段落(F6 证明的
  决策点新鲜契约);verify FAIL 附外科选单与红线。
- 单测:tests-orchestrated.mjs 28 项(spec 归一/匹配 prompt 契约/响应整形+id 调和
  +漏行补缺口/emit 入参机械校验/sharedDb 路径闸/草图归一/模式开关);13 套件全绿。
- B 臂账本:ledger/orchestrated.jsonl(每工具调用一行,elapsed+usage)。
- 甲具:scratchpad/run-orch.mjs(B 臂驱动:扮演"看过架构,继续"的用户 + ask 解锁
  保释)、run-campaign.mjs 加端口参数与主 agent token 采集(两臂同尺)、
  sweep-orch.mjs(五维对比表)。
- host:3095 = A 臂(满档,今日构建)、3098 = B 臂(orchestrated);3096/3097 是
  旧演示 host 不动。场景集:scratchpad/ab-scenarios-arm{A,B}.json(10 个代表,
  需求文本一字不差,name 加 aa-/bb- 前缀防两臂同名互踩)。

## 用户裁定(原话要义)

> assembler 的能力边界要有非常明显的限制——它是一个插件,就该做一项工作。
> spec 让主 agent 做,传递给 assembler;assembler 负责选型;
> 然后主 agent 再负责组装、补上差件等等。

即:**assembler = 零件专家**(唯一认识零件库的人,选型是它的全部智力);
架构的智力、编排的智力全归主 agent。

## 目标架构(B 臂)

```
主 agent(编排者,全套 harness,对用户可见可问)
│
├─ ① 出 spec:架构需求清单、数据模型、工作流、接口
│     (对话里当着用户做,用户可当场改架构)
├─ ② match_catalog(spec) ───→ assembler 唯一的智力工作:
│     ← 每条需求 → 零件id 或 GAP    "需求→零件"映射
├─ ③ 组装决策(主 agent):persona 怎么写、stateSchema 怎么定、
│     名字、缺件先补还是先装
├─ ④ 补差件:照工单造零件入库(自愈,已实证)
├─ ⑤ emit_preset(ids+persona+schema+name+params)
│     ──→ 哑工具:确定性印刷 + 全部闸门(无智力)
└─ ⑥ verify_preset(presetId) ──→ 独立考官:黑盒探针
      ← FAIL 带证据;⑦ 重试策略归主 agent(外科手术式,不再盲重试)
```

## 两条不动的公理(已与用户对齐)

1. **发射是哑工具,不是主 agent 手写文件**。原因是 cordis 物理:host 对
   serverName 进程级永不释放 → "字节决定名字"的代际哈希必须由确定性代码执行;
   手写文件一次就撞代际、废台账。emit_preset 保留全部闸门(秘密剥除/YAML 校验/
   schema 双次执行门/persona lint),但零智力——主 agent 决定打什么,它只保证打得对。
2. **验收独立**。verify_preset 是独立考官:主 agent 可调、可拿证据,不能判卷。
   两臂共用同一张考卷(同一套探针机制),否则 A/B 数据全废。

## 三个新工具(B 模式,flag 后面)

flag:`DSH_ASSEMBLER_MODE=orchestrated` 才注册(与现有 assemble/assemble_solution 并存,
默认不开;A 臂 = 现状 pipeline 不动)。

### 1. match_catalog(assembler 的一项工作)
- 入:`{ spec: { capabilities:[{name,why}], dataModel?, workflow?, interfaces? }, requirement }`
- 内部:现有 llmMapRequirement 瘦身版——**只出映射**,不产 persona/name/stateSchema/前端
  (那些归主 agent 了)。保留:GAP DISCIPLINE、逐条覆盖或标缺口、id 调和、UI≠browser。
- 出:`{ coverage: [{need, capabilityId|null, gap?}], capabilityIds, missing, missingEntries }`
- 预期副产:输出砍大半 → 选型 200s 降到 ~60s 级(打法 C 白拿)。

### 2. emit_preset(哑工具)
- 入:`{ name, capabilityIds, persona, stateSchema?, params?, frontendTemplate? }`
- 内部:现有 emitPreset + installStateEquipment + emitFrontend + 命名裁决(显式名撞
  不同概念仍拒绝)+ 工单落盘 + BOM。全部闸门保留。
- 出:preset 路径、前端 URL、gaps 工单路径、BOM 摘要。
- 注意:不做选型、不做验收、不写 persona——缺什么参数就报错让主 agent 补。

### 3. verify_preset(独立考官)
- 入:`{ presetId, probe? }`——probe 可由主 agent 提供草图(它最懂用户意图,出题人≠
  施工人,合法),过 validateArchProbe 机械校验;不给或不合格则 assembler 自己推导。
- 内部:现有 runPlan 机制原样(真会话、workspace cwd、240s/轮、问人判负、动作直播、
  归一化标记匹配)。**不自动重试**——FAIL 直接带证据返回(探针原文、差哪个标记、
  agent 回复摘录),重试决策归主 agent。
- 出:PASS/FAIL/SKIPPED + 证据 + 台账写入(PASS 时)。

工具描述要教会主 agent 整条流程契约(spec→match→组装决策→(补件)→emit→verify→
FAIL 则外科决策),并保留行为红线(不手改 preset 文件、不翻装配器源码)。

## A/B 甲具与指标

- 场景:市场战役库挑 10 个代表(记账/客服/合同/知识库/数据分析/看板/研报/翻译/
  医院导诊/HR)+ 1 个 FDE(供应链或电商班子)。
- 驱动:复用 scratchpad/run-campaign.mjs 双臂各跑(B 臂 prompt 引导走编排流程);
  sweep-campaign.mjs 出对比表。
- 指标五维:
  1. 质量:PASS 率、首探通过率、缺口真假(对照架构需求清单人工判)
  2. 成本:**两边 token 都记**——aux 账已有;主 agent 侧从会话 usage 事件累计
     (甲具要补:驱动器对 session 的 usage chunk 求和)
  3. 时间:端到端墙钟 + 分段
  4. 纪律:义警事件数、可复现性(同需求重跑选型一致性)、跳步(不验收就交付)
  5. 交互:反问次数与质量(B 臂独有价值:装配前架构可被用户审)
- 判定:B 赢 → 转正为默认模式;输 → 留档负结果(与方向 4 同款诚实)。

## 预期(押注,待打脸)

- B 赢在:缺口质量(架构可审)、重试效率(外科 vs 盲试 297s)、义警动机消解
  (名正言顺编排,不需越权)、选型段耗时(输出瘦身)
- B 险在:墙钟(多次工具往返串行)、可复现性(persona/决策变主 agent 雪花)、
  成本转移(flash 辅助调用 → 会话主模型)、编排纪律

## 实现顺序

1. src/orchestrated-tools.ts:三工具薄封装(全部复用现有内部机制,不发明新东西)
2. flag 注册 + 工具描述流程契约
3. 驱动器补主 agent token 账(usage 事件求和)
4. 单测:match 瘦身输出形状 / emit 缺参报错+闸门仍全 / verify 不重试带证据
5. 双臂跑 10+1 场景 → sweep 对比 → 判定

体量参照:约等于 assemble_solution 那次(一晚)。
