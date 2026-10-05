import {execFile} from 'node:child_process'

/**
 * Agentia plugins cannot call the CLI's internals yet, so MC Ship talks to
 * Copado the supported way: by running `agentia ... --json` as a child process.
 * All calls go through this one file so a future first-party API is a one-file change.
 */
export function agentiaBin(): string {
  return process.env.MCSHIP_AGENTIA_BIN ?? 'agentia'
}

export interface AgentiaResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

export function runAgentia<T = unknown>(args: string[], timeoutMs = 180_000): Promise<AgentiaResult<T>> {
  return new Promise((resolve) => {
    execFile(
      agentiaBin(),
      [...args, '--json'],
      {timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: {...process.env, NO_COLOR: '1'}},
      (err, stdout, stderr) => {
        const parsed = parseJson(stdout)
        if (err && !parsed) {
          resolve({ok: false, error: (stderr || err.message).trim().split('\n').slice(-3).join(' ')})
          return
        }
        // oclif --json wraps failures as {status, name, message}
        const p = parsed as {status?: number; message?: string; result?: unknown; error?: {message?: string}} | undefined
        if (p && typeof p.status === 'number' && p.status !== 0 && p.message) {
          resolve({ok: false, error: p.message})
          return
        }
        // Agentia commands report failures as {error: {message}}
        if (p && p.error && typeof p.error === 'object') {
          resolve({ok: false, error: p.error.message ?? 'Agentia command failed'})
          return
        }
        if (err) {
          resolve({ok: false, error: (stderr || err.message).trim().split('\n').slice(-3).join(' ')})
          return
        }
        resolve({ok: true, data: ((p && 'result' in p ? p.result : p) ?? stdout.trim()) as T})
      },
    )
  })
}

function parseJson(out: string): unknown {
  const s = out.trim()
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    const start = s.search(/[[{]/)
    if (start === -1) return undefined
    try {
      return JSON.parse(s.slice(start))
    } catch {
      return undefined
    }
  }
}

/** Pull the text answer out of `agentia ai agent ask --json`, whatever its exact shape. */
export function answerText(data: unknown): string | undefined {
  if (typeof data === 'string') return data
  if (!data || typeof data !== 'object') return undefined
  const o = data as Record<string, unknown>
  for (const k of ['answer', 'response', 'text', 'content', 'message', 'output']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
    const nested = answerText(v)
    if (nested) return nested
  }
  if (Array.isArray(o.messages)) {
    const last = [...o.messages].reverse().map(answerText).find(Boolean)
    if (last) return last
  }
  return undefined
}

export async function askCopadoAi(prompt: string, userStory?: string): Promise<AgentiaResult<string>> {
  const args = ['ai', 'agent', 'ask', '--agent', 'release', '--no-stream', '-p', prompt]
  if (userStory) args.push('--user-story', userStory)
  const r = await runAgentia(args)
  if (!r.ok) return {ok: false, error: r.error}
  const text = answerText(r.data)
  return text ? {ok: true, data: text} : {ok: false, error: 'Copado AI returned no text'}
}

export async function attachToUserStory(userStory: string, note: string): Promise<AgentiaResult> {
  // technical-specifications holds up to 30,000 characters
  return runAgentia(['cicd', 'work', 'update', userStory, '--technical-specifications', note.slice(0, 30_000)])
}
