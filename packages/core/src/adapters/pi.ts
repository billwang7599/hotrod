import type { Adapter, ToolKind } from '../types.ts'

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

const kindOf = (name: string): ToolKind => (name.startsWith('mcp__') ? 'mcp' : (KINDS[name] ?? 'other'))

function summarize(kind: ToolKind, input: any): string {
  const picked = SUMMARY_FIELDS[kind]?.map((key) => input?.[key]).find((value) => typeof value === 'string')
  return (picked ?? JSON.stringify(input) ?? '').replace(/\s+/g, ' ').trim()
}

const textOf = (content: any): string =>
  (Array.isArray(content) ? content : []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')

export const pi: Adapter = {
  id: 'pi',

  async detect(machine) {
    const options = { cwd: '/' }
    const version = await machine.run('pi', ['--version'], options).catch(() => null)
    if (version?.code !== 0) return { installed: false, signedIn: false }
    const models = await machine.run('pi', ['--list-models', '--offline'], options).catch(() => null)
    const signedIn = models?.code === 0 && models.stdout.trim() !== '' && !models.stdout.includes('No models available')
    return { installed: true, signedIn, detail: version.stdout.trim() }
  },

  start(machine, { cwd, instructions }, emit) {
    const args = [
      '--mode', 'rpc',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-mcp',
      '--no-context-files',
      '--no-approve',
    ]
    if (instructions) args.push('--append-system-prompt', instructions)
    const proc = machine.spawn('pi', args, { cwd })
    const send = (command: unknown) => proc.write(JSON.stringify(command) + '\n')
    let buffer = ''
    let turnError: string | undefined
    let closed = false
    let exited = false

    const endTurn = (error?: string) => {
      turnError = undefined
      emit(error ? { type: 'turn.completed', error } : { type: 'turn.completed' })
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
      exited = true
      if (code === 0 || closed) return emit({ type: 'session.ended' })
      emit({ type: 'session.ended', error: stderrTail.trim() || `pi exited with code ${code}` })
    })

    return {
      prompt(text) {
        send({ type: 'prompt', message: text })
        emit({ type: 'turn.started' })
      },
      interrupt() {
        send({ type: 'abort' })
      },
      respond() {},
      close() {
        closed = true
        proc.closeStdin()
        if (!exited) proc.kill()
      },
    }
  },
}
