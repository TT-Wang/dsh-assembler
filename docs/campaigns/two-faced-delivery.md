# 双面交付实战:四件套验收(2026-08-24)

> 公理落地战:"泛化 agent 的 verified assembly,形态是装配出来的结果,不是入口处
> 的分类"。交付体 = 一本账 + N 张脸 + 每脸一考官。战场:独立 host(3097),
> 主角 = 第 30 天之战的 m30-ledger。甲具 bench/battle-two-faced.mjs,可重跑。

## 战果:13/13 PASS(第三轮全绿;前两轮各揪出一虫,见教训)

| # | 检查 | 证据 |
|---|---|---|
| A | m30 同名重发(吃进新模板+带脸零件) | 5 件重发,台账沿用明示 |
| B1 | 前端双门(顺带触发零件挂载) | 页面门+环路门 PASS |
| B2 | host `/.service` 路由 → 零件端点档案 | sqlite 面 url+token 同源可得 |
| B3 | **页面直连 SQL(零模型零轮次)** | `SELECT count(*)` 毫秒级回行 |
| B4 | `/schema` 报共享账结构 | ledger_entries + budgets |
| C | **selfcheck 同卷重考**(考卷随行的意义) | 重发后 2 轮全过(记帐→CSV 导出读回) |
| D1 | record-desk 配方以 `DB_PATH` 共享 m30 的账 | app 实例化,零拷贝共账 |
| D2 | verify_app 真 AI 解析入共享账 | "战役验收咖啡 9.9 元 TWFACE-D77" 落 ledger_entries,黑盒可查 |
| E1 | **app 面写**一行(token+payload) | changes=1 |
| E2 | **会话面读**:m30 按 token 查库报出 payload | 照抄闸下 HANDOFF-8842-OK 报出——两张脸真共一本账 |
| F1 | ops-heartbeat 无人值守 preset 发射 | sqlite 2 件 + 预建 heartbeat 表 |
| F2 | cron-trigger fire-task 经 wire 开真会话 | 与探针驱动器同一条公开 wire,host 零改造 |
| F3 | **触发考:打一发验后果** | 心跳行 `HB-…` 落库——触发→会话→agent→SQL→行,无人值守闭环 |

## 判读

- **①服务脸**:确定性流(查/表渲染)从"每次一整轮 LLM"变成毫秒级直连;记一笔
  (薄判断)仍走该走的地方。data-desk 模板的直连台账卡对存量 preset 自动生效
  (无脸静默隐藏,向后兼容)。
- **②记录配方**:schema 自适应实证——同一张配方,样例库(records 表)与 m30 共享
  账(ledger_entries/budgets)零改动通吃;AI 解析尊重 CHECK 约束(type 收/支)。
- **③交接考**:app↔agent 双向数据流被独立考官签字,"同一个产品的两张脸"不再是
  口号是证据。
- **④触发面**:任何已交付 preset 免改造获得定时形态(fire 走公开 wire);完成判据
  = 落库效果,与"会话结束≠工作结束"的 P3 教训对齐。

## 教训(两轮各一虫,都不在机制在甲具/考官)

1. **考官默认表之虫**(第 1 轮 D2):record 考的 `/api/rows` 缺省查字母序第一张表
   (budgets),标记明明写进了 ledger_entries——修:考官按 `/api/record` 返回的
   table 查。老病类:验收断言的目标要跟着**实际写入位置**走,不许猜缺省。
2. **战役脚本任务 id 复用之虫**(第 2 轮 F3):cron 任务持久化(特性!)使上轮的
   `hb-battle` 残留,schedule 报"已存在"被脚本忽略、fire 打了旧任务旧标记——
   机制其实成功了两次(库里两行旧标记为证)。修:战役任务 id 每轮唯一。老病类:
   **持久化状态面前,幂等假设必须显式处理**;以及 schedule 返回值不许不看。

## 遗留

- 触发考目前是战役脚本形态;若无人值守交付走量,升格为一等 verify 工具。
- 服务脸 token 信任域 = 能打开 host 页面的人;多用户 host 场景要再收紧(per-preset
  token 已具备,配 host 鉴权即可)。
- 战役副产品:m30 账本里累积了带标记的验收行(TWFACE-D77/TWF-3391 等)——是证据
  不是垃圾,但提醒:对**真实用户**的库做验收要用可识别前缀并事后提供清理指引。
