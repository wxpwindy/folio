import PDFDocument from 'pdfkit'
import { existsSync, readFileSync } from 'node:fs'
import { create, type Font } from 'fontkit'
import { AppError } from './ai.ts'

// Prefer the existing Latin font, then broad Unicode/CJK system fonts. Do not
// scan personal font directories or download fonts as a side effect of export.
const systemFonts = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Light.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msgothic.ttc',
  'C:/Windows/Fonts/malgun.ttf',
]

function fontError(detail: string): AppError {
  return new AppError(422, `PDF export: ${detail} Set PDF_FONT_PATH to a readable Unicode TTF/OTF/TTC font covering all resume characters, then restart the server. For a collection, optionally set PDF_FONT_NAME to its PostScript face name. No PDF was exported.`)
}

function missingGlyphs(font: Font, characters: string[]): string[] {
  return characters.filter(character => {
    const codePoint = character.codePointAt(0)!
    if (!font.hasGlyphForCodePoint(codePoint)) return true
    // PDFKit embeds outlines, not bitmap/color emoji. A cmap entry alone can
    // otherwise appear to cover a character that will be invisible in the PDF.
    return !/[\s\p{Default_Ignorable_Code_Point}]/u.test(character)
      && font.glyphForCodePoint(codePoint).path.commands.length === 0
  })
}

function selectFont(text: string): { data: Buffer; name?: string } | undefined {
  const configuredPath = process.env.PDF_FONT_PATH?.trim()
  const configuredName = process.env.PDF_FONT_NAME?.trim()
  if (configuredName && !configuredPath) throw fontError('PDF_FONT_NAME requires PDF_FONT_PATH.')
  const characters = [...new Set(Array.from(text.replace(/\n/g, '')))]
  let closestMissing = characters

  for (const path of configuredPath ? [configuredPath] : systemFonts) {
    if (!existsSync(path)) {
      if (configuredPath) throw fontError('PDF_FONT_PATH does not exist.')
      continue
    }
    try {
      // Reuse the exact inspected bytes for embedding (including TTC faces).
      const data = readFileSync(path)
      const opened = create(data)
      const faces = 'fonts' in opened ? opened.fonts : [opened]
      const candidates = configuredName ? faces.filter(face => face.postscriptName === configuredName) : faces
      if (!candidates.length) throw fontError('PDF_FONT_NAME does not match a PostScript face in PDF_FONT_PATH.')
      for (const face of candidates) {
        const missing = missingGlyphs(face, characters)
        if (missing.length < closestMissing.length) closestMissing = missing
        if (missing.length) continue
        // Reject .notdef glyphs introduced by shaping as well as missing cmap
        // entries. Glyph coverage does not guarantee complex-script/bidi layout.
        if (text.split('\n').some(line => face.layout(line).glyphs.some(glyph => glyph.id === 0))) continue
        // A name on a standalone TTF is interpreted by fontkit as a variable
        // font instance, not a face selector. Only collections need the name.
        return { data, name: 'fonts' in opened ? face.postscriptName : undefined }
      }
    } catch (error) {
      if (configuredPath) {
        if (error instanceof AppError) throw error
        throw fontError('PDF_FONT_PATH could not be read or is not a compatible outline font.')
      }
      // An optional system font can be unreadable/unsupported; try the next.
    }
  }

  // Helvetica is safe only for printable ASCII. Never hand Unicode to its
  // single-byte encoding, which silently drops or corrupts unsupported text.
  if (!configuredPath && /^[\x20-\x7e\n]*$/.test(text)) return undefined
  const codePoints = closestMissing.slice(0, 8).map(character => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
  throw fontError(`No compatible font covers the complete resume${codePoints.length ? ` (missing glyphs: ${codePoints.join(', ')}${closestMissing.length > 8 ? ', …' : ''})` : ' with supported shaping'}.`)
}

export async function exportPdf(text: string, title: string, documentType: 'resume' | 'cover-letter' = 'resume'): Promise<Buffer> {
  // Normalize layout controls, not the language/content. Metadata titles use
  // PDFKit's Unicode PDF strings and do not require the body font's glyphs.
  const normalizedText = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
  const font = selectFont(normalizedText)
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title, Creator: 'Folio — local resume workspace' } })
    const chunks: Buffer[] = []
    doc.on('data', chunk => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', () => reject(fontError('The selected font could not be embedded.')))
    try {
      if (font?.name) doc.font(font.data, font.name)
      else if (font) doc.font(font.data)
      const lines = normalizedText.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trimEnd()
        const heading = documentType === 'resume' && line.length > 0 && line.length < 65 && /[A-Z]/.test(line) && line === line.toUpperCase()
        doc.fontSize(i === 0 ? (documentType === 'cover-letter' ? 16 : 20) : documentType === 'cover-letter' ? 11 : heading ? 11 : 10)
          .fillColor(i === 0 ? '#153e37' : '#202825')
          .text(line || ' ', { lineGap: heading ? 6 : 3 })
      }
      doc.end()
    } catch {
      doc.destroy()
      reject(fontError('The selected font could not be embedded.'))
    }
  })
}