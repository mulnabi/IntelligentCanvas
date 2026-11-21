import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { getAuthErrorMessage } from '../services/authService'
import './Auth.css'

const initialValues = {
  username: '',
  email: '',
  password: '',
  confirmPassword: '',
}

function SignupPage({ onSignup, onRetryProfile, authLoading = false, authError = '', currentUid = null }) {
  const navigate = useNavigate()
  const { state } = useLocation()
  const [values, setValues] = useState(initialValues)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pendingProfile, setPendingProfile] = useState(null)
  const inFlight = useRef(false)
  const retryingProfile = pendingProfile !== null
  const accountChanged = retryingProfile && !authLoading && currentUid !== pendingProfile.uid

  const updateValue = (field) => (event) => {
    setValues({ ...values, [field]: event.target.value })
    setError('')
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (inFlight.current || authLoading || authError || accountChanged) return
    if (!values.username.trim() || values.username.trim().length > 80) {
      setError('닉네임은 공백을 제외한 1~80자로 입력해 주세요.')
      return
    }
    if (!retryingProfile && values.password !== values.confirmPassword) {
      setError('비밀번호가 일치하지 않습니다.')
      return
    }

    inFlight.current = true
    setSubmitting(true)
    setError('')
    try {
      if (retryingProfile) {
        await onRetryProfile({ uid: pendingProfile.uid, nickname: values.username })
      } else {
        await onSignup({ username: values.username, email: values.email, password: values.password })
      }
    } catch (error) {
      if (error?.code === 'profile/save-failed') {
        setPendingProfile({ uid: error.uid })
        setValues((previous) => ({ ...previous, email: error.email ?? previous.email, password: '', confirmPassword: '' }))
      }
      setError(getAuthErrorMessage(error))
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const handleBack = () => {
    if (state?.fromLogin === true) navigate(-1)
    else navigate('/login', { replace: true })
  }

  return (
    <main className="auth-page">
      <section className="auth-card auth-card--signup">
        <header className="signup-header">
          <button
            aria-label="로그인 화면으로 돌아가기"
            className="auth-back"
            onClick={handleBack}
            disabled={submitting}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <h1>회원가입</h1>
        </header>
        <form className="auth-form signup-form" onSubmit={handleSubmit} aria-busy={submitting || authLoading}>
          <div className="auth-field">
            <label htmlFor="signup-username">닉네임</label>
            <input
              autoComplete="username"
              id="signup-username"
              maxLength={80}
              disabled={submitting}
              onChange={updateValue('username')}
              placeholder="닉네임을 입력해 주세요 (중복 가능)"
              required
              value={values.username}
            />
          </div>
          <div className="auth-field">
            <label htmlFor="signup-email">이메일</label>
            <input
              autoComplete="email"
              id="signup-email"
              disabled={submitting || retryingProfile}
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
              disabled={submitting || retryingProfile}
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
              disabled={submitting || retryingProfile}
              onChange={updateValue('confirmPassword')}
              placeholder="비밀번호를 다시 입력해 주세요"
              required
              type="password"
              value={values.confirmPassword}
            />
          </div>
          {(error || authError || accountChanged) && <p className="auth-error" role="alert">
            {accountChanged ? '로그인 계정이 변경되었습니다. 로그인 화면에서 해당 계정으로 다시 로그인해 주세요.' : error || authError}
          </p>}
          <button className="auth-button auth-button--primary" type="submit" disabled={submitting || authLoading || !!authError || accountChanged}>
            {submitting ? '처리 중…' : authLoading ? '로그인 상태 확인 중…' : retryingProfile ? '프로필 저장 다시 시도' : '가입하기'}
          </button>
        </form>
      </section>
    </main>
  )
}

export default SignupPage
