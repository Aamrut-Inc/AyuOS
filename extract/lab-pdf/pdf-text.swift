// Extracts positioned text fragments from a PDF, fully on-device.
//
// Usage: pdf-text <file.pdf>
// Prints JSON: {"pages":[{"page":1,"method":"text"|"ocr","width":W,"height":H,
//               "fragments":[{"text":"...","x":0,"y":0,"w":0,"h":0}]}]}
// Coordinates are in PDF points with the origin at the TOP-left, so callers
// can sort rows top-to-bottom and cells left-to-right.
//
// Pages with a usable text layer are read with PDFKit (exact text). Scanned
// pages (no/near-empty text layer) are rendered and OCR'd with Vision.

import Foundation
import PDFKit
import Vision

struct Fragment: Encodable { let text: String; let x: Double; let y: Double; let w: Double; let h: Double }
struct Page: Encodable { let page: Int; let method: String; let width: Double; let height: Double; let fragments: [Fragment] }
struct Output: Encodable { let pages: [Page] }

let minTextLayerChars = 20

func textLayerFragments(_ page: PDFPage) -> [Fragment] {
    let bounds = page.bounds(for: .mediaBox)
    guard let selection = page.selection(for: bounds) else { return [] }
    var fragments: [Fragment] = []
    for line in selection.selectionsByLine() {
        guard let text = line.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { continue }
        let r = line.bounds(for: page)
        fragments.append(Fragment(
            text: text,
            x: Double(r.minX - bounds.minX),
            y: Double(bounds.maxY - r.maxY),
            w: Double(r.width),
            h: Double(r.height)
        ))
    }
    return fragments
}

func ocrFragments(_ page: PDFPage) throws -> [Fragment] {
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 3
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    let image = page.thumbnail(of: size, for: .mediaBox)
    guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return [] }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false // lab values and units aren't dictionary words
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])

    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        // Vision boxes are normalized with a bottom-left origin.
        let b = observation.boundingBox
        return Fragment(
            text: candidate.string,
            x: Double(b.minX * bounds.width),
            y: Double((1 - b.maxY) * bounds.height),
            w: Double(b.width * bounds.width),
            h: Double(b.height * bounds.height)
        )
    }
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: pdf-text <file.pdf>\n".data(using: .utf8)!)
    exit(2)
}
guard let document = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
    FileHandle.standardError.write("could not open PDF\n".data(using: .utf8)!)
    exit(1)
}
if document.isLocked {
    FileHandle.standardError.write("PDF is password-protected\n".data(using: .utf8)!)
    exit(1)
}

var pages: [Page] = []
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let textLayer = textLayerFragments(page)
    let chars = textLayer.reduce(0) { $0 + $1.text.count }
    let useOcr = chars < minTextLayerChars
    let fragments = useOcr ? try ocrFragments(page) : textLayer
    pages.append(Page(
        page: index + 1,
        method: useOcr ? "ocr" : "text",
        width: Double(bounds.width),
        height: Double(bounds.height),
        fragments: fragments
    ))
}

let encoder = JSONEncoder()
FileHandle.standardOutput.write(try encoder.encode(Output(pages: pages)))
