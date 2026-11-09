import { useCallback, useEffect, useRef } from 'react'
import { BAD_TOKEN_CLOSE_CODE, type ClientMessage } from '@kotharhq/core/shared'
import type { Action } from './state.ts'

const DEV_CORE_URL = 'ws://127.0.0.1:4317'
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000
const TOKEN_KEY = 'kothar.token'

export function coreUrl(
  env: { DEV: boolean; VITE_KOTHAR_CORE_URL?: string; VITE_HOTROD_CORE_URL?: string },
  page: { protocol: string; host: string },
  token: string,
) {
  // VITE_HOTROD_CORE_URL is its name from when Kothar was Hotrod.
  const set = env.VITE_KOTHAR_CORE_URL || env.VITE_HOTROD_CORE_URL
  const base = set || (env.DEV ? DEV_CORE_URL : `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}`)
  const url = new URL(base)
  url.searchParams.set('token', token)
  return url.href
}

export function attachmentUrl(socketUrl: string, chatId: string, path: string) {
  const url = new URL(socketUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = `/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(path.split('/').at(-1) ?? '')}`
  return url.href
}

type TokenStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readToken(hash: string, storage: TokenStorage) {
  const fromLink = new URLSearchParams(hash.slice(1)).get('token')
  if (fromLink) storage.setItem(TOKEN_KEY, fromLink)
  return fromLink ?? storage.getItem(TOKEN_KEY) ?? ''
}

export function useCore(dispatch: (action: Action) => void) {
  const socketRef = useRef<WebSocket | null>(null)
  useEffect(() => {
    let retryMs = MIN_RETRY_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const token = readToken(location.hash, sessionStorage)
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
    const connect = () => {
      const socket = new WebSocket(coreUrl(import.meta.env, location, token))
      socketRef.current = socket
      socket.onopen = () => {
        retryMs = MIN_RETRY_MS
        dispatch({ type: 'connection', connected: true })
      }
      socket.onmessage = (e) => dispatch(JSON.parse(e.data))
      socket.onclose = (e) => {
        const rejected = e.code === BAD_TOKEN_CLOSE_CODE
        dispatch({ type: 'connection', connected: false, rejected })
        if (stopped || rejected) return
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
