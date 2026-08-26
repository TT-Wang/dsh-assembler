// 骨架入口(禁改):暗色随系统;App 负责挂载 pages/。
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('dark')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
