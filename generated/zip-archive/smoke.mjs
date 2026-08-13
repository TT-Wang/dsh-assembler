/**
 * smoke.mjs — zip-archive MCP stdio server 冒烟验证。
 *
 * 流程:
 *   1. listTools() 打印工具清单
 *   2. zip-create-archive 内存压缩两个文件
 *   3. zip-list-entries 列条目
 *   4. zip-read-file 解压读回内容（含 base64 二进制读回）
 *   5. zip-update-archive 增/删条目
 *   6. 缺参调用（zip-read-file 不带 entry）验证 zod 校验错误
 *   7. 校验 server 在 client 关闭后干净退出
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const transport = new StdioClientTransport({
  command: 'node',
  args: ['index.js'],
  cwd: new URL('.', import.meta.url).pathname,
})

const client = new Client({ name: 'smoke-zip-archive', version: '0.0.1' })
await client.connect(transport)

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    failed++
    console.log(`  [FAIL] ${name}${extra ? ' — ' + extra : ''}`)
  }
}

// ---- 1. listTools ----
console.log('== 1. listTools() ==')
const { tools } = await client.listTools()
console.log('tools:', tools.map((t) => t.name).join(', '))
const names = tools.map((t) => t.name)
for (const expect of ['zip-list-entries', 'zip-read-file', 'zip-create-archive', 'zip-update-archive']) {
  ok(`listTools 包含 ${expect}`, names.includes(expect))
}
ok('工具数量为 4', names.length === 4, `实际 ${names.length}`)

// ---- 2. zip-create-archive ----
console.log('== 2. zip-create-archive（内存压缩两个文件）==')
const created = await client.callTool({
  name: 'zip-create-archive',
  arguments: {
    files: [
      { name: 'hello.txt', content: '你好，adm-zip! Hello from zip-archive smoke test.', comment: 'smoke 条目注释' },
      { name: 'docs/', content: '' }, // 显式目录条目
      { name: 'docs/readme.md', content: '# Smoke\n\n生成的归档冒烟测试。' },
      { name: 'bin/data.bin', content: Buffer.from([0, 1, 2, 253, 254, 255]).toString('base64'), encoding: 'base64' },
    ],
  },
})
const createdJson = JSON.parse(created.content[0].text)
const zipB64 = createdJson.zip
console.log('created entries:', JSON.stringify(createdJson.entries.map((e) => e.entryName)))
ok('创建成功且返回 zip base64', typeof zipB64 === 'string' && zipB64.length > 0)
ok('条目数 = 4', createdJson.count === 4, `实际 ${createdJson.count}`)
ok('含目录 docs/', createdJson.entries.some((e) => e.entryName === 'docs/' && e.isDirectory))
ok('data.bin 为 DEFLATE 压缩', createdJson.entries.find((e) => e.entryName === 'bin/data.bin').method === 8)

// ---- 3. zip-list-entries ----
console.log('== 3. zip-list-entries ==')
const listed = await client.callTool({
  name: 'zip-list-entries',
  arguments: { zip: zipB64 },
})
const listedJson = JSON.parse(listed.content[0].text)
console.log('count:', listedJson.count, 'entries:', listedJson.entries.map((e) => `${e.entryName}(${e.size}B/c${e.compressedSize}B)`).join(', '))
ok('列出 4 个条目', listedJson.count === 4)
ok('hello.txt size 正确', listedJson.entries.find((e) => e.entryName === 'hello.txt').size > 0)

// ---- 4. zip-read-file ----
console.log('== 4. zip-read-file（读回内容）==')
const txt = await client.callTool({
  name: 'zip-read-file',
  arguments: { zip: zipB64, entry: 'hello.txt' },
})
const txtJson = JSON.parse(txt.content[0].text)
console.log('hello.txt ->', JSON.stringify(txtJson.content))
ok('hello.txt 内容读回一致', txtJson.content === '你好，adm-zip! Hello from zip-archive smoke test.')

const md = await client.callTool({
  name: 'zip-read-file',
  arguments: { zip: zipB64, entry: 'docs/readme.md', encoding: 'utf8' },
})
const mdJson = JSON.parse(md.content[0].text)
ok('docs/readme.md 子目录内文件读回', mdJson.content.includes('Smoke'))

const bin = await client.callTool({
  name: 'zip-read-file',
  arguments: { zip: zipB64, entry: 'bin/data.bin', encoding: 'base64' },
})
const binJson = JSON.parse(bin.content[0].text)
const binBuf = Buffer.from(binJson.content, 'base64')
ok('bin/data.bin 二进制读回一致', binBuf.equals(Buffer.from([0, 1, 2, 253, 254, 255])), `bytes=${Array.from(binBuf)}`)

// ---- 5. zip-update-archive ----
console.log('== 5. zip-update-archive（增/改/删）==')
const updated = await client.callTool({
  name: 'zip-update-archive',
  arguments: {
    zip: zipB64,
    addOrUpdate: [
      { name: 'hello.txt', content: 'updated content' },
      { name: 'new-file.txt', content: '我是新加的' },
    ],
    delete: ['docs/readme.md'],
    comment: 'smoke 归档注释',
  },
})
const updatedJson = JSON.parse(updated.content[0].text)
console.log('updated entries:', updatedJson.entries.map((e) => e.entryName).join(', '), '| zipComment:', updatedJson.zipComment)
ok('更新后条目数 = 4 (hello覆盖, new新增, readme删除, docs保留)', updatedJson.count === 4, `实际 ${updatedJson.count}`)
ok('归档注释生效', updatedJson.zipComment === 'smoke 归档注释')

const helloUpdated = await client.callTool({
  name: 'zip-read-file',
  arguments: { zip: updatedJson.zip, entry: 'hello.txt' },
})
ok('hello.txt 内容被覆盖更新', JSON.parse(helloUpdated.content[0].text).content === 'updated content')

const delErr = await client.callTool({
  name: 'zip-update-archive',
  arguments: { zip: zipB64, delete: ['不存在.txt'] },
})
ok('删除不存在条目返回 isError', delErr.isError === true, delErr.content[0].text.slice(0, 60))

// ---- 6. 缺参校验 ----
console.log('== 6. 缺参调用验证 ==')
const missing = await client.callTool({
  name: 'zip-read-file',
  arguments: { zip: zipB64 }, // 缺少必填 entry
})
console.log('missing-arg result isError:', missing.isError, '| text:', (missing.content?.[0]?.text || '').slice(0, 80))
ok('缺参调用被拒绝（isError 或校验错误文本）', missing.isError === true || /entry|参数/i.test(missing.content?.[0]?.text || ''))

const badB64 = await client.callTool({
  name: 'zip-list-entries',
  arguments: { zip: '!!!not-base64!!!' },
})
ok('非法 base64 返回清晰错误', badB64.isError === true && /base64|错误/i.test(badB64.content[0].text), badB64.content[0].text.slice(0, 60))

// ---- 结果 ----
console.log(`\n===== 冒烟结果: ${passed} passed, ${failed} failed =====`)
await client.close()
console.log('client closed; 等待 server 干净退出…')

// server 应在 stdin 关闭后自行退出；这里等待子进程结束并确认退出码
const proc = transport._process
if (proc) {
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve('TIMEOUT(server 未在 5s 内退出)'), 5000)
    proc.on('exit', (c) => {
      clearTimeout(t)
      resolve(c)
    })
    // 某些 SDK 版本 close 后进程可能已退出，兜底
    if (proc.exitCode !== null) {
      clearTimeout(t)
      resolve(proc.exitCode)
    }
  })
  console.log('server exit code:', code)
  ok('server 在 client 关闭后干净退出', code === 0 || code === null, `code=${code}`)
}

process.exit(failed === 0 ? 0 : 1)
