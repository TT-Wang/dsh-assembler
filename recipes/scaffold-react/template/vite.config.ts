import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// base:按配套 preset 的**绝对**路径构建资产引用(/assembler/ui/<preset>/)。
// 病史:曾用相对 base './',而 host 伺服的页面 URL 无尾斜杠,浏览器把
// './assets/x' 解析成 /assembler/ui/assets/x(preset 段被吃掉)→ 全部资产 404、
// 页面白屏。PRESET_ID 在实例化时已知(app.config.json),据此定死。
function presetBase(): string {
  const cfg = path.resolve(__dirname, 'app.config.json')
  if (existsSync(cfg)) {
    const id = (JSON.parse(readFileSync(cfg, 'utf8')) as { PRESET_ID?: string }).PRESET_ID
    if (typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id)) return `/assembler/ui/${id}/`
  }
  return './'
}

export default defineConfig({
  base: presetBase(),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
