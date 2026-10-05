import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSync, type Font } from 'fontkit'
import { PDFParse } from 'pdf-parse'
import { AppError } from './ai.ts'
import { exportPdf } from './pdf.ts'

// Synthetic text only. Probe system fonts, never personal fonts/resume data.
const latinFonts = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'C:/Windows/Fonts/arial.ttf',
]
const cjkFonts = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msgothic.ttc',
]

function compatibleFont(paths: string[], text: string): { path: string; face: Font } | undefined {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const opened = openSync(path)
      for (const face of 'fonts' in opened ? opened.fonts : [opened]) {
        if (Array.from(text.replace(/\n/g, '')).some(character => !face.hasGlyphForCodePoint(character.codePointAt(0)!))) continue
        // Only skip unavailable/unsupported local fonts, not export failures.
        const subset = face.createSubset()
        for (const glyph of face.layout(text.replace(/\n/g, ' ')).glyphs) subset.includeGlyph(glyph)
        subset.encode()
        return { path, face }
      }
    } catch { /* Not a compatible installed font on this platform. */ }
  }
}

async function readPdf(buffer: Buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-')
  assert.match(buffer.subarray(-32).toString(), /%%EOF/)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    return await parser.getText({ pageJoiner: '\n' })
  } finally {
    await parser.destroy()
  }
}

function actionableError(error: unknown): boolean {
  assert.ok(error instanceof AppError)
  assert.equal(error.status, 422)
  assert.match(error.message, /PDF_FONT_PATH/)
  assert.match(error.message, /restart the server/)
  assert.match(error.message, /No PDF was exported/)
  return true
}

describe('multilingual PDF export', { concurrency: false }, () => {
  let originalPath: string | undefined
  let originalName: string | undefined
  let temporaryDirectory: string

  beforeEach(() => {
    originalPath = process.env.PDF_FONT_PATH
    originalName = process.env.PDF_FONT_NAME
    delete process.env.PDF_FONT_PATH
    delete process.env.PDF_FONT_NAME
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'folio-pdf-test-'))
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PDF_FONT_PATH
    else process.env.PDF_FONT_PATH = originalPath
    if (originalName === undefined) delete process.env.PDF_FONT_NAME
    else process.env.PDF_FONT_NAME = originalName
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  it('preserves English headings, blank lines, and multipage text', async () => {
    const text = `Alex Example\r\n\r\nEXPERIENCE\n${Array.from({ length: 160 }, (_, index) => `Project ${index + 1}: Maintained TypeScript services and wrote tests.`).join('\n')}\nFINAL SECTION\nEnd of resume.`
    const parsed = await readPdf(await exportPdf(text, 'Engineer — Example Co'))
    assert.ok(parsed.total > 1)
    for (const expected of ['Alex Example', 'EXPERIENCE', 'Project 160', 'FINAL SECTION', 'End of resume.']) assert.ok(parsed.text.includes(expected))
  })

  it('roundtrips accented Latin, Greek, Cyrillic, and punctuation with an explicit font', async context => {
    const text = 'Zoë García\nEXPÉRIENCE\nΕλληνικά\nКириллица\nRésumé — café • naïve'
    const font = compatibleFont(latinFonts, text)
    if (!font) { context.skip('No compatible system Latin font installed.'); return }
    process.env.PDF_FONT_PATH = font.path
    const parsed = await readPdf(await exportPdf(text, 'Synthetic Unicode'))
    for (const line of text.split('\n')) assert.ok(parsed.text.includes(line), `Missing synthetic line: ${line}`)
  })

  const cjkText = 'Alex Example\n中文简历\n繁體履歷\n日本語履歴書\nTypeScript 2026'

  it('automatically roundtrips CJK and English using compatible system fonts', async context => {
    if (!compatibleFont(cjkFonts, cjkText)) { context.skip('No compatible system CJK font installed.'); return }
    const parsed = await readPdf(await exportPdf(cjkText, 'Synthetic 中文'))
    for (const line of cjkText.split('\n')) assert.ok(parsed.text.includes(line), `Missing synthetic line: ${line}`)
  })

  it('automatically selects a TTC face and honors an explicit PostScript face', async context => {
    const font = compatibleFont(cjkFonts.filter(path => path.endsWith('.ttc')), cjkText)
    if (!font) { context.skip('No compatible system CJK collection installed.'); return }
    process.env.PDF_FONT_PATH = font.path
    for (const name of [undefined, font.face.postscriptName]) {
      if (name) process.env.PDF_FONT_NAME = name
      const parsed = await readPdf(await exportPdf(cjkText, 'Synthetic collection'))
      for (const line of cjkText.split('\n')) assert.ok(parsed.text.includes(line), `Missing synthetic line: ${line}`)
    }
    process.env.PDF_FONT_NAME = 'FolioNonexistentPostScriptFace'
    await assert.rejects(exportPdf(cjkText, 'Synthetic invalid face'), error => {
      actionableError(error)
      assert.match((error as Error).message, /PDF_FONT_NAME does not match/)
      return true
    })
  })

  it('roundtrips Korean when a compatible system font is available', async context => {
    const text = 'Alex Example\n한국어 이력서\nTypeScript 2026'
    const font = compatibleFont([...cjkFonts, '/System/Library/Fonts/AppleSDGothicNeo.ttc', 'C:/Windows/Fonts/malgun.ttf'], text)
    if (!font) { context.skip('No compatible system Korean font installed.'); return }
    process.env.PDF_FONT_PATH = font.path
    const parsed = await readPdf(await exportPdf(text, 'Synthetic Korean'))
    for (const line of text.split('\n')) assert.ok(parsed.text.includes(line))
  })

  it('always rejects missing Unicode glyphs actionably, including astral code points', async () => {
    await assert.rejects(exportPdf('Synthetic private content\n\u{10ffff}', 'Missing glyph'), error => {
      actionableError(error)
      assert.match((error as Error).message, /U\+10FFFF/)
      assert.doesNotMatch((error as Error).message, /Synthetic private content/)
      return true
    })
  })

  it('does not silently replace an explicitly configured font with insufficient coverage', async context => {
    const font = compatibleFont(latinFonts, 'Alex Example')
    if (!font) { context.skip('No system Latin font installed.'); return }
    process.env.PDF_FONT_PATH = font.path
    await assert.rejects(exportPdf('Alex Example\n\u{10ffff}', 'Missing glyph'), actionableError)
    if (!font.face.hasGlyphForCodePoint(0x4e2d)) {
      await assert.rejects(exportPdf('Alex Example\n中文', 'Missing CJK'), actionableError)
    }
  })

  it('rejects nonexistent font paths rather than silently falling back to Arial', async () => {
    process.env.PDF_FONT_PATH = join(temporaryDirectory, 'missing.ttf')
    await assert.rejects(exportPdf('Alex Example', 'Invalid font'), actionableError)
  })

  it('rejects corrupt font files and directory paths with configuration guidance', async () => {
    const invalidFont = join(temporaryDirectory, 'invalid.ttf')
    writeFileSync(invalidFont, 'Synthetic invalid font')
    for (const path of [invalidFont, temporaryDirectory]) {
      process.env.PDF_FONT_PATH = path
      await assert.rejects(exportPdf('Alex Example', 'Invalid font'), actionableError)
    }
  })

  it('requires a path when a PostScript face is configured', async () => {
    process.env.PDF_FONT_NAME = 'SyntheticFace'
    await assert.rejects(exportPdf('Alex Example', 'Invalid configuration'), actionableError)
  })
})