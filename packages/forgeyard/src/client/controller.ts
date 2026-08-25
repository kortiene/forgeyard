import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  AttemptId,
  AttemptSessionRef,
  AttemptView,
  DecisionRequest,
  ForgeyardSnapshot,
  MissionCreateRequest,
  MissionId,
  MissionView,
  PromoteRequest,
  RetryRequest,
  TaskId,
} from '../types.ts'

/** Host-authoritative operations consumed by the browser Cockpit. */
export interface ForgeyardClientApi {
  snapshot(): Promise<ForgeyardSnapshot>
  createMission(request: MissionCreateRequest): Promise<MissionView>
  startAttempt(taskId: TaskId): Promise<AttemptView>
  verifyAttempt(attemptId: AttemptId): Promise<AttemptView>
  decide(request: DecisionRequest): Promise<AttemptView>
  retry(request: RetryRequest): Promise<AttemptView>
  promote(request: PromoteRequest): Promise<AttemptView>
  attemptForSession(sessionId: string): Promise<AttemptSessionRef | null>
}

export type CockpitView =
  | { readonly name: 'missions' }
  | { readonly name: 'mission'; readonly missionId: MissionId }
  | {
    readonly name: 'attempt'
    readonly missionId: MissionId
    readonly attemptId: AttemptId
  }

export interface CockpitSnapshot {
  readonly open: boolean
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly data: ForgeyardSnapshot | null
  readonly view: CockpitView
  readonly busy: string | null
  readonly error: string | null
  /** A null value is an explicit ambiguous/unresolvable mapping; absence is not loaded yet. */
  readonly sessionAttempts: Readonly<Record<string, AttemptId | null>>
  /** Forces consumers to reconsider native-session availability when the DSH list changes. */
  readonly sessionRevision: number
}

export type ForgeyardSessions = Pick<ISessions, 'list' | 'open'>

const INITIAL_SNAPSHOT: CockpitSnapshot = {
  open: false,
  phase: 'idle',
  data: null,
  view: { name: 'missions' },
  busy: null,
  error: null,
  sessionAttempts: {},
  sessionRevision: 0,
}

/**
 * One client-owned state machine shared by the three framework-rendered slot entries.
 * It owns view selection only; all mission and attempt records remain Host-authoritative.
 */
export class ForgeyardCockpitController {
  private current: CockpitSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private readonly sessionLookups = new Map<string, Promise<AttemptId | undefined>>()
  private readonly unsubscribeSessions: () => void
  private generation = 0
  private disposed = false

  constructor(
    private readonly api: ForgeyardClientApi,
    private readonly sessions: ForgeyardSessions,
  ) {
    this.unsubscribeSessions = sessions.list.subscribe(() => {
      this.publish({ sessionRevision: this.current.sessionRevision + 1 })
    })
  }

  readonly getSnapshot = (): CockpitSnapshot => this.current

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.unsubscribeSessions()
    this.sessionLookups.clear()
    this.listeners.clear()
  }

  open(): void {
    this.publish({ open: true, error: null })
    if (this.current.data === null && this.current.busy === null) void this.refresh()
  }

  close(): void {
    this.publish({ open: false })
  }

  showMissions(): void {
    this.publish({ view: { name: 'missions' }, error: null })
  }

  showMission(missionId: MissionId): void {
    if (this.findMission(missionId) === undefined) {
      this.publish({ error: `Mission ${missionId} is no longer available.` })
      return
    }
    this.publish({ view: { name: 'mission', missionId }, error: null })
  }

  showAttempt(missionId: MissionId, attemptId: AttemptId): void {
    const attempt = this.findAttempt(attemptId)
    if (attempt === undefined || attempt.mission.mission.id !== missionId) {
      this.publish({ error: `Attempt ${attemptId} is no longer available.` })
      return
    }
    this.publish({ view: { name: 'attempt', missionId, attemptId }, error: null })
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    this.publish({
      phase: this.current.data === null ? 'loading' : this.current.phase,
      busy: 'Refreshing missions',
      error: null,
    })
    try {
      const data = await this.api.snapshot()
      if (!this.isCurrent(generation)) return
      this.installData(data, { busy: null, phase: 'ready' })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.publish({
        busy: null,
        phase: this.current.data === null ? 'error' : 'ready',
        error: messageOf(error),
      })
    }
  }

  async createMission(request: MissionCreateRequest): Promise<void> {
    await this.mutate(
      'Creating mission',
      () => this.api.createMission(request),
      mission => ({ name: 'mission', missionId: mission.mission.id }),
    )
  }

  async startAttempt(taskId: TaskId): Promise<void> {
    await this.mutate('Starting attempt', () => this.api.startAttempt(taskId), (attempt, data) => {
      const mission = data.missions.find(candidate => candidate.task.id === attempt.attempt.taskId)
      if (mission === undefined) return { name: 'missions' }
      return {
        name: 'attempt',
        missionId: mission.mission.id,
        attemptId: attempt.attempt.id,
      }
    })
  }

  async verifyAttempt(attemptId: AttemptId): Promise<void> {
    await this.mutate('Running verification', () => this.api.verifyAttempt(attemptId), (attempt, data) => {
      return viewForAttempt(data, attempt.attempt.id)
    })
  }

  async decide(request: DecisionRequest): Promise<void> {
    await this.mutate('Recording decision', () => this.api.decide(request), (attempt, data) => {
      return viewForAttempt(data, attempt.attempt.id)
    })
  }

  async retry(request: RetryRequest): Promise<void> {
    await this.mutate('Starting retry', () => this.api.retry(request), (attempt, data) => {
      return viewForAttempt(data, attempt.attempt.id)
    })
  }

  /**
   * Perform the explicitly confirmed local promotion of one approved Attempt.
   * The request carries the exact review digest the operator confirmed, so a
   * digest that moved between rendering and confirmation fails closed.
   *
   * A refused promotion is a durable Host outcome — a recorded failure, a ref
   * that already exists, a Promotion left uncertain — so this action refreshes
   * authoritative state on its failure path as well as its success path.
   */
  async promote(request: PromoteRequest): Promise<void> {
    await this.mutate('Promoting approved deliverable', () => this.api.promote(request), (attempt, data) => {
      return viewForAttempt(data, attempt.attempt.id)
    }, { refreshOnFailure: true })
  }

  /** Whether an attempt's native Session is presently addressable by `sessions.open`. */
  canOpenSession(attempt: AttemptView): boolean {
    const sessionId = attempt.attempt.dshSessionId
    return sessionId !== '' && this.sessions.list.getSnapshot().byId[sessionId as SessionId] !== undefined
  }

  /**
   * Leave the overlay synchronously before selecting the native DSH Session.
   * The exact attempt association is installed first so its header can return without guessing.
   */
  openSession(attempt: AttemptView): void {
    const sessionId = attempt.attempt.dshSessionId
    if (sessionId === '') {
      this.publish({ error: 'This attempt does not have a DSH Session yet.' })
      return
    }
    const existing = this.current.sessionAttempts[sessionId]
    if (existing === null || (existing !== undefined && existing !== attempt.attempt.id)) {
      this.publish({ error: `Session ${sessionId} does not identify one exact Forgeyard attempt.` })
      return
    }
    if (this.sessions.list.getSnapshot().byId[sessionId as SessionId] === undefined) {
      this.publish({ error: `Session ${sessionId} is no longer available in DSH.` })
      return
    }

    this.publish({
      sessionAttempts: {
        ...this.current.sessionAttempts,
        [sessionId]: attempt.attempt.id,
      },
      open: false,
      error: null,
    })
    try {
      this.sessions.open(sessionId as SessionId)
    } catch (error) {
      this.publish({ open: true, error: messageOf(error) })
    }
  }

  attemptIdForSession(sessionId: string): AttemptId | undefined {
    return this.current.sessionAttempts[sessionId] ?? undefined
  }

  /** Resolve an exact association from Host state when the local snapshot has not supplied it. */
  async ensureAttemptForSession(sessionId: string): Promise<AttemptId | undefined> {
    if (Object.hasOwn(this.current.sessionAttempts, sessionId)) {
      return this.attemptIdForSession(sessionId)
    }
    const active = this.sessionLookups.get(sessionId)
    if (active !== undefined) return await active

    const lookup = this.api.attemptForSession(sessionId).then((ref) => {
      if (this.disposed) return undefined
      // A concurrent refresh may have installed a newer authoritative answer.
      // Never replace either its exact association or its explicit ambiguity.
      if (Object.hasOwn(this.current.sessionAttempts, sessionId)) {
        return this.attemptIdForSession(sessionId)
      }
      const attemptId = ref?.attemptId
      this.publish({
        sessionAttempts: {
          ...this.current.sessionAttempts,
          [sessionId]: attemptId ?? null,
        },
      })
      return attemptId
    }, (error: unknown) => {
      if (this.disposed) return undefined
      if (Object.hasOwn(this.current.sessionAttempts, sessionId)) {
        return this.attemptIdForSession(sessionId)
      }
      this.publish({
        sessionAttempts: { ...this.current.sessionAttempts, [sessionId]: null },
        error: messageOf(error),
      })
      return undefined
    }).finally(() => {
      this.sessionLookups.delete(sessionId)
    })
    this.sessionLookups.set(sessionId, lookup)
    return await lookup
  }

  /** Reopen the Cockpit on the one Attempt bound to this exact native Session. */
  async returnToAttempt(sessionId: string): Promise<void> {
    const attemptId = await this.ensureAttemptForSession(sessionId)
    if (attemptId === undefined) return

    let located = this.findAttempt(attemptId)
    if (located === undefined) {
      await this.refresh()
      located = this.findAttempt(attemptId)
    }
    if (located === undefined) {
      this.publish({ error: `Attempt ${attemptId} is no longer available.` })
      return
    }
    this.publish({
      open: true,
      view: {
        name: 'attempt',
        missionId: located.mission.mission.id,
        attemptId,
      },
      error: null,
    })
  }

  /**
   * `refreshOnFailure` is for operations whose failure is itself recorded on the
   * Host. Reporting the error alone would leave the panel rendering the state
   * that existed before the request, hiding the newly recorded outcome and
   * inviting the operator to repeat an action the Host has already refused.
   */
  private async mutate<T>(
    label: string,
    operation: () => Promise<T>,
    select: (value: T, data: ForgeyardSnapshot) => CockpitView,
    options: { readonly refreshOnFailure?: boolean } = {},
  ): Promise<void> {
    if (this.current.busy !== null) return
    const generation = ++this.generation
    this.publish({ busy: label, error: null })
    try {
      const value = await operation()
      const data = await this.api.snapshot()
      if (!this.isCurrent(generation)) return
      this.installData(data, {
        busy: null,
        phase: 'ready',
        view: select(value, data),
      })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      const message = messageOf(error)
      if (options.refreshOnFailure === true) {
        try {
          const data = await this.api.snapshot()
          if (!this.isCurrent(generation)) return
          this.installData(data, { busy: null, phase: 'ready' })
          // `installData` clears the error; the failure the operator must read
          // is republished over the refreshed authoritative state.
          this.publish({ error: message })
          return
        } catch {
          // The refresh failed too. The original failure is what matters.
        }
      }
      this.publish({ busy: null, error: message })
    }
  }

  private installData(
    data: ForgeyardSnapshot,
    patch: Pick<CockpitSnapshot, 'busy' | 'phase'> & { readonly view?: CockpitView },
  ): void {
    const sessionAttempts = sessionAttemptIndex(data)
    const view = normalizeView(patch.view ?? this.current.view, data)
    this.publish({
      data,
      sessionAttempts,
      busy: patch.busy,
      phase: patch.phase,
      view,
      error: null,
    })
  }

  private findMission(missionId: MissionId): MissionView | undefined {
    return this.current.data?.missions.find(candidate => candidate.mission.id === missionId)
  }

  private findAttempt(attemptId: AttemptId): { mission: MissionView; attempt: AttemptView } | undefined {
    for (const mission of this.current.data?.missions ?? []) {
      const attempt = mission.attempts.find(candidate => candidate.attempt.id === attemptId)
      if (attempt !== undefined) return { mission, attempt }
    }
    return undefined
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation
  }

  private publish(patch: Partial<CockpitSnapshot>): void {
    if (this.disposed) return
    this.current = { ...this.current, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}

function sessionAttemptIndex(data: ForgeyardSnapshot): Readonly<Record<string, AttemptId | null>> {
  const index: Record<string, AttemptId | null> = {}
  for (const mission of data.missions) {
    for (const attempt of mission.attempts) {
      const sessionId = attempt.attempt.dshSessionId
      if (sessionId === '') continue
      const existing = index[sessionId]
      index[sessionId] = existing === undefined || existing === attempt.attempt.id
        ? attempt.attempt.id
        : null
    }
  }
  return index
}

function normalizeView(view: CockpitView, data: ForgeyardSnapshot): CockpitView {
  if (view.name === 'missions') return view
  const mission = data.missions.find(candidate => candidate.mission.id === view.missionId)
  if (mission === undefined) return { name: 'missions' }
  if (view.name === 'mission') return view
  return mission.attempts.some(candidate => candidate.attempt.id === view.attemptId)
    ? view
    : { name: 'mission', missionId: view.missionId }
}

function viewForAttempt(data: ForgeyardSnapshot, attemptId: AttemptId): CockpitView {
  for (const mission of data.missions) {
    if (mission.attempts.some(candidate => candidate.attempt.id === attemptId)) {
      return { name: 'attempt', missionId: mission.mission.id, attemptId }
    }
  }
  return { name: 'missions' }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'Forgeyard request failed.'
}
