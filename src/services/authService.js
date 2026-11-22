import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { ensureUserProfile, normalizeNickname } from './userService'
import { withCanvasSaved } from './pendingCanvasChanges'
import { getSessionIdToken, waitForAuthSession } from './authSession'

async function getAuthClient() {
  // 지연 import로 개발 설정 오류가 기존 작품 목록·그림판 렌더링을 중단하지 않게 한다.
  const { auth } = await import('../config/firebase.js')
  await waitForAuthSession(auth)
  return auth
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function getAuthErrorMessage(error) {
  if (error?.code?.startsWith('canvas/')) return error.message
  if (error?.message?.startsWith('[Firebase 설정]')) return error.message
  const messages = {
    'auth/invalid-email': '이메일 형식을 확인해 주세요.',
    'auth/missing-password': '비밀번호를 입력해 주세요.',
    'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/wrong-password': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/user-not-found': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/email-already-in-use': '이미 가입된 이메일입니다. 로그인 화면에서 로그인해 주세요.',
    'auth/weak-password': '비밀번호는 8자 이상으로 입력해 주세요.',
    'auth/password-does-not-meet-requirements': '비밀번호가 인증 서버의 비밀번호 조건을 충족하지 않습니다.',
    'auth/network-request-failed': '인증 서버에 연결하지 못했습니다. Auth Emulator와 네트워크를 확인해 주세요.',
    'auth/restore-timeout': '로그인 상태를 확인하지 못했습니다. 페이지를 새로고침해 다시 시도해 주세요.',
    'auth/session-invalidated': '이전 로그인 세션이 만료되었거나 무효화되었습니다. 다시 로그인해 주세요.',
    'auth/login-blocked': '그림을 저장하지 못해 로그인 상태를 바꾸지 않았습니다. 그림판에서 저장을 다시 시도해 주세요.',
    'auth/too-many-requests': '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    'auth/user-disabled': '사용 중지된 계정입니다.',
    'auth/operation-not-allowed': '이메일·비밀번호 인증 설정을 확인해 주세요.',
    'profile/invalid-nickname': '닉네임은 공백을 제외한 1~80자로 입력해 주세요.',
    'profile/auth-changed': '로그인 계정이 변경되었습니다. 해당 계정으로 다시 로그인해 주세요.',
    'profile/save-failed': '계정은 생성되었지만 프로필 저장을 확인하지 못했습니다. 아래 버튼으로 프로필 저장만 다시 시도해 주세요.',
  }
  return messages[error?.code] ?? '요청을 처리하지 못했습니다. Emulator 실행 상태를 확인하고 다시 시도해 주세요.'
}

function profileSaveError(user) {
  const error = new Error(getAuthErrorMessage({ code: 'profile/save-failed' }))
  error.code = 'profile/save-failed'
  error.uid = user.uid
  error.email = user.email
  return error // 비밀번호·토큰·원본 SDK 요청 정보는 보관하지 않는다.
}

async function registerAccount({ username, email, password }) {
  const nickname = normalizeNickname(username)
  const normalizedEmail = normalizeEmail(email)
  if (typeof password !== 'string' || password.length < 8) {
    const error = new Error('비밀번호는 8자 이상으로 입력해 주세요.')
    error.code = 'auth/weak-password'
    throw error
  }
  const auth = await getAuthClient()
  // 프로필 저장 실패 후 새로고침해 다시 제출해도 인증된 같은 UID를 재사용한다.
  let user = auth.currentUser
  if (user && user.email?.toLowerCase() === normalizedEmail.toLowerCase()) {
    await getSessionIdToken(auth, user, true)
    if (auth.currentUser !== user) {
      throw Object.assign(new Error('로그인 계정이 변경되었습니다.'), { code: 'profile/auth-changed' })
    }
  } else {
    user = (await createUserWithEmailAndPassword(auth, normalizedEmail, password)).user
  }
  try {
    const profile = await ensureUserProfile(user.uid, nickname)
    return { user, profile }
  } catch (error) {
    if (['profile/auth-changed', 'auth/session-invalidated', 'auth/login-blocked', 'canvas/save-failed'].includes(error?.code)) throw error
    throw profileSaveError(user)
  }
}

export function registerUser(values) {
  return withCanvasSaved(() => registerAccount(values))
}

export async function retryProfileSave({ uid, nickname }) {
  const auth = await getAuthClient()
  if (auth.currentUser?.uid !== uid) {
    const error = new Error(getAuthErrorMessage({ code: 'profile/auth-changed' }))
    error.code = 'profile/auth-changed'
    throw error
  }
  const user = auth.currentUser
  const normalized = normalizeNickname(nickname)
  try {
    return { user, profile: await ensureUserProfile(uid, normalized) }
  } catch (error) {
    if (['profile/auth-changed', 'auth/session-invalidated', 'auth/login-blocked', 'canvas/save-failed'].includes(error?.code)) throw error
    throw profileSaveError(user)
  }
}

export async function loginUser({ email, password }) {
  return withCanvasSaved(async () => {
    const auth = await getAuthClient()
    const { user } = await signInWithEmailAndPassword(auth, normalizeEmail(email), password)
    return user
  })
}

export async function logoutUser() {
  await withCanvasSaved(async () => signOut(await getAuthClient()))
}

export async function subscribeToAuthState(onChange, onError) {
  const auth = await getAuthClient()
  return onAuthStateChanged(auth, onChange, onError)
}
