import { readFileSync, writeFileSync } from 'node:fs'
const models = JSON.parse(readFileSync('/tmp/omniroute-models.json', 'utf8'))
const families = []
const byFamily = new Map()
for (const m of models) {
  const prefix = m.id.includes('/') ? m.id.split('/')[0] : '(top-level)'
  if (!byFamily.has(prefix)) { byFamily.set(prefix, []); families.push(prefix) }
  byFamily.get(prefix).push(m)
}
const fmt = n => n === undefined ? '—' : n.toLocaleString('en-US')
const esc = s => s === undefined ? '' : String(s).replace(/\|/g, '\\|')
const pinned = [
  'auto/best-coding','auto/best-fast','auto/best-reasoning',
  'anthropic/claude-opus-5-high','anthropic/claude-sonnet-5-high',
  'openrouter/openai/gpt-5.6-terra-pro-high','openrouter/openai/gpt-5.3-codex-high',
  'openrouter/deepseek/deepseek-v4-pro-high','openrouter/z-ai/glm-5.2-xhigh',
  'openrouter/x-ai/grok-4.5-high',
]
const ids = new Set(models.map(m => m.id))
let md = ''
md += '# OmniRoute Provider — Exhaustive Model List\n\n'
md += '- **Gateway**: https://omniroute.kortiene.com/v1 (`GET /models`, OpenAI-compatible)\n'
md += '- **Retrieved**: 2026-08-23, live, via the running DSH host\'s `llm.discoverModels` RPC\n'
md += '- **Total advertised models**: ' + models.length + '\n'
md += '- **Families**: ' + families.length + '\n'
md += '- **Machine-readable copy**: [omniroute-models.json](omniroute-models.json)\n\n'
md += 'Every entry the gateway advertises is listed below, grouped by id family in the gateway\'s own order. Context is the maximum combined request+response window; Max out is the maximum output tokens. A dash means the gateway disclosed nothing.\n\n'
md += '## Family summary\n\n'
md += '| Family | Models | Typical context | Typical max out |\n'
md += '|---|---:|---:|---:|\n'
for (const f of families) {
  const list = byFamily.get(f)
  const ctx = [...new Set(list.map(m => m.contextWindow).filter(v => v !== undefined))]
  const out = [...new Set(list.map(m => m.maxTokens).filter(v => v !== undefined))]
  const cell = a => a.length === 1 ? fmt(a[0]) : a.length === 0 ? '—' : 'varied'
  md += '| `' + f + '/` | ' + list.length + ' | ' + cell(ctx) + ' | ' + cell(out) + ' |\n'
}
md += '\n## All models by family\n'
for (const f of families) {
  const list = byFamily.get(f)
  md += '\n### `' + f + '/` (' + list.length + ')\n\n'
  md += '| ID | Name | Context | Max out |\n'
  md += '|---|---|---:|---:|\n'
  for (const m of list) {
    md += '| `' + m.id + '` | ' + (esc(m.name) || '—') + ' | ' + fmt(m.contextWindow) + ' | ' + fmt(m.maxTokens) + ' |\n'
  }
}
md += '\n## Cross-check against the local DSH configuration\n\n'
md += 'The omniroute route in `~/.dsh/settings.yaml` pins 10 models; an explicit `models:` list **replaces** the advertised catalog in every DSH picker, which is why the model selector shows only these 10. Advertised status per pinned id:\n\n'
md += '| Pinned in settings.yaml | Advertised by gateway |\n'
md += '|---|---|\n'
for (const p of pinned) {
  md += '| `' + p + '` | ' + (ids.has(p) ? 'yes' : '**no**') + ' |\n'
}
const missing = pinned.filter(p => !ids.has(p)).length
md += '\n' + missing + ' of the pinned ids (the `anthropic/*` and `openrouter/*` direct routes) are absent from `GET /models` above. They may still be served on request — a gateway can accept more than it advertises — but the gateway does not list them.\n\n'
md += 'To adopt any advertised model in DSH: **Settings → Models → OmniRoute → Edit → “Fetch models”** lists these same candidates with checkboxes; or add ids by hand to the `models:` list of the omniroute provider in `~/.dsh/settings.yaml`.\n'
writeFileSync('docs/omniroute-models.md', md)
writeFileSync('docs/omniroute-models.json', JSON.stringify(models, null, 2) + '\n')
console.log('md bytes:', md.length, '| json entries:', models.length, '| families:', families.length)