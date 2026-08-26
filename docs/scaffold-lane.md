# scaffold 车道设计稿(2026-08-25)

> **执行状态(同日)**:S1-S4 已落地并实战——13 件 shadcn 词汇联邦入库
> (scaffold-sync-vocab 同步进模板);scaffold-react 配方入库门五考 PASS;
> 行为考(face 验库效 + wire 场景探针 + 考官自拉零件自给自足)进考官;
> **S4 真装**:kb-sdk-e2e 定制看板页全链 PASS 并经 static-deploy 上线,
> **拖卡 face 直连 5.1ms vs 模板版整轮会话 4-20s(三个数量级)**。
> **写手席接轨(次日)**:WRITE-ME 操作手册+双范例进骨架(锁定面)、SCAFFOLD_BATON
> 接力棒、deploy_app 发布工具(先考后发闸)。**真会话全链首测 PASS**(bench/
> run-writer-seat.mjs):deepseek 主 agent 从"便签墙"一句话独立走完 架构检查点→
> emit_preset→emit_app→读手册写考卷写页→verify_app(五门 PASS 7s)→deploy_app,
> 墙钟 406s;它写的 PAGE-SPEC 四动作全带效果断言(删除考还自带清场)。独立复核:
> 页面 200、资产全通。剩余:ai-thin 路由实装、独立态 scaffold、DOM 层考(puppeteer 候选)。

> 产品定位(用户裁定):**内嵌 agent 能力的 web app**。前端 = Vite + React +
> shadcn/ui + Tailwind(Lovable 同款词汇,模型语料熟悉度最高);后端 = 双层运行
> 时(托管态:host 里装配的零件服务脸 + wire 会话面;独立态:配方 app);每个
> 页面动作按流谱标注路由(face/wire/ai)。本车道解决"模板是天花板"——把 7 张
> 手工模板降级为兜底与范例,让 AI 在锁死的词汇+SDK 内**现写**任意形状的页面。

## 一、与既有车道的分工线

| 车道 | 产出 | 谁写内容 | 考官 |
|---|---|---|---|
| 前端模板(7 张) | 兜底页/few-shot 范例 | 手工(已 SDK 化) | 页面门+环路门 |
| **scaffold(本稿)** | Vite+React 定制前端,static-deploy 进 preset | **主 agent 照 spec 写 src/pages** | 构建门+lint 门+双门+**行为考** |
| 配方(recipe) | 自带 server 的独立 app | 模板实例化(零 LLM) | verify_app |

铁律沿用:**智力归主 agent,装配器只印刷和考试**。scaffold 骨架由 emit_app 确定
性实例化(哑印刷),页面代码由主 agent(有全套 coding 能力)照 spec 写,考官
黑盒验——生成自由度用验收深度买单。

## 二、交付形态(托管态,主线)

```
~/apps/<name>-ui/                     ← scaffold-react 配方实例化产物
├── package.json / vite.config.ts / tailwind.config / tsconfig
├── src/
│   ├── sdk/assembler-sdk.ts          ← 固定通信层(_vendor SDK 的 TS 版:wire 客户端
│   │                                    /服务脸发现/类型;字节稳定,禁改)
│   ├── components/ui/…               ← shadcn 组件源码(vendor-registry/ 联邦进货,
│   │                                    离线可装;词汇表本体)
│   ├── pages/…                       ← ★ 主 agent 写的部分(唯一自由区)
│   └── main.tsx / App.tsx            ← 骨架(路由挂 pages,禁改)
├── PAGE-SPEC.yml                     ← 动作路由标注(考卷的种子,见四)
└── recipe.lock.yml
构建:vite build → dist/ → static-deploy 零件 → /assembler/ui/<preset>/ 同源伺服
运行:页面经 sdk 直连服务脸(确定性流)+ wire(判断流)——与手工模板同一条链
```

独立态变体:scaffold 产物配 record-desk 式自带 server(后续版本,不阻塞主线)。

## 三、词汇表(锁死的三层)

1. **组件层**:shadcn/ui 组件源码,经 `registry-add.mjs` 联邦进货到
   `vendor-registry/`(POC 已通:官方 button 已入库)。首批进货清单(按 7 张
   模板+战役需求倒推):button/card/input/table/dialog/select/badge/tabs/
   dropdown-menu/form/toast/textarea/checkbox + lucide-react 图标 + recharts
   (仪表盘缺图表词汇是实测痛点)。
2. **通信层**:`src/sdk/assembler-sdk.ts`——与 `_vendor/assembler-sdk.js` 同源
   同纪律(围栏出声/IME 守卫/服务脸发现),加 TS 类型。页面动作**只许**经 SDK
   出网(lint 门机械查:src/pages 内禁 fetch/WebSocket 裸调)。
3. **样式层**:Tailwind + shadcn 主题 token(亮暗自适应),禁外链(离线交付)。

依赖离线策略:scaffold 模板的 node_modules 由 emit_app 用本机 npm cache 装
(pnpm store 共享);断网环境走预打包 tarball(后续)。

## 四、PAGE-SPEC.yml:动作路由标注 = 考卷种子

主 agent 写页面前先写 spec(架构检查点的页面版),每个动作声明路由与可验效果:

```yaml
pages:
  - id: board
    shape: 看板
    actions:
      - name: 列出任务
        route: face            # 确定性:SELECT,零模型
        sql: SELECT id,title,status FROM tasks ORDER BY id
      - name: 拖卡改状态
        route: face            # 确定性:UPDATE(scaffold 页知道自己的 schema!)
        sql: UPDATE tasks SET status=? WHERE id=?
        effect: SELECT status FROM tasks WHERE id=?   # 考官验效
      - name: 一句话加任务
        route: ai-thin         # 薄判断:解析→INSERT(ai-call 面)
      - name: 帮我排优先级
        route: wire            # 全判断:开 agent 会话
```

**这正是手工模板做不到的**:模板不知道 schema 只能全走模型;scaffold 页面在
生成时知道 schema,确定性动作直接绑 face——"按判断密度分流"从架构口号变成
每个按钮的属性。

## 五、门阵(五道,考官逐道签字)

1. **构建门**:`vite build` 零错误(确定性,exit code)
2. **lint 门**(机械):src/pages 禁裸 fetch/WS(必须经 SDK)、禁外链 URL、
   禁 dangerouslySetInnerHTML、禁改 sdk//components/ui/ 骨架字节(哈希比对)
3. **页面门**:部署后 HTTP 200 + 挂载点存在(现有门沿用)
4. **环路门**:wire 路由的动作真开会话打口令(现有门沿用)
5. **行为考**(新,本车道的灵魂):按 PAGE-SPEC 逐动作验——
   - route:face 的动作:考官经服务脸执行其 sql,再跑 effect 断言(不点 DOM,
     考 SDK 之下的真实链路;页面层的绑定正确性由 lint 门"动作必经 SDK"+
     构建门类型检查夹住)
   - route:wire 的动作:单轮场景探针(runScenario 现成)
   - route:ai-thin:同 record 考(真句→落库→可查)
   诚实边界:DOM 事件→SDK 调用这一跳无浏览器驱动考不到,记为已知缺口;
   后续可选 puppeteer 零件补(不阻塞 v1)。

## 六、发射流(一次交付的完整链)

1. emit_preset:后端(零件+装备 DDL+persona)——现有
2. emit_app(recipe=scaffold-react):骨架+词汇+SDK+PAGE-SPEC 模板落地——哑印刷
3. 主 agent:写 PAGE-SPEC.yml + src/pages/(检查点:spec 给用户过目)
4. verify_app(scaffold 扩展):五道门
5. static-deploy:dist → preset frontend/,同源伺服
6. 双面交接考(verify_shared_data):页面写的行 agent 读得到——现有

## 七、实施切片(每片独立可验)

- **S1 词汇进货**:registry-add 批量收 shadcn 首批组件 + lucide/recharts 离线
  vendored;门=每件 build 通过
- **S2 scaffold-react 配方**:骨架模板 + TS 版 SDK + 构建门/lint 门进 verify_app;
  样例 = 手写一张 pages/board.tsx 过全部门(先不上 AI 写手)
- **S3 行为考**:PAGE-SPEC 解析 + face/wire/ai-thin 三类考执行器
- **S4 首次真装**:一个真实需求(库存看板+过期高亮级),主 agent 写页,全链
  PASS,与 kb-sdk-e2e(模板版)同题对比延迟/成本/形状贴合度——车道验收战
- **S5 范例库**:7 张模板改写为 few-shot(放 scaffold 模板的 examples/)

## 与"永不做"的对表

不做可视化画布(生成的是代码,可 diff 可毕业);不手工包裹框架(shadcn 走
registry 协议进货);不为当代模型写永久散文(PAGE-SPEC 是数据不是散文;写手
提示词按契约到期制管理)。

> **状态(2026-08-26)**:宪法第九条执行——配方车道并入本车道,scaffold 成为 app 交付唯一底盘
> (recipes/ → scaffold/,成品配方降级为 examples/ 范例页,出厂门 `index-add.mjs scaffold-gate`)。
> 本稿"与既有车道的分工线"一节从此为历史记录。
