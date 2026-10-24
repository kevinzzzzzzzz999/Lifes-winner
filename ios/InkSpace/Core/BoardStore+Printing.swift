import Foundation
import SwiftUI
import CoreGraphics
import PencilKit

extension BoardStore {
    var printFrames: [BoardPrintFrame] { document.printFrames ?? [] }
    var selectedPrintFrame: BoardPrintFrame? {
        printFrames.first { $0.id == selectedPrintFrameID }
    }

    func outputSnapshot() -> BoardDocument {
        var snapshot = document
        snapshot.drawing = drawing.dataRepresentation()
        snapshot.viewport = BoardViewport(x: viewportCenter.x, y: viewportCenter.y, zoom: zoom)
        return snapshot
    }

    @discardableResult
    func appendPrintFrames(_ frames: [BoardPrintFrame]) -> Bool {
        guard canEditBoardContents, !isBusy else { return false }
        do {
            let combined = printFrames + frames
            try PrintPageGeometry.validate(frames: combined, canvasSize: document.canvasWidth)
            document.printFrames = combined
            selectedPrintFrameID = frames.first?.id
            selectedIDs = []
            showsPrintFrames = true
            mode = .paper
            printTool = .select
            changed()
            status = String(localized: "已添加 \(frames.count) 个打印框 · Letter · 页脚居中编号")
            return true
        } catch { status = error.localizedDescription; return false }
    }

    func placePrintPage(at paperOrigin: CGPoint) {
        let content = printOrientation.contentRect
        let margin = PrintPageGeometry.margin / printScale
        let page = BoardPrintFrame(x: paperOrigin.x + margin, y: paperOrigin.y + margin,
                                   width: content.width / printScale, height: content.height / printScale,
                                   orientation: printOrientation)
        _ = appendPrintFrames([page])
    }

    func capturePrintRegion(_ rect: CGRect, forExport: Bool) {
        guard PrintPageGeometry.valid(rect), rect.minX >= 0, rect.minY >= 0,
              rect.maxX <= document.canvasWidth, rect.maxY <= document.canvasHeight else {
            status = String(localized: "选区超出白板范围，请重新框选")
            return
        }
        capturedPrintRegion = rect
        capturedRegionForExport = forExport
        printTool = .select
        printRegionRequest = UUID()
    }

    func updatePrintFrame(_ frame: BoardPrintFrame) {
        guard canEditBoardContents, !isBusy else { return }
        guard let index = printFrames.firstIndex(where: { $0.id == frame.id }) else { return }
        var frames = printFrames
        frames[index] = frame
        do {
            try PrintPageGeometry.validate(frames: frames, canvasSize: document.canvasWidth)
            document.printFrames = frames
            changed()
        } catch { status = error.localizedDescription }
    }

    func resizeSelectedPrintFrame(by factor: Double) {
        guard factor.isFinite, factor > 0, var frame = selectedPrintFrame else { return }
        frame.width *= factor
        frame.height *= factor
        updatePrintFrame(frame)
    }

    func removePrintFrames(ids: Set<UUID>) {
        guard canEditBoardContents, !isBusy else { return }
        document.printFrames = printFrames.filter { !ids.contains($0.id) }
        if let selectedPrintFrameID, ids.contains(selectedPrintFrameID) { self.selectedPrintFrameID = nil }
        changed()
    }

    func movePrintFrames(from offsets: IndexSet, to destination: Int) {
        guard canEditBoardContents, !isBusy else { return }
        var frames = printFrames
        guard offsets.allSatisfy(frames.indices.contains), (0...frames.count).contains(destination) else { return }
        frames.move(fromOffsets: offsets, toOffset: destination)
        document.printFrames = frames
        changed()
    }

    func focusPrintFrame(_ frame: BoardPrintFrame) {
        mode = .paper
        printTool = .select
        selectedPrintFrameID = frame.id
        showsPrintFrames = true
        command = CanvasCommand(action: .jump(CGPoint(x: frame.rect.midX, y: frame.rect.midY),
                                              zoom: min(2, max(0.00005, 600 / frame.height))))
    }

    func printFrame(at point: CGPoint) -> BoardPrintFrame? {
        guard showsPrintFrames else { return nil }
        let frames = printFrames.reversed()
        if let content = frames.first(where: { $0.rect.contains(point) }) { return content }
        return frames.first {
            let margin = PrintPageGeometry.margin / $0.pdfScale
            return $0.rect.insetBy(dx: -margin, dy: -margin).contains(point)
        }
    }
}
