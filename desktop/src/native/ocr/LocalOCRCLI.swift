import Foundation
import Darwin

@main
enum LocalOCRCLI {
    struct Failure: Encodable { let errorCode: String }
    static func main() async {
        do {
            let args = CommandLine.arguments
            if args.count == 5, args[1] == "--learning-page" {
                guard let page = Int(args[3]), page >= 1, page <= 100_000 else { throw LocalOCR.Failure.invalidPageRange }
                let result = try LocalOCR.learningPage(url: URL(fileURLWithPath: args[2]), page: page)
                try result.pngData.write(to: URL(fileURLWithPath: args[4]), options: .withoutOverwriting)
                FileHandle.standardOutput.write(try JSONEncoder().encode(result.metadata))
                return
            }
            guard [4, 5].contains(args.count), let start = Int(args[2]), let end = Int(args[3]),
                  start >= 1, end >= start, end - start < 10, end <= 100_000 else {
                throw LocalOCR.Failure.invalidPageRange
            }
            var words: [String] = []
            if args.count == 5 {
                let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: args[4]))
                defer { try? file.close() }
                let data = try file.read(upToCount: 131_073) ?? Data()
                guard data.count <= 131_072 else { throw LocalOCR.Failure.tooLarge }
                words = try JSONDecoder().decode([String].self, from: data)
            }
            guard words.count <= 200, words.allSatisfy({ !$0.contains("\0") && $0.unicodeScalars.count <= 80 }) else { throw LocalOCR.Failure.tooLarge }
            let result = try await LocalOCR.recognize(url: URL(fileURLWithPath: args[1]), pages: start...end, customWords: words)
            FileHandle.standardOutput.write(try JSONEncoder().encode(result))
        } catch {
            let code: String
            switch error {
            case LocalOCR.Failure.invalidPageRange: code = "OCR_PAGE_RANGE"
            case LocalOCR.Failure.lockedPDF: code = "OCR_LOCKED"
            case LocalOCR.Failure.tooLarge: code = "TOO_LARGE"
            case LocalOCR.Failure.recognitionUnavailable: code = "OCR_UNAVAILABLE"
            case LocalOCR.Failure.unsupported: code = "UNSUPPORTED"
            default: code = "OCR_FAILED"
            }
            if let data = try? JSONEncoder().encode(Failure(errorCode: code)) { FileHandle.standardOutput.write(data) }
            exit(1)
        }
    }
}
