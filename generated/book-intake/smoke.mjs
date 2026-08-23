// book-intake 冒烟:真拉起 stdio 服务、真调三个工具、真走 HTTP 上传通道。
// 门槛(index-add verify 契约):真调用拿真结果 + 进程干净退场。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import AdmZip from 'adm-zip'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const workdir = mkdtempSync(join(tmpdir(), 'book-intake-smoke-'))

// 造一本最小 epub(container.xml → content.opf spine → 两章 xhtml)
const zip = new AdmZip()
zip.addFile('mimetype', Buffer.from('application/epub+zip'))
zip.addFile('META-INF/container.xml', Buffer.from(
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'))
zip.addFile('OEBPS/content.opf', Buffer.from(
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>微尘集</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'))
zip.addFile('OEBPS/ch1.xhtml', Buffer.from('<html><body><h1>夜航</h1><p>船在夜里走。</p></body></html>'))
zip.addFile('OEBPS/ch2.xhtml', Buffer.from('<html><body><h1>灯下</h1><p>灯下读旧信。</p></body></html>'))
writeFileSync(join(workdir, 'weichen.epub'), zip.toBuffer())
writeFileSync(join(workdir, 'note.txt'), '第一行笔记\n第二行笔记\n')

const client = new Client({ name: 'smoke', version: '0.0.1' })
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'index.js')],
  env: { ...process.env, PART_WORKDIR: workdir },
}))

// 1. 工具面
const tools = (await client.listTools()).tools.map((t) => t.name)
console.log('tools:', tools.join(', '))
for (const t of ['upload-info', 'extract-epub', 'extract-text-file']) ok(`listTools 含 ${t}`, tools.includes(t))
ok('工具数为 3', tools.length === 3, `实际 ${tools.length}`)

// 2. extract-epub:真解析,拿真章节
const ep = JSON.parse((await client.callTool({ name: 'extract-epub', arguments: { path: 'weichen.epub' } })).content[0].text)
ok('书名解析', ep.title === '微尘集', JSON.stringify(ep).slice(0, 120))
ok('两章齐且顺序对', ep.chapters?.length === 2 && ep.chapters[0].title === '夜航' && ep.chapters[1].title === '灯下')
ok('正文提取', String(ep.chapters?.[1]?.content ?? '').includes('灯下读旧信'))

// 3. 路径穿越拒绝
const esc = await client.callTool({ name: 'extract-epub', arguments: { path: '../outside.epub' } })
ok('路径穿越被拒', esc.isError === true || /escape/i.test(esc.content?.[0]?.text ?? ''))

// 4. extract-text-file(返回裸文本)
const txtRaw = (await client.callTool({ name: 'extract-text-file', arguments: { path: 'note.txt' } })).content[0].text
ok('文本读取', String(txtRaw).includes('第二行笔记'), String(txtRaw).slice(0, 100))

// 5. HTTP 上传通道:upload-info 拿端口 → POST 真字节 → 落盘核对
const info = JSON.parse((await client.callTool({ name: 'upload-info', arguments: {} })).content[0].text)
ok('上传口已通告(127.0.0.1)', typeof info.url === 'string' && info.url.includes('127.0.0.1'))
const res = await fetch(`${info.url}up.bin`, { method: 'POST', body: Buffer.from([1, 2, 3, 250]) })
const up = await res.json()
ok('HTTP 上传 200 且回路径', res.ok && typeof up.path === 'string', JSON.stringify(up).slice(0, 100))
const landed = join(workdir, 'uploads', 'up.bin')
ok('字节精确落盘 uploads/', existsSync(landed) && readFileSync(landed).length === 4)

await client.close()
if (failures > 0) {
  console.error(`book-intake smoke: ${failures} failure(s)`)
  process.exit(1)
}
console.log('book-intake smoke: all green')
process.exit(0)
