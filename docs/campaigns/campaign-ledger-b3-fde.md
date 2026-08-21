# 市场模拟战役台账 · 批次 3(FDE 级:多 agent 整体交付)

## 首跑暴露的天花板缺陷(f01 电商运营班子)

需求:"一整套运营 agent 班子(不是单个 agent):客服/对账/库存/内容 4 个 agent
共享数据,各有前端,最后给交付说明书"。

**首跑(无 assemble_solution 工具):主 agent 只调 1 次 assemble,把 4 份职责揉进
一个 30 能力的巨型单体 `dianshang-yunying-taozhuang`。** 多 agent 分工、共享数据
契约、HANDOVER 文档全部没落地——因为 solution 车道此前只有 CLI,agent 够不着。

## 修复:assemble_solution 多 agent 交付工具

新增 src/solution.ts + src/solution-tool.ts,注册为 host 面 agent 工具。
主 agent 面对多 agent 需求改调它,内部逐个走装配脊柱 + 从工件汇总 HANDOVER。

## 复验(有工具后重跑 f01)——天花板攻克

主 agent 正确拆成 4 个独立 agent,每个完整需求,一键 assemble_solution 交付:
- cs-agent(9 能力,3 工单)、reconciliation-agent(19 能力 PASS)、
  inventory-agent(6 能力 PASS)、content-agent(13 能力 PASS)——3/4 独立验收 PASS。
- 4 个前端页全有;HANDOVER.md 生成(agent 表+职责+部署参数+完整 BOM 含每零件
  上游 repo@版本+许可证)。
- **主 agent 转述达交付经理水准**:列 4 agent、缺件工单表、HANDOVER 路径,主动澄清
  "待配置凭证为空=零件未入库而非不需要"、列出客户要准备的 5 类凭证、提醒配环境变量。

## 复验后仍存的深层缺陷(记为下一批靶,非本轮)

- **G1(重)共享数据没真正共享**:需求要"4 agent 共享同一套商品/订单数据",但
  assemble_solution 内部各 agent 独立 assemble(),各建各的 SQLite 库,HANDOVER 的
  "共享预建表"显示为空。真正的共享需要 solution 层引入**跨 agent 的共享 schema
  声明**(一处定义商品/订单表,各 agent 的装备槽都指向同一个库文件)——独立的一
  大块设计,下一批专门做。
- **G2(中)真外部凭证被报成缺件工单而非 requiredSecrets**:选型选了 harness 内置
  crm/ticket(无凭证声明),真的银行/支付/公众号 API 落到了缺件工单。凭证清单与
  缺件工单的边界要理清(有些"缺件"其实是"缺凭证的已知零件")。
- **G3(小)NO-VERDICT**:驱动器只认单发 assemble 的"自动验证"字样,不认
  assemble_solution 的方案结果格式——测试甲具问题,非产品。

## G1 修复:方案级共享数据库(已实战验证)

installStateEquipment 加 sharedDb;assembleSolution 加 sharedSchema:建一个
_solutions/<name>/shared/data.db,共享 DDL 建表一次,每个子 agent 的
SQLITE_DEFAULT_DB 钉到它。assemble_solution 工具加 sharedSchema 参数引导主 agent。

**复验(G1 修复后重跑 f01)实锤共享成立:**
- shared/data.db 真建出来;共享 schema = products/orders/order_items(主 agent
  设计的规范商品订单模型,含外键)。
- 共享库最终 6 张表:3 张共享 + reconciliation-agent 自己的 bank_statements/
  reconciliation_reports 专属表补进同一份账——正是设计目标(共享表全班共用+
  专属表补入同库)。
- 三个子 agent 的 SQLITE_DEFAULT_DB 全部指向同一个 shared/data.db(逐个 grep 实证)。
- HANDOVER「共享数据」段如实列出 products/orders/order_items。

## 最终结论

FDE 级"多 agent 方案一键交付"完整建成并三轮实战验证:
拆分 → 独立验收 → **真共享数据库** → HANDOVER(职责/共享表/凭证/BOM)→ 专业转述。
从首跑的"巨型单体、零共享、无文档"到终态的"4 独立 agent + 共享库 + 完整交付说明书"。
剩 G2(真凭证 vs 缺件工单边界)、G3(测试甲具不认方案格式)属打磨,非天花板。