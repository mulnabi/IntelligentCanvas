import { useState } from 'react'
import '../Auth.css'

const initialValues = {
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
}

function SignupPage({ onBack, onSignup }) {
  const [values, setValues] = useState(initialValues)
  const [error, setError] = useState('')

  const updateValue = (field) => (event) => {
    setValues({ ...values, [field]: event.target.value })
    setError('')
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    if (values.password !== values.confirmPassword) {
      setError('비밀번호가 일치하지 않습니다.')
      return
    }

    onSignup()
  }

  return (
    <main className="auth-page">
      <section className="auth-card auth-card--signup">
        <header className="signup-header">
          <button
            aria-label="로그인 화면으로 돌아가기"
            className="auth-back"
            onClick={onBack}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1>회원가입</h1>
        </header>
        <form className="auth-form signup-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="signup-username">아이디</label>
            <input
              autoComplete="username"
              id="signup-username"
              onChange={updateValue('username')}
              placeholder="아이디를 입력해 주세요"
              required
              value={values.username}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-email">이메일</label>
            <input
              autoComplete="email"
              id="signup-email"
              onChange={updateValue('email')}
              placeholder="이메일을 입력해 주세요"
              required
              type="email"
              value={values.email}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-password">비밀번호</label>
            <input
              autoComplete="new-password"
              id="signup-password"
              minLength={8}
              onChange={updateValue('password')}
              placeholder="8자 이상 입력해 주세요"
              required
              type="password"
              value={values.password}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-confirm-password">비밀번호 확인</label>
            <input
              autoComplete="new-password"
              id="signup-confirm-password"
              onChange={updateValue('confirmPassword')}
              placeholder="비밀번호를 다시 입력해 주세요"
              required
              type="password"
              value={values.confirmPassword}
            />
          </div>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="auth-button auth-button--primary" type="submit">가입하기</button>
        </form>
      </section>
    </main>
  )
}

export default SignupPage
