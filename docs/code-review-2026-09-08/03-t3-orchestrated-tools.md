# 深审：orchestrated-tools.ts 工具面

- 任务 key: `t3_tools` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t3_tools`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `surface`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_2c770f4e-4069-4187-bf80-8f671295e6bc', 'evidence_ad18f358-5718-488b-bd52-f53fb1fb24ee', 'evidence_d100da7e-5e23-468c-bd91-1772ce04630f', 'evidence_0a252499-1bf6-4a8b-a9ad-3521bba4dd25', 'evidence_a38beb4b-20cc-48c5-99f2-57a4940a5fb7']

---

# 深审报告：src/orchestrated-tools.ts（工具面）— task t3_tools / aud_surface
审查方式：纯只读。全程未修改任何文件。证据 = 本 attempt 的 host 记录 read/bash/grep 运行（全文 5 段通读 2312 行 + 依赖面 index.ts/verify.ts/scaffold.ts/frontend.ts 关键段 + tests-orchestrated.mjs/tests-frontend.mjs 逐段核对 + capabilities/生成件抽查）。工作树无 node_modules，tsc --noEmit 不可运行，故验证以源码读取与检索为准（A7 允许的 read/grep 类只读验证）。

## 1. 模块职责与架构定位
- 全仓最大单文件（2312 行）。定位：装配器「工具面」——13 个 host 工具的 defineTool 定义工厂 + 配套纯函数（校验/整形/闸）＋契约散文与接力棒常量。分工契约（头部注释 1-19 行）：search_catalog 机械检索、match_catalog 备用精排、emit_preset 哑发射、verify_preset 独立考官、verify_shared_data/verify_trigger 扩展考官、emit_app/verify_app/preview_app/deploy_app app 车道、add_knowledge/read_preset/submit_part 资源通道。哲学一致性极强：事实走代码闸，散文走 prose()/BARE 门（70-72），每份导出散文在 CONTRACT_TAGS 登记代际（81-86），测试用「概念账」钉数量。
- 注册协议：index.ts apply() 内 `ctx.tools.register(<definition>(ctx, config))` 共 13 处（index.ts:1451-1469），effect 标签 assembler.tool.*；off 形态全停（index.ts:1448-1470）。生态关系：ToolDefinition 来自 @deepseek-ai/dsh-tools（27 行）；Context/llm 来自 @deepseek-ai/cordis、aux 调用用 @deepseek-ai/dsh-llm BlockAssembler（24-26、255-278）；MCP SDK 在联邦列举与 submit_part 实探处动态 import（index.ts:1142-1144、orchestrated-tools.ts:2283-2284）；登记写目录走 scripts/index-add.mjs register（2237、2299）；js-yaml 全程做 YAML 安全读写。peerDependencies 声明与此文件 import 面一致。
- 数据流：工具参数（未知形状）→ 各自机械校验 → 纯函数整形/闸 → 落盘工件（agent.cordis.yml/parts.lock.yml/equipment/selfcheck*）→ 验收读取盘上工件（"考官只认工件"969-970 行）。

## 2. 发现列表（critical 0 / major 5 / minor 5 / nit 4）
严重度按「影响面 × 触发概率 × 是否有闸兜底」裁定；无 critical：本文件最危险的执行面（submit_part）是刻意设计的越沙箱通道，且有 smoke/实探闸兜底，故定 major 而非 critical。

### major
**OT-1 [major·健壮性/安全] submit_part 门禁 = 宿主级代码执行面且实探无超时**
- 位置：src/orchestrated-tools.ts:2249-2291（npm install 2269 无 --ignore-scripts、smoke 2274-2279、MCP 实探 2283-2291、env 全量 2286）。
- 现象：会话 agent 提交的字节（indexJs/smokeMjs/dependencies）在宿主进程内被执行：npm install 会运行依赖生命周期脚本；smoke 由 `execFileSync('node', ['smoke.mjs'])` 直跑（继承 process.env）；独立实探 `c.connect(...)`+`listTools()` 无任何超时（对比同函数内 npm 300s、smoke 180s 时限；对比 verify.ts 的 PROBE_RPC_TIMEOUT_MS/AUX 纪律），坏零件可让 listTools 永久不返回，工具调用无限挂起。
- 影响：被 prompt 注入的主 agent 可获得宿主级任意代码执行（本工具的意义即越会话沙箱，故该能力是特性；但门禁**无 secret-env 剥离、无网络隔离、无人工闸**，且坏零件可 DoS host 工具通道。
- 修复：门禁子进程按 SECRET_KEY_RE 纪律剥离 env（index.ts:761 已有同形正则可复用）、npm install 加 --ignore-scripts（或至少提示风险）、实探挂 AbortSignal.timeout 并在超时 kill 子进程、listTools 结果只回白名单字段。

**OT-2 [major·正确性/判定完整性] verify_preset 前端门与总判定脱钩，FAIL 可随 PASS 一起交付**
- 位置：src/orchestrated-tools.ts:1180-1190（前端门独立跑）、1254-1257（head 打「验收 PASS」）、1194-1201（记分板只记 verification.status）、1209-1218（台账/selfcheck 照落）、1182（index.html 不存在则门永不跑）。
- 现象：行为路径全 PASS 但 runFrontendGate FAIL（页面不可达/槽位未填/环路失败）时，结果头仍为「验收 PASS」，记分板与 last-verify.json 无任何 FAIL 痕迹；发射期 emitFrontend 失败（feErr，859-863）导致没有 index.html 的 preset，此后每次 verify 都直接跳过前端门。注释称前端验收是「同一张考卷」（1180），与判定口径矛盾。
- 影响：交付「脸坏了/没脸」的 preset 且官方口径 PASS；emit_app/deploy_app 的 presetVerdictGate（1604-1628）只读记分板，会把这种 PASS 当闸放行——P3「发射完成≠可用」哲学在页面维度失效。验收 PASS 的长期台账也失去页面健康信息。
- 修复：前端门 FAIL 时总判定不得 PASS（或记分板单列 FRONT_FAIL 门级行并令 head/contract 文本按门级真实汇报）；缺 index.html 但目录/锁显示本应兜底发射前端时给警告行。

**OT-3 [major·安全] verify_shared_data 的本机白名单可绕过（SSRF/伪造 PASS）**
- 位置：src/orchestrated-tools.ts:1373-1374（startWith 前缀校验），消费于 1408-1431 appSql/fetch。
- 现象：校验是 `startsWith('http://127.0.0.1:')` 字符串前缀而非 URL 解析。WHATWG URL 中 userinfo 位于主机名前：`http://127.0.0.1:80@<任意主机>/` 通过前缀校验，但解析后 host=<任意主机>（默认 80 端口）。fetch 会把 JSON {sql} POST 到任意内网/外网主机，远端可控应答（rows 含 payload）即可伪造 PASS（1430-1431 只判字符串包含）。
- 影响：「本机 app 地址」承诺失效；宿主出向任意 HTTP POST（SSRF 面，可打内网）；验收可被远端伪造，与「考官不许被刷」的纪律冲突（verify.ts 全文件把不可刷当第一性原理）。
- 修复：`new URL(u)` 后校验 protocol==='http:' && hostname==='127.0.0.1'，禁止 username/password，端口白名单可选。

**OT-4 [major·健壮性] add_knowledge 无尺寸纪律、失败留半包、空标记可空转检索门**
- 位置：src/orchestrated-tools.ts:2007-2024（递归无上限复制、扁平化改名 rel 可碰撞且静默覆盖、无 try/finally）、2027（全树文本常驻内存 + toLowerCase）、2030-2034（空串标记 includes('') 恒命中）、2038（仅检索门失败才 rmSync 清理）、770-775（emit 侧缺书闸只查 docs 目录存在性）。
- 现象/影响：超大文档集可 OOM 宿主；复制中途异常（磁盘满/权限）遗留半包目录，此后 emit_preset 会把它当完整知识包静默装进 preset（半包教材 = 交付物自毁）；同名扁平化碰撞使 docCount/totalBytes 与盘上不一致；mustInclude:[''] 空考题恒 PASS，检索门失去意义。
- 修复：字节上限与文件数上限；扁平化冲突报错；try/finally 清理（对照 2264-2267 fail() 模式）；标记复用 sanitizeMarks（verify.ts:283）式长度/内容闸；包内落 .knowledge-meta.json 完成标记，emit 端闸补查完整标记。

**OT-5 [major·安全（供应链）/设计缺口] 会话 agent 可无人复核地把内容/代码写进共享目录，且无标注流入后续模型上下文**
- 位置：src/orchestrated-tools.ts:2069-2074（capabilities.yml 直接追加条目）、2294-2308（零件自动 register）、316-319（buildMatchPrompt 把 description/tags 原样进 aux LLM prompt）、1323（检索结果行）、verify.ts:407（deriveProbe 工具清单含 description）。
- 现象：add_knowledge/submit_part 的条目文本与代码经门禁即入库，无人确认；条目里无 submittedByAgent 溯源字段（.index-meta.json 有，capabilities.yml 条目没有）。此后任何装配会话中这些 description/tags 无标注地进入匹配/检索/推导 prompt，零件代码进入每个挂载 preset 的会话进程。
- 影响：被注入的 agent（恶意文档/外部文本）可持久污染共享目录：description 里埋指令 = 对后续所有装配/验收模型的持久 prompt 注入；后门零件代码随交付扩散。目录越共享（团队/多用户）影响越大。
- 修复：能力条目加溯源（如 config.submittedByAgent + at）+ 人工确认点（或 host 级审批钩子）；prompt 侧对非人工审定条目渲染时加「机器提交、未审」标注；至少保留可见审计（现有 ledger 行不够醒目）。

### minor
**OT-6 [minor·安全纵深] verify_trigger 的 effectSql 只读闸是前缀正则**
- 位置：src/orchestrated-tools.ts:1521（`/^\s*(SELECT|WITH)\b/i`）。
- 现象/影响：`SELECT 1; DROP TABLE x` 一类的多语句串同样通过闸；当前被零件语义兜住——generated/sqlite-query/index.js:120 明确「多条语句 better-sqlite3 在此抛错」（本 attempt 抽查证实 /sql 单语句 prepare），故今天不构成写面，但只读承诺挂在零件实现上而非本工具；若 sqlite 面换成多语句执行的服务变体（mcp-servers 可配），承诺即破。
- 修复：闸内拒绝含 `;` 的多语句（或解析首语句后比对原文）；测试补「SELECT…;DROP」类用例。

**OT-7 [minor·行为/文档不一致] 沿用(carry)路径整段跳过前端门，与 verify.ts 注释承诺相反**
- 位置：src/orchestrated-tools.ts:1024-1032（carry 早退 return，无任何前端检查）；verify.ts:758-759（注释：沿用轮只跑门 1）。
- 现象/影响：同字节沿用 PASS 时页面可达性/槽位不再复核——页面若在窗口期坏掉（文件被误删、伺服回归），下一次真正的门要到 reverify 才发生；doc 说「沿用轮跑门 1」，代码没跑。
- 修复：carry 路径补一次廉价门 1（fetch + 槽位正则，verify.ts runFrontendGate 已有 loop:false 语义）。

**OT-8 [minor·健壮性] read_preset 部分分区读无防护，单点损坏毁整次读取**
- 位置：src/orchestrated-tools.ts:2145（agent.cordis.yml yaml.load 无 try）、2174（workspace/.service.json JSON.parse 无 try，由零件运行时写、可能半写/并发改写）、2163（selfcheck-history 解析有 try，风格不一致）。
- 现象/影响：.service.json 损坏或正在写时 read_preset 整体抛错，persona/ddl/bom 等健康分区全部丢失；2184-2188 的 frontend.source.json 已有防护范式，未推广。
- 修复：各分区独立 try/catch 降级为「(读取失败)」行。

**OT-9 [minor·可维护性/发布分叉] 运行期写面目录不在 package.json files 白名单**
- 位置：package.json:17-22（files 只含 lib/capabilities.yml/presets/frontends）；本文件写/读 REPO 下 knowledge/（2000-2060）、generated/ 与 scripts/index-add.mjs（2228-2305）、ledger/（212-214）、scaffold 隐含（46-48）。
- 现象/影响：以 npm 安装物（node_modules 只读）运行时 add_knowledge/submit_part/verify_trigger 的通道全部失效或写进共享 node_modules；检出版与发布版行为分叉。若本产品只在检出模式使用，应显式声明。
- 修复：files 增补运行面目录，或文档/README 明示「装配器以检出模式运行」，并把 REPO 依赖点集中可配。

**OT-10 [minor·正确性] parseMatchResponse 允许 coverage 行数超过 needs**
- 位置：src/orchestrated-tools.ts:370-389。
- 现象：模型多给的行（need 名不在需求清单但非空）会被原样计入 coverage → 其 capabilityId 进入 capabilityIds、gap 进入 missing——「exactly one row per need」整形未被机械执行；多给行可能给装配注入需求外的零件或缺口计数错乱。
- 修复：只收 need 属于 needs 集合的行（或按 index 截断到 needs.length），多余行丢弃并出声。

### nit
**OT-11 [nit] emit_preset 名称静默归一化**：validateEmitArgs:437-439 放行 'A Bot!'，发射层 777 静默改用 slug 'a-bot'，结果行只报 slug；两个拼写不同的名字可落到同一目录靠同名裁决兜底（不静默铸 -2）。建议 name!==id 时在结果行补「(已归一为 <id>)」。测试钉的是校验层保留原文（tests-orchestrated.mjs:91），非发射层，可安全加注。
**OT-12 [nit] 发射多文件无提交点顺序**：agent.cordis.yml（841）先于 preset.yml/parts.lock.yml（877-882）写，中途 fs 异常会留下 cordis 新代 + lock 旧代的混合代际对（概率低但正是本文件处处防备的「验中版本钉」反面）。建议以 lock 先写、cordis 最后写（提交点）或写前先渲染全部再批量落盘。
**OT-13 [nit] 主探针与 probes 重复无去重**：normalizeProbeSketchList（533-543）会把 probe 与 probes[0] 的重复对象都收进 sketchInputs，verify 1062-1071 只数总数不查重复，同卷重跑同路径烧双份探针预算；去重（按任务文本指纹）成本极低。
**OT-14 [nit] 残留/输入卫生**：verify_trigger finally 中 `void (Date.now() - t0)`（1575）是无意义表达式（死代码）；timeoutMs 参数（1563）无数值校验，NaN 传入会让 runTriggerProbe 预算变 NaN 并立即 FAIL（fail-closed 但报错信息误导）。建议删死行、加 Number.isFinite 校验。

## 3. 测试盲区（对照 tests-orchestrated.mjs 674 行 / tests-frontend.mjs 97 行）
已覆盖（钉得很密）：纯函数（normalizeSpecInput/buildMatchPrompt/parseMatchResponse/validateEmitArgs/deadKnowledgeError/normalizeProbeSketch*/partsUtilization/planToSketch/renderSelfCheck）、BARE/到期制/形态、契约承重句与 CONTRACT_ACTIONS 注册闸（653-668 行）、deploy_app 快照回滚 e2e（136-174）、search_catalog 执行面（接力棒/零命中/BARE，614-636）、add_knowledge 参数闸（609-611）、verify_trigger 负向闸（含 effectSql 只读拒收 DELETE）、presetVerdictGate 全分支（452-524 区）、概念账 13 工具钉（638-643）。
盲区：
1. **13 个工具的 execute 真跑面基本无覆盖**：verify_preset 判定组合（carry/草图过闸/降级推导/覆盖补考/预算截断/FAIL 证据梯）、verify_shared_data 全流程、verify_trigger 正路径、emit_preset 全流程、submit_part 门禁——均需真 ctx/webServer/零件进程，npm test 链全部缺席；OT-1/OT-2/OT-3 正是这些面上的缺陷，测试结构上拦不住。
2. **OT-2 前端门与判定组合**无测试（任何 verdict×feLine 组合断言不存在）；**OT-7 carry×前端**组合无测试。
3. **verify_shared_data 的 URL 守卫**只测到字符串前缀层？未见到 userinfo 绕过用例（搜遍无 '@' 用例）。
4. add_knowledge 只测了参数闸与目录条目钉，未测：检索门真跑/空标记/碰撞覆盖/半包清理（OT-4 全空）。
5. partsUtilization 未覆盖 p.serverName 存在但 tool 不带 mcp 前缀、tool 段含 '__' 的边界（256-257 只测了标准形）。
6. read_preset 仅测 frontend 分区（169-173），persona/ddl/bom/faces 分区与损坏降级无测试（OT-8）。
7. 集成性：npm test 全链跑 lib/ 构建产物（tests 顶部 import './lib/…'），构建先行（package.json test 首步 build），故 lib 缺失不会红——测试与源码映射由 build 保证，可接受；但工具 execute 的 ctx 依赖面没有任何 mock 契约测试（fakeCtx 只给 get/effect/tools.register）。

## 4. 文档声明一致性
- 文件头注释（1-19 行）所述工具分工与代码实现一一对应；「四臂删除/形态 search 唯一」与 assemblerMode()（185-187）、index.ts 注册面一致，tests 有钉。
- 差异点：① verify.ts:758-759 注释「沿用轮只跑门 1」与 orchestrated-tools.ts:1024-1032 carry 早退（门 1 也不跑）不符（OT-7）；② 1180 注释「前端验收(同一张考卷)」与判定脱钩（OT-2）；③ search_catalog 描述「zero LLM, instant, deterministic」与 execute 内 maybeWarnProseGeneration（1288）仅 console 不拦一致，无矛盾；④ BARE 语义（描述/回执散文可剥、事实保留）与 prose() 使用点抽查一致（tests 636 行钉住）。

## 5. 优点（供汇总参考）
闸文化贯彻最深：所有模型输入先机械整形、失败路径全部「出声不静默」、验收只认盘上工件、预算与路径上限处处在；sanitizePresetName 统一防路径注入（index.ts:741-749，本文件全部 presetId 入参都过它）；SECRET_KEY_RE 双闸（emit params、app params/scaffold SECRET_PARAM_RE）与凭证「只点名不值入账」纪律执行干净；错误信息几乎全部可行动（presetNotFoundError 1805-1816 带近邻提示）。总体是本仓库里「自己批判自己」密度最高的文件。

证据（本 attempt host 记录，read/bash/grep 全部只读）：run_031814b4 / run_0aaadbcd / run_27d35248 / run_5aa48940 / run_5b64dfa9 / run_5bde9edb / run_5cad99af / run_67ebae2b / run_6be070e6 / run_70e8f03b / run_8c1e5362 / run_8c697b34 / run_94180fde / run_949a40c9 / run_9b36ce6e / run_9e68012b / run_a06a0eea / run_bb599b55 / run_ee429453 / run_d908a5e9（覆盖：orchestrated-tools.ts 全文 5 段、index.ts 关键段 196-345/354-743/740-965/965-1145/1235-1340/1435-1487、verify.ts 228-428/688-968、tests-orchestrated.mjs 60-239/240-369/604-674、tests-frontend.mjs 全文、scaffold.ts materializeApp 段、generated/sqlite-query/index.js 抽查、package.json）。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_2c770f4e-4069-4187-bf80-8f671295e6bc`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bb599b55-d798-4e62-b66d-60e1bf8cbaf5", "run_031814b4-5c52-4e0a-8d4e-cd0bf795b17f", "run_5aa48940-6cd9-4e91-84ef-3b5fade4079e"]

[major·健壮性/安全] submit_part(2200-2312)把会话方字节当作门禁执行体:npm install 无 --ignore-scripts(2269,依赖生命周期脚本即宿主级代码执行)、smoke 直跑(2274-2279,180s 限)、MCP 实探 connect/listTools/close 全程无超时(2283-2291,对比 npm/smoke 均有 timeout;env: process.env 全量传入 2286)——坏零件可无限挂起工具调用阻塞 host;门禁进程继承宿主 env+网络。建议:门禁子进程剥离 secret 形 env、--ignore-scripts、实探挂 AbortSignal 超时并 kill。

### evidence `evidence_ad18f358-5718-488b-bd52-f53fb1fb24ee`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_031814b4-5c52-4e0a-8d4e-cd0bf795b17f", "run_70e8f03b-85db-49c8-beab-f3f23f337d24", "run_8c1e5362-a49f-4cad-9e54-152bda2a7a5c"]

[major·正确性/判定完整性] verify_preset 前端门与总判定脱钩:行为路径全 PASS 而 runFrontendGate FAIL 时 head 仍打「验收 PASS」(1254-1257),记分板/台账 verdict 只记 verification.status(1194-1201、1209-1218),前端 FAIL 无任何持久痕迹;frontend/index.html 缺失(发射期 feErr)则前端门永不跑(1182 存在性门槛)。「前端验收(同一张考卷)」(1180)语义与 PASS 头条矛盾,且 emit_app/deploy_app 的 presetVerdictGate(1604-1628)会把这种 PASS 当闸放行。建议:前端门并入总判定或记分板单列门级 FAIL,head 在门 FAIL 时不得写 PASS。

### evidence `evidence_d100da7e-5e23-468c-bd91-1772ce04630f`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_031814b4-5c52-4e0a-8d4e-cd0bf795b17f", "run_5aa48940-6cd9-4e91-84ef-3b5fade4079e"]

[major·安全] verify_shared_data 的「本机 app」白名单可绕过(1373-1374):校验是 startsWith('http://127.0.0.1:') 前缀而非 URL 解析。WHATWG URL 中 userinfo 在主机前,http://127.0.0.1:80@任意主机[:端口]/ 的 authority 解析为 userinfo=127.0.0.1:80、host=任意主机——前缀校验通过但 fetch 实际连任意主机/端口(默认 80),「127.0.0.1 限定」形同虚设;可对任意内网/外网主机发 POST /api/sql(SSRF 面),远端可控应答(rows 含 payload)可伪造 PASS(1430-1431)。建议:new URL() 解析后校验 protocol==='http:' && hostname==='127.0.0.1',并禁止 userinfo。

### evidence `evidence_0a252499-1bf6-4a8b-a9ad-3521bba4dd25`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bb599b55-d798-4e62-b66d-60e1bf8cbaf5", "run_ee429453-66fd-4af4-bfe3-aed1afa3377a", "run_031814b4-5c52-4e0a-8d4e-cd0bf795b17f"]

[major·健壮性] add_knowledge 入库无尺寸纪律且失败会留半包:整目录递归无上限复制(2007-2024,单文件整读+整写),语料整树 readFileSync+toLowerCase 常驻内存(2027);复制中途异常无 try/finally 清理(2038 仅检索门失败才 rm),遗留半包目录会被 emit_preset 的缺书闸放行——该闸只查 docs 目录存在性(770-775),后续装到 preset 的是静默截断的教材;扁平化改名(2020)同名源文件静默覆盖但 docCount/totalBytes 按覆盖前累计,台账与盘上不符。另 mustInclude 空串恒命中(2030-2034 includes('')),检索门可空转通过。建议:字节上限、冲突检测报错、finally 清理、复用 sanitizeMarks 级标记闸、发射端校验包完整性标记。

### evidence `evidence_a38beb4b-20cc-48c5-99f2-57a4940a5fb7`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bb599b55-d798-4e62-b66d-60e1bf8cbaf5", "run_5aa48940-6cd9-4e91-84ef-3b5fade4079e", "run_94180fde-ca0d-4b40-bef3-6ac513450196", "run_031814b4-5c52-4e0a-8d4e-cd0bf795b17f"]

[major·安全(供应链)/设计缺口] add_knowledge 与 submit_part 让会话 agent 在无人复核下把内容/代码自动写进共享目录:capabilities.yml 条目直接追加(2069-2074),零件代码经门禁即自动 register(2294-2308)。这些 agent 可控文本随后**无标注**流入后续装配的模型上下文:buildMatchPrompt 的 tagsIndex(318,description/tags 原样进 aux LLM prompt)、search_catalog 结果行(1323)、deriveProbe 工具清单(verify.ts 407)——被注入的主 agent(或恶意文档)可向共享目录植入持久 prompt 注入与后门零件,影响此后所有装配与交付会话。建议:入库条目加 submittedByAgent 溯源与人工确认点,description/tags 进 prompt 时带来源标记;代码入库维持现状则需配套审计与告警。
