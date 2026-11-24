import Foundation
import UIKit
import Vision

/// Apple Vision text recognition for DuitfulKit.recognizeText (since 1.64).
///
/// iPhone and iPad used to read receipts, statement pages, EA forms and alert
/// screenshots with Google's ML Kit (a ~20 MB pod) and kept Tesseract's wasm
/// (another ~20 MB) as the fallback. Vision is built into iOS, runs on the
/// device, needs no model download and no AI, and reads phone photos at least
/// as well. Nothing is uploaded.
///
/// The JS layer (`nativeTextReader()` / `mlkitWordsFromResult()` in
/// app/script.js) already understands ML Kit's result, so this answers in
/// exactly that shape, in image pixels with a top-left origin:
///
///   { text, blocks: [{ text, boundingBox: {left, top, right, bottom},
///                      cornerPoints, recognizedLanguage,
///                      lines: [{ ...same, elements: [{ ...same }] }] }] }
///
/// Vision reports one observation per line, with a normalised box whose
/// origin is bottom-left. Each observation becomes one block holding one line;
/// the words become elements, each with its own box. The JS rebuilds rows from
/// the words, so how lines are grouped into blocks does not matter.
enum DuitfulTextReader {
    /// Wanted languages, in priority order. Only the ones this iOS version
    /// supports are passed (Vision has no Malay model; Malay is Latin script,
    /// which the English model reads, minus the dictionary correction).
    static let wantedLanguages = ["en-US", "ms-MY", "zh-Hans"]

    struct Failure: Error {
        let message: String
        let code: String
    }

    static func recognize(base64: String, rotation: Int, languageCorrection: Bool,
                          completion: @escaping (Result<[String: Any], Failure>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            var body = base64
            if body.hasPrefix("data:"), let comma = body.firstIndex(of: ",") {
                body = String(body[body.index(after: comma)...])
            }
            guard let data = Data(base64Encoded: body, options: .ignoreUnknownCharacters),
                  let image = UIImage(data: data),
                  let cgImage = upright(image) else {
                completion(.failure(Failure(message: "Unable to read the image", code: "IMAGE")))
                return
            }
            let orientation = cgOrientation(rotation)
            // Normalised boxes are relative to the image as Vision sees it,
            // i.e. after the orientation is applied: a quarter turn swaps the sides.
            let quarter = orientation == .left || orientation == .right
            let width = CGFloat(quarter ? cgImage.height : cgImage.width)
            let height = CGFloat(quarter ? cgImage.width : cgImage.height)

            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            // Off by default: the correction is an English dictionary, and it
            // "fixes" Malay item names (TEH → THE) and codes on receipts.
            request.usesLanguageCorrection = languageCorrection
            if let supported = try? request.supportedRecognitionLanguages() {
                let langs = wantedLanguages.filter { supported.contains($0) }
                if !langs.isEmpty { request.recognitionLanguages = langs }
            }

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            do {
                try handler.perform([request])
            } catch {
                completion(.failure(Failure(message: error.localizedDescription, code: "VISION")))
                return
            }
            let observations = request.results ?? []
            var blocks: [[String: Any]] = []
            var lines: [String] = []
            for obs in observations {
                guard let best = obs.topCandidates(1).first else { continue }
                let string = best.string
                if string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
                let lineRect = pixelRect(obs.boundingBox, width, height)
                let elements = words(in: best, lineRect: lineRect, width: width, height: height)
                let lang = languageTag(for: string)
                let line: [String: Any] = [
                    "text": string,
                    "boundingBox": box(lineRect),
                    "cornerPoints": corners(lineRect),
                    "recognizedLanguage": lang,
                    "elements": elements,
                ]
                blocks.append([
                    "text": string,
                    "boundingBox": box(lineRect),
                    "cornerPoints": corners(lineRect),
                    "recognizedLanguage": lang,
                    "lines": [line],
                ])
                lines.append(string)
            }
            completion(.success(["text": lines.joined(separator: "\n"), "blocks": blocks]))
        }
    }

    /// The words of one line, each with its own pixel box. Vision gives a box
    /// for any range of the string; when it can't, or hands back the whole
    /// line for a single word (older iOS on .accurate), the word's share of
    /// the line is measured by its character offsets instead.
    private static func words(in text: VNRecognizedText, lineRect: CGRect,
                              width: CGFloat, height: CGFloat) -> [[String: Any]] {
        let string = text.string
        var ranges: [Range<String.Index>] = []
        var i = string.startIndex
        while i < string.endIndex {
            while i < string.endIndex, string[i].isWhitespace { i = string.index(after: i) }
            guard i < string.endIndex else { break }
            var j = i
            while j < string.endIndex, !string[j].isWhitespace { j = string.index(after: j) }
            ranges.append(i..<j)
            i = j
        }
        let total = max(1, string.count)
        var out: [[String: Any]] = []
        for r in ranges {
            var rect: CGRect? = nil
            if let obs = try? text.boundingBox(for: r) {
                let candidate = pixelRect(obs.boundingBox, width, height)
                let wholeLine = ranges.count > 1 && candidate.width >= lineRect.width * 0.95
                if candidate.width > 0, candidate.height > 0, !wholeLine { rect = candidate }
            }
            if rect == nil {
                let start = CGFloat(string.distance(from: string.startIndex, to: r.lowerBound)) / CGFloat(total)
                let end = CGFloat(string.distance(from: string.startIndex, to: r.upperBound)) / CGFloat(total)
                rect = CGRect(x: lineRect.minX + lineRect.width * start, y: lineRect.minY,
                              width: lineRect.width * (end - start), height: lineRect.height)
            }
            guard let wordRect = rect else { continue }
            out.append([
                "text": String(string[r]),
                "boundingBox": box(wordRect),
                "cornerPoints": corners(wordRect),
                "recognizedLanguage": languageTag(for: String(string[r])),
            ])
        }
        return out
    }

    /// Normalised, bottom-left origin → pixels, top-left origin.
    private static func pixelRect(_ r: CGRect, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        let x0 = max(0, min(1, r.minX)) * width
        let x1 = max(0, min(1, r.maxX)) * width
        let top = (1 - max(0, min(1, r.maxY))) * height
        let bottom = (1 - max(0, min(1, r.minY))) * height
        return CGRect(x: x0, y: top, width: max(0, x1 - x0), height: max(0, bottom - top))
    }

    private static func box(_ r: CGRect) -> [String: Any] {
        ["left": Double(r.minX), "top": Double(r.minY), "right": Double(r.maxX), "bottom": Double(r.maxY)]
    }

    private static func corners(_ r: CGRect) -> [String: Any] {
        [
            "topLeft": ["x": Double(r.minX), "y": Double(r.minY)],
            "topRight": ["x": Double(r.maxX), "y": Double(r.minY)],
            "bottomRight": ["x": Double(r.maxX), "y": Double(r.maxY)],
            "bottomLeft": ["x": Double(r.minX), "y": Double(r.maxY)],
        ]
    }

    /// ML Kit names a language per node; Vision doesn't. Han characters → zh,
    /// anything else → "" (unknown), which is what ML Kit sends for Latin too
    /// often enough that nothing in the JS reads it.
    private static func languageTag(for s: String) -> String {
        s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? "zh" : ""
    }

    private static func cgOrientation(_ rotation: Int) -> CGImagePropertyOrientation {
        // Same meaning as ML Kit's `rotation`: the image's counter-clockwise
        // turn in degrees.
        switch ((rotation % 360) + 360) % 360 {
        case 90: return .left
        case 180: return .down
        case 270: return .right
        default: return .up
        }
    }

    /// A CGImage with the pixels the right way up. Canvas JPEGs and the
    /// scanner's pages already are; a photo carrying EXIF orientation is
    /// redrawn so the boxes match what the JS drew.
    private static func upright(_ image: UIImage) -> CGImage? {
        if image.imageOrientation == .up, let cg = image.cgImage { return cg }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return image.cgImage }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return drawn.cgImage
    }
}

/// Dates in text for DuitfulKit.extractEntities on iOS, with Foundation's
/// NSDataDetector (no model, no download). Until 1.64 this was ML Kit Entity
/// Extraction; on iPhone its only job was a receipt's date when the parser
/// found none (iPhones don't see bank alerts), so money is no longer read.
enum DuitfulDateReader {
    static func dates(in text: String) -> [[String: Any]] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue) else {
            return []
        }
        let ns = text as NSString
        var out: [[String: Any]] = []
        detector.enumerateMatches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) { match, _, _ in
            guard let match = match, let date = match.date else { return }
            let snippet = ns.substring(with: match.range)
            out.append([
                "text": snippet,
                "start": match.range.location,
                "end": NSMaxRange(match.range),
                "timestamp": Int64(date.timeIntervalSince1970 * 1000),
                "hasDay": hasDay(snippet),
            ])
        }
        return out
    }

    /// NSDataDetector fills in a missing day ("Nov 2026" → the 1st) without
    /// saying so. A receipt date names its day: two numbers ("24/11/26"), or a
    /// number of at most two digits beside a month name ("24 Nov 2026").
    static func hasDay(_ s: String) -> Bool {
        let groups = s.split(whereSeparator: { !$0.isNumber }).map(String.init)
        if groups.count >= 3 { return true }
        let months = ["jan", "feb", "mac", "mar", "apr", "may", "mei", "jun", "jul", "ogo", "aug", "sep", "okt", "oct", "nov", "dis", "dec"]
        let lower = s.lowercased()
        let hasMonthName = months.contains { lower.contains($0) }
        return hasMonthName && groups.contains { $0.count <= 2 }
    }
}
