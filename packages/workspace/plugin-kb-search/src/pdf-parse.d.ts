declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>
}