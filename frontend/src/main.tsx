import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/components/ThemeProvider'
import { initClientLogger } from '@/lib/clientLogger'
import App from './App'
import './index.css'

// 初始化浏览器控制台日志上报：拦截 console 与未捕获异常，批量发送到后端写入 log/frontend-console.log
// 生产环境只上报 warn 及以上：debug/info 调用点有 270+ 处（含轮询循环内的日志），
// 全量上报会持续占用带宽与后端写入，开发环境保留 debug 便于排查。
initClientLogger({ minLevel: import.meta.env.DEV ? 'debug' : 'warn' })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
)
