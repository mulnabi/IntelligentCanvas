import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// 개발자 콘솔에서 명시적으로 호출할 때만 테스트 모듈을 불러온다.
if (import.meta.env.DEV) {
  window.runFirebaseSmokeTest = async (options) => {
    try {
      const { runFirebaseSmokeTest } = await import('./dev/firebaseSmokeTest.js')
      return await runFirebaseSmokeTest(options)
    } catch (error) {
      const detail = error instanceof Error && error.message.startsWith('[Firebase 설정]')
        ? error.message : '검증 모듈을 불러오지 못했습니다. 개발 서버와 환경변수 설정을 확인해 주세요.'
      const result = { success: false, checks: [{ name: 'Firebase 초기화', status: '실패', detail }] }
      console.table(result.checks)
      return result
    }
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
