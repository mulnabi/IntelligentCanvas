import { useEffect, useState } from 'react'
import { getAuthErrorMessage, subscribeToAuthState } from '../services/authService'

export function useAuth() {
  const [state, setState] = useState({ user: null, loading: true, error: '' })

  useEffect(() => {
    let active = true
    let unsubscribe
    const onError = (error) => {
      if (active) setState({ user: null, loading: false, error: getAuthErrorMessage(error) })
    }
    subscribeToAuthState((user) => {
      if (active) setState({ user, loading: false, error: '' })
    }, onError).then((stop) => {
      if (active) unsubscribe = stop
      else stop()
    }).catch(onError)

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  return state
}
