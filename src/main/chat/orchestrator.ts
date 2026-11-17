import path from 'node:path'
import {
  AGENT_IDS,
  DEFAULT_TITLE,
  DISPLAY_NAMES,
  otherAgent,
  type AgentActivity,
  type AgentChoices,
  type AgentId,
  type AgentInfo,
  type ApprovalDecision,
  type ApprovalEntry,
  type ApprovalMode,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatMessage,
  type ChatSnapshot,
  type DialogueState,
  type ReviewState,
  type SendRequest,
  type Workspace,
  type Roles,
  isAgentId,
} from '../../shared/types'
import { titleFromMessage } from '../../shared/validate'
import type { Access, AgentAdapter, ApprovalRequest } from '../agents/types'
import type { ConversationContent, StoredParticipant } from '../store/conversationStore'
import { chatSystemPrompt, codeSystemPrompt, collectUnseen, formatUnseen, isApproved, replyTarget, turnNote } from './prompt'

/** The changes in a project folder, for the reviewer. */
export interface GitDiff {
  /** `git diff` against the last commit, plus new files. */
  text: string
  files: number
  added: number
  removed: number
}

/**
 * Who a turn is for: a normal reply, a dialogue turn (read-only), or a 実装＋レビュー turn
 * (the implementer writes, the reviewer reads).
 */
type TurnKind = 'normal' | 'dialogue' | 'implement' | 'review'

/** How many implement → review rounds 実装＋レビュー runs at most. */
export const MAX_REVIEW_ROUNDS = 3

/** One reply's approvals: 「今回は全部許可」 lets the rest of that reply through. */
interface TurnApprovals {
  allowAll: boolean
}

interface PendingApproval {
  messageId: number
  agent: AgentId
  turn: TurnApprovals
  resolve(decision: 'allow' | 'deny'): void
}

/** Replaces the entry with the same id, or adds it at the end (a new array). */
function upsert<T extends { id: string }>(list: T[] | undefined, entry: T): T[] {
  const items = list ?? []
  return items.some((item) => item.id === entry.id) ? items.map((item) => (item.id === entry.id ? entry : item)) : [...items, entry]
}

interface AgentRuntime {
  info: AgentInfo
  adapter: AgentAdapter
  sessionId: string | null
  /** IDs of messages already handed to this agent's CLI session. */
  delivered: Set<number>
  controller: AbortController | null
  /** A message arrived for this agent while it was busy; run again when it finishes. */
  rerun: boolean
}

export interface OrchestratorOptions {
  /** Shared with other conversations; the orchestrator does not dispose them. */
  adapters: Record<AgentId, AgentAdapter>
  /** Working directory for chat-mode CLI sessions (an empty folder). */
  cwd: string
  emit(envelope: ChatEventEnvelope): void
  /** A saved conversation to continue. */
  initial?: ConversationContent
  /** Models for a new conversation (a saved one keeps its own). */
  models?: Partial<Record<AgentId, string | null>>
  /** Reasoning efforts for a new conversation (a saved one keeps its own). */
  efforts?: Partial<Record<AgentId, string | null>>
  /** The project folder of a coding conversation; absent for a chat. */
  workdir?: string | null
  /** The checked-out git branch of a folder (null when it is not a repository). */
  gitBranch?(dir: string): Promise<string | null>
  /** The uncommitted changes of a folder (null when it is not a repository). */
  gitDiff?(dir: string): Promise<GitDiff | null>
  now?: () => Date
}

/** Why dialogue mode ended, as shown in the timeline. */
const DIALOGUE_STOPPED = {
  user: '対話モードを止めました',
  error: 'エラーが起きたので対話モードを止めました',
  quiet: '次の話者に渡す発言がないので対話モードを止めました',
  restart: '前回は対話モードの途中で終了しました',
} as const

type DialogueStopReason = keyof typeof DIALOGUE_STOPPED

/** Why 実装＋レビュー ended, as shown in the timeline. */
const REVIEW_STOPPED = {
  approved: 'レビューで承認されました（APPROVED）',
  limit: `上限の ${MAX_REVIEW_ROUNDS} 往復に達したので、実装＋レビューを止めました`,
  user: '実装＋レビューを止めました',
  error: 'エラーが起きたので実装＋レビューを止めました',
  quiet: '次に渡す発言がないので実装＋レビューを止めました',
  restart: '前回は実装＋レビューの途中で終了しました',
} as const

type ReviewStopReason = keyof typeof REVIEW_STOPPED

/**
 * Holds one conversation and routes it to the agents.
 *
 * Each agent keeps its own CLI session. On each turn it receives only the messages it has
 * not seen yet (from the user and the other agent), so the whole history is never resent.
 *
 * In dialogue mode the agents take turns: each reply goes to the other agent, until the user
 * stops it or a reply fails. What the user says meanwhile reaches the next speaker.
 */
export class Orchestrator {
  private readonly messages: ChatMessage[]
  private readonly agents: Record<AgentId, AgentRuntime>
  private readonly now: () => Date
  private title: string
  private nextMessageId: number
  private seq = 0
  private dialogue: DialogueState | null = null
  /** The agent whose dialogue turn is running. */
  private dialogueSpeaker: AgentId | null = null
  private review: ReviewState | null = null
  /** The agent whose 実装＋レビュー turn is running (or whose changes are being collected). */
  private reviewSpeaker: AgentId | null = null
  private workspace: Workspace | null
  private approvalMode: ApprovalMode
  private roles: Roles
  /** Coding: the agent whose reply may change the project now. Only one at a time. */
  private writer: AgentId | null = null
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private nextApprovalNumber = 1

  constructor(private readonly options: OrchestratorOptions) {
    const initial = options.initial
    this.now = options.now ?? (() => new Date())
    this.title = initial?.title ?? DEFAULT_TITLE
    this.approvalMode = initial?.approvalMode ?? 'ask'
    this.roles = initial?.roles ?? 'single'
    this.workspace = options.workdir
      ? {
          path: options.workdir,
          name: path.basename(options.workdir),
          branch: null,
        }
      : null
    this.messages = (initial?.messages ?? []).map((m) => ({
      ...m,
      status: m.status === 'streaming' ? 'stopped' : m.status,
    }))
    this.nextMessageId = this.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
    this.agents = Object.fromEntries(
      AGENT_IDS.map((id) => {
        const saved = initial?.participants[id]
        const runtime: AgentRuntime = {
          info: {
            id,
            model: saved ? saved.model : (options.models?.[id] ?? null),
            activeModel: null,
            effort: saved ? saved.effort : (options.efforts?.[id] ?? null),
            busy: false,
            activity: null,
          },
          adapter: options.adapters[id],
          sessionId: saved?.sessionId ?? null,
          delivered: new Set(saved?.delivered ?? []),
          controller: null,
          rerun: false,
        }
        return [id, runtime]
      }),
    ) as Record<AgentId, AgentRuntime>

    // The app closed during a dialogue or 実装＋レビュー: say it ended, so the agents know too.
    const lastDialogue = this.messages.findLast((m) => m.notice === 'dialogue-start' || m.notice === 'dialogue-stop')
    if (lastDialogue?.notice === 'dialogue-start') this.messages.push(this.stopNotice('restart'))
    const lastReview = this.messages.findLast((m) => m.notice === 'review-start' || m.notice === 'review-stop')
    if (lastReview?.notice === 'review-start') this.messages.push(this.reviewStopNotice('restart'))
    void this.refreshBranch()
  }

  snapshot(): ChatSnapshot {
    return {
      seq: this.seq,
      state: {
        title: this.title,
        kind: this.workspace ? 'code' : 'chat',
        workspace: this.workspace ? { ...this.workspace } : null,
        approvalMode: this.approvalMode,
        roles: this.roles,
        messages: this.messages.map((m) => ({ ...m })),
        agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { ...this.agents[id].info }])) as Record<AgentId, AgentInfo>,
        dialogue: this.dialogue ? { ...this.dialogue } : null,
        review: this.review ? { ...this.review } : null,
      },
    }
  }

  /** Everything needed to continue this conversation later. */
  content(): ConversationContent {
    return {
      title: this.title,
      approvalMode: this.approvalMode,
      roles: this.roles,
      messages: this.messages.map((m) => ({ ...m })),
      participants: Object.fromEntries(
        AGENT_IDS.map((id) => {
          const agent = this.agents[id]
          const participant: StoredParticipant = {
            model: agent.info.model,
            effort: agent.info.effort,
            sessionId: agent.sessionId,
            delivered: [...agent.delivered].sort((a, b) => a - b),
          }
          return [id, participant]
        }),
      ) as Record<AgentId, StoredParticipant>,
    }
  }

  get isEmpty(): boolean {
    return this.messages.length === 0
  }

  get busy(): boolean {
    return AGENT_IDS.some((id) => this.agents[id].info.busy)
  }

  get currentTitle(): string {
    return this.title
  }

  get inDialogue(): boolean {
    return this.dialogue !== null
  }

  get inReview(): boolean {
    return this.review !== null
  }

  send(request: SendRequest): void {
    const text = request.text.trim()
    if (!text) return
    // With an implementer chosen, a request starts 実装＋レビュー instead of a plain reply.
    if (this.workspace && !this.dialogue && !this.review && isAgentId(this.roles)) {
      this.startReview(this.roles, text)
      return
    }
    this.addUserMessage(text, request.to)
    if (this.dialogue || this.review) {
      // An interruption: the next speaker gets it with the rest, and the loop goes on.
      this.advanceDialogue()
      this.advanceReview()
      return
    }
    const targets = request.to === 'all' ? AGENT_IDS : [request.to]
    for (const id of targets) this.trigger(id)
  }

  /** Coding: whether edits and commands wait for approval. Applies from the next reply. */
  setApprovalMode(mode: ApprovalMode): void {
    if (mode === this.approvalMode) return
    this.approvalMode = mode
    this.emitWorkspace()
  }

  /** Coding: chooses the roles. Choosing an implementer starts nothing by itself: the next request sent starts a review. */
  setRoles(roles: Roles): void {
    if (roles === this.roles) return
    this.roles = roles
    this.emitWorkspace()
  }

  /** The user's answer to an approval card. 「今回は全部許可」 also lets the rest of that reply through. */
  approve(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return
    if (decision === 'allow-all') pending.turn.allowAll = true
    this.settleApproval(approvalId, decision === 'deny' ? 'deny' : 'allow')
    if (decision === 'allow-all') {
      for (const [id, other] of this.pendingApprovals) if (other.turn === pending.turn) this.settleApproval(id, 'allow')
    }
  }

  /** Turns dialogue mode on (from where the conversation is now) or off. */
  setDialogue(on: boolean): void {
    if (on) this.startDialogue()
    else this.stopDialogue('user')
  }

  setTitle(title: string): void {
    if (title === this.title) return
    this.title = title
    this.emit({ type: 'title:update', title })
  }

  /** Chooses how hard an agent thinks; applies from its next reply. Null leaves it to the CLI. */
  setEffort(id: AgentId, effort: string | null): void {
    if (this.agents[id].info.effort === effort) return
    this.updateAgent(id, { effort })
  }

  /** Chooses an agent's model; applies from its next reply. Null leaves it to the CLI. */
  setModel(id: AgentId, model: string | null): void {
    if (this.agents[id].info.model === model) return
    // The CLI says which model it uses once the next reply starts.
    this.updateAgent(id, { model, activeModel: null })
  }

  info(id: AgentId): AgentInfo {
    return { ...this.agents[id].info }
  }

  /** What can be chosen for an agent with its current model. */
  choices(id: AgentId): Promise<AgentChoices> {
    const agent = this.agents[id]
    return agent.adapter.choices(agent.info.model)
  }

  /**
   * 実装＋レビュー (coding conversations): `implementer` works on the user's last request, the other agent
   * reviews the diff. Null stops it.
   */
  setReview(implementer: AgentId | null, task?: string): void {
    if (implementer) this.startReview(implementer, task?.trim() ?? '')
    else this.stopReview('user')
  }

  private addUserMessage(text: string, to: ChatMessage['to']): void {
    const firstFromUser = !this.messages.some((m) => m.from === 'user')
    this.addMessage({ from: 'user', to, text, status: 'done' })
    // Name a new conversation after its first message, as Claude.ai does.
    if (firstFromUser && this.title === DEFAULT_TITLE) {
      const title = titleFromMessage(text)
      if (title) this.setTitle(title)
    }
  }

  /** Stops every reply in progress, dialogue mode and 実装＋レビュー. */
  stop(): void {
    this.stopDialogue('user')
    this.stopReview('user')
    for (const id of AGENT_IDS) {
      const agent = this.agents[id]
      agent.rerun = false
      agent.controller?.abort()
    }
  }

  private trigger(id: AgentId): void {
    const agent = this.agents[id]
    if (agent.controller) {
      agent.rerun = true
      return
    }
    void this.runTurn(id)
  }

  private startDialogue(): void {
    if (this.dialogue || this.review) return
    const first = this.firstSpeaker()
    this.addMessage({
      from: 'system',
      to: 'all',
      text: `ここから対話モード · ${DISPLAY_NAMES[first]} から開始`,
      status: 'done',
      notice: 'dialogue-start',
    })
    this.setDialogueState({ next: first, turns: 0 })
    this.advanceDialogue()
  }

  /** The AI that did not speak last. After the user: Claude, or GPT when the user spoke to GPT. */
  private firstSpeaker(): AgentId {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!
      if (m.from === 'system') continue
      if (m.from === 'user') return m.to === 'gpt' ? 'gpt' : 'claude'
      return otherAgent(m.from)
    }
    return 'claude'
  }

  private stopDialogue(reason: DialogueStopReason): void {
    if (!this.dialogue) return
    this.setDialogueState(null)
    const speaker = this.dialogueSpeaker
    if (reason === 'user' && speaker) this.agents[speaker].controller?.abort()
    const notice = this.stopNotice(reason)
    this.messages.push(notice)
    this.emit({ type: 'message:add', message: { ...notice } })
  }

  private stopNotice(reason: DialogueStopReason): ChatMessage {
    return {
      id: this.nextMessageId++,
      at: this.now().toISOString(),
      from: 'system',
      to: 'all',
      text: DIALOGUE_STOPPED[reason],
      status: 'done',
      notice: 'dialogue-stop',
    }
  }

  /** Starts the next dialogue turn, once replies already under way have finished. */
  private advanceDialogue(): void {
    const dialogue = this.dialogue
    if (!dialogue || this.dialogueSpeaker) return
    if (AGENT_IDS.some((id) => this.agents[id].controller)) return
    const speaker = dialogue.next
    if (collectUnseen(this.messages, speaker, this.agents[speaker].delivered).length === 0) {
      this.stopDialogue('quiet')
      return
    }
    this.dialogueSpeaker = speaker
    void this.runTurn(speaker, 'dialogue')
  }

  private startReview(implementer: AgentId, task: string): void {
    const workspace = this.workspace
    if (!workspace || this.review || this.dialogue) return
    if (!task && !this.messages.some((m) => m.from === 'user')) return
    // The request goes in first; the loop, not this message, decides who replies.
    if (task) this.addUserMessage(task, implementer)
    const reviewer = otherAgent(implementer)
    const onMain = workspace.branch === 'main' || workspace.branch === 'master'
    const advice = onMain ? ` · いまのブランチは ${workspace.branch} です。変更をまとめて戻せるよう、作業ブランチで進めるのがおすすめです` : ''
    this.addMessage({
      from: 'system',
      to: 'all',
      text: `ここから実装＋レビュー · 実装: ${DISPLAY_NAMES[implementer]}、レビュー: ${DISPLAY_NAMES[reviewer]}（最大 ${MAX_REVIEW_ROUNDS} 往復）${advice}`,
      status: 'done',
      notice: 'review-start',
      implementer,
    })
    this.setReviewState({
      implementer,
      reviewer,
      round: 1,
      maxRounds: MAX_REVIEW_ROUNDS,
      phase: 'implement',
    })
    this.advanceReview()
  }

  private stopReview(reason: ReviewStopReason): void {
    if (!this.review) return
    this.setReviewState(null)
    const speaker = this.reviewSpeaker
    if (reason === 'user' && speaker) this.agents[speaker].controller?.abort()
    const notice = this.reviewStopNotice(reason)
    this.messages.push(notice)
    this.emit({ type: 'message:add', message: { ...notice } })
  }

  private reviewStopNotice(reason: ReviewStopReason): ChatMessage {
    return {
      id: this.nextMessageId++,
      at: this.now().toISOString(),
      from: 'system',
      to: 'all',
      text: REVIEW_STOPPED[reason],
      status: 'done',
      notice: 'review-stop',
    }
  }

  /** Starts the next 実装＋レビュー turn, once replies already under way have finished. */
  private advanceReview(): void {
    const review = this.review
    if (!review || this.reviewSpeaker) return
    if (AGENT_IDS.some((id) => this.agents[id].controller)) return
    const speaker = review.phase === 'implement' ? review.implementer : review.reviewer
    if (collectUnseen(this.messages, speaker, this.agents[speaker].delivered).length === 0) {
      this.stopReview('quiet')
      return
    }
    this.reviewSpeaker = speaker
    void this.runTurn(speaker, review.phase)
  }

  /** After an implementer's turn: the diff goes to the reviewer. After a review: APPROVED, the limit, or another round. */
  private async afterReviewTurn(kind: 'implement' | 'review', reply: ChatMessage): Promise<void> {
    const review = this.review
    if (!review) return
    if (reply.status === 'error') return this.stopReview('error')
    if (reply.status === 'stopped') return this.stopReview('user')
    if (kind === 'review') {
      if (isApproved(reply.text)) return this.stopReview('approved')
      if (review.round >= review.maxRounds) return this.stopReview('limit')
      this.setReviewState({
        ...review,
        round: review.round + 1,
        phase: 'implement',
      })
      return
    }
    const workspace = this.workspace
    const diff = workspace && this.options.gitDiff ? await this.options.gitDiff(workspace.path).catch(() => null) : null
    if (this.review !== review) return // stopped while the diff was being read
    const reviewer = DISPLAY_NAMES[review.reviewer]
    const text = !diff
      ? `git のリポジトリではないので、変更の差分はレビュー役（${reviewer}）に渡せませんでした`
      : diff.files === 0
        ? `変更はありません。レビュー役（${reviewer}）に、そのことを伝えました`
        : `変更をレビュー役（${reviewer}）に渡しました · ${diff.files} ファイル、+${diff.added} −${diff.removed}`
    this.addMessage({
      from: 'system',
      to: 'all',
      text,
      status: 'done',
      notice: 'review-diff',
      implementer: review.implementer,
      ...(diff && diff.text ? { detail: diff.text } : {}),
    })
    this.setReviewState({ ...review, phase: 'review' })
  }

  private setReviewState(review: ReviewState | null): void {
    this.review = review
    this.emit({ type: 'review:update', review: review ? { ...review } : null })
  }

  private setDialogueState(dialogue: DialogueState | null): void {
    this.dialogue = dialogue
    this.emit({
      type: 'dialogue:update',
      dialogue: dialogue ? { ...dialogue } : null,
    })
  }

  private async runTurn(id: AgentId, kind: TurnKind = 'normal'): Promise<void> {
    const agent = this.agents[id]
    const unseen = collectUnseen(this.messages, id, agent.delivered)
    if (unseen.length === 0) return
    for (const m of unseen) agent.delivered.add(m.id)

    const controller = new AbortController()
    agent.controller = controller
    const access = this.accessFor(id, unseen, kind)
    if (access === 'write') this.writer = id
    const workspace = this.workspace
    const turn: TurnApprovals = { allowAll: false }
    // Models think before they write, so a reply starts as 「考え中」.
    this.updateAgent(id, { busy: true, activity: { kind: 'thinking' } })
    // In a dialogue or 実装＋レビュー, each reply is for the other agent.
    const to = kind === 'normal' ? replyTarget(unseen, id) : otherAgent(id)
    const reply = this.addMessage({
      from: id,
      to,
      text: '',
      status: 'streaming',
    })
    // Stopping answers the cards still waiting at once: Codex finishes a turn only after its approval
    // requests are answered, so waiting for the turn to end first would never stop it.
    controller.signal.addEventListener(
      'abort',
      () => {
        for (const [approvalId, pending] of this.pendingApprovals) if (pending.messageId === reply.id) this.settleApproval(approvalId, 'deny')
      },
      { once: true },
    )
    const prompt =
      workspace && access !== 'chat'
        ? `${turnNote(access, this.approvalMode, workspace.name)}\n\n${formatUnseen(unseen, id)}`
        : formatUnseen(unseen, id)

    try {
      const result = await agent.adapter.run({
        prompt,
        systemPrompt: workspace ? codeSystemPrompt(id, workspace.path) : chatSystemPrompt(id),
        sessionId: agent.sessionId,
        cwd: workspace?.path ?? this.options.cwd,
        model: agent.info.model,
        effort: agent.info.effort,
        access,
        approval: this.approvalMode,
        onTool: (tool) => {
          if (controller.signal.aborted) return
          reply.tools = upsert(reply.tools, tool)
          this.emit({ type: 'message:tool', id: reply.id, tool })
        },
        requestApproval: (ask) => this.askApproval(id, reply, ask, turn, controller.signal),
        signal: controller.signal,
        onSession: (sessionId) => {
          agent.sessionId = sessionId
        },
        onModel: (model) => {
          if (model !== agent.info.activeModel) this.updateAgent(id, { activeModel: model })
        },
        onActivity: (activity) => {
          if (!controller.signal.aborted) this.setActivity(id, activity)
        },
        onText: (delta) => {
          if (controller.signal.aborted) return
          this.setActivity(id, { kind: 'writing' })
          reply.text += delta
          this.emit({ type: 'message:append', id: reply.id, text: delta })
        },
      })
      reply.text = result.text || reply.text
      reply.status = result.status
    } catch (error) {
      if (controller.signal.aborted) {
        reply.status = 'stopped'
      } else {
        reply.status = 'error'
        reply.error = error instanceof Error ? error.message : String(error)
        // The session may not have received these messages; hand them over again next time.
        for (const m of unseen) agent.delivered.delete(m.id)
      }
    } finally {
      agent.controller = null
      // Cards still waiting when the reply ends were never allowed.
      for (const [approvalId, pending] of this.pendingApprovals) if (pending.messageId === reply.id) this.settleApproval(approvalId, 'deny')
      this.emit({ type: 'message:update', message: { ...reply } })
      this.updateAgent(id, { busy: false, activity: null })
      if (access === 'write') {
        this.writer = null
        void this.refreshBranch()
      }
    }

    if (kind === 'dialogue') {
      this.dialogueSpeaker = null
      if (this.dialogue) {
        if (reply.status === 'error') this.stopDialogue('error')
        else if (reply.status === 'stopped') this.stopDialogue('user')
        else
          this.setDialogueState({
            next: otherAgent(id),
            turns: this.dialogue.turns + 1,
          })
      }
    } else if (kind === 'implement' || kind === 'review') {
      await this.afterReviewTurn(kind, reply)
      this.reviewSpeaker = null
    }
    if (this.dialogue || this.review) {
      // The loop gives every agent its turn, with whatever arrived meanwhile.
      agent.rerun = false
      this.advanceDialogue()
      this.advanceReview()
    } else if (agent.rerun) {
      agent.rerun = false
      void this.runTurn(id)
    }
  }

  /**
   * Coding: what an agent may do on this turn. Only the agent the user spoke to may change the project,
   * and only one agent at a time; messages for everyone and dialogues are read-only.
   */
  private accessFor(id: AgentId, unseen: readonly ChatMessage[], kind: TurnKind): Access {
    if (!this.workspace) return 'chat'
    if (kind === 'implement') return 'write'
    if (kind === 'dialogue' || kind === 'review') return 'read'
    const askedDirectly = unseen.some((m) => m.from === 'user' && m.to === id)
    return askedDirectly && this.writer === null ? 'write' : 'read'
  }

  /** Shows an approval card and waits for the user's answer. */
  private askApproval(id: AgentId, reply: ChatMessage, ask: ApprovalRequest, turn: TurnApprovals, signal: AbortSignal): Promise<'allow' | 'deny'> {
    if (signal.aborted) return Promise.resolve('deny')
    const entry: ApprovalEntry = {
      id: `${reply.id}-${this.nextApprovalNumber++}`,
      ...ask,
      status: turn.allowAll ? 'allowed' : 'pending',
    }
    reply.approvals = upsert(reply.approvals, entry)
    this.emit({ type: 'message:approval', id: reply.id, approval: entry })
    if (turn.allowAll) return Promise.resolve('allow')
    this.setActivity(id, { kind: 'waiting' })
    return new Promise((resolve) => {
      this.pendingApprovals.set(entry.id, {
        messageId: reply.id,
        agent: id,
        turn,
        resolve,
      })
    })
  }

  private settleApproval(approvalId: string, decision: 'allow' | 'deny'): void {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return
    this.pendingApprovals.delete(approvalId)
    const message = this.messages.find((m) => m.id === pending.messageId)
    const entry = message?.approvals?.find((a) => a.id === approvalId)
    if (message && entry) {
      const settled: ApprovalEntry = {
        ...entry,
        status: decision === 'allow' ? 'allowed' : 'denied',
      }
      message.approvals = upsert(message.approvals, settled)
      this.emit({
        type: 'message:approval',
        id: message.id,
        approval: settled,
      })
    }
    if (this.agents[pending.agent].controller && ![...this.pendingApprovals.values()].some((p) => p.agent === pending.agent)) {
      this.setActivity(pending.agent, { kind: 'thinking' })
    }
    pending.resolve(decision)
  }

  private async refreshBranch(): Promise<void> {
    const workspace = this.workspace
    const branchOf = this.options.gitBranch
    if (!workspace || !branchOf) return
    const branch = await branchOf(workspace.path).catch(() => null)
    if (!this.workspace || branch === this.workspace.branch) return
    this.workspace = { ...this.workspace, branch }
    this.emitWorkspace()
  }

  private emitWorkspace(): void {
    this.emit({
      type: 'workspace:update',
      workspace: this.workspace ? { ...this.workspace } : null,
      approvalMode: this.approvalMode,
      roles: this.roles,
    })
  }

  private addMessage(fields: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const message: ChatMessage = {
      id: this.nextMessageId++,
      at: this.now().toISOString(),
      ...fields,
    }
    this.messages.push(message)
    this.emit({ type: 'message:add', message: { ...message } })
    return message
  }

  private updateAgent(id: AgentId, patch: Partial<Omit<AgentInfo, 'id'>>): void {
    const agent = this.agents[id]
    agent.info = { ...agent.info, ...patch }
    this.emit({ type: 'agent:update', agent: { ...agent.info } })
  }

  private setActivity(id: AgentId, activity: AgentActivity): void {
    const agent = this.agents[id]
    const current = agent.info.activity
    if (current?.kind === activity.kind && current.detail === activity.detail) return
    agent.info = { ...agent.info, activity }
    this.emit({ type: 'agent:activity', id, activity })
  }

  private emit(event: ChatEvent): void {
    this.seq += 1
    this.options.emit({ seq: this.seq, event })
  }
}
