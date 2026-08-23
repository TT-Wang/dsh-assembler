#!/usr/bin/env node
/**
 * 架构直构探针的机械校验闸单测(真瓶颈打法 B):合格草图 → 直接成 ProbePlan
 * (省掉 ~160s LLM 推导);任何一条闸不过 → null 回退 LLM。每条闸都是战役真坑。
 * 跑法:node tests-arch-probe.mjs(先 npm run build)
 */
import { validateArchProbe } from './lib/arch-spec.js'
import { sanitizeMarks } from './lib/verify.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const good = {
  kind: 'scenario',
  createTask: '请登记一笔新订单,订单号 ORD-7788,客户张三,金额 500 元,备注"加急"。',
  retrieveTask: '查询订单 ORD-7788,报告它的客户姓名和金额。',
  token: 'ORD-7788',
  marks: ['张三', '500'],
}

// 1. 合格草图 → scenario plan,轮1 标记=token,轮2 标记=marks
const p1 = validateArchProbe(good, sanitizeMarks)
check('合格草图直构 scenario', p1 !== null && p1.kind === 'scenario', JSON.stringify(p1))
check('轮1 = createTask,标记为 token', p1?.scenario?.turns[0].prompt === good.createTask && JSON.stringify(p1?.scenario?.turns[0].mustInclude) === '["ORD-7788"]')
check('轮2 = retrieveTask,标记为 marks', p1?.scenario?.turns[1].prompt === good.retrieveTask && p1?.scenario?.turns[1].mustInclude.includes('张三'))

// 2. token 自给自足闸:轮1 或轮2 不含 token → null
check('createTask 缺 token → 回退', validateArchProbe({ ...good, createTask: '登记一笔订单,客户张三,金额 500。' }, sanitizeMarks) === null)
check('retrieveTask 缺 token → 回退', validateArchProbe({ ...good, retrieveTask: '查询刚才那笔订单,报告客户和金额。' }, sanitizeMarks) === null)

// 3. 照抄闸:retrieveTask 把标记值复述在指令里 → null(agent 照抄即假 PASS)
check('取回轮复述标记值 → 回退', validateArchProbe({ ...good, retrieveTask: '查询订单 ORD-7788,确认客户是张三、金额 500。' }, sanitizeMarks) === null)

// 4. 标记消毒闸:代码碎片/过短标记全剔 → null
check('标记全是垃圾 → 回退', validateArchProbe({ ...good, marks: ['(', 'x'] }, sanitizeMarks) === null)
check('标记为空 → 回退', validateArchProbe({ ...good, marks: [] }, sanitizeMarks) === null)

// 5. 短任务/短 token 闸
check('createTask 过短 → 回退', validateArchProbe({ ...good, createTask: '建单ORD-7788' }, sanitizeMarks) === null)
check('token 过短 → 回退', validateArchProbe({ ...good, token: 'A1', createTask: good.createTask.replace('ORD-7788', 'A1'), retrieveTask: good.retrieveTask.replace('ORD-7788', 'A1') }, sanitizeMarks) === null)

// 6. single 形态
const single = validateArchProbe({ kind: 'single', task: '把 128 摄氏度转成华氏度并报告结果。', marks: ['262.4'] }, sanitizeMarks)
check('single 草图直构', single !== null && single.kind === 'single' && single.probe.mustInclude.includes('262.4'))
check('single 缺 task → 回退', validateArchProbe({ kind: 'single', marks: ['262.4'] }, sanitizeMarks) === null)

console.log(`\n==== 架构直构探针单元测试: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ====`)
process.exit(failures === 0 ? 0 : 1)
