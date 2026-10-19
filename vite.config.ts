/**
 * Vite 配置（架构文档 §3.1 #3）：
 * - react + @tailwindcss/vite 插件（Tailwind v4 无需单独 postcss/tailwind.config）；
 * - `@shared` 别名与 tsconfig.json paths 保持一致（前后端共享契约目录）；
 * - publicDir="agent"：构建时把 dujie-agent.py 复制进 dist 根（§8.1 一键安装 curl 下载）；
 * - 产物输出 dist/（wrangler.toml [assets] directory 指向该目录）。
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// shared 目录绝对路径，与 tsconfig paths 的 "@shared/*" 对应
const sharedDir = new URL('./shared', import.meta.url).pathname

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': sharedDir,
    },
  },
  publicDir: 'agent',
  build: {
    outDir: 'dist',
  },
})
