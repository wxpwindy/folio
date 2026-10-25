import { PDFParse } from 'pdf-parse'
import { AppError } from './ai.ts'

/** Extract locally into the editable draft only; never persist the uploaded file. */
export async function extractJobDescription(buffer: Buffer, filename: string): Promise<string> {
  let text: string
  if (/\.pdf$/i.test(filename)) {
    if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new AppError(400, 'Upload a valid PDF document.')
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText({ pageJoiner: '\n' })
      if (result.total > 30) throw new AppError(400, 'This job description is too long. Use at most 30 pages and 30,000 characters.')
      text = result.text.trim()
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(400, 'This PDF could not be read. It may be damaged or password protected. Export it again or paste the job description.')
    } finally { await parser.destroy() }
  } else if (/\.txt$/i.test(filename)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim() }
    catch { throw new AppError(400, 'This text file is not UTF-8. Save it as UTF-8 or paste the job description.') }
    if ([...text].some(char => {
      const code = char.charCodeAt(0)
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127
    })) throw new AppError(400, 'Upload a plain UTF-8 text file, not a binary document.')
  } else {
    throw new AppError(400, 'Unsupported document type. Upload a PDF or UTF-8 .txt file, or paste the job description.')
  }
  if (!text) throw new AppError(400, 'This document has no selectable text. Scanned PDFs need OCR first. Paste the job description or upload a text-based document.')
  if (text.length > 30000) throw new AppError(400, 'This job description is too long. Use at most 30,000 characters.')
  return text
}