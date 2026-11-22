import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { getAuthErrorMessage } from '../services/authService'
import './Auth.css'

function LoginPage({ onLogin, authLoading = false, authError = '' }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (inFlight.current || authLoading || authError) return

    if (!email || !password) {
      setError('이메일과 비밀번호를 모두 입력해 주세요.')
      return
    }

    setError('')
    inFlight.current = true
    setSubmitting(true)
    try {
      await onLogin({ email: email.trim(), password })
    } catch (error) {
      setError(getAuthErrorMessage(error))
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-placeholder" aria-hidden="true" />
        <form className="auth-form login-form" onSubmit={handleSubmit} aria-busy={submitting || authLoading}>
          <div className="auth-field">
            <label htmlFor="login-email">이메일</label>
            <input
              autoComplete="email"
              id="login-email"
              disabled={submitting}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="이메일을 입력해 주세요"
              required
              type="email"
              value={email}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="login-password">비밀번호</label>
            <input
              autoComplete="current-password"
              id="login-password"
              disabled={submitting}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력해 주세요"
              required
              type="password"
              value={password}
            />
          </div>

          {(error || authError) && <p className="auth-error" role="alert">{error || authError}</p>}

          <button className="auth-button auth-button--primary" type="submit" disabled={submitting || authLoading || !!authError}>
            {submitting ? '로그인 중…' : authLoading ? '로그인 상태 확인 중…' : '로그인'}
          </button>
          <button
            className="auth-button auth-button--secondary"
            onClick={() => navigate('/signup', { state: { fromLogin: true } })}
            disabled={submitting}
            type="button"
          >
            회원가입
          </button>
        </form>
      </section>
    </main>
  )
}

export default LoginPage
