import { expect, it } from 'vitest'
import { CLAUDE_ERRORS } from './claude-code.ts'
import { CODEX_ERRORS } from './codex.ts'
import { errorKindOf, withKind } from './error-kind.ts'
import { OPENCODE_ERRORS } from './opencode.ts'
import { PI_ERRORS } from './pi.ts'

it('tells Stop, limits, the connection and an overloaded service from everything else', () => {
  expect(errorKindOf('Interrupted')).toBe('interrupted')
  for (const error of [
    'API Error: Connection error.',
    'getaddrinfo ENOTFOUND api.anthropic.com',
    'read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
    'TypeError: fetch failed',
    'API Error: Request timed out.',
    'socket hang up',
  ]) {
    expect(errorKindOf(error), error).toBe('network')
  }
  for (const error of [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: 503 Service Unavailable',
    '502 Bad Gateway',
  ]) {
    expect(errorKindOf(error), error).toBe('overloaded')
  }
  for (const error of ["The account's 5-hour usage limit is reached", 'API Error: 429 rate_limit_error', 'Too Many Requests']) {
    expect(errorKindOf(error), error).toBe('rate_limit')
  }
  for (const error of ['Claude Code exited with code 1', 'Tool failed: file not found', 'Process terminated by the user before it finished']) {
    expect(errorKindOf(error), error).toBe('other')
  }
  expect(withKind(undefined)).toEqual({})
  expect(withKind('socket hang up')).toEqual({ error: 'socket hang up', errorKind: 'network' })
})

// The wording each engine really uses, read from its own build: Claude Code 2.1, pi 1.1 (pi-ai), Codex 0.167 and
// OpenCode 1.17. Each engine's adapter passes its own (EngineErrors).
const engines = {
  'claude-code': {
    errors: CLAUDE_ERRORS,
    network: [
      'Unable to connect to API. Check your internet connection',
      'Unable to connect to API (ECONNRESET)',
      'Network error. Please check your internet connection.',
    ],
    overloaded: [
      'Repeated 529 Overloaded errors',
      'Opus is experiencing high load, please use /model to switch to Sonnet',
      'Server is temporarily limiting requests (not your usage limit)',
    ],
    other: ['Unable to connect to API: SSL certificate has expired'],
  },
  pi: {
    errors: PI_ERRORS,
    network: ['terminated', 'Connection error.', 'other side closed', 'upstream connect error or disconnect/reset before headers', 'Anthropic stream ended before message_stop'],
    overloaded: ['servers are currently busy', '{"type":"error","error":{"type":"server_busy"}}'],
    other: [],
  },
  codex: {
    errors: CODEX_ERRORS,
    network: [
      'Connection failed: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
      'stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)',
      'stream disconnected before completion: idle timeout waiting for SSE',
      'stream disconnected before completion: stream closed before response.completed',
      'error sending request: client error (Connect): dns error: failed to lookup address information',
      'tcp connect error: Network unreachable',
    ],
    overloaded: [
      'Selected model is at capacity. Please try a different model.',
      "We're currently experiencing high demand, which may cause temporary errors.",
      'exceeded retry limit, last status: 503 Service Unavailable',
    ],
    other: [
      'stream disconnected before completion: Incomplete response returned, reason: content_filter',
      'Policy-restricted capacity is unavailable. Please try again later.',
    ],
  },
  opencode: {
    errors: OPENCODE_ERRORS,
    network: [
      'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
      'Cannot connect to API: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      'ConnectionRefused',
    ],
    overloaded: ['Provider is overloaded'],
    other: [],
  },
}

it("knows each engine's own network and overload errors", () => {
  for (const [engine, { errors, ...kinds }] of Object.entries(engines)) {
    for (const [kind, texts] of Object.entries(kinds)) {
      for (const text of texts) expect(errorKindOf(text, errors), `${engine}: ${text}`).toBe(kind)
    }
  }
})
