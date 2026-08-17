# northwind-oss-governance 交付报告

- 客户:northwind
- 方案版本:0.1.0
- 生成时间:2026-08-17T18:33:53.096Z
- 最近一次装配:2026-08-17T18:33:28.879Z

## 交付的 agent

| agent | 状态 | 零件数 | 验收 |
|---|---|---|---|
| nw-dep-triage | 已装配 | 13 | PASS |
| nw-upgrade-advisor | 已装配 | 9 | PASS |
| nw-policy-desk | 已装配 | 3 | PASS |

## 部署参数

- `timezone` = Asia/Shanghai
- `language` = zh

## 待配置凭证

(本方案不需要凭证)

## 知识包

| 包 | 篇数 | 来源 | 版本 |
|---|---|---|---|
| nw-oss-governance | 2 | Northwind 开源治理口径 + 两个上游的实测字段口径(2026-08-17 现场核对) | 2026-08-17 |

## 供应链清单(BOM 汇总)

| 零件 | 出处 | 许可 |
|---|---|---|
| content-search | - | - |
| filesystem | - | - |
| osv-vulns | - | - |
| deps-graph | - | - |
| sqlite-query | - | - |
| template-render | - | - |

## 重建方式

```bash
node scripts/solution.mjs apply solutions/northwind-oss-governance/solution.yml --port <端口> [--param k=v]
```

同一方案交付给另一个租户:改 `--param`、配另一套凭证,零件与知识不变。
