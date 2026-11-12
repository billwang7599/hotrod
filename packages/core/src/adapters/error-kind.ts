// Why a turn failed, read from an engine's error text (TurnErrorKind), so extensions such as Reconnect needn't parse
// engines' errors themselves. The wording shared by every engine lives here: Node, undici and Bun errors, the provider
// APIs' (Anthropic, OpenAI) overload and limit messages. Each adapter adds its own engine's wording (EngineErrors), so
// what only one engine says stays in its adapter.
import type { TurnErrorKind } from '@kothar/extension-api'

export type EngineErrors = {
  // The engine's own words for a dropped connection or an overloaded service.
  network?: RegExp
  overloaded?: RegExp
  // Words that would read as a usage limit, or as the connection, but aren't.
  notLimit?: RegExp
  notNetwork?: RegExp
}

const LIMIT = /usage limit|hit your (?:[\w-]+ )?limit|rate[_ ]?limit|out of (?:extra )?usage|too many requests|\b429\b/i
const NETWORK = new RegExp(
  [
    // Node, undici and Bun error codes.
    '\\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|' +
      'UND_ERR_[A-Z_]+|ConnectionRefused|ConnectionClosed|FailedToOpenSocket)\\b',
    // Node and the provider SDKs (Anthropic, OpenAI): "Connection error.", "Request timed out.", "fetch failed".
    'getaddrinfo|fetch failed|failed to fetch|connection (?:error|reset|refused|closed|lost|failed)|socket hang up',
    'other side closed|reset before headers|upstream connect|network (?:error|is unreachable|unreachable)',
    'request timed out|connect timeout|you(?:\'|’)?re offline|internet connection',
    // undici's mid-stream drop is a bare "terminated".
    '(?:^|: )terminated\\.?$',
  ].join('|'),
  'im',
)
// The providers' own words for load they're shedding, which reach every engine that calls them, and HTTP 502/503/504/529.
const OVERLOADED =
  /overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|server_busy|servers are currently busy|high demand|high load|at capacity|temporarily limiting requests|(?:api error|error|status|http)\W{0,3}5(?:02|03|04|29)\b/i

export function errorKindOf(error: string, engine: EngineErrors = {}): TurnErrorKind {
  if (error === 'Interrupted') return 'interrupted'
  if (engine.notNetwork?.test(error)) return 'other'
  if (LIMIT.test(error) && !engine.notLimit?.test(error)) return 'rate_limit'
  if (NETWORK.test(error) || engine.network?.test(error)) return 'network'
  if (OVERLOADED.test(error) || engine.overloaded?.test(error)) return 'overloaded'
  return 'other'
}

// The error with its kind, to spread into a turn.completed or session.ended event.
export const withKind = (error: string | undefined, engine?: EngineErrors) =>
  error ? { error, errorKind: errorKindOf(error, engine) } : {}
