import { useEffect } from 'react'

const SAVE_INTERVAL_MS = 5 * 60 * 1000

export function useArtworkSync(enabled, saveAutomatically) {
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(saveAutomatically, SAVE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, saveAutomatically])
}
