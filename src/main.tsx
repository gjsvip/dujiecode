/**
 * 渡劫code SPA 入口（架构文档 §3.3 #11）：
 * React 18 挂载 + BrowserRouter + 全局 CSS（Tailwind v4 深色 IDE 主题）。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('缺少 #root 挂载节点，请检查 index.html')
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
