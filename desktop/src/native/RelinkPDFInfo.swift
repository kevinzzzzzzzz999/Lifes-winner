import Foundation
import CoreGraphics

// The parent passes an already-open, read-only descriptor as fd 3. CoreGraphics
// reads the PDF on demand; never create Data(contentsOf:) for a course-sized PDF.
let url = URL(fileURLWithPath: "/dev/fd/3")
guard let provider = CGDataProvider(url: url as CFURL), let pdf = CGPDFDocument(provider) else {
    print("{\"error\":\"INTEROP_INVALID_CONTENT\"}")
    exit(1)
}
if pdf.isEncrypted && !pdf.isUnlocked {
    print("{\"error\":\"INTEROP_ENCRYPTED\"}")
    exit(1)
}
let count = pdf.numberOfPages
guard count > 0 else {
    print("{\"error\":\"RELINK_PAGE_MISSING\"}")
    exit(1)
}
print("{\"pageCount\":\(count)}")
