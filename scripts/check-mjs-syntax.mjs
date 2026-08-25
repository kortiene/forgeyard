import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const thisFile = fileURLToPath(import.meta.url)
const defaultScriptsRoot = dirname(thisFile)

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function displayPath(root, file) {
  return relative(root, file).split(sep).join('/')
}

function errorMessage(error) {
  if (error && typeof error === 'object') {
    if (typeof error.stderr === 'string' && error.stderr.trim().length > 0) return error.stderr.trimEnd()
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) return error.stdout.trimEnd()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Recursively enumerate regular .mjs files below root.
 *
 * The returned absolute paths are unique and ordered by their slash-normalized
 * path relative to root. Directory traversal order, filesystem enumeration
 * order, locale, and shell glob behavior therefore cannot change the gate.
 * Symbolic links are deliberately not followed: following a directory link can
 * escape the reviewed scripts tree or introduce cycles.
 */
export async function discoverMjsFiles(root) {
  const absoluteRoot = resolve(root)
  const files = []

  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `Cannot read MJS syntax-check directory ${directory} below root ${absoluteRoot}: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path)
    }
  }

  await walk(absoluteRoot)
  return [...new Set(files)].sort((left, right) =>
    compareText(displayPath(absoluteRoot, left), displayPath(absoluteRoot, right)))
}

/**
 * Parse-check every discovered .mjs file with the exact Node executable running
 * this gate. Failures are collected instead of stopping at the first file so CI
 * preserves every useful parser diagnostic in one run.
 */
export async function checkMjsSyntax(root, { nodePath = process.execPath } = {}) {
  const absoluteRoot = resolve(root)
  const files = await discoverMjsFiles(absoluteRoot)
  if (files.length === 0) {
    throw new Error(`No .mjs files found under ${absoluteRoot}; refusing to pass an empty syntax gate.`)
  }

  const failures = []
  for (const file of files) {
    try {
      await execFileAsync(nodePath, ['--check', file], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      })
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        throw new Error(`Cannot execute Node syntax checker at ${nodePath}: ${errorMessage(error)}`, { cause: error })
      }
      failures.push({ file: displayPath(absoluteRoot, file), diagnostic: errorMessage(error) })
    }
  }

  if (failures.length > 0) {
    const diagnostics = failures.map(failure =>
      `
--- ${failure.file} ---
${failure.diagnostic}`).join('')
    throw new Error(
      `MJS syntax check failed for ${failures.length} of ${files.length} file(s) under ${absoluteRoot}.${diagnostics}`,
    )
  }

  return {
    root: absoluteRoot,
    files: files.map(file => displayPath(absoluteRoot, file)),
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1) {
    throw new Error('Usage: node scripts/check-mjs-syntax.mjs [scripts-directory]')
  }
  const root = args[0] === undefined ? defaultScriptsRoot : resolve(args[0])
  const result = await checkMjsSyntax(root)
  const shownRoot = relative(process.cwd(), result.root) || '.'
  process.stdout.write(
    `MJS syntax check passed: ${result.files.length} file(s) under ${shownRoot.split(sep).join('/')}.
`,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    process.stderr.write(`MJS syntax check failed: ${errorMessage(error)}
`)
    process.exitCode = 1
  })
}
