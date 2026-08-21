// 浏览器半区打包:esbuild CJS + __ModuleLoader__.load 包裹(与 genui 同制式)。
// externals(react 等)在运行时经 factory 的 require 参数由 host 共享模块图供给。
import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

const result = await build({
  entryPoints: [join(REPO, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
  external: ['react', 'react-dom', 'cordis', '@deepseek-ai/*', 'dsh-better-sidebar', 'dsh-better-sidebar/*'],
})

const cjs = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({id:${JSON.stringify(PKG.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${cjs}\nreturn module.exports}})\n`
mkdirSync(join(REPO, 'lib'), { recursive: true })
writeFileSync(join(REPO, 'lib', 'client.js'), wrapped)
console.log(`client half → lib/client.js (${wrapped.length} bytes)`)
