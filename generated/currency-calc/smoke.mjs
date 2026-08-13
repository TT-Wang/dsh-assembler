/**
 * 冒烟测试：连接本 MCP stdio server，列出工具并真实调用验证。
 * 运行: node smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
})

const client = new Client({ name: 'currency-calc-smoke', version: '0.0.1' })

async function callTool(name, args) {
  const res = await client.callTool({ name, arguments: args })
  return res
}

function firstText(res) {
  const t = res?.content?.find((c) => c.type === 'text')
  return t ? t.text : JSON.stringify(res)
}

let failures = 0
function check(label, actual, expected) {
  const ok = String(actual).includes(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label}`)
  if (!ok) {
    failures++
    console.log(`  expected substring: ${expected}`)
    console.log(`  actual:             ${actual}`)
  }
}

try {
  await client.connect(transport)

  // 1. listTools
  const tools = await client.listTools()
  console.log('=== listTools ===')
  for (const t of tools.tools) {
    console.log(`- ${t.name}: ${(t.description || '').slice(0, 80)}...`)
  }
  console.log(`工具数量: ${tools.tools.length}`)
  check('listTools 数量为 4', tools.tools.length, '4')

  // 2. currency-calc: 精度验证 1.23 + 4.56 = 5.79（浮点直接相加是 5.789999999999999）
  const addRes = await callTool('currency-calc', { op: 'add', value: 1.23, operand: 4.56 })
  const addText = firstText(addRes)
  console.log('\n=== currency-calc(1.23 + 4.56) ===')
  console.log(addText)
  check('add: result=5.79', addText, '"value": 5.79')
  check('add: formatted=$5.79', addText, '"formatted": "$5.79"')

  // 3. currency-calc: 字符串金额乘法（README 场景）
  const mulRes = await callTool('currency-calc', { op: 'multiply', value: '2,573,693.75', operand: 2 })
  const mulText = firstText(mulRes)
  console.log('\n=== currency-calc(2,573,693.75 * 2) ===')
  console.log(mulText)
  check('multiply: result=5147387.5', mulText, '"value": 5147387.5')

  // 4. currency-calc: 除零校验
  const divRes = await callTool('currency-calc', { op: 'divide', value: 10, operand: 0 })
  const divText = firstText(divRes)
  console.log('\n=== currency-calc(10 / 0) ===')
  console.log(divText)
  check('divide-by-zero 返回错误', divText, '不能为 0')

  // 5. currency-format: 日元格式
  const fmtRes = await callTool('currency-format', { value: 1234.56, symbol: '¥' })
  const fmtText = firstText(fmtRes)
  console.log('\n=== currency-format(1234.56, ¥) ===')
  console.log(fmtText)
  check('format: ¥1,234.56', fmtText, '"formatted": "¥1,234.56"')

  // 6. currency-distribute: 1.12 分 5 份
  const distRes = await callTool('currency-distribute', { value: 1.12, count: 5 })
  const distText = firstText(distRes)
  console.log('\n=== currency-distribute(1.12, 5) ===')
  console.log(distText)
  check('distribute: sumMatchesTotal=true', distText, '"sumMatchesTotal": true')

  // 7. currency-parse: 欧元格式
  const parseRes = await callTool('currency-parse', { value: '€2.573.693,75', decimal: ',' })
  const parseText = firstText(parseRes)
  console.log('\n=== currency-parse(€2.573.693,75, decimal=,) ===')
  console.log(parseText)
  check('parse: parsed=2573693.75', parseText, '"parsed": 2573693.75')

  // 8. 缺参校验（SDK zod 校验层）
  const missing = await callTool('currency-format', {})
  console.log('\n=== currency-format(缺参) ===')
  console.log(firstText(missing))
  check('缺参返回错误', firstText(missing), 'value')

  // 9. 非法输入：无数字字符串
  const invalid = await callTool('currency-parse', { value: 'abc' })
  const invalidText = firstText(invalid)
  console.log('\n=== currency-parse(abc) ===')
  console.log(invalidText)
  check('非法输入返回错误', invalidText, '至少一个数字')

  // 10. 缺必填参数（SDK zod 校验层：value/operand 均为必填）
  const missingOp = await callTool('currency-calc', { op: 'add' })
  console.log('\n=== currency-calc(add, 缺 value/operand) ===')
  console.log(firstText(missingOp))
  check('缺 value 返回校验错误', firstText(missingOp), 'Invalid input at value')

  console.log('\n========================')
  if (failures === 0) {
    console.log('SMOKE OK (全部断言通过)')
    process.exit(0)
  } else {
    console.log(`SMOKE FAILED (${failures} 个断言未通过)`)
    process.exit(1)
  }
} catch (e) {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
}
