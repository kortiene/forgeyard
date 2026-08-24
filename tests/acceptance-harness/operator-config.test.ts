import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the acceptance harness is plain ESM JavaScript, not part of a tsconfig project.
import { parseDefaultModel, withoutProfileScopedSettings } from '../../scripts/harness/dsh-profile.mjs'

const SETTINGS = [
  'llm:',
  '  providers:',
  '    deepseek-official:',
  '      apiKeyEnv: DEEPSEEK_API_KEY',
  'permission:',
  '  defaultPreset: danger-full-access',
  'agent-default-model:',
  '  provider: omniroute',
  '  model: claude/claude-fable-5',
  'agent-presets:',
  '  default: cordis-claude',
  'ui-theme:',
  '  preference: system',
  '',
].join('\n')

describe('withoutProfileScopedSettings', () => {
  it('drops the operator agent-preset default the pinned profile cannot mount', () => {
    const stripped = withoutProfileScopedSettings(SETTINGS)
    expect(stripped).not.toMatch(/^agent-presets:/mu)
    expect(stripped).not.toContain('cordis-claude')
  })

  it('keeps provider routing, credentials config, and the neighbouring blocks intact', () => {
    const stripped = withoutProfileScopedSettings(SETTINGS)
    expect(stripped).toContain('apiKeyEnv: DEEPSEEK_API_KEY')
    expect(stripped).toMatch(/^agent-default-model:$/mu)
    expect(stripped).toMatch(/^ui-theme:$/mu)
    expect(stripped).toContain('  preference: system')
    expect(parseDefaultModel(stripped)).toEqual({ provider: 'omniroute', model: 'claude/claude-fable-5', reasoningEffort: null })
  })

  it('is a no-op when the operator set no preset default', () => {
    const withoutBlock = SETTINGS.replace('agent-presets:\n  default: cordis-claude\n', '')
    expect(withoutProfileScopedSettings(withoutBlock)).toBe(withoutBlock)
  })

  it('does not touch a similarly named key nested under another block', () => {
    const nested = ['plugins:', '  agent-presets:', '    default: keep-me', ''].join('\n')
    expect(withoutProfileScopedSettings(nested)).toBe(nested)
  })
})

describe('parseDefaultModel', () => {
  it('reports nulls when the operator configured no default model', () => {
    expect(parseDefaultModel('ui-theme:\n  preference: system\n'))
      .toEqual({ provider: null, model: null, reasoningEffort: null })
  })

  it('unquotes values and reads the optional reasoning effort', () => {
    const yaml = 'agent-default-model:\n  provider: "deepseek-official"\n  model: \'deepseek-v4-flash\'\n  reasoningEffort: high\n'
    expect(parseDefaultModel(yaml)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
  })
})
