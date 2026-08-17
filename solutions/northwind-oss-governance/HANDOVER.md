# northwind-oss-governance 交付报告

- 客户:northwind
- 方案版本:0.1.0
- 生成时间:2026-08-17T19:20:53.493Z
- 最近一次装配:2026-08-17T19:20:08.248Z

## 交付的 agent

| agent | 状态 | 零件数 | 验收 |
|---|---|---|---|
| nw-dep-triage | 已装配 | 13 | PASS |
| nw-upgrade-advisor | 已装配 | 6 | PASS |
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
| content-search | 宿主自带能力(不来自供应链) | - |
| filesystem | 宿主自带能力(不来自供应链) | - |
| osv-vulns | https://api.osv.dev | Apache-2.0 (OSV data: per-source, CC-BY-4.0 for OSV-prefixed records) |
| deps-graph | https://api.deps.dev/v3 | Apache-2.0 (deps.dev; licence data mirrored from upstream registries) |
| sqlite-query | WiseLibs/better-sqlite3@v11.1.2 | MIT |
| date-format | iamkun/dayjs@v1.11.11 | MIT |
| crypto-hash | 第一方(Node 内置薄壳,无第三方依赖) | BSD-3-Clause |

## 重建方式

```bash
node scripts/solution.mjs apply solutions/northwind-oss-governance/solution.yml --port <端口> [--param k=v]
```

同一方案交付给另一个租户:改 `--param`、配另一套凭证,零件与知识不变。
