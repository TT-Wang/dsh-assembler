#!/usr/bin/env node
/**
 * 目录文件写入单元测试。
 *
 * 这两个函数守的是同一件事:index/catalog.yml 和 capabilities.yml 是拼字符串
 * 拼出来的,而它们是产品的数据本体。真实事故:register 逐字段决定引号,漏了
 * license;收录 OSV.dev 时许可证写作 `Apache-2.0 (OSV data: per-source, …)`,
 * 里头的 ": " 让整份 catalog.yml 解析不了,而 register 报的是 ok。
 *
 * 所以两条断言线:
 *   s()          —— 凡是能把 YAML 写坏的字符,过它一遍都不再能写坏
 *   assertYaml() —— 万一还是写坏了(下一种没见过的破法),写入前就得拦下
 */
import yaml from 'js-yaml'
import { s, assertYaml } from './scripts/yaml-write.mjs'

let failed = 0
const ok = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra === '' ? '' : ` — ${extra}`}`)
  if (!cond) failed++
}

/** 把一个值写成 `key: <scalar>` 再读回来,断言原值无损往返。 */
const roundTrip = (value) => yaml.load(`key: ${s(value)}`).key

// ── s():能把 YAML 写坏的那些字符 ───────────────────────────────────────────
// 排头的就是真出过事的那个。
const realLicence = 'Apache-2.0 (OSV data: per-source, CC-BY-4.0 for OSV-prefixed records)'
ok('冒号加空格(真实事故那一条)无损往返', roundTrip(realLicence) === realLicence, realLicence.slice(0, 32) + '…')

for (const [label, value] of [
  ['行首井号(会被当注释)', '# not a comment'],
  ['行内井号', 'MIT # really'],
  ['纯冒号结尾', 'weird:'],
  ['换行', 'line one\nline two'],
  ['双引号', 'he said "hi"'],
  ['单引号', "it's fine"],
  ['反斜杠', 'C:\\path\\to'],
  ['前后空白', '  padded  '],
  ['破折号开头(会被当列表项)', '- item'],
  ['花括号(流式映射)', '{a: 1}'],
  ['方括号(流式序列)', '[1, 2]'],
  ['锚点与引用符号', '&anchor *alias'],
  ['制表符', 'a\tb'],
  ['中文全角标点', '许可证(参考):不是法律结论'],
  ['emoji', 'ok 🎉'],
  ['像布尔的字符串', 'yes'],
  ['像 null 的字符串', 'null'],
  ['像数字的字符串', '0755'],
  ['空串', ''],
]) {
  ok(`${label} 无损往返`, roundTrip(value) === value, JSON.stringify(value))
}

ok('undefined 变空串而不是字面 undefined', roundTrip(undefined) === '')
ok('null 变空串', roundTrip(null) === '')
ok('数字被序列化成字符串(目录里一律字符串,类型不漂移)', roundTrip(42) === '42')
ok('像布尔的字符串读回来还是字符串', typeof roundTrip('yes') === 'string')
ok('像数字的字符串不丢前导零', roundTrip('0755') === '0755')

// 流式映射里也要成立——工具行就是 `- { name: …, description: … }` 这个形状。
const flow = yaml.load(`- { name: ${s('a,b}c')}, description: ${s('has "quotes" and: colon')} }`)
ok('流式映射里带逗号与右花括号的名字不破坏结构', flow[0].name === 'a,b}c', JSON.stringify(flow[0].name))
ok('流式映射里带引号与冒号的描述无损', flow[0].description === 'has "quotes" and: colon')

// ── assertYaml():坏文本必须在写入前被拦下 ──────────────────────────────────
const good = 'a: 1\nb:\n  - x\n  - y\n'
let threw = false
try { assertYaml(good, 'good.yml') } catch { threw = true }
ok('合法 YAML 放行', threw === false)
ok('放行时原样返回文本(便于串在写入链上)', assertYaml(good, 'good.yml') === good)

const badCases = [
  ['未加引号的冒号(真实事故的形状)', 'license: Apache-2.0 (OSV data: per-source)\n'],
  ['缩进错乱', 'a:\n  b: 1\n   c: 2\n'],
  ['流式映射没闭合', '- { name: x, description: y\n'],
  ['重复键', 'a: 1\na: 2\n'],
]
for (const [label, text] of badCases) {
  let msg = null
  try { assertYaml(text, 'catalog.yml') } catch (e) { msg = e.message }
  ok(`拦下:${label}`, msg !== null, msg === null ? '(放行了!)' : msg.slice(0, 60))
  if (msg !== null) ok(`  报错里点明是哪个文件`, msg.includes('catalog.yml'))
}

console.log(`\n==== 目录写入单元测试: ${failed === 0 ? '全部通过 ✅' : `${failed} 条失败 ❌`} ====`)
process.exit(failed === 0 ? 0 : 1)
