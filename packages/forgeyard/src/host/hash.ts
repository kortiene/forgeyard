import { createHash, randomUUID } from 'node:crypto'

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Forgeyard snapshots require finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  }
  throw new TypeError(`Forgeyard snapshots cannot encode ${typeof value}`)
}

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return canonical(value)
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashRecord(value: unknown): string {
  return sha256(canonicalJson(value))
}

export function forgeyardId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}
