# WRITE-ME — 写手席操作手册(随骨架落地;事实清单,不是教程)

你(主 agent)现在是这个 app 的**写手**。骨架已就位,你的工作只有两件:
写 `PAGE-SPEC.yml`(考卷),写 `src/pages/*.tsx`(页面)。写完调 `verify_app` 领考,
PASS 后调 `deploy_app` 上线。

## 自由区(越界 = skeleton-lock 考 FAIL)

- ✅ 可写:`PAGE-SPEC.yml`、`src/pages/**`
- ❌ 禁改:其余一切(`src/sdk/`、`src/components/`、`src/App.tsx`、`vite.config.ts`…
  字节已哈希锁定)。缺组件/缺能力 → 如实上报,不要自己造轮子进骨架。
- 不需要你跑 npm/vite:构建由考官执行(verify_app 的 build 门)。

## PAGE-SPEC.yml(先写它——它既是设计,也是考卷)

每页列动作,每个动作标路由;**face/wire 动作必须带考题**,考官照卷真考:

```yaml
pages:
  - id: board            # 与 src/pages/board.tsx 对应
    shape: 看板
    actions:
      - name: 列出任务
        route: face      # 确定性流:SQL 直连,零模型
        sql: SELECT id, title, status FROM tasks ORDER BY id
      - name: 添加任务
        route: face
        sql: INSERT INTO tasks (title, status) VALUES (?, ?)
        sampleParams: ['考题任务 @@TOKEN@@', '待办']
        effect: { sql: "SELECT status FROM tasks WHERE title LIKE ?", sampleParams: ['%@@TOKEN@@%'], expect: '待办' }
      - name: 任务分析
        route: wire      # 判断流:真 agent 会话
        probe: 查看 tasks 表,报告标题含 @@TOKEN@@ 的任务状态,并原样报出口令 @@TOKEN@@。不要问任何人。
        marks: ['@@TOKEN@@']
      - name: 一句话贴便签
        route: ai-thin   # 薄判断:一次补全(ai-call 服务脸),不开会话
        prompt: 把这句话解析成 JSON {content,color},只输出 JSON:@@TOKEN@@ 红色便签
        expect: '@@TOKEN@@'          # AI 输出必须包含;缺 key 时该考 SKIPPED 不判负
      - name: 本地筛选
        route: local     # 纯前端状态,不出网,免考
```

路由判据(逐动作,不是逐页):增删改查/汇总/渲染 = `face`(零模型);**一次性
解析/分类/改写 = `ai-thin`**(一次补全,别为它开会话);需要多轮理解、建议、
开放对话 = `wire`;纯 UI 状态 = `local`。`@@TOKEN@@` 由考官注入随机口令。
**表结构以配套 preset 的装备 DDL 为准**(列名照抄,别发明)。

## SDK(`@/sdk/assembler-sdk`——页面唯一的出网通道)

```ts
import { sqliteFace, createClient, bindEnter, extractFence, APP } from '@/sdk/assembler-sdk'

const face = await sqliteFace()                    // null = 服务脸不可达(要出声,别装死)
await face.sql('SELECT …', [参数])                  // → { rows } 或 { changes, lastInsertRowid }
await face.schema()                                 // → { tables: [{name, columns}] }

const client = createClient({ onDelta?, onToolCall?, onError? })
const out = await client.ask('…')                   // → { reply, fence };fence.ok=false 必须给用户看 reason

const ai = await aiFace()                           // null = 未挂 ai-call 零件(降级:让用户填表单)
await ai.complete({ prompt: '…', system: '…' })     // → { text };薄判断走这里,不要为一次解析开会话

await faces()                                       // → ['sqlite','ai','files','speech',…] 先问有哪些脸
const sp = await face('speech')                     // 通用取脸:任意零件的服务脸都这么取
await sp.post('/transcribe/rec.webm', blob)         // JSON 面
sp.mediaUrl('/speak?text=你好')                      // ← <audio src> 用这个(token 进 URL)
// SDK 里没有的脸 = 缺口,如实上报,**不要去改骨架/SDK**(骨架锁会 FAIL,且沙箱也不让)

const files = await filesFace()                     // null = 未挂 file-channel 零件
await files.upload('report.pdf', fileFromInput)     // 大字节直传,**绝不过模型**;落盘路径可交给解析零件
files.fileUrl('report.pdf')                         // 取回/预览用的 URL

bindEnter(inputEl, fn)                              // 回车提交(IME 守卫内置,必用它,禁手写 keydown 回车)
APP.PRESET_ID / APP.APP_NAME                        // 实例参数
```

## 页面纪律(pages-lint 考机械查,违一条 FAIL)

禁裸 `fetch(` / `new WebSocket`(出网只许经 SDK);禁 `dangerouslySetInnerHTML`;
禁任何 `http(s)://` 外链(离线交付,图标用 lucide-react,别引 CDN)。

## 词汇表(仅此 13 件 + 两库,别 import 不存在的)

SDK 出口:`faces` `face`(通用)· `sqliteFace` `aiFace` `filesFace`(便捷)· `createClient` `bindEnter` `extractFence` `APP`。

`@/components/ui/`:badge · button · card · checkbox · dialog · dropdown-menu ·
input · label · select · separator · table · tabs · textarea
图标:`lucide-react`(任意图标名);图表:`recharts`(仪表盘用)。
页面文件:默认导出组件 + `export const title = '导航名'`;多页自动出 hash 导航。

## 范例 = 起始页(照猫画虎,质量地板在这)

- `examples/board.tsx` — 看板:face 直连列/增/拖 + wire 分析 + 错误出声,全套纪律的活体
- `examples/records.tsx` — 记录台:schema 驱动表格 + 表单直录 + face 汇总

需求落在这些形状里时,**整页拷进 `src/pages/` 当起点再改**(examples/ 本身在锁定面,
只读;拷贝进自由区后随便改)。记录/台账/库存类需求直接从 records.tsx 起步,
看板/任务类从 board.tsx 起步——别从零写一遍已经存在的形状。

## 交付流(你在第 2 步)

1. ~~emit_app~~(已完成,骨架即本目录)
2. **你:写 PAGE-SPEC.yml + src/pages/**
3. `verify_app { targetDir }` — 六门:构建/骨架锁/页面 lint/资产可达/**行为考**(照你的考卷真考)/**DOM 考**(真开页面:每页挂载死活必考;face 动作可标 dom 步骤,考官真填真点验"点击→落库→回显"——给要标注的交互元素起稳定 id,如 `#draft`/`#addBtn`,范例页 board.tsx 就是范本);FAIL 带证据,外科修复后重验,连续 3 次 FAIL 停手上报
4. `deploy_app { targetDir, presetId }` — 构建产物发布进 preset,同源上线
5. 如实向用户报告:页面 URL、考了什么、结论
