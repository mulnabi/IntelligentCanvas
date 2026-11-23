import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

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

const root = createRoot(document.getElementById('root'))

async function startApp() {
  try {
    const { default: App } = await import('./App.jsx')
    root.render(<StrictMode><App /></StrictMode>)
  } catch (error) {
    console.error(error)
    const message = error instanceof Error && error.message.startsWith('[Firebase 설정]')
      ? error.message : '앱을 시작하지 못했습니다. 페이지를 새로고침해 주세요.'
    root.render(<p className="no-result" role="alert">{message}</p>)
  }
}

void startApp()
