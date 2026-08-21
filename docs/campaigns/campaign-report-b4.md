# 市场模拟战役报告(results-b4)

生成:2026-08-21T15:41:12.856Z · 场景 10 · 有伤 4

| id | preset | 判决 | 秒 | 能力 | 缺口 | 前端 | 伤情 |
|---|---|---|---|---|---|---|---|
| r01 | reg-jizhang | PASS | 38 | 5 | 0 | data-desk |  |
| r02 | reg-fapiao | PASS | 75 | 8 | 0 | data-desk |  |
| r03 | reg-kanban | PASS | 58 | 4 | 0 | kanban |  |
| r04 | reg-yanbao | PASS | 68 | 8 | 0 | chat-console |  |
| r05 | reg-hetong | PASS | 349 | 6 | 1 | chat-console | 有缺件工单; 慢:349s |
| r06 | reg-zhishiku | PASS | 33 | 14 | 0 | chat-console |  |
| r07 | reg-youjian | GOOD-CRED | 289 | 19 | 1 | chat-console | 有缺件工单; 慢:289s |
| r08 | reg-gpx | PASS | 55 | 7 | 0 | chat-console |  |
| r09 | reg-zhuce-inject | PASS | 330 |  |  |  | 有缺件工单; 慢:330s; preset目录缺失 |
| f04 | saas-cs-suite | SOLUTION-PARTIAL(3/4) | 491 |  |  |  | 有缺件工单; 慢:491s; preset目录缺失 |

## 账单一览

- r01: 装配完成:共 24s — 零件联邦 0s · 选型 3s · 发射 0s · 探针推导 2s · 验收探针(2轮) 14s · 前端验收 4s
- r02: 装配完成:共 53s — 零件联邦 0s · 选型 5s · 发射 0s · 探针推导 3s · 验收探针(2轮) 42s · 前端验收 4s
- r03: 装配完成:共 47s — 零件联邦 0s · 选型 2s · 发射 0s · 探针推导 2s · 验收探针(2轮) 8s · 重试轮(重选+重验) 32s · 前端验收 3s
- r04: 装配完成:共 54s — 零件联邦 0s · 选型 4s · 发射 0s · 探针推导 4s · 验收探针(2轮) 44s · 前端验收 3s
- r05: 装配完成:共 86s — 零件联邦 0s · 选型 4s · 发射 0s · 探针推导 4s · 验收探针(2轮) 72s · 前端验收 6s
- r06: 装配完成:共 22s — 零件联邦 0s · 选型 5s · 发射 0s · 探针推导 2s · 验收探针(单轮) 9s · 前端验收 6s
- r07: 装配完成:共 12s — 零件联邦 0s · 选型 6s · 发射 0s · 前端验收 6s
- r08: 装配完成:共 38s — 零件联邦 0s · 选型 3s · 发射 0s · 探针推导 3s · 验收探针(2轮) 29s · 前端验收 3s