import { useCallback, useEffect, useRef } from 'react'
import type { ClientMessage } from '@hotrod/core/types'
import type { Action } from './state.ts'

const DEV_CORE_URL = 'ws://127.0.0.1:4317'
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000

export function coreUrl(env: { DEV: boolean; VITE_HOTROD_CORE_URL?: string }, page: { protocol: string; host: string }) {
  if (env.VITE_HOTROD_CORE_URL) return env.VITE_HOTROD_CORE_URL
  if (env.DEV) return DEV_CORE_URL
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}`
}

export function useCore(dispatch: (action: Action) => void) {
  const socketRef = useRef<WebSocket | null>(null)
  useEffect(() => {
    let retryMs = MIN_RETRY_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const connect = () => {
      const socket = new WebSocket(coreUrl(import.meta.env, location))
      socketRef.current = socket
      socket.onopen = () => {
        retryMs = MIN_RETRY_MS
        dispatch({ type: 'connection', connected: true })
      }
      socket.onmessage = (e) => dispatch(JSON.parse(e.data))
      socket.onclose = () => {
        dispatch({ type: 'connection', connected: false })
        if (stopped) return
        timer = setTimeout(connect, retryMs)
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
      }
    }
    connect()
    return () => {
      stopped = true
      clearTimeout(timer)
      socketRef.current?.close()
    }
  }, [dispatch])
  return useCallback((message: ClientMessage) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])
}
