import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Adapter, type Sandbox, type ToolKind } from '../shared.ts'

const KINDS: Record<string, ToolKind> = {
  bash: 'shell',
  powershell: 'shell',
  edit: 'edit',
  write: 'edit',
  read: 'read',
  ls: 'read',
  grep: 'search',
  find: 'search',
}

const SUMMARY_FIELDS: Partial<Record<ToolKind, string[]>> = {
  shell: ['command'],
  edit: ['path'],
  read: ['path'],
  search: ['pattern'],
}

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const CLEAN_ARGS = [
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-mcp',
  '--no-context-files',
  '--no-approve',
]

const RPC_ARGS = ['--mode', 'rpc', ...CLEAN_ARGS]

// pi fails with its login read-only, and needs nothing else of its state folder.
const STATE_FILES = ['auth.json*', 'settings.json.lock*', 'models-store.json*', 'install/update.lock*']

function jailed(sandbox: Sandbox) {
  const stateDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  return { ...sandbox, writable: [...sandbox.writable, ...STATE_FILES.map((file) => join(stateDir, file))] }
}

const kindOf = (name: string): ToolKind => (name.startsWith('mcp__') ? 'mcp' : (KINDS[name] ?? 'other'))

function summarize(kind: ToolKind, input: any): string {
  const picked = SUMMARY_FIELDS[kind]?.map((key) => input?.[key]).find((value) => typeof value === 'string')
  return (picked ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ').trim()
}

const textOf = (content: any): string =>
  (Array.isArray(content) ? content : []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

export const pi: Adapter = {
  id: 'pi',
  imageInput: true,

  async detect(machine) {
    const options = { cwd: '/' }
    const version = await machine.run('pi', ['--version'], options).catch(() => null)
    if (version?.code !== 0) return { installed: false, signedIn: false }
    const input = ['get_available_models', 'get_state'].map((type) => JSON.stringify({ type }) + '\n').join('')
    const rpc = await machine.run('pi', [...RPC_ARGS, '--offline'], { ...options, input }).catch(() => null)
    const answers: Record<string, any> = {}
    for (const line of rpc?.stdout.split('\n') ?? []) {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'response' && msg.success) answers[msg.command] = msg.data
      } catch {}
    }
    const models = ((answers.get_available_models?.models ?? []) as any[]).flatMap(({ provider, id }) =>
      provider && id ? [`${provider}/${id}`] : [],
    )
    const { model: started, thinkingLevel } = answers.get_state ?? {}
    const startedId = `${started?.provider}/${started?.id}`
    const defaultModel = models.includes(startedId) ? startedId : undefined
    return {
      installed: true,
      signedIn: models.length > 0,
      detail: version.stdout.trim(),
      models,
      thinking: THINKING,
      ...(defaultModel && { defaultModel }),
      ...(THINKING.includes(thinkingLevel) && { defaultThinking: thinkingLevel }),
    }
  },

  async complete(machine, { cwd, system, prompt, model, timeoutMs, sandbox }) {
    const args = ['-p', ...CLEAN_ARGS, '--no-tools', '--offline', '--model', model, '--thinking', 'off']
    args.push('--system-prompt', system)
    const options = { cwd, input: prompt, timeoutMs, ...(sandbox && { sandbox: jailed(sandbox) }) }
    const { code, stdout, stderr } = await machine.run('pi', args, options)
    if (code !== 0) throw new Error(stderr.trim() || `pi exited with code ${code}`)
    return stdout
  },

  start(machine, { cwd, instructions, extraDirs = [], model, thinking, sandbox }, emit) {
    const args = [...RPC_ARGS]
    if (model) args.push('--model', model)
    if (thinking) args.push('--thinking', thinking)
    const dirs = extraDirs.map((dir) => `\n- ${dir}`).join('')
    const systemPrompt = [instructions, dirs && `You can also work in these folders:${dirs}`].filter(Boolean)
    if (systemPrompt.length) args.push('--append-system-prompt', systemPrompt.join('\n\n'))
    const proc = machine.spawn('pi', args, { cwd, ...(sandbox && { sandbox: jailed(sandbox) }) })
    const send = (command: unknown) => proc.write(JSON.stringify(command) + '\n')
    let buffer = ''
    let turnError: string | undefined
    let closed = false

    const endTurn = (error?: string) => {
      turnError = undefined
      emit({ type: 'turn.completed', ...(error && { error }) })
    }

    const handle = (msg: any) => {
      switch (msg.type) {
        case 'message_update': {
          const { type, delta } = msg.assistantMessageEvent ?? {}
          if (!delta) return
          if (type === 'text_delta') emit({ type: 'text.delta', text: delta })
          if (type === 'thinking_delta') emit({ type: 'thinking.delta', text: delta })
          return
        }
        case 'message_end': {
          const message = msg.message ?? {}
          if (message.role !== 'assistant') return
          for (const block of message.content ?? []) {
            if (block.type === 'text' && block.text) emit({ type: 'text.completed', text: block.text })
          }
          turnError = message.stopReason === 'error' ? message.errorMessage || 'pi failed' : undefined
          return
        }
        case 'tool_execution_start': {
          const kind = kindOf(msg.toolName)
          const summary = summarize(kind, msg.args)
          emit({ type: 'tool.started', toolId: msg.toolCallId, name: msg.toolName, kind, summary, input: msg.args })
          return
        }
        case 'tool_execution_end':
          emit({ type: 'tool.completed', toolId: msg.toolCallId, output: textOf(msg.result?.content), isError: msg.isError === true })
          return
        case 'agent_settled':
          // An abort during a tool call ends the next message with stopReason "error", so `aborted` wins.
          endTurn(msg.aborted ? 'Interrupted' : turnError)
          return
        case 'response':
          if (msg.command !== 'prompt') return
          if (!msg.success) endTurn(msg.error || 'pi rejected the prompt')
          else if (msg.data?.disposition === 'handled') endTurn()
      }
    }

    proc.onStdout((chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        handle(msg)
      }
    })
    proc.onExit((code, stderrTail) => {
      if (code === 0 || closed) return emit({ type: 'session.ended' })
      emit({ type: 'session.ended', error: stderrTail.trim() || `pi exited with code ${code}` })
    })

    return {
      prompt(text, images = []) {
        const attached = images.map(({ mimeType, base64 }) => ({ type: 'image', data: base64, mimeType }))
        send({ type: 'prompt', message: text, ...(attached.length && { images: attached }) })
        emit({ type: 'turn.started' })
      },
      interrupt() {
        send({ type: 'abort' })
      },
      respond() {},
      close() {
        closed = true
        proc.closeStdin()
        proc.kill()
      },
    }
  },
}
