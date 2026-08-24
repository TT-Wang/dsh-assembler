import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// base './':构建产物用相对路径引资产——static-deploy 进 /assembler/ui/<preset>/
// 任意前缀下照常工作(同源伺服,零 CORS)。
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
