import { useState } from 'react'
import '../Auth.css'

function LoginPage({ onLogin, onSignup }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()

    if (!email || !password) {
      setError('이메일과 비밀번호를 모두 입력해 주세요.')
      return
    }

    setError('')
    onLogin({ email, password })
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-placeholder" aria-hidden="true" />
        <form className="auth-form login-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="login-email">이메일</label>
            <input
              autoComplete="email"
              id="login-email"
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
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호를 입력해 주세요"
              required
              type="password"
              value={password}
            />
          </div>

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button className="auth-button auth-button--primary" type="submit">
            로그인
          </button>
          <button
            className="auth-button auth-button--secondary"
            onClick={onSignup}
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