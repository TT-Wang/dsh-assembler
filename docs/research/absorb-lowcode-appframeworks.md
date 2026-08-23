# 调研:低代码平台与应用框架——吸收什么、怎么赢(2026-08-23)

背景:泛化 agent 定义确立(调用 AI 能力、帮人解决问题的应用 = 泛化 agent),
装配对象从"聊天中枢 agent"泛化为"AI 应用"。隔壁两块地——低代码平台与应用
框架(web/移动)——本调研回答:吸收什么、凭什么做得更好、零件库怎么扩容。

## 一、五个对象的核心机制(实搜结论)

### 1. shadcn/ui Registry —— 零件分发协议的最佳先例
- 本质:**分发源码而非编译包**的 JSON 协议。registry-item 字段:name/type/title/
  description/files(path/type/target)/dependencies/devDependencies/
  **registryDependencies**/cssVars/tailwind/css/envVars/docs/categories/meta。
- 类型分类学 12 种:registry:base(整套设计系统)/block(多文件复合)/component/
  ui/hook/lib/font/page/file/style/theme/item。
- 依赖解析五路:裸名(内置)/@namespace(命名空间)/owner/repo/item#v1.2.0
  (GitHub 钉版本)/URL/本地路径——**联邦式、可钉版、去中心**。
- v0 构建在其上;生态有 registry.directory 等目录站。
- **与我们同构**:源码进项目 = 我们知识包"拷进 preset";registryDependencies
  = 我们 BOM 的依赖面;质检门是他们没有的。

### 2. 低代码平台 —— 前辈的死因清单(我们的疫苗对照表)
- **最后一公里病**:数据模型超出 CRUD 即僵硬;扩展性不足逼出脆弱 workaround;
  "开发者不是讨厌低代码,是长大后被它困住"(outgrow)。
- **锁定病**:代码所有权缺失、专有 API、83% 数据迁移项目失败或超支、退出 =
  从零重建;75% 企业同时用 4+ 平台,治理噩梦。
- 对照我们:组合是 git 里的文本、零件是真代码/真进程、执行层框架无关——
  **毕业不受惩罚**(客户拿走目录照样跑)是结构性疫苗,要当卖点明说。

### 3. AI 应用生成器(vibe coding 产品化)—— 正面对手
- Lovable(最干净的 React/TS)、Bolt.new(多框架)、v0(Next.js+shadcn,
  代码可过 review)、Replit Agent(最自主,30+ 集成,内置 PG/KV/托管/鉴权)。
- 结构性软肋(评测原话):后端"increasingly stitched from third-party services
  rather than compiled from one plan"——**缝合而非按计划编译**;共同缺失:
  零件复用为零(每次从头生成雪花)、无验收测试、无供应链记录、无证据积累。
- 他们的强项 = 我们的洞:秒级预览、一键部署、抛光 UI。

### 4. Expo —— 移动车道的现成蓝图
- Expo Modules(封装好的原生能力 + JS API)、Config Plugins(声明式改写原生
  工程)、**CNG/prebuild:原生工程是从声明式配置生成的产物**、EAS(云构建/
  提交/OTA 更新)。
- CNG 与我们发射哲学同构:声明 → 确定性生成 → 可重生。移动吸收路线 =
  app-shell 零件(create-expo-app 脚手架)+ config-plugin 当零件 + EAS 当
  构建/部署零件——**不是手工包裹每个 RN 库**。

### 5. n8n —— 缺失零件类型的教科书
- 节点四类(INodeType 契约):**Trigger(唯一入口:webhook/cron/事件)**/
  App-Action(资源-操作)/Core(变换与流控)/Cluster(AI 子节点组合)。
- 我们目录零 trigger 零件——"无人值守"应用的入口件整类缺席。
- 许可注意:n8n 是 fair-code 非 OSI,借形态不借代码。

## 二、吸收表(模式→出处→怎么借)

| 模式 | 出处 | 怎么借 |
|---|---|---|
| 源码分发 + registry JSON + 五路依赖解析 | shadcn | 目录新增 registry 联邦源:induction 加 registry 适配器(经质检门收外部 UI 零件);我们的前端件改造成 registry-item 形状;远期反向输出(我们的目录可被 shadcn CLI 消费) |
| 12 种条目类型分类学 | shadcn | 零件类型轴扩容的词汇表底稿(block/page/hook/style…) |
| 锁定病与最后一公里 | 低代码文献 | 反面宪法:永远源码可见、组合可 diff、执行层框架无关、"毕业不受惩罚"写进 README 卖点 |
| 声明式配置 → 确定性生成原生工程(CNG) | Expo | 移动发射 = 我们发射哲学的既有验证;移动车道照 CNG 形态设计 |
| config-plugin 当零件、云构建当零件 | Expo | 零件类型新增 build/deploy 类;EAS/vercel-deploy 进目录 |
| Trigger 节点 = 唯一入口 + 事件/cron/webhook | n8n | 零件类型新增 trigger 类(先 cron+webhook 两枚);"无人值守"泛化 agent 的入口件 |
| 秒级预览 + 一键部署环路 | Lovable/Bolt/v0/Replit | 我们已有 /assembler/ui 预览;缺部署零件——补 deploy 类零件补齐环路 |
| 内置基础设施包(PG/KV/auth/托管) | Replit Agent | 不自建;当作"基础设施零件族"收进目录(供应商中立,BOM 记出处) |

## 三、凭什么做得比他们好(差异化)

一句话:**他们生成代码或隐藏代码;我们供应经过验收的零件,并为每一次组合签发证据。**

1. **vs 低代码**:他们的天花板(最后一公里/锁定)是商业模式使然,我们的解药是
   结构使然——零件是真代码、组合是文本、随时接管。AI 原生 vs AI 外挂。
2. **vs AI 生成器**:生成 = 每次新雪花,无复用无验收;装配 = 零件过冒烟门、
   组合过黑盒考、证据进台账复利。他们"缝合无计划",我们**BOM 记录每根线**。
   第 30 天优势(需求变更=同名重装、零件升级自动惠及、动用率瘦身)是他们
   结构上给不了的。
3. **共同缺失即我们内核**:验证层与证据层在两个邻域都是空白——这正是
   verified assembly 的坑位。

## 四、零件库泛化蓝图

零件类型系统 v2 =两根轴:
- **类型轴**:app-shell(web/expo 脚手架)| ui(registry 件/我们模板)|
  service(book-intake 型,含 HTTP 面)| ai-capability(prompt+模型配置包成
  服务件)| trigger(cron/webhook/事件)| build/deploy | data | knowledge |
  conversational(聊天 agent 降为一种零件)
- **调用者轴**:model(工具)| ui(直调服务)| trigger(入口)| part(件间)|
  human(界面/文档)

吸收协议三条(**不手工包裹任何框架**):
1. **scaffold-as-part**:框架官方生成器(create-next-app/create-expo-app)
   包成 app-shell 零件,质检门 = create+build+start 探针
2. **registry federation**:外部 registry(shadcn 系/npm/pub.dev)经 induction
   适配器 + 质检门联邦进目录,出处与版本进 BOM
3. **build/deploy-as-part**:构建与部署服务当零件(EAS、静态托管)

考官泛化:应用级黑盒(HTTP 探针 + 现有页面门/环路门扩展);UI 零件门 =
build+render 冒烟;trigger 门 = fire-and-assert。

## 五、分期(诚实的刹车)

- **近期(证明性,单周量级)**:①服务化零件转正(已定的第一级台阶)+ 读书
  助手 app 形态重装对照;② trigger 零件两枚(cron/webhook);③ shadcn
  registry 联邦 POC(收 1 个外部 registry、装出 1 张真页面过门)
- **中期**:app-shell(web 一枚)+ AI 能力零件化 + deploy 零件一枚 → 与
  Lovable 同题对跑(同需求:verified assembly vs 生成器)
- **远期**:Expo 移动车道(CNG 对齐);反向输出 registry
- **永不做**:手工包裹每个框架;可视化画布编辑器(低代码的坟);自建基础设施

## 来源

shadcn registry 文档与生态目录、低代码锁定/最后一公里文献(refine/baytech/
betty blocks/MDPI 多源)、2026 AI 应用生成器横评(getmocha/layout/mindstudio
等)、Expo 官方文档(CNG/config plugins/EAS)、n8n 官方文档(节点四类/trigger)。
