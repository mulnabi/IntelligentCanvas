import { createBrowserRouter, createHashRouter, RouterProvider, Routes, Route, Navigate, useNavigate } from 'react-router'

import './App.css'

import ArtworkList from './page/ArtworkList'
import ArtworkDrawingPage from './page/ArtworkDrawingPage'
import SignupPage from './page/SignupPage'
import LoginPage from './page/LoginPage'
import { useAuth } from './hook/useAuth'
import { loginUser, registerUser, retryProfileSave } from './services/authService'

function AppRoutes() {
  const navigate = useNavigate()
  const { user, loading, error } = useAuth()

  const handleLogin = async (values) => {
    const signedInUser = await loginUser(values)
    navigate('/', { replace: true })
    return signedInUser
  }

  const handleSignup = async (values) => {
    const result = await registerUser(values)
    navigate('/', { replace: true })
    return result
  }

  const handleRetryProfile = async (values) => {
    const result = await retryProfileSave(values)
    navigate('/', { replace: true })
    return result
  }

  return (
    <Routes>
      <Route path="/" element={!loading && !error && !user
        ? <Navigate to="/login" replace />
        : <ArtworkList key={user?.uid ?? 'signed-out'} uid={user?.uid ?? null} authLoading={loading} authError={error}/>} />
      <Route path="/singup" element={<Navigate to="/signup" replace />} />
      <Route path="/signup" element={<SignupPage
        onSignup={handleSignup}
        onRetryProfile={handleRetryProfile}
        authLoading={loading}
        authError={error}
        currentUid={user?.uid ?? null}
      />} />
      <Route path="/login" element={<LoginPage
        onLogin={handleLogin}
        authLoading={loading}
        authError={error}
      />} />
      <Route path="/drawing" element={<Navigate to="/" replace />} />
      <Route path="/drawing/:artworkId" element={<ArtworkDrawingPage key={user?.uid ?? 'signed-out'} uid={user?.uid ?? null} authLoading={loading} authError={error}/>} />
    </Routes>
  )
}

// 기존 경로/화면을 유지하면서 useBlocker로 미저장 상태의 내부 이동을 기다린다.
const createRouter = import.meta.env.VITE_GITHUB_PAGES === 'true' ? createHashRouter : createBrowserRouter
const router = createRouter([{ path: '*', element: <AppRoutes/> }])

export default function App() { return <RouterProvider router={router}/> }
