# 深审：核心装配链路 index/arch-spec/scaffold/capability-index

- 任务 key: `t1_arch` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t1_arch`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `core`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_e5ab8665-e6ab-4225-943b-177c9b6e1751', 'evidence_7013d2b0-0382-4cbd-93f9-608d3f4da5fd', 'evidence_a2824648-3e32-4637-8f72-bf495d049256', 'evidence_cf633a3e-8ffc-4c5a-8dbf-8b11c30272b5', 'evidence_0256423a-ef12-4cbd-8794-2b555f737b31']

---

# 分模块深审报告：核心装配链路（src/index.ts、src/arch-spec.ts、src/scaffold.ts、src/capability-index.ts、src/js-yaml.d.ts、capabilities.yml 消费侧）

审查任务：task …_t1_arch / attempt_db64a96e；纯只读（read/grep/bash 只读探针，无任何写操作；tsc 因工作树无 node_modules 依赖不可解析而未跑，关键论断均由逐行读取与检索支撑）。
证据：发布见 evidence_e5ab8665 / evidence_7013d2b0 / evidence_a2824648 / evidence_cf633a3e / evidence_0256423a。

## 0. 模块概览：职责、依赖方向、数据流与 DESIGN.md 一致性

- **src/index.ts（1487 行）**——装配核心的"确定性一半"（文件头自述）：目录加载与联邦（loadCatalog/catalogChain/federateMcpTools/toolsToEntries）、确定性发射（emitPreset + assertEmittedPreset + screenParams/applyParams + serverName 代际后缀 + writePresetFile）、BOM（renderPartsLock）、缺件工单（renderGapWorkOrder/writeGapWorkOrders/renderMissingDraft）、知识包（installKnowledgePacks/knowledgeLocatorText）、装备槽（validateStateSchema/installStateEquipment）、验收台账（VerifyLedger/carryDecision）、以及插件接线 apply()。它与 orchestrated-tools.ts 的边界干净：本文件纯函数/确定性；工具定义与"编排智力"在 orchestrated-tools（外部引用仅第 19-20 行的工具定义与前端路由）。
- **src/arch-spec.ts（92 行）**——架构 spec 形状（ArchSpec）与探针草图机械校验闸（checkArchProbe/validateArchProbe）。数据流位置：spec（主 agent 经 OrchSpec 递入）→ 机械闸 → 合格直接构造 verify.ts 的 ProbePlan（省 LLM 推导）；不合格返回 null+why，由考官回退 LLM 推导。与 verify.ts 的单向类型依赖（import type ProbePlan）方向正确。文件头历史注记与 DESIGN「架构优先：先出 spec」一致；"报错即界面"的 why 设计与宪法第二条一致。
- **src/scaffold.ts（858 行）**——app 车道的底盘（emit_app/verify_app/preview_app/出厂门四件事 + 共享考官件 makeSub/faceSql/assertEffect/acquireSqliteFace/hashLockPaths/hashTemplate）。宪法第九条后"唯一底盘"定位与 scaffold/scaffold.yml（id scaffold-react, version 6, 六道门）一致；"考卷是声明式 check、安全往代码压"与 DESIGN「验收从外面立契约」一致。
- **src/capability-index.ts（96 行）**——search_catalog 的机械检索后端（tokenize/rankCapabilities），词袋+IDF、tag×3/desc×1、注释把设计裁定（lexical 不上 embedding）与 A/B 历史讲清楚；确定性、可单测。
- **src/js-yaml.d.ts（5 行）**——CJS js-yaml 的 minimal ambient 声明。load 返回 unknown、dump 返回 string，形状保守正确；仓库确实未装 @types/js-yaml，此声明是必要补丁（可维护性 OK）。
- **capabilities.yml（788 行，消费数据）**——24 行起 mcp-servers（104 个 server，路径/command/env/requiredSecrets/serviceAnnounce 声明），600 行起 capabilities（frontend×8、knowledge×3、package×3、harness×4、persona×2、via:mcp×2 等）。

spec→arch→scaffold→verify 链路的实际走向：主 agent 产出需求与 spec（含 probe 草图，arch-spec.ts 机械校验）→ emit_preset 经 index.ts 确定性发射 → verify.ts 黑盒探针验收（preset 车道）/ scaffold.ts 六门考官（app 车道）。capability-index 供 search_catalog 检索选型。依赖方向：index.ts → arch-spec/capability-index（纯函数）；orchestrated-tools → index.ts 全部；verify.ts 与 arch-spec/scaffold 互相只借类型与共享件（makeSub 等抽到 scaffold.ts 供 dom 门复用）——整体模块边界与 DESIGN.md 的三件本分/负面清单（不编排、不在运行时在场、不自产能力、不碰凭证明文、不无证宣称）一致。js-yaml 全程 yaml.load（无 schema/无代码执行），JSON 路径均 try/catch。

## 1. 按严重度分级发现列表

### critical
（无。未发现可直接被外部利用的注入/RCE/凭证明文泄漏面：execFileSync/spawn 全部数组参数无 shell；凭据形状闸双向存在；YAML 解析无代码执行。下述 major 是该模块最重问题。）

### major

**M1 [major·正确性/数据-发射一致性] shipped catalog 两条 via:mcp 静态条目无 config.server，选中即静默空发射**
- 证据：capabilities.yml:769-776（sms-gateway、mobi-parser 均为 `via: mcp` + description/tags，无 config 键）；同名 mcp-servers 键存在于 capabilities.yml:460-473 与 475-478。发射端 src/index.ts:422-424：`selected.filter(c=>c.via==='mcp').map(c=>c.config?.server ?? '')` 再 `filter(server !== '' && mcpServers[server] !== undefined && …)`——server 为空/未注册的能力被静默剔除，不产生任何 mcp-client 行。BOM 侧 src/index.ts:1256-1265：server '' 时 nameFor 找不到前缀 → `part.plane = 'host'`（而 host 平面实际什么都没挂），供应链记录与事实相反。
- 现象/影响：search 可检得、可被选中的"发送短信/解析 MOBI"能力，装配"成功"而 preset 里没有任何对应行；verify 探针失败也只会呈现为泛化的能力不达。违反 capabilities.yml:12-15 头部注释自述的 "connection config must exist under mcp-servers" 不变式。根因是 loadCatalog（index.ts:196-221）与 emitPreset 均无"via:mcp 条目必须可解析到真实 server"的结构闸（整条发射链对 YAML 条目零形状校验）。
- 修复建议：在 loadCatalog（或 emitPreset 的 usable 过滤处）加完整性校验：via==='mcp' 且 (config.server 缺失或不在 mcp-servers) → 装载/发射报错点名条目；或给两条数据补 `config.server`。补测：对 shipped capabilities.yml 断言每条 via:mcp 条目 config.server 可解析（当前测试面全用合成 catalog——tests-capability-index.mjs:25、tests-naming.mjs:39 等，无一处读真实 catalog 校验该不变量；grep 全部 tests-*.mjs 无 sms-gateway/mobi-parser 引用）。

**M2 [major·健壮性/考官进程面] scaffold 考官三处 spawn 无 'error' 监听、stdout 管道无人消费**
- 证据：src/scaffold.ts:432-438：`spawn(startArgv[0], …)` 只挂 `child.stderr.on('data')`，无 child.on('error')，stdout 走 'pipe' 从不读；同类 247（sqlite 服务脸自拉）与 634（ai 服务脸自拉）也无 error 监听、spawn 前不检查 generated/<id>/index.js 存在性（grep 证实全文件仅 srv.on('error') 一处监听，位于 364 getFreePort）。generated/ 不在 package.json files 发布清单。
- 现象/影响：startArgv[0]（如 npx/node）缺失 → spawn 异步 emit 'error'，无监听器 = 进程级未捕获异常：独立考官不给 FAIL 证据而是整个装配器（host 插件进程）崩溃；stdout 不消费，输出超管道缓冲会堵死被测 app 子进程造成 waitReady 假超时/误杀；零件文件缺失时同样崩溃而非可行动报错。这与考官"考完给可行动证据"的定位直接冲突。
- 修复建议：统一 spawn 封装——child.on('error') 将 ENOENT 转 FAIL 证据并带 stderr；stdout 改 'ignore'（或 drain）；自拉零件 spawn 前 statSync 校验入口存在并给出"缺 generated/<id> 应跑 index-add/install"提示。补测：mock 缺失 start 命令断言返回 FAIL 而非抛未捕获异常（现有 tests 无 spawn error 路径）。

### minor

**m1 [minor·验收信任面] verify ledger 与工件同目录、无完整性绑定，可被伪造/回滚**
- 证据：src/index.ts:853（VERIFY_LEDGER_FILE='last-verify.json'）、887-895（loadVerifyLedger 只验 presetSha256/status/verifiedAt 形状）、897-899（saveVerifyLedger 直接覆写）、905-918（carryDecision 只按 sha+TTL 判定沿用）。台账与被验 preset 同一目录（调用侧 dir = preset 目录）。
- 现象/影响：能写 preset 目录者（交付写手本就有该权限）可预置/回滚一份 sha 匹配、PASS、verifiedAt 新鲜的台账，使 verify_preset 不经真实探针即报"沿用 PASS"；同字节重放的沿用也无法区分"真跑过"与"复制来的"。DESIGN「四级验收，全部黑盒」「验收从外面立契约」在此边界无实现保障。
- 修复建议：台账放 host 侧独立位置或加 host 签名（最少：沿用证据里带上生成方痕迹）；验收文档明示该信任边界。补测：篡改/伪造台账后 verify 必须走真实探针的用例。

**m2 [minor·文档-闸面一致性] skeleton-lock 的锁定面比声称窄，pages-lint 出网纪律可绕过**
- 证据：scaffold/scaffold.yml:43-44 声称"写手自由区之外的一切"被锁、自由区只有 src/pages 与 PAGE-SPEC.yml，而 lockPaths（45-56）未含 package.json/package-lock.json/app.config.json，也未覆盖实例根上任意新增文件；src/scaffold.ts:145 walkFiles 跳过全部 '.' 前缀条目（锁目录内点文件增改不可见）；pages-lint（466-520）只扫 src/pages 下的文件。
- 现象/影响：写手（LLM）可改 package.json 增依赖/脚本（如引入 axios）并在自由区页面里调用——页面 lint"禁裸 fetch/离线交付"纪律被绕过且 skeleton-lock 全绿；app.config.json（装配参数注入件）也可被改而不被察觉。
- 修复建议：把 package.json 等骨架文件纳入 lockPaths（ingest 先于哈希执行，时序已安全）；或把"锁定面 = lockPaths 清单"写清楚到 scaffold.yml 注释，避免过度承诺。补测：改 package.json 后 runAppSelftest 应 FAIL 的用例。

**m3 [minor·一致性] DSH_HOME 默认值在 preview 与 selftest/dom 之间不一致**
- 证据：src/scaffold.ts:578 与 691 的默认 presetRoot 走 `process.env.DSH_HOME ?? join(homedir(),'.dsh')`；779（runAppPreview 的 presetDir）只 `join(homedir(),'.dsh',…)`，忽略 DSH_HOME。
- 影响：设了 DSH_HOME 的 host 上 preview_app 去错目录找配套 preset → 服务脸静默降级、预览"无脸"。修复：三处统一走同一 helper。补测：设 DSH_HOME 后 preview 指向正确目录的用例。

**m4 [minor·正确性] static-reach 只真取前 20 个引用资产，PASS 证据却称"全部可取"**
- 证据：src/scaffold.ts:535 `for (const u of refs.slice(0, 20))`；545 PASS 证据 `…+ ${refs.length} 个引用资产全部可取`。
- 影响：>20 引用的页面第 21 个起断链仍 PASS，证据文本与事实不符（证据文化受损）。修复：证据如实写"前 20 个"或全量取（加超时预算）。

**m5 [minor·正确性] runAppSelftest 不核对 lock.scaffold/lock.version 与当前底盘的一致性**
- 证据：src/scaffold.ts:402-407 只验 lock.scaffold 是 string 就放行，随后 406 loadScaffold(默认 SCAFFOLD_DIR) 用**当前**底盘考卷与 lockPaths 判定实例；materialize 时 lock 记了 scaffold/version（332-340），哈希只保骨架字节不保考卷语义。
- 影响：底盘升版后老实例被新考卷/新 lockPaths 判定；跨底盘 id 实例也可能错配考官。修复：验收前比对 lock.scaffold/lock.version === spec.id/version，不符即报"先 fresh 重印"。

**m6 [minor·健壮性] catalog 条目零形状校验，脏数据可让 search_catalog 崩溃**
- 证据：src/capability-index.ts:19-31 tokenize 对 tags/description 直接调用 .toLowerCase/.matchAll（string 假设）；loadCatalog（index.ts:196-221）对条目零校验（tags 非数组/元素非 string、description 缺失等均直接透传）。客户端 catalog（catalogs/<client>）是受支持扩展面。
- 影响：tags 含数字（YAML tags: [2024]）或 desc 缺失 → rankCapabilities 抛 TypeError，检索面整段不可用。修复：loadCatalog 归一化条目形状（String() 包裹、缺失默认），与 M1 的结构闸一并做。

**m7 [minor·健壮性] nameFor 前缀匹配歧义 + serverName 长度无闸**
- 证据：src/index.ts:1253-1255 `serverNames.find(n => n.startsWith(`${server}-`))`；serverName 生成 441-442/456（`${server}-` + 8 hex），host 上限 32 字符只见于注释 419-420。
- 影响：server 键存在前缀关系（x 与 x-y）时 BOM 的 serverName 可能张冠李戴（当前仓库 104 键已核无此碰撞，但客户端 catalog 可触发）；server 键 >23 字符时发射成功而 host 挂载拒收（注释声称"不同文件字节 ⇒ 不同 serverName"可挂，超长即破）。修复：nameFor 改精确解析（行文本 serverName: "…" 后按已知 server 集合精确匹配）；发射前校验 serverName ≤32。

**m8 [minor·安全(边界)] gap 工单文件名与缺件草案对 LLM 字段无形状闸**
- 证据：src/index.ts:1405-1407 `join(gapsDir, \`${i+1}-${draft.id}.md\`)`，draft.id 未经任何清洗（含 `/`/`..` 即可越出 gaps/，多段 `..` 可越出 presetDir）；renderMissingDraft（1414-1433）把 id/description/tags 原样拼进可复制 YAML。
- 影响：主 agent（LLM）产出的 missingEntries 若被 prompt 污染或幻觉出路径形 id，工单可写到 preset 目录外（内容为 md 文本，属同用户越界写）。修复：对 draft.id 应用与 PRESET_ID_RE 同款或 kebab 形状闸，超界拒绝并报错。

### nit

**n1 [nit] catalogChain 与 loadCatalog 对 extends 环语义分裂**：index.ts:188-194 遇环静默返回截断链（还会在链里重复出现环首文件），196-203 抛错。同一输入两种行为；BOM 的 index 读取路径（orchestrated-tools.ts:868 消费）会静默拿到残缺供应链记录。建议 catalogChain 复用 loadCatalog 的环检测。

**n2 [nit] installStateEquipment 的 sharedDb 不强制绝对路径**：index.ts:714-715 `opts.sharedDb ?? join(...)` 直接透传，docblock（683-687）声称"钉到这个绝对路径"；相对 sharedDb 会在 host cwd 造目录并把相对路径写进 env（正是该函数注释痛斥的病）。修复：`resolve(opts.sharedDb)` 后校验 isAbsolute。

**n3 [nit] SECRET 形状正则双份拷贝、子串匹配 + 静默剔除**：index.ts:761（SECRET_KEY_RE）与 scaffold.ts:41（SECRET_PARAM_RE）同式两份，漂移风险；子串匹配（auth/secret/token…）会把 AUTHOR_*、AUTH_MODE 之类合法键一并拒/剔除，且 stripSecretEnv（index.ts:484-492）剔除时零日志——目录维护者看不见自己的 env 键消失。建议收敛为共享模块一份正则 + 剔除时 console.warn。

**n4 [nit] emitPreset 强制 tool-cs 行不参与 presetRows 去重**：index.ts:391-393 生成的 `- id: tool-cs` 行与 extraRows（394-400）分道渲染；客户 presetRows 若自占 id tool-cs（或 name '@dsh-external/dsh-cs-tools'），发射出重复 loader id → host 拒挂整份 preset（assertEmittedPreset 只查 YAML 可解析不查 id 重复）。建议把 packageRows 并入 dedupeRowsById。

**n5 [nit] carryDecision 对坏日期误报"过期"**：index.ts:913-915 中 verifiedAt 不可解析（age=NaN）与真实过期的 why 同为"台账已过期"，误导排障（实为文件损坏/手改）。建议分别报"台账日期损坏"。

**n6 [nit] arch-spec 运行时容错缺口**：src/arch-spec.ts:53-87——kind 非 'single' 的任意值静默走 scenario 分支；marks 与 token 同值/互为子串的边界依赖 sanitize 兜底（verify.ts:283-295 slice(0,3)）与第 70-74 行的 includes 子串判断，行为正确但无注释说明；tests-arch-probe.mjs 覆盖了 6 组规则（自给自足/复述/过短/消毒/理由），未覆盖坏 kind、marks==token、中文标记大小写外边界。均为低风险补注释+补用例。

**n7 [nit] materializeApp 未知参数键静默丢弃**：scaffold.ts:285-289 只按 spec.params 提取，调用方多传的键被忽略（typo 键若恰好满足其它必填会静默失配）。建议对未声明键报错或警告。另 scaffold.ts:705-706 SIGTERM 后 2s SIGKILL 只杀直接子进程，`npx vite preview` 的孙进程可能残留占用端口（低概率，可在杀进程时用进程组）。

**n8 [nit] hashTemplate/hashLockPaths 的点文件盲区**（并入 m2 亦可单列）：scaffold.ts:145 跳过 '.' 开头条目——模板/锁目录内点文件字节变化不进哈希（当前模板无点文件，属理论缺口）。

## 2. 测试盲区清单（只读对照 tests-*.mjs）
- shipped capabilities.yml 的结构闸缺失：via:mcp↔config.server↔mcp-servers 一致性（M1）——现有闸门（tests-capability-index/tests-naming/tests-catalog-layer）全部使用合成 catalog，真实 catalog 只被读取性使用（capabilities.yml 出现在 tests-capability-index/catalog-layer/orchestrated/yaml-write 的 grep 命中中，未见结构性断言）。
- spawn error/ENOENT、stdout 背压路径（M2）无任何用例；tests-verify.mjs 系 verify.ts 行为面（t2 将细审）。
- scaffold 考官的 lock id/version 错配、DSH_HOME 差异、static-reach >20 引用（m3-m5）无用例。
- rankCapabilities 脏数据（tags 非字符串）与 shipped catalog 检索冒烟缺失（m6）。
- gap 工单文件名穿越（m8）无用例。
- 覆盖良好的部分：tests-arch-probe.mjs 对 checkArchProbe 六组规则+拒绝理由文案断言充分（58 行 17 个 check）；tests-naming.mjs 覆盖 serverName 形状/suffix/32 字符上限（合成输入）、双代际 suffix 区分等发射面关键不变量——这使 M1 这类"真实数据 vs 合成数据"的盲区更突出。

## 3. 模块质量结论
核心装配链路整体工程质量高：确定性发射的失败形状被认真对待（assertEmittedPreset 防不可挂载 preset 出门、writePresetFile 保 mtime 代际、serverName 全文本哈希命名、屏幕参数/密钥形状闸双份执行）；注释普遍带战役取证与设计裁定，模块边界清晰、死代码少（历史形态均按宪法删除并留注）。主要问题集中在：(1) 真实数据（capabilities.yml）与合成数据测试面之间的结构性校验空档（M1/m6/m7）；(2) 考官进程面的崩溃路径未兜（M2）；(3) 若干"声明 vs 实现"的窄差（skeleton-lock 面、DSH_HOME、台账鉴真）。建议修复优先级：M1（数据+闸）、M2（进程面）→ m1（台账信任）→ 其余 minor/nit 随补测一并处理。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_e5ab8665-e6ab-4225-943b-177c9b6e1751`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_bb2e4f79-ac47-46fa-9e3a-16bcf8ff495b", "run_61583cde-c7f1-4d84-84ea-aa09c6f53209", "run_0e443f70-3ea8-4468-a385-f28850b3b298", "run_58204d19-3b94-43db-b229-b0077c4634f3"]

[major·正确性/数据-发射一致性] capabilities.yml:769-776 两条静态条目 sms-gateway、mobi-parser 声明 `via: mcp` 却**无 config.server**(亦无 config 键),而同名 mcp-servers 键(460/475)存在但没有任何链接。发射端 src/index.ts:422-424 只认 `c.config?.server ?? ''` 且过滤掉空串/未注册 server——选中这两条能力会**静默不发射任何 mcp-client 行**,preset 不带短信/解析能力却报装配成功;BOM(index.ts:1260-1265)还会把该 part 记成 `plane: host`(host 平面实际并未挂载),供应链记录与事实相反。capabilities.yml:12-15 头部注释自述"mcp → connection config must exist under mcp-servers"即被自身数据违反;loadCatalog(index.ts:196-221)与发射路径均无"via:mcp 条目必须可解析到 server"的结构闸。测试盲区:grep 全部 tests-*.mjs 无任何 sms-gateway/mobi-parser 引用,无闸门对 shipped catalog 的 via:mcp↔server 一致性做断言(tests 全用自带合成 catalog)。修复:loadCatalog/emitPreset 处加完整性校验(via:'mcp' 且 config.server 缺失或不在 mcp-servers → 装载/发射时报错),或给两条条目补 config.server。

### evidence `evidence_7013d2b0-0382-4cbd-93f9-608d3f4da5fd`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_ec2a1d5c-e99e-4a7e-9865-9c691eb7540b", "run_8c71d764-a5be-4098-b2bf-6d9abd281253", "run_97e26fe2-6ad7-4c5e-bc65-4c6288a1d4d2"]

[major→minor·健壮性/考官进程面] runAppSelftest 的 app 拉起 spawn(scaffold.ts:432-436)未挂 'error' 监听且 stdout 走 'pipe' 但从不消费:startArgv[0] 不可执行(如 node/npx 缺失)时 spawn 异步 emit 'error',无监听器即进程级未捕获异常——考官不是给出 FAIL 证据而是整个装配器进程崩溃;stdout 管道无人读,输出超过管道缓冲(64KB)会堵死 app 子进程导致 waitReady 假超时。acquireSqliteFace(scaffold.ts:247)与 ai 服务脸自拉(scaffold.ts:634)同样无 error 监听、spawn 前不检查 generated/<part>/index.js 是否存在(该目录不在 package.json files 发布清单,grep 证实无 existsSync 前置)。修复:统一 spawn 封装——child.on('error') 把 ENOENT 转成 FAIL/可行动证据、stdout 改 'ignore' 或 drain、spawn 前 statSync 检查零件入口。

### evidence `evidence_a2824648-3e32-4637-8f72-bf495d049256`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_6ec081d0-bdb9-42af-9bdd-5fbfc8db0638", "run_0e443f70-3ea8-4468-a385-f28850b3b298"]

[minor·验收信任面] verify ledger(index.ts:853 VERIFY_LEDGER_FILE=last-verify.json;loadVerifyLedger 887-895;carryDecision 905-918;saveVerifyLedger 897-899)与被验 preset **同目录存放、无任何完整性绑定**(无签名/HMAC/独立存储)——台账只按 presetSha256+verifiedAt 判定沿用。能写 preset 目录者(交付写手本身即有该权限)可预置/回滚一份 sha 匹配、status PASS、verifiedAt 新鲜的 last-verify.json,使 verify_preset 不经真实探针即"沿用 PASS";台账与工件同目录也使同字节重放的"沿用"无法区分"真跑过"与"复制来的"。影响是验收证据的不可伪造性声明(DESIGN 四级黑盒验收)在该边界无实现保障。修复:ledger 写入只读/独立位置或加 host 侧签名;至少同字节沿用行明示来源路径。另:[nit] carryDecision(index.ts:913-915)在 verifiedAt 不可解析(age=NaN)时误报"台账已过期",与真实过期同文案,误导排障。

### evidence `evidence_cf633a3e-8ffc-4c5a-8dbf-8b11c30272b5`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_84dfa434-9a98-4bb6-87ba-cda6c27cfaab", "run_ec2a1d5c-e99e-4a7e-9865-9c691eb7540b", "run_0822b555-43c4-4db1-a064-f3b1575a9024"]

[minor×4·scaffold 一致性/闸面] (a) skeleton-lock 面与声明不符:scaffold.yml:43-44 声称"写手自由区之外的一切"被锁,但 lockPaths(45-56)漏掉 package.json/package-lock.json/app.config.json 及全部新增根级文件——写手(LLM)可改 package.json 加依赖/脚本(如加 axios 后页面直出网)或改 app.config.json 改装配参数,骨架锁仍 PASS;walkFiles(scaffold.ts:145)还跳过一切 '.' 前缀条目,锁目录内的点文件增改不可见。影响:pages-lint 的"禁裸出网/离线交付"纪律可经 package.json+自由区页面绕过。(b) DSH_HOME 默认值不一致:runAppSelftest/dom 门默认 presetRoot 走 DSH_HOME(scaffold.ts:578,691),runAppPreview 的 presetDir(scaffold.ts:779)只走 join(homedir(),'.dsh',...)忽略 DSH_HOME——设了 DSH_HOME 的 host 上 preview_app 找错 preset 目录、服务脸静默降级。(c) static-reach 证据夸大:只取前 20 个引用资产真取(scaffold.ts:535 refs.slice(0,20)),PASS 证据却写"${refs.length} 个引用资产全部可取"(545)——>20 引用时证据与事实不符。(d) runAppSelftest 载当前底盘 spec 但从不核对 lock.scaffold/lock.version(402-407 vs lock 写入 332-340):老代实例被当前底盘的新考卷/新 lockPaths 判定,跨底盘 id 也可能错配(loadScaffold 默认 SCAFFOLD_DIR)。建议:lock 里记 scaffold id+version,验收前比对不符即要求重印;四者均为低概率/低影响,故 minor。

### evidence `evidence_0256423a-ef12-4cbd-8794-2b555f737b31`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_fa4080cb-ba6a-4755-bad1-cb0a5f039ac2", "run_042e4379-2f90-4608-878f-d68fe7e85481", "run_0e443f70-3ea8-4468-a385-f28850b3b298", "run_3cc6a7f9-ff8a-4973-a470-2b3a1d463d17"]

[minor×3+nit×4·检索/直构/发射边缘] (a) capability-index.ts:19-31 tokenize 假定 tags/description 均为 string;loadCatalog(index.ts:196-221)对条目零结构校验,客户 catalog 里 tags 含数字/描述缺失即让 search 崩溃——建议在 loadCatalog 边界做条目形状归一(与注释自称的"目录只许承诺本机此刻真能拉起"同级闸)。(b) index.ts:1253-1255 renderPartsLock 的 nameFor 用 startsWith(`${server}-`) 取首个前缀匹配:server 键存在前缀关系(x 与 x-y)时 BOM 的 serverName 可能张冠李戴;当前仓库数据无此碰撞(键清单已核),但客户端 catalog 可触发;同处 serverName ≤32 字符(index.ts:419-420 注释的 host 上限)对 server 键长无校验,超长键发射成功而 host 拒挂。(c) index.ts:1405-1407 writeGapWorkOrders 的 draft.id 未做形状校验直接进文件名,含路径分隔符/.. 的 id(LLM 产出)可把工单写到 presetDir 之外;renderMissingDraft(1414-1433)同源裸插 id——发射链路对 LLM 字段无第二道形状闸。(nit) catalogChain(188-194)遇 extends 环静默截断返回而 loadCatalog(196-203)抛错,同一输入两种语义;(nit) installStateEquipment sharedDb(714-715)不 enforce 绝对路径,与 docblock"钉到这个绝对路径"不符,相对值会在 host cwd 造目录;(nit) stripSecretEnv(SECRET_KEY_RE index.ts:761)按子串匹配 auth/secret 等,**静默**剔除合法键(如 AUTHOR_*、AUTH_MODE),与 scaffold.ts:41 的 SECRET_PARAM_RE 双份拷贝易漂移;emitPreset 的强制 tool-cs 行(index.ts:391-393)不参与 presetRows 去重,客户行若自占 id tool-cs 将产出重复 loader id;(nit) arch-spec.ts checkArchProbe 对运行时非 single/scenario 的 kind 值(53 行后全按 scenario 处理)与 marks 中含 token 的情形无专门说明,依赖 sanitize 的 slice(0,3)(verify.ts:283-295)兜上限。测试盲区:rank 只测合成目录;无 shipped catalog 检索冒烟、无 gap 工单文件名穿越、无 spawn error 用例(与 tests-arch-probe 覆盖的 6 组规则相比,arch-spec 侧缺 kind/极端 marks 用例)。
