/**
 * Parse a single executable invocation without a shell. Shell operators are
 * rejected so the displayed requirement and the executed argv cannot diverge.
 */
export function parseCommandLine(input: string): string[] {
  const text = input.trim()
  if (text.length === 0) throw new Error('verification command must not be empty')
  const argv: string[] = []
  let token = ''
  let quoted = false
  let quote: 'single' | 'double' | null = null
  let escaping = false

  const finish = (): void => {
    if (token.length > 0 || quoted) argv.push(token)
    token = ''
    quoted = false
  }

  for (const character of text) {
    if (escaping) {
      token += character
      escaping = false
      quoted = true
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      else token += character
      quoted = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else if (character === '\\') escaping = true
      else token += character
      quoted = true
      continue
    }
    if (character === '\\') {
      escaping = true
      continue
    }
    if (character === "'") {
      quote = 'single'
      quoted = true
      continue
    }
    if (character === '"') {
      quote = 'double'
      quoted = true
      continue
    }
    if (/\s/u.test(character)) {
      finish()
      continue
    }
    if (';&|<>`'.includes(character) || character === '$') {
      throw new Error(`shell syntax is not allowed in verification commands: ${character}`)
    }
    token += character
  }
  if (escaping || quote !== null) throw new Error('verification command has an unterminated quote or escape')
  finish()
  if (argv.length === 0 || argv[0]?.length === 0) throw new Error('verification command needs an executable')
  return argv
}
