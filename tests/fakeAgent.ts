import type { AgentAdapter, AgentRunRequest, AgentRunResult } from '../src/main/agents/types'
import type { AgentActivity, AgentChoices, AgentId } from '../src/shared/types'

/** An agent whose replies the test controls. */
export class FakeAgent implements AgentAdapter {
  readonly calls: AgentRunRequest[] = []
  disposed = false
  private readonly open: { request: AgentRunRequest; resolve(r: AgentRunResult): void; reject(e: Error): void }[] = []

  constructor(readonly id: AgentId) {}

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(request)
    return new Promise((resolve, reject) => {
      const turn = { request, resolve, reject }
      this.open.push(turn)
      request.signal.addEventListener('abort', () => {
        this.open.splice(this.open.indexOf(turn), 1)
        resolve({ text: '途中まで', status: 'stopped' })
      })
    })
  }

  reply(text: string): void {
    const turn = this.open.shift()!
    turn.request.onSession(`${this.id}-session`)
    turn.request.onText(text)
    turn.resolve({ text, status: 'done' })
  }

  /** Models asked about through `choices`. */
  readonly choiceModels: (string | null)[] = []

  choices(model: string | null): Promise<AgentChoices> {
    this.choiceModels.push(model)
    return Promise.resolve({ efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })
  }

  /** Reports what the oldest open turn is doing (thinking, searching, …). */
  activity(activity: AgentActivity): void {
    this.open[0]!.request.onActivity(activity)
  }

  fail(message: string): void {
    this.open.shift()!.reject(new Error(message))
  }

  get pending(): number {
    return this.open.length
  }

  dispose(): void {
    this.disposed = true
  }
}

/** Lets pending promise callbacks and zero-delay timers run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
