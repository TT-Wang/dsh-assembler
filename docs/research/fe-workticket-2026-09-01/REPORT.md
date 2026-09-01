# 前端能力工单(BACKLOG 1.0)第一波执行报告(2026-09-01)

审计基线与五路修法见 BACKLOG 1.0 条目。本波落地与判据:

## 已落地

- **① 预览眼**:`preview_app`(第 13 工具面,修宪记入 CONSTITUTION 概念账)——构建
  → 考场镜像伺服 → 每页亮/暗双主题机械体检(console/pageerror/横向溢出/死图/低对比
  度/零尺寸)+ 布局降维速写 + 截图落 `.preview/`;配套 preset 在场时自拉 sqlite 脸,
  页面带真数据渲染。快闸不判定(0.8 快慢闸分层),判定仍归 verify_app 六门。
- **② 考官词表 2→8**:browser-automate 零件 v0.1.0 加装五指(select/press/hover/
  upload/inspect,合成考场 10/10 实测);scaffold-dom 词表七动词
  (fill/click/select/press/hover/upload/waitText)+ 伴随字段闸 + 区分口令闸扩展
  (upload.content/waitText 均可织 @@TOKEN@@);selector 教 playwright 引擎
  (text= / :nth-match / [role=]),循环格点第 N 项免新工具。7 枚正反 fixture 钉。
- **④ 原子补件**:shadcn 13→20(progress/skeleton/switch/tooltip/popover/
  radio-group/toast[零依赖命令式]);**图表死库存激活**——recharts 本在依赖里,
  配 `chart.tsx` 面(SimpleBar/Line/Pie + StatCard,主题色 CSS 变量自动、
  data-chart/data-points 供考官断言);index.css 补亮暗 --chart-1..5。
- **③ 模式库 v0**:examples/dashboard.tsx(统计卡+双图表+select 过滤+回车速录+
  toast+空态/骨架屏);WRITE-ME 教满新词表与预览回路;scaffold v5→v6。
- **⑤ 机械美学门**:并入预览眼(溢出/对比度 WCAG 算式/console 零错/暗色双渲染);
  审美 advisory 车道(aux 视觉模型)留待后续,明确不进判定。

## 判据

- 出厂门(scaffold-gate):v6 骨架 sample 六门 PASS(templateHash 11544de380701f9f)。
- 手动 E2E(夹具 preset + PASS 记分板):emit_app 0.8 闸真过 → dashboard 页 →
  preview 双主题**体检零异常**(截图见本目录)→ verify_app 六门 PASS,DOM 考实弹
  执行 select→fill→press(Enter)→waitText 新动词链,库效✓。
- npm test 13 套零✗(含新钉)。

## 过程战果(预览眼首航即立功)

- 抓获自身误报一枚:闭合 select 内 `<option>` 天然 0×0(已修 inspect 启发式);
- 抓获考场噪音一枚:Chromium 自动请求 /favicon.ico 的 404 脏 console 台账(考场改 204);
- **抓获存量真 bug 一枚:verify_app 未把 presetRoot 下传考官**——默认 $DSH_HOME 上
  碰巧不炸,自定义 presetRoot 下行为考取脸取错对象(no such table 假死)。已修并贯通。

## 残差

- upload/hover 动词:零件层 10/10 实测,执行器层未在真考卷跑(选做题型出现时自然覆盖);
- advisory 视觉评语车道未建(明确不进判定,后续单独立项);
- 真写手席在新词表下的活体运行:见后续记录。
