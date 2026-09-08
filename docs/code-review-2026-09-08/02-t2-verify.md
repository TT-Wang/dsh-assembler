# 深审：独立审查器 verify.ts 与 proving-grade

- 任务 key: `t2_verify` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t2_verify`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `core`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_58dd51ac-142f-4c07-8276-756a2a98969b', 'evidence_32bc5149-ccbe-4615-8856-18f64490362c']

---

# 分模块深审报告：独立审查器 src/verify.ts（968 行）与 proving-grade 语义边界

审查任务：task …_t2_verify / attempt_edbf707f；纯只读（verify.ts 全文件 3 段整读 + tests-verify.mjs 全读 + tests-proving-grade/tests-equipment 断言大纲检索 + 跨文件调用点 grep；tsc 因工作树无 node_modules 未跑，全部论断行级可复核）。
证据：evidence_58dd51ac / evidence_32bc5149。

## 0. 模块概览：职责、数据流、与"独立考官"定位一致性

- **纯判定件**（无副作用）：ProbeSpec/ScenarioTurn/ScenarioSpec/TurnResult/ProbeResult 类型（:23-109）、marksPresent（:194-203，精确子串 + 排版归一双通道）、canonMark（:185-187）、evaluateProbe（:206-208）、evaluateScenario（:218-220）、sanitizeMarks（:283-289，2-60 字符/≥2 相连字母数字汉字/截 3）、probePayloadViolation（:243-247，≥200 连续 base64 形字符硬闸）、mergeToolsUsed（:154-162）、aggregateToolCalls（:112-121）。
- **探针推导件**（aux LLM）：callDeriver（:343-377）、parseModelJson（:385-397）、deriveProbe（:400-431）、deriveProbePlan（:506-585，single/scenario 形状裁决 + 坏稿降级单轮）、deriveCoverageProbes/parseCoverageProbes（:437-484）；常量 PROBE_TURN_BUDGET_MS=240s（:133）、PROBE_RPC_TIMEOUT_MS=30s（:177）、VERIFY_MAX_PATHS=4（:141）、VERIFY_EXTRA_PATH_SOFT_BUDGET_MS=480s（:148）、AUX_CALL_TIMEOUT_MS=0（:307，用户裁定不设兜底闸，注释完整记录风险）。
- **探针执行件**（真会话黑盒）：openProbeSession（:621-625）、sendTurn（:650-696，turn/end 计数定界 + 动作流 + 20s 心跳 + 问人即判负三义务）、runProbe（:716-740）、runScenario（:792-851）、runFrontendGate（:761-790，页面可达 + 会话环路两门）、runSharedDataProbe（:873-911，writer 写→reader 读跨 preset 共享库）、runTriggerProbe（:919-968，打一发+轮询效果落库）。
- **判定协议**：PASS/FAIL/SKIPPED/ERRORED 四态（:63-109 文档极清晰：SKIPPED=设计内无事可验，ERRORED=探针没跑起来=交付失败，注释带"三个未挂载 agent 曾报 ok:true"的历史教训）。判定只读回复文本（黑盒，不审轨迹）；PASS 的沿用语义由 carried 标志如实携带（:93-101）。
- **独立性声明核验**：成立。verify.ts 不 import scaffold/arch-spec（仅 import wire.js、index.js 的 CapabilityEntry 类型、cordis/dsh-llm）；scaffold.ts → verify.ts 的单向借用（runScenario/sanitizeMarks）与 arch-spec.ts → verify.ts 的纯类型借用（ProbePlan）都保持"考官判定不含装配器任何发射逻辑"的边界。探针走 host 公开 wire 契约（:7-12），与用户会话同一表面——"这里过 = 用户会话那样过"成立，代价是 preset 车道考官依赖 host 存活（与 scaffold app 车道考官自拉进程互补，README/DESIGN 定位一致）。
- **架构观察（供 t7 汇总）**：proving-grade 的"判卷语义"（ensembleChecks/gradeBoundary，kinds：trigger-verified/shared-db-alerts/same-account-binding/kb-two-packs/regen-lineage/dom-examined/not-a-copy/bom-contains/part-utilized/iteration-not-rebuild/snapshot-chain/published-page/upstream-alive——见 tests-proving-grade.mjs:34-184）实际住在 **bench/lib/proving-grade.mjs**；verify.ts 提供探针原语与标记判定基元。验收判卷层（bench）与探针层（src/verify.ts）分居两目录，单文件审查到此为止，两者间的证据契约（ProbeResult/台账/轨迹）需 t7 交叉核对。

## 1. 按严重度分级发现列表

### critical
（无。判定路径无代码执行面、无凭据接触；标记匹配逻辑经双通道归一有防御；exec/spawn 面不在此文件。）

### major
（无达到 major 的独立缺陷：文件内最强的三个问题均为资源/语义边界的 minor，且最敏感的两个假阳面——reasoning 文本进 reply、标记空串——分别有架构注释假设与上游 sanitize 兜底，需补测试钉死而非即刻修复。若 wire 帧语义与 :587-593 注释不符（reasoning 以 text 块送达）经实测坐实，见 m1 升级为 major。）

### minor

**v1 [minor·资源泄漏] 缺省 cwd 的探针工作区永久残留**
- 证据：verify.ts:14（fs 仅 import mkdtempSync）、:621-625 openProbeSession `cwd ?? mkdtempSync(join(tmpdir(),'assembler-probe-'))`；src/ 全树无该前缀清理（orchestrated-tools.ts 亦无，grep 证实）。
- 影响：每次缺省 cwd 的探针（含 agent 轮内写入的全部夹具/产物数据）在 /tmp 无界累积，长驻 host 磁盘渐满；探针产物（可能含用户数据副本）无过期即残留。修复：session close 后按创建路径 rmSync（或调用方显式传 workspace，缺省路径至少登记待清）；补生命周期测试。

**v2 [minor·错误语义塌缩] runTriggerProbe 盲发：preset 挂载失败不可探，ERRORED/FAIL 折叠**
- 证据：verify.ts:937-946 events:false 订流被关、不订阅会话错误；:952-967 只轮询效果；失败理由（:967）把"agent 没干活/表列名不对/根本没挂上"混为一谈。
- 影响：presetId 打错/预设不可挂载时，探针烧满 240s 预算后以泛化 FAIL 收场——与 ProbeResult 文档（:73-79）刻意区分的 ERRORED（探针未跑成=交付失败）语义矛盾；无人值守第四格的误诊会把"装配没验成"报成"装配没通过"。修复：events:false 之外保留最小错误通道（订流只消费 session 错误帧，或 prompt 后一次延迟探活会话状态），挂载失败尽早以 ERRORED 面返回。

**v3 [minor·入口防御缺口] 空串标记恒命中；runners 对空场景/空标记无入口断言**
- 证据：marksPresent（:194-203）`hay.includes('')===true`，对 mustInclude 含 '' 直接全过；runScenario（:792-851）对空 turns 直接 evaluateScenario(…,0) 判 FAIL 且无 reason；runProbe/runScenario 不校验 mustInclude 元素非空——全链路依赖上游 sanitizeMarks（:283-289）与 checkArchProbe/scaffold 的调用前检查，verify.ts 自身作为公共 API 无防御。
- 影响：直接调用（未来新调用方/tests 外的宿主面）可空转通过或给出无因 FAIL；纵深防御缺一层。修复：marksPresent 对空串/空集标记返回 false 并在入口 validate（场景≥1 轮、每轮 mustInclude≥1 非空）。

**v4 [minor·测试盲区→假阳面敞口] 判定所依赖的帧类型契约未被任何测试钉死**
- 证据：sendTurn（:676-683）把轮内全部 assistant/message 文本帧 join 为 reply 并据此判标记；注释（:587-593）断言 reasoning 是独立块型、不会进 reply；但 tests-verify.mjs 的夹具只喂单一 text 块（:181-182、:172-174 等），无 reasoning 块、无多 assistant 消息帧、无帧乱序用例。
- 影响：若 wire 实际把推理内容以 text 型块送达（注释假设不成立），思维链里出现的标记即可假 PASS——这是验收欺骗最敏感的假阳面且当前零检测。修复：tests-verify 增两类夹具（reasoning 块进 reply 必须判 FAIL 或明确过滤、同轮多条 assistant 消息的拼接语义），把帧形状契约固化成测试。

**v5 [minor·可维护性] aux 模型默认值三处各持一份**
- 证据：verify.ts:354-355（provider ?? 'deepseek-official'；model ?? 'deepseek-v4-flash'）与 index.ts:50-53 Config 文档、orchestrated 工具定义各写默认，模型名换代需多处同改。
- 影响：低（配置可覆盖），但硬编码模型 id 属可漂移事实；建议默认值收敛为单处导出常量。

### nit

**n1** parseModelJson（:385-397）：剥围栏后取首 `{` 至末 `}`——模型一次返回多段 JSON 或尾部散文含花括号时，解析失败报错只带开头 160 字符，定位靠猜。属可接受降级，建议报错带上 `{` 之后与 `}` 之前的定位线索。
**n2** sendTurn（:659-695）1s 轮询粒度：轮预算存在 ±1s 粒度误差，恰在边界完成的轮会被判超时；turn/end 在超时瞬间后 ≤1s 到达同样判超时。建议退出循环前做最后一次扫描再定超时。
**n3** deriveProbe/deriveProbePlan/deriveCoverageProbes（:400-585）三份 prompt 各自拼规则子集 + 范例 + MARK_RULES，重复面大；形状约束与段落序（缓存工程）建议收敛为共享 prompt builder，降低三处漂移。
**n4** marksPresent 的 canonMark 字符类（:186）只含空白/常见标点，不含 %、#、$ 等符号：标记 '7.1%' 回复 '7.1 %' 归一后 '71%' vs '71%' 恰好命中，但 'a#b' 与 'a # b' 类变体不归一——行为保守（宁假红不假阳），注释补一句即可。

## 2. 测试盲区清单（只读对照 tests-verify.mjs / tests-proving-grade.mjs / tests-equipment.mjs）
- tests-verify.mjs 覆盖质量高：判定纯件（大小写/归一/子串/空集恒假/中文标记 8 项）、writePresetFile 幂等、renderPartsLock、persona lint、stripSecretEnv/collectRequiredSecrets（含 optional）、installKnowledgePacks（含缺书上报）、sendTurn 三义务（mock 帧：问人判负/正常取回/预算耗尽）。缺：marksPresent 空串标记、reasoning 块与多 assistant 帧（v4）、canonMark 的 %/# 边界、sendTurn 帧晚到/乱序、prompt() 抛错的传播。
- runProbe/runScenario 多轮语义（turn/end 计数、中途失败 stops、轮间状态连续性）在 npm test 闸内**零直接覆盖**（tests-verify 只单轮 mock）；runFrontendGate/runSharedDataProbe/runTriggerProbe 零覆盖——这些原语只在 bench/装备层经真实 host 间接使用，回归保护依赖 bench 而非闸门（t7 可建议补契约级 mock 测试）。
- tests-proving-grade.mjs 全面覆盖 bench 判卷 kinds（含触发落库/共享库/血缘/字节绑定/防抄写等 19 项正反例）与 gradeBoundary/termHit 边界——它验证的是"判卷器",不是 verify.ts 的"探针执行器"；二者间的探针→证据→判卷数据契约（toolsUsed/台账/utilization）无专门的契约测试。
- tests-equipment.mjs 覆盖 validateStateSchema 负清单与 installStateEquipment 全路径（含 sharedDb 绝对路径断言）——与 verify.ts 无直接接口。

## 3. 模块质量结论
verify.ts 是仓库里文档-实现一致性最好的文件之一：判定协议四态语义、沿用不冒充、探针预算的战役取证、直播台三义务、载荷硬闸与标记消毒机械闸全部"注释即设计、实现即执行"，纯函数与副作用边界干净，单测覆盖其纯件面。问题集中在执行件边界：资源生命周期（v1）、盲发盲等（v2）、入口防御（v3）、帧契约未钉（v4）与默认值漂移（v5）——均不构成 critical/major，但 v4 若与 wire 实际帧语义不符会直接威胁"假 PASS"防线，建议最先补帧型夹具实证。proving-grade 判卷层在 bench/lib（本任务范围外），verify.ts 只供原语——t7 汇总时应把 bench 判卷与 src 探针的契约单独列为交叉核对项。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_58dd51ac-142f-4c07-8276-756a2a98969b`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_e701fb55-37cc-4a5b-8922-9e53b26c64d4", "run_ef44edce-65fd-4bbd-ad23-dc4527c03033", "run_17a03b58-9f68-4803-ae03-9a523caf4922"]

[minor×3·verify.ts 资源与语义] (1) 探针工作区泄漏:openProbeSession(verify.ts:621-625)在 cwd 缺省时 mkdtempSync(join(tmpdir(),'assembler-probe-')),全文件唯一 fs import 是 mkdtempSync(:14),src/ 内无任何 rmSync/清理,调用方 orchestrated-tools.ts 也从不清理该前缀目录(grep 证实)——每次缺省 cwd 的探针(含 agent 在轮内写出的全部夹具数据)在 /tmp 永久累积,长驻 host 上无界增长。(2) runTriggerProbe 盲发盲等:events:false 且不订流(937-946),preset 挂载失败/ID 打错无任何错误可探——openProbeSession 的会话错误通道被关掉后只剩轮询效果,坏 preset 烧满 240s 预算并以"agent 没干活?"类泛化理由 FAIL(:967),把 ProbeResult 文档(73-79)刻意区分的 ERRORED(未验)与 FAIL(验不过)折叠成同一 pass:false。(3) 入口防御缺口:marksPresent(:194-203)对空串标记恒真(hay.includes('')===true),runScenario/runProbe(:792-851/716-740)不对空 turns/空 mustInclude/空串标记做入口断言(空场景直接 evaluateScenario 判 FAIL 且无 reason;空标记全靠上游 sanitizeMarks 兜底)——直接调用时验收可空转通过。修复:session 结束/close 时清理工作区(或由调用方显式传 cwd);trigger 模式保留最小错误面(订流只看 session 错误帧或 prompt 后延迟探活一次);入口统一 validateScenario/validateMarks。

### evidence `evidence_32bc5149-ccbe-4615-8856-18f64490362c`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_1a9c138d-ec90-4317-9405-d2fb3f710bb5", "run_3f911a23-631c-48e3-b5a7-c4ac9bb33a92", "run_b78de559-b371-4139-9bb2-701884d13de8", "run_0c5a0b0c-bd66-4d2e-aa9d-cccda40f2e8f"]

[minor×2+nit×3+架构观察·verify.ts] (4) 判定面的帧类型契约未被钉死:sendTurn 把轮内全部 assistant/message 文本帧 join 成 reply(:676-683)并据以判标记,而注释(:587-593)声称 reasoning 是独立块型不会进 reply——但测试夹具(tests-verify.mjs:181 等)只喂 text 块,无任何用例带 reasoning 块/多 assistant 消息帧;若 wire 把推理以 text 型块送达,藏在思维链里的标记即可假 PASS(这是验收欺骗最敏感的假阳面)。建议在 tests-verify 加两种帧型夹具钉死契约。(5) 派生器默认模型/供应商硬编码 verify.ts:354-355('deepseek-official'/'deepseek-v4-flash'),与 index.ts:50-53 Config 文档及 orchestrated 调用点各持一份默认,模型名换代须三处同改,漂移风险(nit:deriveProbe/deriveProbePlan/deriveCoverageProbes 三份 prompt 各写一遍规则子集+范例,重复面大,建议把形状约束收敛成共享 builder)。nit:parseModelJson(:385-397)剥围栏后取首 { 到末 }——模型一次返回多段 JSON/尾部散文含括号时解析失败的报错只含开头 160 字符,定位靠猜(可接受的降级但脆);sendTurn(:659-695)1s 轮询粒度使轮预算有 ±1s 粒度误差,恰在边界完成的轮会被判超时。架构观察:proving-grade 的判卷语义实际在 bench/lib/proving-grade.mjs(ensembleChecks/gradeBoundary;tests-proving-grade.mjs:34-184 的 trigger-verified/shared-db-alerts/regen-lineage/dom-examined/not-a-copy/part-utilized/iteration-not-rebuild 等 kind),verify.ts 只提供探针原语与标记判定基元——验收判卷层与探针层分居两目录,单文件审查时该边界需在 t7 汇总中显式标注(本任务范围只到 verify.ts,不做 bench 判定审查)。测试盲区:runProbe/runScenario(多轮 turn/end 计数)/runFrontendGate/runSharedDataProbe/runTriggerProbe 在 npm test 闸内零直接覆盖(tests-proving-grade 测的是 bench 判卷 kind,不是这些原语);marksPresent 空串与未消毒标记、canonMark 的 %/# 等非标点符号边界均无用例。
