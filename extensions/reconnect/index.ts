import type { ChatDetail, Extension, ExtensionHost } from '@kothar/extension-api'

// Sent once the connection is back. Memory shows the agent its turn so far, so it picks up where it stopped.
export const CONTINUE_PROMPT =
  'The connection dropped during your last turn. Continue where you left off: check what you already finished ' +
  '(files, commands, replies above) and don’t redo it.'

// Why a turn ended early: the network was down, or the engine's service was (overloaded, 502/503/504/529).
export type Reason = 'network' | 'service'

const LIMIT = /usage limit|hit your (?:[\w-]+ )?limit|rate[_ ]?limit|out of (?:extra )?usage|\b429\b/i
const NETWORK =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_[A-Z_]+)\b|getaddrinfo|fetch failed|connection error|connection (?:reset|refused|closed)|socket hang up|network (?:error|is unreachable)|request timed out|connect timeout|you(?:'|’)?re offline|internet connection/i
const SERVICE =
  /overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|(?:api error|error|status|http)\W{0,3}5(?:02|03|04|29)\b/i

// Only failures the connection explains: a Stop, a usage limit or an ordinary error is left alone.
export function classify(error: string | undefined): Reason | undefined {
  if (!error || error === 'Interrupted' || LIMIT.test(error)) return undefined
  if (NETWORK.test(error)) return 'network'
  if (SERVICE.test(error)) return 'service'
  return undefined
}

// Where each engine's model calls go, for the connectivity check. Unknown engines count as online once any answers.
export const API_HOSTS: Record<string, string[]> = {
  'claude-code': ['https://api.anthropic.com'],
  codex: ['https://api.openai.com', 'https://chatgpt.com'],
}
const ANY_HOSTS = ['https://api.anthropic.com', 'https://api.openai.com']

// The first check waits FIRST_MS, then each waits twice as long, up to CAP_MS.
export const FIRST_MS = 5_000
export const CAP_MS = 5 * 60_000
// Continuations of one message before giving up, so a turn that keeps failing doesn't loop all night.
export const MAX_TRIES = 5

export const delayOf = (attempt: number, first = FIRST_MS, cap = CAP_MS) => Math.min(cap, first * 2 ** attempt)

// Any HTTP answer within a few seconds counts: the network and DNS work. Through the Machine, so it checks the
// network the engine runs on.
async function curlProbe(host: ExtensionHost, url: string) {
  try {
    const args = ['-sS', '-o', '/dev/null', '-I', '--max-time', '5', url]
    const { code } = await host.run('curl', args, { timeoutMs: 8_000 })
    return code === 0
  } catch {
    return false
  }
}

export type ReconnectOptions = {
  // Whether the engine's API can be reached now.
  probe?: (url: string, host: ExtensionHost) => Promise<boolean>
  now?: () => number
  firstMs?: number
  capMs?: number
}

type Pending = {
  reason: Reason
  engine: string
  since: number
  attempt: number
  timer?: ReturnType<typeof setTimeout>
  checking?: boolean
  host: ExtensionHost
  maxWaitMs: number
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${Math.max(1, m)} min`
}

export function createReconnect(options: ReconnectOptions = {}): Extension {
  const { probe = (url, host) => curlProbe(host, url), now = () => Date.now() } = options
  const first = options.firstMs ?? FIRST_MS
  const cap = options.capMs ?? CAP_MS
  const pending = new Map<string, Pending>()
  // Continuations sent for each chat's current message.
  const tries = new Map<string, number>()

  const waitText = (reason: Reason) =>
    reason === 'network'
      ? 'Offline: will continue when the connection is back'
      : 'The engine’s service is unavailable: will try again shortly'

  const drop = (chatId: string) => {
    const wait = pending.get(chatId)
    if (!wait) return undefined
    clearTimeout(wait.timer)
    pending.delete(chatId)
    return wait
  }

  const online = async (wait: Pending) => {
    const hosts = API_HOSTS[wait.engine] ?? ANY_HOSTS
    const answers = await Promise.all(hosts.map((url) => probe(url, wait.host).catch(() => false)))
    return answers.some(Boolean)
  }

  const resume = (chatId: string) => {
    const wait = drop(chatId)
    if (!wait) return
    tries.set(chatId, (tries.get(chatId) ?? 0) + 1)
    wait.host.note(chatId, wait.reason === 'network' ? 'Connection back, continued' : 'Trying again, continued')
    wait.host.continue(chatId, CONTINUE_PROMPT)
  }

  const giveUp = (chatId: string, text: string) => {
    const wait = drop(chatId)
    if (!wait) return
    wait.host.note(chatId, text)
    // Lets the chat finish its turn: a worker reports the error to its lead, queued messages run.
    wait.host.endWait(chatId)
  }

  const check = async (chatId: string) => {
    const wait = pending.get(chatId)
    if (!wait || wait.checking) return
    clearTimeout(wait.timer)
    wait.timer = undefined
    wait.checking = true
    // The service case needs time, not a network: an answer from the host says nothing about overload.
    const ready = wait.reason === 'service' || (await online(wait))
    wait.checking = false
    if (pending.get(chatId) !== wait) return
    // Released some other way (Stop, the extension turned off): nothing holds it for us any more.
    if (wait.host.chat(chatId)?.status !== 'waiting') return void drop(chatId)
    if (ready) return resume(chatId)
    if (now() - wait.since >= wait.maxWaitMs) {
      return giveUp(chatId, `Still offline after ${minutes(wait.maxWaitMs)}, so Kothar stopped waiting. Send a message to try again.`)
    }
    schedule(chatId, wait)
  }

  const schedule = (chatId: string, wait: Pending) => {
    const left = Math.max(0, wait.since + wait.maxWaitMs - now())
    const delay = Math.min(delayOf(wait.attempt++, first, cap), left)
    wait.timer = setTimeout(() => void check(chatId).catch((error) => wait.host.error(String(error))), delay)
  }

  return {
    id: 'reconnect',
    name: 'Reconnect',
    description:
      'When a turn ends because the connection dropped or the engine’s service was unavailable, wait for it to come ' +
      'back and continue the turn where it stopped. Works for spaces, workers and Home.',
    enabledByDefault: true,
    settings: [
      {
        key: 'maxWait',
        label: 'Longest wait (minutes)',
        description:
          'How long a chat waits for the connection before giving up. It checks again after 5 seconds, then twice ' +
          'as long each time, up to every 5 minutes.',
        type: 'number',
        default: 120,
        min: 1,
        max: 24 * 60,
        integer: true,
      },
    ],
    onTurnStarted({ chat, continued }) {
      if (!continued) tries.delete(chat.id)
    },
    // Called as the turn ends, so the wait holds the chat: a worker doesn't report yet, queued messages wait.
    onTurnCompleted({ chat, error }, { values, host }) {
      const reason = classify(error)
      if (!reason) return
      drop(chat.id)
      const done = tries.get(chat.id) ?? 0
      if (done >= MAX_TRIES) {
        host.note(chat.id, `The connection dropped again after ${MAX_TRIES} tries, so Kothar stopped continuing`)
        return
      }
      const maxWaitMs = Math.max(1, Number(values.maxWait) || 120) * 60_000
      const wait: Pending = { reason, engine: chat.engine, since: now(), attempt: 0, host, maxWaitMs }
      pending.set(chat.id, wait)
      host.wait(chat.id, {
        text: waitText(reason),
        buttons: [
          { id: 'now', label: 'Try now', primary: true },
          { id: 'cancel', label: 'Don’t continue', hint: 'Ends the turn as it is. A worker reports the error to its lead.' },
        ],
      })
      host.note(chat.id, reason === 'network' ? 'The connection dropped' : 'The engine’s service was unavailable')
      schedule(chat.id, wait)
    },
    onWaitAction(chat, answer, { host }) {
      if (!pending.has(chat.id)) return host.endWait(chat.id)
      if ('message' in answer) {
        // The user's message runs instead, as a turn of its own.
        drop(chat.id)
        return host.endWait(chat.id)
      }
      if (answer.button === 'cancel') return giveUp(chat.id, 'Not continuing the dropped turn')
      pending.get(chat.id)!.attempt = 0
      void check(chat.id).catch((error) => host.error(String(error)))
    },
    // Stop, or anything else that ended the hold: nothing to resume.
    onStatusChanged(chat: ChatDetail, status) {
      if (status !== 'waiting') drop(chat.id)
    },
    onChatRemoved(chat) {
      drop(chat.id)
      tries.delete(chat.id)
    },
    // Only so onStop runs when the extension is turned off: holds end then, and their checks must too.
    onStart() {},
    onStop() {
      for (const chatId of [...pending.keys()]) drop(chatId)
    },
  }
}

export default createReconnect()
