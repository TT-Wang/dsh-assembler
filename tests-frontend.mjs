#!/usr/bin/env node
/**
 * 前端车道单测:模板库健全性、填参发射(确定性/复用 no-op)、路由解析的
 * 安全包含闸(id/asset 双正则 + resolve 越界拒绝)。全部离线。
 */
import {
  listFrontendTemplates, emitFrontend, fillTemplate, resolveFrontendFile, listAssemblyProgress,
  FRONTEND_ROUTE, DEFAULT_FRONTEND_TEMPLATE,
} from './lib/index.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${String(extra).slice(0, 110)}` : ''}`)
  if (!cond) failures += 1
}

// ── 1. 模板库健全性:四张模板都在,且都带完整 wire 接线 ─────────────────────
const templates = listFrontendTemplates()
check('模板库含七张模板', ['approval-desk', 'chat-console', 'dashboard', 'data-desk', 'file-desk', 'form-desk', 'kanban'].every((t) => templates.includes(t)), templates.join(','))
check('_ 开头目录不算模板(_vendor/_console 是基础设施)', !templates.includes('_vendor') && !templates.includes('_console'))
check('兜底模板存在于库中', templates.includes(DEFAULT_FRONTEND_TEMPLATE))
// SDK 蒸馏(2026-08-25):通信层住进 _vendor/assembler-sdk.js,模板可二选一——
// 引 SDK(新形态)或自带 wire 三件套(特化页过渡形态);槽位与 turn 语义必须在。
const sdkSrc = readFileSync(join('frontends', '_vendor', 'assembler-sdk.js'), 'utf8')
check('SDK:wire 三件套 + 服务脸 + 围栏出声 + IME 守卫齐备', ['session.create', 'session.prompt', 'events.mux', 'turn/end', '/.service', 'extractFence', 'isComposing'].every((k) => sdkSrc.includes(k)))
for (const t of templates) {
  const html = readFileSync(join('frontends', t, 'index.html'), 'utf8')
  const viaSdk = html.includes('_vendor/assembler-sdk.js') && html.includes('AssemblerSDK.createClient')
  const inline = html.includes('session.create') && html.includes('session.prompt') && html.includes('events.mux') && html.includes('turn/end')
  const wired = (viaSdk || inline) && html.includes('{{presetId}}') && html.includes('{{workdir}}')
  check(`模板 ${t}:通信层就位(SDK 或内联)+ 槽位齐全`, wired)
  check(`模板 ${t}:亮暗双主题`, html.includes('prefers-color-scheme'))
  check(`模板 ${t}:引用本地 vendor 组件库`, html.includes('_vendor/core.min.css') && html.includes('_vendor/utilities.min.css') && html.includes('uk-theme-zinc'))
}

// ── 2. 填参与发射 ──────────────────────────────────────────────────────────
check('fillTemplate 逐槽替换', fillTemplate('a {{x}} b {{y}} {{x}}', { x: '1', y: '2' }) === 'a 1 b 2 1')
check('未提供的槽位置空', fillTemplate('[{{nope}}]', {}) === '[]')

const root = mkdtempSync(join(tmpdir(), 'fe-test-'))
const dir = join(root, 'my-agent')
mkdirSync(dir, { recursive: true })
const fe1 = emitFrontend({ template: 'chat-console', presetDir: dir, presetId: 'my-agent', requirement: '记账助手,把每笔收支记到本地账本', workdir: join(dir, 'workspace') })
check('发射落盘 index.html', existsSync(join(dir, 'frontend', 'index.html')) && fe1.changed === true)
const emitted = readFileSync(join(dir, 'frontend', 'index.html'), 'utf8')
check('槽位已填(presetId 进了页面)', emitted.includes("presetId: 'my-agent'") && !emitted.includes('{{presetId}}'))
check('workdir 绝对路径进了页面', emitted.includes(join(dir, 'workspace')))
const m1 = statSync(join(dir, 'frontend', 'index.html')).mtimeMs
const fe2 = emitFrontend({ template: 'chat-console', presetDir: dir, presetId: 'my-agent', requirement: '记账助手,把每笔收支记到本地账本', workdir: join(dir, 'workspace') })
check('同输入重发 = no-op(复用轮零扰动)', fe2.changed === false && statSync(join(dir, 'frontend', 'index.html')).mtimeMs === m1)
let threw = false
try { emitFrontend({ template: 'no-such-tpl', presetDir: dir, presetId: 'x', requirement: 'r', workdir: '/tmp' }) } catch { threw = true }
check('未知模板抛错(由调用方决定降级)', threw)

// ── 3. 路由解析:安全包含闸 ────────────────────────────────────────────────
const R = (p) => resolveFrontendFile(root, p)
const okHit = R(`${FRONTEND_ROUTE}/my-agent`)
check('裸 id → frontend/index.html', okHit !== null && okHit.file.endsWith('my-agent/frontend/index.html') && okHit.mime.startsWith('text/html'))
check('显式资产名可取', R(`${FRONTEND_ROUTE}/my-agent/index.html`) !== null)
check('非法 id(大写)拒绝', R(`${FRONTEND_ROUTE}/My-Agent`) === null)
check('非法 id(下划线)拒绝', R(`${FRONTEND_ROUTE}/my_agent`) === null)
check('遍历:.. 段拒绝', R(`${FRONTEND_ROUTE}/../secrets`) === null)
check('遍历:编码 %2e%2e 拒绝', R(`${FRONTEND_ROUTE}/my-agent/%2e%2e`) === null)
check('遍历:资产含斜杠拒绝', R(`${FRONTEND_ROUTE}/my-agent/a%2fb.html`) === null)
check('遍历:点开头资产拒绝', R(`${FRONTEND_ROUTE}/my-agent/.env`) === null)
check('嵌套资产可取(scaffold dist 的 assets/ 子目录)', R(`${FRONTEND_ROUTE}/my-agent/assets/index-abc.js`)?.file.endsWith('my-agent/frontend/assets/index-abc.js') === true)
check('嵌套段仍拒 ..、点头文件与超深路径', R(`${FRONTEND_ROUTE}/my-agent/assets/../secret`) === null && R(`${FRONTEND_ROUTE}/my-agent/assets/.env`) === null && R(`${FRONTEND_ROUTE}/my-agent/a/b/c/d/e`) === null)
check('前缀不符拒绝', R('/other/my-agent') === null)
check('mime:js 正确', R(`${FRONTEND_ROUTE}/my-agent/app.js`)?.mime.includes('javascript') === true)
// _vendor 共享段
const v = R(`${FRONTEND_ROUTE}/_vendor/core.min.css`)
check('_vendor 资产可取且指向共享目录', v !== null && v.file.endsWith('frontends/_vendor/core.min.css') && v.mime.includes('css'))
check('_vendor 遍历拒绝', R(`${FRONTEND_ROUTE}/_vendor/%2e%2e`) === null && R(`${FRONTEND_ROUTE}/_vendor/.hidden`) === null)
check('_vendor 子目录可取(守卫内嵌套,遍历仍拒)', R(`${FRONTEND_ROUTE}/_vendor/pack/x.js`) !== null && R(`${FRONTEND_ROUTE}/_vendor/pack/../x.js`) === null)
// 直播台数据函数
import('node:fs').then(() => {})
const pr = join(root)
writeFileSync(join(dir, 'progress.log'), '12:00:00 ══ assemble my-agent 开始 ══\n12:00:01 选型完成\n')
const prog = listAssemblyProgress(pr)
check('直播台列出有 progress.log 的 preset', prog.length === 1 && prog[0].id === 'my-agent' && prog[0].tail.includes('选型完成'))
check('直播台带 mtime(秒)', Number.isInteger(prog[0].mtime) && prog[0].mtime > 1_700_000_000)

// 浏览器半区构建产物:ModuleLoader 制式 + 注册/弹出 API 引用齐全
const clientJs = readFileSync('lib/client.js', 'utf8')
check('client half:ModuleLoader 包裹 + 包名 id', clientJs.startsWith('window.__ModuleLoader__.load(') && clientJs.includes('@dsh-external/dsh-assembler'))
check('client half:registerTab + openTab + 直播台数据源', clientJs.includes('registerTab') && clientJs.includes('openTab') && clientJs.includes('/assembler/ui/_console/data'))
check('client half:react 走外部共享(不自带)', clientJs.includes('require("react")') && clientJs.length < 20000)
check('client half:两块都进侧栏(直播台 + agent 操作台)', clientJs.includes('dsh-assembler:console') && clientJs.includes('dsh-assembler:agent') && clientJs.includes('presetId'))

rmSync(root, { recursive: true, force: true })
console.log(`\n==== 前端车道单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
