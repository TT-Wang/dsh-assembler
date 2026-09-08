# 深审：scripts/ 工程脚本与构建配置

- 任务 key: `t5_scripts` ｜ 全 id: `task_draft_start_8e3954f6-9736-401d-9cbb-12c14969c817_t5_scripts`
- kind: research ｜ status: accepted ｜ epoch: 1
- assignee: `ops`
- artifact: commit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` == baseCommit `db10fb3bd1f2f70536ff3224105ff5df45ce8ad8` ｜ changedPaths: []
- evidenceIds: ['evidence_f8bcc461-47dc-420e-b3ae-de28ca4fe849', 'evidence_3bae79fe-ef3f-4b0f-9681-47676c60bc08', 'evidence_615c90cf-86e8-47ec-ae88-03eca3cb0a9a', 'evidence_c965903f-0f7b-4918-8a7c-6e096bdffce0', 'evidence_71bc315a-3b05-4e23-963b-20107e08448e', 'evidence_83786c0c-2251-4ea7-ac7f-a70cbabbe4f7']

---

# 深审报告：scripts/ 工程脚本与构建配置（A5 / t5_scripts）

审查方式：全程只读（read/grep/node --check/无副作用 node -e 探针/静态推演），未修改任何文件。逐文件通读 scripts/ 全部 9 脚本与 package.json、tsconfig.json、.gitignore、.service.json；行为探针证据见本 attempt toolRuns（run_53446aaa / run_68eff4a1 / run_abb8505e / run_ddc3b57c / run_b6ed8b7a / run_3461d0df / run_1ec47427 / run_5e01dda6 / run_b6bfb148 / run_58842e80 / run_284f7d8f / run_75257ef9 / run_49cf1ece / run_b0cf1621 等）。

## 一、模块概览（职责 / 调用面 / 契约）

| 脚本 | 职责 | 调用面 | 输出契约 |
|---|---|---|---|
| index-add.mjs (1017行) | 索引流水线 CLI：scaffold/verify/register/check-all/coverage/auto/from-spec/knowledge(-verify)/scaffold-gate/adopt | npm scripts index:*（package.json:30-34）；agent 手动调用 | 最后一行 stdout JSON {ok:true/false}（die/out 统一；75-81） |
| catalog-report.mjs | index/catalog.yml → README 能力清单渲染；--check 归类闸 | catalog:report / catalog:check（package.json:35-36）；npm test 链含 --check | 中文/英文片段 stdout；--check 以退出码表达 |
| registry-add.mjs | shadcn registry-item.json 联邦吸收 → vendor-registry/<ns>/<name>/ + index/registry.lock.yml | 手动（无 npm script） | validateRegistryItem/fileTargetOf 纯函数导出（被 tests-orchestrated.mjs:325 引用）；main JSON |
| build-client.mjs | src/client/index.ts esbuild CJS + __ModuleLoader__.load 包裹 → lib/client.js | npm build 后半段（package.json:24） | lib/client.js |
| link-dsh.mjs | peer 包 symlink 进 node_modules（DSH_SOURCE/DSH_HOME 定位 harness） | npm run link:dsh（package.json:26） | 日志；无 JSON |
| lock-check.mjs | 根 package-lock.json 可移植性闸（禁 file:/link/非 https） | npm test 链第 2 步（package.json:28）；lock:check | 退出码 |
| yaml-write.mjs | s()/assertYaml()：写 YAML 标量序列化 + 写前解析闸 | 被 index-add、tests-yaml-write 引用 | 纯函数 |
| spec-intake.mjs | specBaseUrl/inventoryEndpoints：OpenAPI3+Swagger2 方言知识 | 被 index-add from-spec 与 tests-spec-intake 引用 | 纯函数 |
| scaffold-sync-vocab.mjs | vendor-registry/shadcn/* ui 源码 → scaffold/template/src/components/ui/ 词表同步 | 手动 | 日志 |

工程配置要点：tsconfig 编译 src/→lib/（src/client 排除，tsconfig.json:14-19）；.gitignore 忽略 lib//node_modules/.env/ledger 等但**未忽略 .service.json**；.service.json 含 3 个本机服务 token/路径/pid 且已被 git 跟踪；package.json files 发布白名单含 capabilities.yml 但**不含 index/catalog.yml、generated/、index/reports/**。

闸门链实际约束力（npm test = build → lock-check → catalog-report --check → 13 个 tests-*.mjs，package.json:28）：锁与归类两道工程闸真实执行且现状通过（实测 lock-check exit 0，"OK — 182 entries"）；catalog-report --check 仅当 catalog.yml 可解析且有未归类/失效 id 时失败。

## 二、发现列表（按严重度）

### critical
无（未发现可直接远程利用、无前置条件的缺陷；最接近 critical 的两项见 major）。

### major

**M1 [安全] index-add.mjs 两处 execSync shell 注入** — scripts/index-add.mjs:278 `execSync(\`npm view ${pkg} version license description --json\`)`；287 行 `execSync(\`git clone --depth 1 https://github.com/${repoSlug}.git "${upstream}"\`)`。repoSlug 只校验含 '/'（268），pkg 来自 --pkg 或 repoSlug.split('/')[1]（269），均未做字符白名单/转义，execSync 经 /bin/sh 执行；含 `;`/`$()`/反引号/`&&` 的输入即命令注入。该 CLI 头注释（5 行）"设计给 agent 调用"，调用方是 LLM——repoSlug/pkg 可能源自用户需求文本/上游数据等不可信面，注入 = 以使用者权限 RCE。影响：本地提权面内的任意代码执行；可能性中（需调用方传入恶意串）。修复：改用 spawnSync 数组参数（node/npm view 无法数组化时用 npm exec 等价物），或先白名单校验 repoSlug `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`、pkg 包名正则再拼接。

**M2 [可移植性/健壮性] registerCore 把绝对机器路径写进被跟踪的 capabilities.yml** — scripts/index-add.mjs:465-471（entryJs = join(root,...) 恒为绝对路径 → `args: [${s(entryJs)}...]`）；实文件 capabilities.yml:37/50/55/64/74… 全部 `/Users/tongtao/code/dsh-assembler/generated/<id>/index.js`。消费端 src/index.ts:1158-1162 只对 @@WORKSPACE@@/@@KBDIR@@ 槽位替位，其余 arg 原样透传 StdioClientTransport；换机器检出/安装后 stdio 服务器指向不存在路径（filesystem 条目另有 node_modules 绝对依赖路径，pnpm/npm 布局不同也会断）。capabilities.yml 且在 package.json:17-22 files 发布清单内。修复：capabilities.yml 记仓库相对路径（generated/<id>/index.js）或专用槽位，进程内基于自身 REPO 解析；并在 register 后跑一次"解析性"自检。

**M3 [健壮性/可维护性] index-add 全部子命令被顶层静态 import 绑死在构建产物上** — scripts/index-add.mjs:29 `import { openWireSession } from '../lib/wire.js'`；lib/ 被 gitignore（.gitignore:5）且 git ls-files 无 lib（tsc 输出物仅 build 后存在）。全新检出（npm install 后、npm run build 前）跑任何子命令（含与 wire 无关的 coverage/knowledge）都会在模块解析期 ERR_MODULE_NOT_FOUND，报错无"先 build"指引（scaffold-gate 虽有 895-896 显式检查，但被 29 行抢先）。实测本工作树 `node scripts/index-add.mjs coverage` 模块解析期失败。修复：wire 改 auto 路径内动态 import，其它子命令零 lib 依赖；或顶层 catch 给出可行动报错。

**M4 [正确性] spec-intake inventoryEndpoints 不解 $ref 参数，body 判定系统性失真** — scripts/spec-intake.mjs:46-57：params 拼接 `${prm.name}...`、bodyParams 只认 `prm.in==='body'`，对 `{$ref:'#/parameters/X'}` 型参数（Swagger2 主流写法）输出 `undefined(undefined)` 且 hasBody=false。实测探针：GET 带 [$ref, q*(query)] → params `["undefined(undefined)","q*(query)"]`；POST 只带 body-$ref → hasBody:false——与文件头注释（7-9 行）自述的"三个 POST 被标 body-less"教训同类。影响 from-spec（index-add.mjs:629）工单清单误导写件 agent。修复：对 item/op.parameters 做本地 $ref 解引；无法解引时按名称/描述兜底判 body。

**M5 [健壮性] auto 失败路径 process.exit 跳过 finally，wire 会话泄漏** — scripts/index-add.mjs:75-78 die()=process.exit(1)，而 auto() 在 try{…}finally{session.close()}（749-794）内于 760/777 行对超时/修复失败直接 die——finally 不执行，已开的 DSH web 会话（agent 可能仍在跑、烧 LLM 预算）不被 detach。修复：die 改为抛错或设 exitCode 让 finally 收尾后退出；至少 auto 内失败路径先 close 再退出。

### minor

**m1 [安全/闸门] lock-check 只覆盖根锁，零件锁无闸** — scripts/lock-check.mjs:25-36 仅读根 package-lock.json 的 .packages；git 跟踪着约 100 份 generated/*/package-lock.json（git ls-files 实证）与 catalogs/*/generated/*/package-lock.json，任何一份混入 file:/link 条目都会让该零件在别的机器 `npm ci` 失效，且无任何检查（verifyCore 每次 npm install 还会重写它们，index-add.mjs:361/944）。实测根锁 182 条全 https、0 link（现状健康）。修复：lock-check 泛化为扫描所有被跟踪 package-lock.json（`git ls-files '**/package-lock.json'`），同规则逐份校验。

**m2 [闸门约束力] register 质检门不绑定 meta，溯源字段可漂移** — scripts/index-add.mjs:413-417：register 只验 reports/<id>.json 存在且 smoke==='pass'；报告不含 .index-meta.json 的指纹，verify 后手改 meta 的 pkg/version/license/repo/terms 再 register 不会被拒（auto 路径同程执行风险低，手动路径真实存在）。修复：verifyCore 写报告时把 meta 关键字段/hash 一并写入，register 比对。

**m3 [安全] registry-add：--ns 无校验 + type 原样插锁（YAML 注入）** — scripts/registry-add.mjs:49（ns 直拼 dest）、63-68（68 行 resolve 防线随 dest 一起逃逸，ns='../../..' 时文件可写到仓库外）、78 行 `type: ${item.type}` 仅验 startsWith('registry:') 即原样插入 index/registry.lock.yml。实测：validateRegistryItem 对含换行的 type/path 放行（换行 type → 可在锁文件中注入新的 `- name:` 行）。条目来自远程 URL（55 行 fetch），供应链锁可信度受损。另：文件头（8 行）宣称锁记录"许可证"，row（77-85）实际从不写 license。修复：ns 白名单 `/^[a-z0-9-]+$/`；type/url/文件路径逐字符校验（禁控制字符）或整行 JSON.stringify；锁行补 license；落盘前对成品做 assertYaml 闸（yaml-write.mjs 已有该能力却未用于此处——与 register 的做法不一致）。

**m4 [安全/卫生] .service.json 明文 token 被 git 跟踪** — 实文件 .service.json:3-22（speech/vectors/book 的 url+token+绝对 dir+pid），git ls-files 确认已跟踪，.gitignore 无对应项（含 .env 但漏 .service.json）。影响限于 127.0.0.1 本机服务（故 minor），但属"运行态+凭证"文件入库；若仓库公开即外泄并产生无意义 diff。修复：.gitignore 增 `.service.json`（或 service-*.json 运行时命名），git rm --cached 后本地留存。

**m5 [可维护性] scaffold-sync-vocab 只增不删、同名静默覆盖** — scripts/scaffold-sync-vocab.mjs:18-28：readdir 覆盖写 DST，上游删除的文件永不消失；不同组件同名 ui 文件后者覆盖前者（n 计数还重复计）；改写后的 `@/components/ui/<x>` 导入目标是否真的存在无校验（漏同步时模板编译期才爆）。文件头自述"跑完字节变了要升 scaffold.yml 版本"，但脚本自身无 diff/版本提示。修复：按 manifest 双向同步（删多余）、冲突检测报错、同步后提示模板 diff。

**m6 [健壮性] 参数解析与非法值静默化** — index-add.mjs:38-40 标志配对循环对落单位置参数静默忽略；catalog-report.mjs:24 `--lang` 为末参或任意值时静默回落 zh（lang='xx' 无告警）；index-add.mjs:969 adopt --probe 的 JSON.parse 无 try/catch（裸栈、破坏"最后一行 JSON"契约，与 75-81 的 die 协议不一致）；registry-add.mjs:93 isMain 用 `file://${argv[1]}` 拼接，路径含空格/特殊字符的检出目录下主流程静默不执行。修复：统一参数解析（拒绝未知/缺失值）、probe 解析包 try/catch 走 die、isMain 用 pathToFileURL(process.argv[1])。

**m7 [可维护性] catalog-report DOMAINS 人工清单与 README 同步无闸** — scripts/catalog-report.mjs:32-48 领域 id 表是唯一人工输入，--check（62 行）只查"未归类/失效"，README 中由本脚本生成的片段是否与 index/catalog.yml 实际一致（数量、条目、许可统计）没有任何闸门——生成 ≠ 已同步，README 可过期而 CI 全绿。修复：增加 --check 变体比对 README 内嵌片段 === 本脚本输出（或把 README 段改为构建时注入）。

**m8 [健壮性] check-all 的连通性探针依赖可选包 undici** — scripts/index-add.mjs:836 `await import('undici').catch(...)`：undici 不在 package.json dependencies（package.json:53-57），该分支实际永远走 fallback（Node 内置 fetch），属死代码/误导；Agent 构造也仅在 undici 存在时启用。修复：删掉 undici 分支或显式声明依赖。

**m9 [正确性·边界] spec-intake 细节** — scripts/spec-intake.mjs:42 端点方法枚举不含 head/options/trace（OAS3 合法方法被静默跳过，若客户 spec 主要用 HEAD 会产生"0 端点"误报并 die，631 行）；OAS3 path-item/operation 级 $ref 不解引；swagger2 formData 参数不算 body（语义上 formData 即 body，仅 listing 可见）。影响面小（工单生成辅助信息），建议文档化或补齐。

### nit

- scripts/build-client.mjs:23 包裹串含 `var module/exports` 两次声明（外层 wrapper 与 esbuild CJS 头部），依赖 esbuild 自身 shim 的健壮性，建议加产物冒烟（node -e "…" 不可行时用 vm 解析）。
- scripts/link-dsh.mjs:50-66 ensureLink 对已存在真实目录（npm 自动装的 peer 副本）rmSync 递归删除后换链——意图已注释，但无"目标为符号链接/确属 node_modules 管理项"的辨别，误指向用户目录时破坏面大；建议删除前打印将被移除的路径与类型。
- scripts/index-add.mjs:427/457 幂等判定用文本正则（`^- id: ${id}$`、`^  ${id}:$`）而非解析 YAML——当前文件形态下成立（capabilities: 段是 `- id:` 列表，实测无 2 空格键碰撞，capabilities.yml:600+），但引号风格（实文件单引号 vs registerCore s() 双引号，capabilities.yml:37 vs index-add.mjs:471）说明现有条目并非当前代码所写，属格式漂移隐患。
- index-add.mjs:517 knowledge 复制用 src 字符串前缀 slice 计算相对路径，src 为符号链接或大小写差异时 rel 可能错位（罕见）。
- scaffold 二次运行时 package.json 不重写而 .index-meta.json 每次刷新（index-add.mjs:299-317），上游升版后 meta.version 与已锁 package.json 版本可能不一致（register 的 rev 取 meta）。

## 三、测试盲区（脚本层）

- 9 脚本中仅 spec-intake/yaml-write/registry-add(纯函数) 被单测直接引用（tests-spec-intake.mjs:11、tests-yaml-write.mjs:15、tests-orchestrated.mjs:325）；index-add 的 dedupGate/registerCore/verifyCore/writeYaml/parseRequiredSecrets、catalog-report 逻辑、lock-check 判定、link-dsh、build-client、scaffold-sync-vocab 全部无自动化覆盖；npm test 不跑 index:check/check-all/scaffold-gate（package.json:28 只链 13 个 tests-*.mjs），零件冒烟回归与底盘自证门不在默认测试面。
- M2/M4/m3 揭示的行为（绝对路径落盘、$ref body 漏判、锁文件注入）恰好都无测试防回归；建议：register 输出快照测试（相对路径断言）、spec-intake 增 $ref 用例、registry-add 增换行/ns 穿越用例、lock-check 增"嵌套锁含 link"用例（可先以临时目录 + 拷贝锁文件方式做只读化测试）。

## 四、结论

scripts/ 整体纪律性强：JSON 行契约、die/out 统一、写目录前 assertYaml、dedup/verify/register 分闸、对历史事故有注释与对策（yaml-write.mjs:8-11、index-add.mjs:155-160 等处），是一次"有过教训、正在制度化"的工具链。但安全面两处 execSync 拼接（M1）、机器路径入库（M2）、构建产物耦合（M3）与 $ref 方言失真（M4）应在合入前修复；闸门覆盖（嵌套锁、README 同步、register 溯源绑定）建议补闸。全程只读合规：未修改 src/、scripts/、tests-*.mjs 或任何工程配置。

---

## 附录：本任务已发布证据（全文）

### evidence `evidence_f8bcc461-47dc-420e-b3ae-de28ca4fe849`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_53446aaa-547e-4ce1-abe1-74b2678ba8c0", "run_68eff4a1-ccb6-49eb-ae27-69bfadabd9f8", "run_abb8505e-01d4-4740-ad1c-77083a9820cc"]

[major·安全] index-add.mjs 两处 execSync 未对参数做 shell 转义即拼入命令:278 行 `npm view ${pkg} version license description --json`、287 行 `git clone --depth 1 https://github.com/${repoSlug}.git ...`(repoSlug 仅校验含 '/'，pkg 来自 --pkg flag 或 repoSlug.split('/')[1])。execSync 经 /bin/sh 执行，含 `;`、`$()`、反引号等的 owner/repo 或 --pkg 可注入任意命令。该 CLI 头注释(5 行)明确"设计给 agent 调用"，调用方是 LLM，repoSlug/pkg 可能源自不可信外部文本，注入即等于以使用者权限 RCE。修复：改用 spawnSync 数组参数或先做白名单校验(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/ 与包名正则)，杜绝 shell 拼接。

### evidence `evidence_3bae79fe-ef3f-4b0f-9681-47676c60bc08`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_ddc3b57c-f4f1-465d-b66f-f8836e98b3bb", "run_b6ed8b7a-dab3-429a-b05e-970f79af22ef", "run_3461d0df-8a5c-42bc-869d-7b7743dc15a8", "run_1ec47427-8347-4851-915f-2b675ce61efe"]

[major·可移植性] registerCore 把 entryJs 的**绝对机器路径**写进被 git 跟踪的 capabilities.yml(index-add.mjs:465-471 join(root,...) 生成绝对路径；实文件 capabilities.yml:37,50,55 等 args 均为 /Users/tongtao/code/dsh-assembler/...)。消费端 src/index.ts:1158-1162 仅对 @@WORKSPACE@@/@@KBDIR@@ 槽位做替位，其余 arg 原样透传给 StdioClientTransport——换一台机器检出/安装后这些 stdio 服务器指向不存在的路径。capabilities.yml 还在 package.json files:19-22 的发布清单里。修复：capabilities.yml 只写仓库相对路径(如 generated/<id>/index.js 或 $REPO 替位符)，发射/列举端在进程内解析。

### evidence `evidence_615c90cf-86e8-47ec-ae88-03eca3cb0a9a`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_49cf1ece-a90f-42c5-bbba-71198e7fc3fd", "run_b0cf1621-e784-4431-9092-f0636bcd3f9c"]

[major·健壮性] index-add.mjs:29 顶层静态 import '../lib/wire.js'——lib/ 是 gitignore(.gitignore:5 /lib/)且 git ls-files 无任何 lib 文件,tsc 输出物只在 npm run build 后存在。因此全新检出(npm install 之后、build 之前)运行**任何** index-add 子命令(coverage/knowledge 等与 wire 无关的命令)都会 ERR_MODULE_NOT_FOUND 整体失败,且报错不含"先 npm run build"提示(唯一例外:scaffold-gate 在 895-896 有显式检查,但被 29 行静态导入抢先)。实测:本工作树(无 node_modules/lib)`node scripts/index-add.mjs coverage` 在模块解析阶段即失败。修复:将 openWireSession 改为 auto 路径内动态 import,其余子命令保持零构建依赖。

### evidence `evidence_c965903f-0f7b-4918-8a7c-6e096bdffce0`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_5e01dda6-e169-44d4-b96b-dc089f95d533", "run_b6bfb148-8423-47a9-9b49-dfdefb268c71"]

[major·正确性] spec-intake.mjs:46-57 inventoryEndpoints 对 $ref 参数不做解引:Swagger2 以 #/parameters/X 引用 body 参数时 hasBody 恒 false、params 出现 "undefined(undefined)"。实测探针:get 带 [$ref 参数, q*] 输出 params ["undefined(undefined)","q*(query)"],post 带 body-ref 输出 hasBody:false——与文件头注释(7-9 行)自述曾因"读成无 body 的 POST"吃过亏的教训同类。影响:from-spec(index-add.mjs:629)工单端点清单对主流用 $ref 的 spec 系统性失真。修复:对 item.parameters/op.parameters 做本地 $ref 解引(至少 body 判定用参数名/描述兜底)。

### evidence `evidence_71bc315a-3b05-4e23-963b-20107e08448e`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_3461d0df-8a5c-42bc-869d-7b7743dc15a8", "run_1ec47427-8347-4851-915f-2b675ce61efe", "run_b6ed8b7a-dab3-429a-b05e-970f79af22ef"]

[minor→major·测试盲区/闸门约束力] 脚本层三处闸门盲区:(1) lock-check.mjs:25-36 只查根 package-lock.json 的 .packages;git 跟踪的 ~100 份 generated/*/package-lock.json 与 catalogs/*/generated/*/package-lock.json 不在检查面,若某零件锁混入机器本地 link/路径条目无人拦截(实测根锁 182 条全 registry、0 link,现状健康,但口径只覆盖根);(2) index-add.mjs registerCore 的"质检门"只验 index/reports/<id>.json 存在且 smoke==='pass'(414-417),报告不含 .index-meta.json 的哈希/指纹,verify 后手改 meta 的 pkg/version/license/repo 再 register 不会被拒,溯源字段可漂移;(3) catalog-report.mjs --check(62 行)只查 DOMAINS 归类完备性,README 中由它生成的清单片段是否与 catalog.yml 同步无任何闸门(生成≠已同步)。

### evidence `evidence_83786c0c-2251-4ea7-ac7f-a70cbabbe4f7`
- outcome: supported ｜ status: verified
- toolRunIds: ["run_58842e80-00ff-48c3-a665-28c439e6612c", "run_284f7d8f-eb96-466f-aea7-ea8a782b18e9", "run_75257ef9-c6d8-49c6-a73b-2efa48ea6d84"]

[minor·安全/卫生] (a) .service.json 被 git 跟踪且含明文 token(url/token/dir/pid,3 个本机服务)与绝对路径,而 .gitignore 未忽略它——本机运行态文件入库,若仓库公开即泄凭证(影响限于 127.0.0.1 本地服务,故 minor);(b) registry-add.mjs:49 --ns 无格式校验,ns='../..' 时 dest 逃出 vendor-registry/ 而 68 行的 resolve 二次防线与 dest 同逃逸,远程 item 内容 + 越界 ns 可把文件写到仓库外(操作员自供参数,minor);(c) registry-add.mjs:78 type 值仅验 startsWith('registry:') 后原样插进 index/registry.lock.yml(实测换行 type 通过 validateRegistryItem),远程条目可注 YAML 行污染供应链锁;文件头(8 行)宣称锁记录"许可证",但 row(77-85)从不写 license 字段;(d) scaffold-sync-vocab.mjs:18-28 只增不删、同名 basename 静默覆盖(DST 目录无冲突检测),上游删文件/两组件同名时词表漂移。
