# 深审：tests-*.mjs 测试闸门与文档声明一致性

- 任务 key: `t6_tests` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t6_tests`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `ops`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_b210ef7a-f972-4398-992c-4c1d1cbfe439', 'evidence_5a64afa8-5321-4eb3-ac65-9fd700af4c14', 'evidence_55807969-d6a4-493b-a038-5de1cd60c929', 'evidence_b9c2570f-0b60-4836-89ef-5d0c37e88264']

---

# 深审报告：tests-*.mjs 测试闸门与文档声明一致性（A6 / t6_tests）

审查方式：全程只读。13 个 tests-*.mjs 逐文件通读（共约 1650 行），package.json 闸门链、README.md/README.zh.md/DESIGN.md 声明比对，配套只读验证：node --check 13 文件全部通过；grep/awk 计数对照（toolRunIds 见本 attempt：run_d13f5726/run_03c618d8/run_085a0c6d/run_ae2eb749/run_314b0261/run_1665ace8/run_a52229a2/run_9d6b63d6/run_d77de2c5/run_f6b83406 等）。

## 一、闸门链总览与逐文件职责

npm test（package.json:28）= `npm run build` → `lock-check` → `catalog-report --check` → 13 个测试文件（&& 链，首个失败即断）。13 闸全部是**自实现 check 计数 + process.exit** 形态的离线单测（except 少量 127.0.0.1 本机 HTTP/sqlite fixture）：

| 文件 | 职责（被测面） | 断言风格 |
|---|---|---|
| tests-arch-probe.mjs (58行) | checkArchProbe/validateArchProbe 直构闸 6 组规则 + 拒绝理由文案 + 封装一致（:52-55） | 行为级，正反两向 |
| tests-capability-index.mjs (62) | tokenize/rankCapabilities + loadCatalog 真目录召回 | 行为 + 真数据抽查 |
| tests-catalog-layer.mjs (184) | extends 分层/覆盖/隔离/环与深度/dedupeRowsById/catalogChain/knowledgeLocatorText | 行为级，fixture 全 |
| tests-equipment.mjs (87) | validateStateSchema 词法门、installStateEquipment、emitPreset env 注入、BOM equipment | 行为 + 真写盘 |
| tests-federation.mjs (71) | serverCacheKey 失效语义（文件触碰/目录抖动/非路径 arg）、toolsToEntries 确定性、不可达 stdio 剔除 | 行为级 |
| tests-frontend.mjs (97) | 模板库健全/SDK 蒸馏、fillTemplate/emitFrontend no-op、路由安全包含闸（遍历/编码/点文件/嵌套）、直播台、lib/client.js 产物 | 行为 + 真文件 |
| tests-incremental.mjs (114) | sameConceptOnDisk、carryDecision 判定矩阵、台账 roundtrip、persona 回读、usage 计量、目录指纹 | 行为级矩阵全 |
| tests-naming.mjs (170) | sanitizePresetName/suffix/emitPreset 字节确定性+serverName 代际、screenParams 秘密键拒、@@WORKSPACE@@、reconcileCapabilityIds、发射闸、缺件工单 | 行为级，覆盖密 |
| tests-orchestrated.mjs (674) | 工具面纯件（归一/prompt 契约/响应整形/校验）+ DOM 考卷 + 考场服务器 + deploy/emit/verify_app 门 + 全库纪律扫描 + 概念账计数 + 数据抽查 | fixture+真数据+源码文本钉 |
| tests-proving-grade.mjs (201) | bench 判卷器 ensembleChecks 12 kind 正反干跑、gradeBoundary 边界法（node:sqlite 真库） | 行为级 |
| tests-spec-intake.mjs (116) | specBaseUrl 方言矩阵 + hasBody/params（仅内联形状） | 行为级 |
| tests-verify.mjs (192) | evaluateProbe 归一化通道、writePresetFile 幂等、marksPresent/evaluateScenario、lintPersona、stripSecretEnv、collectRequiredSecrets、知识包装、sendTurn 三义务 | 行为级 |
| tests-yaml-write.mjs (87) | s() 标量往返 20+ 危险字符、assertYaml 拦坏文本 | 行为级，含真实事故形状 |

**优点（先讲）**：整体水平高——判定矩阵型用例（incremental:73-81 对 TTL/时钟倒挂/坏台账全覆盖）、真实事故回放（yaml-write:28-29 OSV 许可证、verify:21-23 reader-b 假红、catalog-layer:138-139 duplicate loader）、"报错即界面"文案断言（arch-probe:52-54、equipment:55-58）、字节确定性/代际语义（naming:60-66）、安全包含闸覆盖编码遍历（frontend:67-72）、对 SKIPPED/BYPASS 等反作弊语义的钉子（proving-grade、orchestrated:477-519）。失败语义全部真实（exit 非零），无"永远绿"测试。

## 二、发现列表（按严重度）

### major

**M1 [文档声明一致性] README 能力目录计数陈旧且全链无闸** — README.md:21、:172、README.zh.md:21、:174 均称 "90 parts / 244 tools — 66 library / 19 service / 5 first-party"；实测 index/catalog.yml 为 103 行 / 311 tools / 71 库型 / 27 服务型 / 5 第一方（grep 计数：`^- id:` 103、`kind: service` 27、`repo: first-party` 5、工具行 311；数值自洽 71+27+5=103）。差：零件 +13、工具 +67、服务型 +8，中英双份四行全过期。违反仓库自身两条声明：catalog-report.mjs:3-7"过期的清单比没有清单更坏"、DESIGN.md:63 负面清单 5"没账本不写 README"。catalog-report --check（scripts/catalog-report.mjs:58-62）不比对 README；13 个测试无一覆盖。修复：README 目录段构建期注入（catalog-report 直写），或 --check 增"README 内嵌片段 === 生成输出"比对（与 t5 m7 同源）。

**M2 [闸门盲区] shipped 数据三向一致性无测试闸，且已有真实违例未被拦** — index/catalog.yml:11-12 与 capabilities.yml mcp-servers 段注释都自称"一一对应"，但测试只做抽查（tests-orchestrated.mjs:588-589 七个新件、:579 kg-memory）。实测 id 集合当前干净（103/103 catalog 行均有 mcp-servers 键，多余键仅 filesystem，comm 双向往返），但 t1_arch 已证（evidence_e5ab8665）capabilities.yml:769-776 sms-gateway/mobi-parser 两条 via:'mcp' 条目无 config.server——选中即静默不发射——真实漂移发生过、零闸拦截，"一一对应"声明无机械保证。修复：新增 shipped-catalog 一致性闸（每个 via:'mcp' 条目 config.server ∈ mcp-servers；mcp-servers 键 ↔ catalog 行 ↔ generated/<id> 双向完备），进 npm test。

### minor

**m1 [漏报面] tests-spec-intake 无 $ref 用例，文件头自述的不变量无防护** — tests-spec-intake.mjs:66-111 全用内联参数（OSV 形状直接内联 :74），无 `#/parameters/...` 引用、无 HEAD/OPTIONS 方法边界；t5 实测的 $ref 失真（spec-intake.mjs:46-57：body-$ref → hasBody:false、params 输出 "undefined(undefined)"）在此闸全绿下通过——:7-9 声明的不变量 2（"要 body 的端点必须被标成要 body"）对最常见的 Swagger 引用形态无测试防线。修复：补 $ref 解析用例（含 body-ref 判真）与 method 枚举边界用例。

**m2 [漏报面] readSecret 全库纪律扫描有假阴性** — tests-orchestrated.mjs:546-553：offender 条件 = 直读 && **整文件**不含 'function readSecret('；同文件定义 helper 后对其它声明密钥直读 process.env 不再报；正则漏 `process.env["X"]`（双引号）与解构取值。该扫描是"声明凭证的零件都经 readSecret"（:553）的唯一机械保证，直读与 helper 并存的零件（scaffold 工单鼓励 readSecret 单函数形态）可绕过。修复：逐直读取点断言（剥离 helper 定义后重扫），或按需覆盖双引号/解构形态。

**m3 [盲区] 纯中文名的下游兜底无测试** — tests-naming.mjs:19 断言 sanitizePresetName('网页研究助手')===''（把空串固化为正确结果），但 13 个文件没有任何用例证明发射链在 name='' 时给出可用非空 preset 名（emit_preset 入口校验 validateEmitArgs 只查 name 存在性，tests-orchestrated.mjs:80-81）。全中文装配是真实场景（该测试自己用的例子），建议补一条 emit 级用例钉死兜底（fallback 名/拒绝时机），否则空名可能直通文件系统路径。

**m4 [健壮性] 测试普遍依赖 cwd=仓库根 与构建顺序** — tests-capability-index.mjs:43 `join(process.cwd(),'capabilities.yml')`；tests-frontend.mjs:27/89 读 'frontends/...'、'lib/client.js'；tests-orchestrated.mjs:124-126/131/395/532/553/565/578/594/641/658 读 capabilities.yml/index/catalog.yml/src/*.ts/generated/*；各文件头部注释均声明"先 npm run build"、npm test 链（package.json:28）保证顺序，但单独运行/换 cwd 时以误导性 ENOENT 报错。修复：统一以 import.meta.url 定位仓库根（如 tests-capability-index.mjs 已有 lib 导入路径可复用）。

**m5 [可维护性] 概念账钉用源码文本计数实现，误报漏报同存** — tests-orchestrated.mjs:643 `ctx\.effect\(\(\) => ctx\.tools\.register\(` 计数 ===13、:644-646 via 联合类型行正则解析、:650 CONTRACT_TAGS 长度 4、:599-600 speech-io/vector-store 工具数硬编码 4、tests-frontend.mjs:22 七模板 only 子集断言。意图正当（数概念不数行），但文本/计数断言对格式化（换行、引号风格）假红，对写法变体（如经变量间接 register、新增工具面用不同调用形态）可漏数——"想改这些数字先过第八条"的门会被偶然重排误伤、也会被风格规避。修复：改为对注册数据结构（工具定义表/via 判别联合的 AST 或导出常量）断言。

**m6 [边界诚实但易误读] 链上无任何 LLM/真会话/目录级回归** — tests-orchestrated.mjs:5-6 自述"LLM 调用与探针执行不在此测"（诚实）；DESIGN.md:49 四级验收中"目录级（bench 回归）"不进 npm test（tests-proving-grade.mjs 只干跑判卷器 fixture，非真实战役），README.md:479 亦把 npm test 界定为 unit-test chain——而 README 正文（:26-44 assemble-then-verify/独立探针/真实会话）与 DESIGN 的黑盒验收叙述会让读者误以为 CI 保护这些保证。建议在 README 测试段明示"真会话探针/目录级回归 = 战役制，不在 npm test"。

### nit

- 临时目录泄漏：tests-catalog-layer.mjs:29 mkdtemp 后无任何 rmSync（每次 npm test 留一个目录树）；tests-proving-grade.mjs:18 fixture 根 F 同样不清理（内含 sqlite 文件）；其余 7 个用 mkdtemp 的文件均有清理。
- tests-verify.mjs:119-121 直接写删 process.env.SLACK_BOT_TOKEN，若其间抛错环境不还原（当前代码路径不会抛，属卫生问题）。
- tests-federation.mjs:56 的 rmSync 发生在最后一个检查（:61-68）之前，其后异常即残留。
- tests-frontend.mjs:92 client half `length < 20000` 字节上限随产物增长会假红（无注释说明余量依据）。
- tests-equipment.mjs:66 硬编码 '/tmp/ws-eq/workspace' POSIX 路径；tests-naming.mjs:47/63/83 '/tmp/ws-...' 同——仓库现面向 macOS 开发机，可接受，注明即可。
- tests-orchestrated.mjs:147/485 用固定历史日期 '2026-08-31' 写 selfcheck 台账——若 future 引入台账 TTL 语义（carryDecision 已有 TTL 概念，tests-incremental.mjs:73-81），该 fixture 会在 2026-09-30 后假红；建议用 Date.now() 相对时间。

## 三、README/DESIGN 声明一致性与盲区清单（除上述 M1/M2/m1-m6）

| 声明（位置） | 实际覆盖 | 结论 |
|---|---|---|
| 确定性发射/同输入同字节（README:479 附近；naming:60） | tests-naming.mjs:59-66 字节级+serverName 代际 | ✓ 覆盖 |
| 锁一致性/可移植（README:479；lock-check 用途） | npm test 链含 lock-check（package.json:28），但只查根锁（t5 m1：嵌套锁无闸） | △ 部分 |
| proving-grade/判卷语义（DESIGN:49） | tests-proving-grade.mjs 12 kind 正反干跑 | ✓ 覆盖（干跑级） |
| 凭证永不进 preset/零字节残留（DESIGN:145；README credential 段） | tests-verify.mjs:100-127、tests-naming.mjs:69-76 | ✓ 覆盖 |
| 独立验收=黑盒、考官独立（DESIGN:300；README:44） | 纯函数级（sendTurn/evaluateProbe），真会话不在链 | △ 边界诚实 |
| capabilities↔catalog 一一对应（两数据文件头注释） | 无闸；真实违例已发生（t1 evidence_e5ab8665） | ✗ 盲区（M2） |
| 双次执行门"在内存库连续执行两遍"（DESIGN:226） | tests-equipment.mjs:22-28 只测词法 validateStateSchema；无测试把 DDL 真跑两遍 | △ 盲区（建议补 node:sqlite 双执行用例，proving-grade 已示 node:sqlite 可用） |
| check-all SKIPPED 语义（DESIGN:100-102） | 无测试（check-all 不在 npm test 链）；语义靠 scripts/index-add.mjs 注释与实现 | ✗ 盲区（可抽出纯判定函数测） |
| README 目录计数（:21/:172 等） | 无闸且已过期 13 件/67 工具/8 服务 | ✗ 盲区（M1） |
| 前端模板与目录能力一一可选（frontends/ 8 模板 vs capabilities 8 条 template:） | tests-frontend.mjs:22 只查七模板在库；无"模板↔catalog 条目↔测试钉"闭环 | △ 部分（磁盘另有 reader-upload-web-ui 目录无 catalog template 条目，语义未明） |

## 四、结论

测试闸门链是这套"有过教训、制度化快"的仓库里最成熟的部分：13 个文件全部是行为级断言、失败语义真实、判定矩阵与事故回放型用例密度高，tests-orchestrated 与 tests-proving-grade 甚至做到了"对 shipped 数据与 bench 判卷器做 fixture 干跑"的层次。主要短板集中在**对 shipped 数据/文档的闭环闸缺失**（M1 计数、M2 三向一致性——且 t1 已证明此类漂移真实发生过）、**两处扫描/方言盲区**（m1 $ref、m2 readSecret）与**cwd/构建产物隐式依赖**（m4）上；补测优先级建议：shipped-catalog 一致性闸 > spec-intake $ref/方法边界 > README 同步 > readSecret 假阴性 > 纯中文名兜底。全程只读合规，未修改任何文件。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_b210ef7a-f972-4398-992c-4c1d1cbfe439`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_d13f5726-4b6b-4880-803c-d14f06186e38", "run_03c618d8-e4fc-4b24-86ab-ea23c5888e71", "run_085a0c6d-9d1a-4aae-8378-437dac16e95d"]

[major·文档声明一致性] README 能力目录计数陈旧且全链无闸:README.md:21、README.md:172、README.zh.md:21、README.zh.md:174 均称 "90 parts / 244 tools — 66 library / 19 service / 5 first-party";实测 index/catalog.yml 现为 103 行 / 311 tools / 71 库型 / 27 服务型 / 5 第一方(grep 计数:^- id: 103、kind: service 27、first-party 5、工具行 311)。README 自身哲学(catalog-report.mjs:3-7"过期的清单比没有清单更坏")与 DESIGN.md:63 负面清单 5"没账本不写 README"均被违反;catalog-report --check(scripts/catalog-report.mjs:58-62)只查 DOMAINS 归类,13 个 tests-*.mjs 无一比对 README 片段与 catalog.yml 同步——计数两语言双处过期、服务型差 8 个、工具数差 67。修复:README 段改为构建期由 catalog-report 注入,或 --check 增加"README 内嵌片段===生成输出"比对。

### evidence `evidence_5a64afa8-5321-4eb3-ac65-9fd700af4c14`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_ae2eb749-2d8b-4d93-85d5-fb6e7cea5537", "run_314b0261-b683-4775-9aeb-e194710d29eb"]

[major·闸门盲区] shipped 数据三向一致性(catalog.yml ↔ capabilities.yml mcp-servers ↔ 目录条目 config.server)无任何测试闸:两文件头均自述"一一对应"(index/catalog.yml:11-12 与 capabilities.yml mcp-servers 段注释),但 13 个 tests-*.mjs 只做存在性抽查(如 tests-orchestrated.mjs:588-589 七件抽查、:579 kg-memory 出处)。实测 id 集合当前干净:103/103 catalog 行均有 mcp-servers 键、多余键仅 filesystem(comm 对比),但 t1_arch 已证实的真实违例(sms-gateway/mobi-parser 两条 via:'mcp' 条目无 config.server,选中即静默不发射,见 evidence_e5ab8665)说明此类漂移真实发生过且零闸拦截——与"一一对应"声明直接矛盾。修复:新增 shipped-catalog 一致性测试(每 via:'mcp' 条目必须 config.server∈mcp-servers;mcp-servers 键与 catalog 行双向完备;generated/<id> 存在性),进 npm test。

### evidence `evidence_55807969-d6a4-493b-a038-5de1cd60c929`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_1665ace8-54f2-4e21-adc5-4e1d966f68ef", "run_a52229a2-9ac1-406c-ba9a-7b9d1ac77f0c"]

[minor×3·断言漏报面/盲区] (a) tests-spec-intake.mjs:66-111 全部用内联参数形状(OSV 形状的 parameters 直接内联),无 $ref 参数用例、无 HEAD/OPTIONS 用例——t5 实测的 $ref 参数失真($ref body 参数 → hasBody:false、params 出现 "undefined(undefined)",spec-intake.mjs:46-57)在该闸全绿下通过,文件头 :7-9 自述的不变量 2 形同虚设,修复:补 $ref/引用解析用例与 method 枚举边界;(b) tests-orchestrated.mjs:546-553 readSecret 全库纪律扫描:usesHelper 是整文件级 'function readSecret(' 存在性布尔,同文件定义了 helper 又直读 process.env.X 的零件不报;正则亦漏 process.env[\"X\"] 双引号与解构写法——"声明凭证的零件都经 readSecret"保证有假阴性面,修复:按读取点逐一断言或剥离 helper 后重扫;(c) tests-naming.mjs:19 把 sanitizePresetName('网页研究助手')==='' 固化为正确行为,但 13 个测试中没有任何用例证明纯中文需求在发射链下游会得到非空可用 preset 名(兜底/拼接在何处、何时发生)——全中文输入是装配真实场景(页面/agent 名称),建议补一条发射级用例钉死兜底行为。

### evidence `evidence_b9c2570f-0b60-4836-89ef-5d0c37e88264`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_9d6b63d6-07bc-42fa-a380-18611a8bf58f", "run_d77de2c5-4b8f-4fbd-95d0-af1ca6c1a69b", "run_f6b83406-6fa7-4840-867b-dfc88517ff9a"]

[minor×2+nit×3·可维护性/健壮性] (a) 13 个测试普遍以进程 cwd=仓库根为前提读相对路径/templates:如 tests-capability-index.mjs:43 join(process.cwd(),'capabilities.yml')、tests-frontend.mjs:27/89 'frontends/_vendor/…' 与 'lib/client.js'、tests-orchestrated.mjs:124-126/131/395/532/553/565/578/594/641/658 的 capabilities.yml/index/catalog.yml/src/*.ts/generated/* 相对读取——npm test 链(package.json:28,先 build 后各测试)能保证,但单独跑或换目录即错,报错形式是误导性的文件缺失而非 cwd 提示;另多文件读 lib/*.js 隐式依赖构建顺序(各文件头均有注释,链条保证);建议统一用 import.meta.url 定位仓库根。(b) 源码字符串计数/硬编码数断言(tests-orchestrated.mjs:643 ctx.effect…register 计数=13、:646 via 联合行解析、:650 CONTRACT_TAGS 4 条、:599-600 speech-io/vector-store 工具数=4、tests-frontend.mjs:22 七模板子集断言)作为"概念账"钉有意识引入,但以正则/子串匹配源码文本实现,格式化换行即假红、变体写法可绕过计数——误报与漏报同存,建议改为对注册表数据结构断言而非文本计数。(nit) tests-catalog-layer.mjs:29 mkdtemp 全程无 rmSync、tests-proving-grade.mjs:18 fixture 根不清理(equipment/federation/verify/incremental/frontend/naming 均有清理)——每次 npm test 泄漏两个临时目录树(含 sqlite db);(nit) tests-verify.mjs:119-121 直接写/删 process.env.SLACK_BOT_TOKEN,若中间断言抛错环境不还原;(nit) tests-federation.mjs:56 清理发生在最后一项检查之前,其后代码抛错即残留。
