import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AttemptId,
  AttemptState,
  AttemptView,
  DecisionType,
  EvidenceRecord,
  MissionCreateRequest,
  MissionView,
  PromotionRecord,
  VerificationStatus,
} from '../types.ts'
import type { CockpitSnapshot, ForgeyardCockpitController } from './controller.ts'
import { FORGEYARD_CSS } from './styles.ts'

export interface CockpitInjected {
  readonly cockpit: ForgeyardCockpitController
  readonly hooks: {
    readonly cockpit: HostObservable<CockpitSnapshot>
  }
}

export type ForgeyardFooterActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & InjectFace<CockpitInjected>

export type ForgeyardOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<CockpitInjected>

export interface ReturnInjected extends CockpitInjected {
  readonly returnToAttempt: () => void
}

export type ForgeyardReturnActionProps =
  & PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<ReturnInjected>

export function ForgeyardFooterAction({ cockpit, useCockpit, wide }: ForgeyardFooterActionProps): ReactNode {
  const snapshot = useCockpit(value => value)
  return (
    <button
      type="button"
      className="fy-sidebar-action"
      aria-label="Open Forgeyard"
      aria-pressed={snapshot.open}
      title="Forgeyard"
      onClick={() => { snapshot.open ? cockpit.close() : cockpit.open() }}
    >
      <span className="fy-sidebar-mark" aria-hidden="true">FY</span>
      {wide ? <span className="fy-sidebar-label">Forgeyard</span> : null}
    </button>
  )
}

export function ForgeyardReturnAction({
  cockpit,
  returnToAttempt,
  sessionId,
  useCockpit,
}: ForgeyardReturnActionProps): ReactNode {
  const snapshot = useCockpit(value => value)
  useEffect(() => {
    void cockpit.ensureAttemptForSession(sessionId)
  }, [cockpit, sessionId])

  const attemptId = snapshot.sessionAttempts[sessionId]
  if (typeof attemptId !== 'string') return null
  return (
    <button
      type="button"
      className="fy-return-action"
      title={`Return to Forgeyard attempt ${attemptId}`}
      onClick={returnToAttempt}
    >
      <span aria-hidden="true">←</span>
      <span>Forgeyard</span>
    </button>
  )
}

export function ForgeyardOverlay({ cockpit, useCockpit }: ForgeyardOverlayProps): ReactNode {
  const snapshot = useCockpit(value => value)
  return (
    <>
      <ForgeyardStyleSheet />
      {!snapshot.open ? null : (
        <div
          className="fy-overlay"
          data-forgeyard-cockpit=""
          role="dialog"
          aria-modal="true"
          aria-label="Forgeyard Cockpit"
          onKeyDown={(event) => {
            if (event.key === 'Escape') cockpit.close()
          }}
        >
          <button
            type="button"
            className="fy-backdrop"
            aria-label="Close Forgeyard"
            onClick={() => { cockpit.close() }}
          />
          <section className="fy-cockpit">
            <CockpitHeader cockpit={cockpit} snapshot={snapshot} />
            {snapshot.error === null ? null : (
              <div className="fy-alert" role="alert">
                <span>{snapshot.error}</span>
                <button type="button" onClick={() => { void cockpit.refresh() }}>Retry</button>
              </div>
            )}
            {snapshot.busy === null ? null : (
              <div className="fy-progress" role="status">
                <span className="fy-spinner" aria-hidden="true" />
                {snapshot.busy}
              </div>
            )}
            <main className="fy-content">
              <CockpitBody cockpit={cockpit} snapshot={snapshot} />
            </main>
          </section>
        </div>
      )}
    </>
  )
}

function ForgeyardStyleSheet(): ReactNode {
  return <style data-plugin="forgeyard" data-plugin-css="forgeyard/client">{FORGEYARD_CSS}</style>
}

function CockpitHeader({
  cockpit,
  snapshot,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly snapshot: CockpitSnapshot
}): ReactNode {
  const title = snapshot.view.name === 'missions'
    ? 'Missions'
    : snapshot.view.name === 'mission'
      ? 'Mission detail'
      : 'Attempt review'
  return (
    <header className="fy-header">
      <div className="fy-brand" aria-label="Forgeyard">
        <span className="fy-brand-mark" aria-hidden="true">FY</span>
        <span>
          <strong>Forgeyard</strong>
          <small>Controlled engineering cockpit</small>
        </span>
      </div>
      <div className="fy-header-view">
        <span>{title}</span>
        {snapshot.data === null ? null : <small>Schema {snapshot.data.schemaVersion}</small>}
      </div>
      <div className="fy-header-actions">
        <button
          type="button"
          className="fy-icon-button"
          aria-label="Refresh Forgeyard"
          title="Refresh"
          disabled={snapshot.busy !== null}
          onClick={() => { void cockpit.refresh() }}
        >
          ↻
        </button>
        <button
          type="button"
          className="fy-icon-button"
          aria-label="Close Forgeyard"
          title="Close"
          onClick={() => { cockpit.close() }}
        >
          ×
        </button>
      </div>
    </header>
  )
}

function CockpitBody({
  cockpit,
  snapshot,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly snapshot: CockpitSnapshot
}): ReactNode {
  if (snapshot.data === null) {
    if (snapshot.phase === 'error') {
      return <EmptyState title="Forgeyard is unavailable" detail="Retry once the Host plugin is ready." />
    }
    return <EmptyState title="Loading missions" detail="Reading the Host-authoritative Forgeyard ledger." />
  }

  const data = snapshot.data
  const view = snapshot.view
  switch (view.name) {
    case 'missions':
      return <MissionsView cockpit={cockpit} snapshot={snapshot} />
    case 'mission': {
      const mission = data.missions.find(item => item.mission.id === view.missionId)
      return mission === undefined
        ? <EmptyState title="Mission unavailable" detail="Refresh to reconcile the ledger." />
        : <MissionDetail cockpit={cockpit} mission={mission} busy={snapshot.busy !== null} />
    }
    case 'attempt': {
      const mission = data.missions.find(item => item.mission.id === view.missionId)
      const attempt = mission?.attempts.find(item => item.attempt.id === view.attemptId)
      return mission === undefined || attempt === undefined
        ? <EmptyState title="Attempt unavailable" detail="Refresh to reconcile the ledger." />
        : <AttemptReview cockpit={cockpit} mission={mission} attempt={attempt} busy={snapshot.busy !== null} />
    }
  }
}

function MissionsView({
  cockpit,
  snapshot,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly snapshot: CockpitSnapshot
}): ReactNode {
  const missions = snapshot.data?.missions ?? []
  return (
    <div className="fy-view fy-missions-view">
      <section className="fy-view-heading">
        <div>
          <p className="fy-eyebrow">Mission control</p>
          <h1>Missions</h1>
          <p>Each mission pins its repository, policy, task, and verification contract.</p>
        </div>
        <span className="fy-count">{missions.length} total</span>
      </section>
      <div className="fy-mission-layout">
        <section className="fy-card-grid" aria-label="Forgeyard missions">
          {missions.length === 0
            ? <EmptyState title="No missions yet" detail="Create a mission to begin a controlled attempt." />
            : missions.map(mission => (
              <button
                type="button"
                className="fy-mission-card"
                key={mission.mission.id}
                onClick={() => { cockpit.showMission(mission.mission.id) }}
              >
                <span className="fy-card-topline">
                  <StatusPill state={mission.derivedState} />
                  <span>{mission.attempts.length} attempt{mission.attempts.length === 1 ? '' : 's'}</span>
                </span>
                <strong>{mission.mission.title}</strong>
                <span className="fy-card-objective">{mission.mission.objective}</span>
                <span className="fy-card-meta">
                  <code>{mission.mission.repository.path}</code>
                  <span>{mission.mission.baseRef}</span>
                </span>
              </button>
            ))}
        </section>
        <MissionCreatePanel cockpit={cockpit} busy={snapshot.busy !== null} />
      </div>
    </div>
  )
}

function MissionCreatePanel({
  cockpit,
  busy,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly busy: boolean
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [repositoryPath, setRepositoryPath] = useState('')
  const [baseRef, setBaseRef] = useState('HEAD')
  const [task, setTask] = useState('')
  const [verificationCommand, setVerificationCommand] = useState('')

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const request: MissionCreateRequest = {
      title: title.trim(),
      objective: objective.trim(),
      repositoryPath: repositoryPath.trim(),
      baseRef: baseRef.trim(),
      task: task.trim(),
      verificationCommand: verificationCommand.trim(),
      provider: null,
      model: null,
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: null,
    }
    void cockpit.createMission(request)
  }

  return (
    <aside className="fy-create-panel">
      <button
        type="button"
        className="fy-create-toggle"
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className="fy-plus" aria-hidden="true">+</span>
        <span>
          <strong>New mission</strong>
          <small>Pin intent and verification before execution.</small>
        </span>
      </button>
      {expanded ? (
        <form className="fy-form" onSubmit={submit}>
          <Field label="Title"><input required value={title} onChange={event => { setTitle(event.target.value) }} /></Field>
          <Field label="Objective"><textarea required rows={3} value={objective} onChange={event => { setObjective(event.target.value) }} /></Field>
          <Field label="Repository"><input required placeholder="/absolute/path" value={repositoryPath} onChange={event => { setRepositoryPath(event.target.value) }} /></Field>
          <div className="fy-form-row">
            <Field label="Base ref"><input required value={baseRef} onChange={event => { setBaseRef(event.target.value) }} /></Field>
            <Field label="Verify"><input required placeholder="pnpm test" value={verificationCommand} onChange={event => { setVerificationCommand(event.target.value) }} /></Field>
          </div>
          <Field label="Task instruction"><textarea required rows={5} value={task} onChange={event => { setTask(event.target.value) }} /></Field>
          <button type="submit" className="fy-primary" disabled={busy}>Create mission</button>
        </form>
      ) : null}
    </aside>
  )
}

function MissionDetail({
  cockpit,
  mission,
  busy,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly mission: MissionView
  readonly busy: boolean
}): ReactNode {
  const attempts = [...mission.attempts].sort((left, right) => right.attempt.ordinal - left.attempt.ordinal)
  return (
    <div className="fy-view">
      <Breadcrumb onClick={() => { cockpit.showMissions() }}>Missions</Breadcrumb>
      <section className="fy-detail-hero">
        <div>
          <p className="fy-eyebrow">Mission {shortId(mission.mission.id)}</p>
          <h1>{mission.mission.title}</h1>
          <p>{mission.mission.objective}</p>
        </div>
        <div className="fy-hero-actions">
          <StatusPill state={mission.derivedState} />
          <button
            type="button"
            className="fy-primary"
            disabled={busy || attempts.length !== 0}
            onClick={() => { void cockpit.startAttempt(mission.task.id) }}
          >
            {attempts.length === 0 ? 'Start attempt' : 'Attempt started'}
          </button>
        </div>
      </section>
      <section className="fy-facts" aria-label="Mission facts">
        <Fact label="Repository" value={mission.mission.repository.path} mono />
        <Fact label="Base ref" value={mission.mission.baseRef} mono />
        <Fact label="Task" value={mission.task.specification.title} />
        <Fact label="Verification" value={`${mission.task.specification.verification.length} required`} />
        <Fact label="Model" value={`${mission.mission.defaultPolicy.provider} / ${mission.mission.defaultPolicy.model}`} />
        <Fact label="Sandbox" value={mission.mission.defaultPolicy.sandboxMode} />
      </section>
      <section className="fy-section">
        <div className="fy-section-title">
          <div>
            <p className="fy-eyebrow">Execution history</p>
            <h2>Attempts</h2>
          </div>
          <span className="fy-count">{attempts.length}</span>
        </div>
        {attempts.length === 0 ? (
          <EmptyState title="No attempts" detail="Start the first isolated attempt for this task." />
        ) : (
          <div className="fy-table" role="table" aria-label="Mission attempts">
            {attempts.map(attempt => (
              <button
                type="button"
                className="fy-attempt-row"
                role="row"
                key={attempt.attempt.id}
                onClick={() => { cockpit.showAttempt(mission.mission.id, attempt.attempt.id) }}
              >
                <span className="fy-attempt-number">#{attempt.attempt.ordinal}</span>
                <span>
                  <strong>{shortId(attempt.attempt.id)}</strong>
                  <small>{formatTime(attempt.attempt.updatedAt)}</small>
                </span>
                <StatusPill state={attempt.attempt.state} />
                <span className="fy-verification-ratio">
                  {attempt.review.passingVerificationCount}/{attempt.review.requiredVerificationCount} checks
                </span>
                <span aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function AttemptReview({
  cockpit,
  mission,
  attempt,
  busy,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly mission: MissionView
  readonly attempt: AttemptView
  readonly busy: boolean
}): ReactNode {
  const [actor, setActor] = useState('local-user')
  const [rationale, setRationale] = useState('')
  const sessionAvailable = cockpit.canOpenSession(attempt)
  const state = attempt.attempt.state
  const canReviewDecision = ['awaiting_decision', 'interrupted', 'needs_review'].includes(state)
  const canCancel = ['running', 'awaiting_decision', 'interrupted', 'needs_review'].includes(state)
  const canVerify = ['running', 'awaiting_decision', 'interrupted', 'needs_review'].includes(state)
  const decisionInputReady = actor.trim().length > 0 && rationale.trim().length > 0
  const decide = (type: DecisionType): void => {
    if (type === 'RETRY') {
      void cockpit.retry({ attemptId: attempt.attempt.id, actor: actor.trim(), rationale: rationale.trim() })
      return
    }
    void cockpit.decide({ attemptId: attempt.attempt.id, type, actor: actor.trim(), rationale: rationale.trim() })
  }

  return (
    <div className="fy-view">
      <Breadcrumb onClick={() => { cockpit.showMission(mission.mission.id) }}>{mission.mission.title}</Breadcrumb>
      <section className="fy-detail-hero">
        <div>
          <p className="fy-eyebrow">Attempt #{attempt.attempt.ordinal} · {shortId(attempt.attempt.id)}</p>
          <h1>Attempt review</h1>
          <p>{attempt.attempt.executionSnapshot.task.objective}</p>
        </div>
        <div className="fy-hero-actions">
          <StatusPill state={attempt.attempt.state} />
          <button
            type="button"
            className="fy-secondary"
            disabled={busy || !sessionAvailable}
            title={sessionAvailable ? 'Open native DSH Session' : 'Session is not available in DSH'}
            onClick={() => { cockpit.openSession(attempt) }}
          >
            Open Session ↗
          </button>
        </div>
      </section>
      <section className="fy-review-grid">
        <div className="fy-review-main">
          <ReviewSummary attempt={attempt} />
          <ExecutionSnapshotPanel attempt={attempt} />
          <VerificationPanel attempt={attempt} />
          <EvidencePanel evidence={attempt.evidence} />
          <DecisionHistory attempt={attempt} />
          {/* Keyed by Attempt so an open confirmation never carries to another one. */}
          <PromotionPanel key={attempt.attempt.id} cockpit={cockpit} attempt={attempt} busy={busy} />
        </div>
        <aside className="fy-decision-panel">
          <p className="fy-eyebrow">Decision gate</p>
          <h2>{attempt.review.canApprove ? 'Ready for review' : 'Approval blocked'}</h2>
          <p>{attempt.review.reason ?? 'All required evidence is current.'}</p>
          <Field label="Actor">
            <input value={actor} onChange={event => { setActor(event.target.value) }} />
          </Field>
          <Field label="Rationale">
            <textarea rows={4} value={rationale} onChange={event => { setRationale(event.target.value) }} />
          </Field>
          <div className="fy-decision-actions">
            <button
              type="button"
              className="fy-primary"
              disabled={busy || !attempt.review.canApprove || !decisionInputReady}
              onClick={() => { decide('APPROVE') }}
            >
              Approve
            </button>
            <button type="button" className="fy-secondary" disabled={busy || !canReviewDecision || !decisionInputReady} onClick={() => { decide('REJECT') }}>Reject</button>
            <button type="button" className="fy-secondary" disabled={busy || !canReviewDecision || !decisionInputReady} onClick={() => { decide('RETRY') }}>Retry</button>
            <button type="button" className="fy-danger" disabled={busy || !canCancel || !decisionInputReady} onClick={() => { decide('CANCEL') }}>Cancel</button>
          </div>
          <button
            type="button"
            className="fy-verify"
            disabled={busy || !canVerify}
            onClick={() => { void cockpit.verifyAttempt(attempt.attempt.id) }}
          >
            Run verification
          </button>
          <dl className="fy-review-identifiers">
            <div><dt>Session</dt><dd>{attempt.attempt.dshSessionId || 'Pending'}</dd></div>
            <div><dt>Base</dt><dd>{shortHash(attempt.attempt.baseCommit)}</dd></div>
            <div><dt>Fingerprint</dt><dd>{attempt.attempt.gitFingerprint === null ? 'Pending' : shortHash(attempt.attempt.gitFingerprint)}</dd></div>
          </dl>
        </aside>
      </section>
    </div>
  )
}

/**
 * The local delivery gate. Approval authorizes a reviewed state; promotion is a
 * separate explicit action that requires confirming the exact approved digest.
 */
function PromotionPanel({
  cockpit,
  attempt,
  busy,
}: {
  readonly cockpit: ForgeyardCockpitController
  readonly attempt: AttemptView
  readonly busy: boolean
}): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [actor, setActor] = useState('local-user')
  const [rationale, setRationale] = useState('')
  const eligibility = attempt.promotion
  const digest = eligibility.reviewDigest
  const ready = actor.trim().length > 0 && rationale.trim().length > 0 && digest !== null
  const settled = [...attempt.promotions].reverse()

  return (
    <section className="fy-section fy-promotion" data-promotion-status={eligibility.status}>
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Local delivery</p>
          <h2>Promotion</h2>
        </div>
        <StatusPill state={eligibility.status} />
      </div>
      <p className="fy-promotion-reason">
        {eligibility.reason ?? 'This approved deliverable can be promoted to a durable Forgeyard-owned local Git ref.'}
      </p>
      <dl className="fy-command-evidence">
        <div><dt>Approved digest</dt><dd><code>{digest ?? 'None'}</code></dd></div>
        <div><dt>Output ref</dt><dd><code>{eligibility.outputRef ?? eligibility.plannedRef ?? 'Unavailable'}</code></dd></div>
        <div><dt>Output commit</dt><dd><code>{eligibility.outputCommit ?? 'Not promoted'}</code></dd></div>
        {eligibility.failureReason === null
          ? null
          : <div><dt>Last failure</dt><dd>{eligibility.failureReason}</dd></div>}
      </dl>
      {!eligibility.eligible ? null : confirming ? (
        <div className="fy-promotion-confirm">
          <p>
            Confirm promoting review digest <code>{digest}</code> into{' '}
            <code>{eligibility.plannedRef}</code>. Forgeyard revalidates the live Attempt immediately
            before writing and never pushes anything remotely.
          </p>
          <Field label="Actor">
            <input value={actor} onChange={event => { setActor(event.target.value) }} />
          </Field>
          <Field label="Rationale">
            <textarea rows={3} value={rationale} onChange={event => { setRationale(event.target.value) }} />
          </Field>
          <div className="fy-decision-actions">
            <button
              type="button"
              className="fy-primary"
              disabled={busy || !ready}
              onClick={() => {
                if (digest === null) return
                void cockpit.promote({
                  attemptId: attempt.attempt.id,
                  actor: actor.trim(),
                  rationale: rationale.trim(),
                  expectedReviewDigest: digest,
                })
              }}
            >
              Confirm promotion
            </button>
            <button type="button" className="fy-secondary" disabled={busy} onClick={() => { setConfirming(false) }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="fy-primary fy-promote"
          disabled={busy}
          onClick={() => { setConfirming(true) }}
        >
          Promote approved deliverable…
        </button>
      )}
      {settled.length === 0 ? null : (
        <div className="fy-check-list">
          {settled.map(record => <PromotionRow key={record.id} record={record} />)}
        </div>
      )}
    </section>
  )
}

function PromotionRow({ record }: { readonly record: PromotionRecord }): ReactNode {
  const projection = record.projection
  const dropped = projection.excludedByReason.find(entry => entry.reason === 'directory-dropped')?.count ?? 0
  const ignored = projection.excludedByReason.find(entry => entry.reason === 'ignored')?.count ?? 0
  return (
    <article className="fy-check">
      <StatusPill state={record.status} />
      <div>
        <strong>{record.actor}</strong>
        <code>{record.outputRef} · {shortHash(record.outputCommit)} · {formatTime(record.createdAt)}</code>
        <p>{record.failureReason ?? record.rationale}</p>
        <small>
          {projection.promoted.count} promoted · {ignored} ignored · {dropped} dropped directories ·{' '}
          {projection.unrepresentableModes.count} unrepresentable modes · projection {shortHash(projection.hash)}
          {projection.promoted.previewTruncated || projection.excluded.previewTruncated ? ' · ledger preview bounded' : ''}
        </small>
      </div>
    </article>
  )
}

function ExecutionSnapshotPanel({ attempt }: { readonly attempt: AttemptView }): ReactNode {
  const snapshot = attempt.attempt.executionSnapshot
  const latestGit = [...attempt.evidence].reverse().find(item => item.payload.kind === 'git')
  const head = latestGit?.payload.kind === 'git' ? latestGit.payload.headCommit : null
  return (
    <section className="fy-section">
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Frozen authority</p>
          <h2>Execution snapshot</h2>
        </div>
        <code>{shortHash(attempt.attempt.executionSnapshotHash)}</code>
      </div>
      <dl className="fy-command-evidence">
        <div><dt>Instruction</dt><dd>{snapshot.task.instruction}</dd></div>
        <div><dt>Worktree</dt><dd><code>{attempt.attempt.worktreePath}</code></dd></div>
        <div><dt>Base</dt><dd><code>{snapshot.baseCommit}</code></dd></div>
        <div><dt>Head</dt><dd><code>{head ?? 'Pending Evidence'}</code></dd></div>
        <div><dt>Model</dt><dd><code>{snapshot.policy.provider} / {snapshot.policy.model}</code></dd></div>
        <div><dt>Reasoning</dt><dd>{snapshot.policy.reasoningEffort ?? 'Provider default'}</dd></div>
        <div><dt>Agent preset</dt><dd><code>{snapshot.policy.agentPreset ?? 'DSH default'}</code></dd></div>
        <div><dt>Permission</dt><dd><code>{snapshot.policy.permissionPreset} · {snapshot.policy.sandboxMode} · {snapshot.policy.approvalPolicy}</code></dd></div>
        <div><dt>Tool schema</dt><dd><code>{shortHash(snapshot.policy.toolPolicy.schemaHash)} · {snapshot.policy.toolPolicy.allowedToolNames.length} tools</code></dd></div>
      </dl>
    </section>
  )
}

function ReviewSummary({ attempt }: { readonly attempt: AttemptView }): ReactNode {
  const completed = attempt.review.requiredVerificationCount === 0
    ? 0
    : Math.round((attempt.review.passingVerificationCount / attempt.review.requiredVerificationCount) * 100)
  return (
    <section className="fy-section fy-review-summary">
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Review digest</p>
          <h2>{shortHash(attempt.review.reviewDigest)}</h2>
        </div>
        <strong>{completed}%</strong>
      </div>
      <div className="fy-meter" aria-label={`${completed}% of required verification passing`}>
        <span style={{ width: `${completed}%` }} />
      </div>
      <div className="fy-summary-stats">
        <Fact label="Required" value={String(attempt.review.requiredVerificationCount)} />
        <Fact label="Passing" value={String(attempt.review.passingVerificationCount)} />
        <Fact label="Evidence" value={String(attempt.evidence.length)} />
        <Fact label="Stale" value={attempt.review.approvalStale ? 'Yes' : 'No'} />
      </div>
    </section>
  )
}

function VerificationPanel({ attempt }: { readonly attempt: AttemptView }): ReactNode {
  const latestRunId = attempt.review.latestRunId
  const latest = attempt.verifications.filter(item => item.runId === latestRunId)
  const historical = attempt.verifications.filter(item => item.runId !== latestRunId)
  return (
    <section className="fy-section">
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Deterministic checks</p>
          <h2>Verification</h2>
        </div>
        <span className="fy-count">{latest.length}/{attempt.attempt.executionSnapshot.verification.length} current</span>
      </div>
      <div className="fy-check-list">
        {attempt.attempt.executionSnapshot.verification.map((requirement, index) => {
          const item = latest.find(candidate => candidate.requirementIndex === index)
          return (
            <article className="fy-check" key={`${requirement.key}:${index}`}>
              {item === undefined ? <StatusPill state="pending" /> : <VerificationPill status={item.status} />}
              <div>
                <strong>{requirement.command}</strong>
                <code>{requirement.argv.join(' ')}</code>
                <p>{item?.rationale ?? 'Frozen requirement; no current trusted evaluation.'}</p>
                <small>{item === undefined ? 'No reviewed run' : `Reviewed run ${shortId(item.runId)} · Evidence ${item.evidenceIds.map(shortHash).join(', ')}`}</small>
              </div>
            </article>
          )
        })}
      </div>
      {historical.length === 0 ? null : (
        <details className="fy-evidence">
          <summary><strong>Earlier verification runs</strong><span>{historical.length}</span></summary>
          <div className="fy-check-list fy-evidence-body">
            {historical.map(item => (
              <article className="fy-check" key={item.id}>
                <VerificationPill status={item.status} />
                <div><strong>{item.requirement.command}</strong><code>Run {shortId(item.runId)}</code><p>{item.rationale}</p></div>
              </article>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}

function EvidencePanel({ evidence }: { readonly evidence: EvidenceRecord[] }): ReactNode {
  const reviewedRunId = evidenceRunId(evidence)
  return (
    <section className="fy-section">
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Immutable artifacts</p>
          <h2>Evidence</h2>
        </div>
        <span className="fy-count">{evidence.length}</span>
      </div>
      {evidence.length === 0 ? (
        <EmptyState title="No evidence collected" detail="Evidence appears after execution and verification." />
      ) : (
        <div className="fy-evidence-list">
          {evidence.map(item => (
            <details className="fy-evidence" key={item.id}>
              <summary>
                <span>
                  <strong>{item.kind === 'git' ? 'Git snapshot' : 'Verification command'}</strong>
                  <small>{shortHash(item.hash)} · {item.completeness} · Run {shortId(item.runId)}{item.runId === reviewedRunId ? ' · reviewed' : ' · historical'}</small>
                </span>
                <span>{formatTime(item.createdAt)}</span>
              </summary>
              {item.payload.kind === 'git' ? (
                <div className="fy-evidence-body">
                  <ul>
                    {item.payload.changedFiles.map(file => <li key={`${file.status}:${file.path}`}><b>{file.status}</b><code>{file.path}</code></li>)}
                  </ul>
                  {item.payload.diff === '' ? null : <pre>{item.payload.diff}</pre>}
                </div>
              ) : (
                <div className="fy-evidence-body">
                  <dl className="fy-command-evidence">
                    <div><dt>Command</dt><dd><code>{item.payload.command}</code></dd></div>
                    <div><dt>argv</dt><dd><code>{item.payload.argv.join(' ')}</code></dd></div>
                    <div><dt>cwd</dt><dd><code>{item.payload.cwd}</code></dd></div>
                    <div><dt>Environment</dt><dd>{item.payload.environment.length === 0 ? 'No recorded facts' : item.payload.environment.map(fact => `${fact.name}=${fact.value}`).join(' · ')}</dd></div>
                    <div><dt>Exit</dt><dd>{item.payload.exitCode ?? item.payload.signal ?? 'Unavailable'}</dd></div>
                    <div><dt>Duration</dt><dd>{item.payload.durationMs} ms</dd></div>
                    <div><dt>Timed out</dt><dd>{item.payload.timedOut ? 'Yes' : 'No'}</dd></div>
                    <div><dt>Spawn error</dt><dd>{item.payload.spawnError ?? 'None'}</dd></div>
                    <div><dt>stdout</dt><dd>{shortHash(item.payload.stdoutHash)} · {item.payload.stdoutBytes} bytes · {item.payload.stdoutTruncated ? 'truncated' : 'complete'}</dd></div>
                    <div><dt>stderr</dt><dd>{shortHash(item.payload.stderrHash)} · {item.payload.stderrBytes} bytes · {item.payload.stderrTruncated ? 'truncated' : 'complete'}</dd></div>
                  </dl>
                  {item.payload.stdout === '' ? null : <pre aria-label="Verifier stdout">{item.payload.stdout}</pre>}
                  {item.payload.stderr === '' ? null : <pre aria-label="Verifier stderr">{item.payload.stderr}</pre>}
                </div>
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  )
}

function evidenceRunId(evidence: readonly EvidenceRecord[]): string | null {
  const git = [...evidence]
    .filter(item => item.kind === 'git')
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]
  return git?.runId ?? null
}

function DecisionHistory({ attempt }: { readonly attempt: AttemptView }): ReactNode {
  return (
    <section className="fy-section">
      <div className="fy-section-title">
        <div>
          <p className="fy-eyebrow">Append-only review record</p>
          <h2>Decisions</h2>
        </div>
        <span className="fy-count">{attempt.decisions.length}</span>
      </div>
      {attempt.decisions.length === 0 ? (
        <EmptyState title="No decision" detail="Approval, rejection, retry, or cancellation will be retained here." />
      ) : (
        <div className="fy-check-list">
          {attempt.decisions.map(decision => (
            <article className="fy-check" key={decision.id}>
              <StatusPill state={decision.type.toLowerCase()} />
              <div>
                <strong>{decision.actor}</strong>
                <code>{shortHash(decision.reviewDigest)} · {formatTime(decision.createdAt)}</code>
                <p>{decision.rationale}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function Breadcrumb({ children, onClick }: { readonly children: ReactNode; readonly onClick: () => void }): ReactNode {
  return <button type="button" className="fy-breadcrumb" onClick={onClick}><span aria-hidden="true">←</span>{children}</button>
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return <label className="fy-field"><span>{label}</span>{children}</label>
}

function Fact({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }): ReactNode {
  return <div className="fy-fact"><span>{label}</span>{mono ? <code>{value}</code> : <strong>{value}</strong>}</div>
}

function EmptyState({ title, detail }: { readonly title: string; readonly detail: string }): ReactNode {
  return <div className="fy-empty"><span aria-hidden="true">◇</span><strong>{title}</strong><p>{detail}</p></div>
}

function StatusPill({ state }: { readonly state: AttemptState | string }): ReactNode {
  return <span className="fy-status" data-state={toneForState(state)}>{humanize(state)}</span>
}

function VerificationPill({ status }: { readonly status: VerificationStatus }): ReactNode {
  return <span className="fy-check-status" data-status={status}>{status}</span>
}

function shortId(id: AttemptId | string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : hash.slice(0, 12)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase())
}

function toneForState(state: string): 'good' | 'bad' | 'active' | 'neutral' {
  if (state === 'approved' || state === 'promoted') return 'good'
  if (state === 'rejected' || state === 'cancelled' || state === 'interrupted'
    || state === 'failed' || state === 'blocked' || state === 'diverged') return 'bad'
  if (state === 'running' || state === 'verifying' || state === 'awaiting_decision'
    || state === 'eligible' || state === 'pending' || state === 'uncertain') return 'active'
  return 'neutral'
}
