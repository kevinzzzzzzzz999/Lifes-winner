import UIKit

/// A real UITextInput surface. UIKit owns Scribble recognition; this component
/// owns only the explicit draft, fixed text size and optional idle submission.
@MainActor final class BoardWritingAidScribbleView: UIView, UITextViewDelegate, UIScribbleInteractionDelegate {
    var onCreateText: ((BoardWritingAidTextSubmission) -> Bool)?
    var onDraftChanged: ((UUID, String) -> Void)?
    var onClose: (() -> Void)?
    private(set) var draftText = ""
    private(set) var isScribbling = false
    private var token: BoardWritingAidSessionToken?
    private var boardID: UUID?
    private var settings = BoardWritingAidSettings()
    private var canEdit = false
    private var active = false
    private var draftGeneration = 0
    private var draftAnchor = CGPoint.zero
    private var sessionDrafts: [UUID: (text: String, anchor: CGPoint)] = [:]
    private var editingToken: BoardWritingAidSessionToken?
    private var idleWork: DispatchWorkItem?
    private let title = UILabel()
    private let status = UILabel()
    private let textView = UITextView()
    private let createButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private var scribbleInteraction: UIScribbleInteraction?

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "writingAid.scribble"
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 16; layer.borderWidth = 1; layer.borderColor = UIColor.separator.cgColor
        title.text = String(localized: "手写转文字")
        title.font = .preferredFont(forTextStyle: .headline)
        status.font = .preferredFont(forTextStyle: .caption1); status.textColor = .secondaryLabel; status.numberOfLines = 2
        textView.delegate = self
        textView.backgroundColor = .systemBackground
        textView.layer.cornerRadius = 8
        textView.isEditable = true; textView.isSelectable = true
        textView.accessibilityIdentifier = "writingAid.scribble.input"
        textView.accessibilityLabel = String(localized: "在此用 Apple Pencil 写字，系统会转为文字")
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        let interaction = UIScribbleInteraction(delegate: self)
        textView.addInteraction(interaction); scribbleInteraction = interaction
        createButton.setTitle(String(localized: "生成文字卡"), for: .normal)
        createButton.accessibilityIdentifier = "writingAid.scribble.create"
        createButton.addAction(UIAction { [weak self] _ in self?.submit() }, for: .touchUpInside)
        closeButton.setTitle(String(localized: "收起保留草稿"), for: .normal)
        closeButton.accessibilityIdentifier = "writingAid.scribble.close"
        closeButton.addAction(UIAction { [weak self] _ in
            self?.setActive(false); self?.onClose?()
        }, for: .touchUpInside)
        for view in [title, status, textView, createButton, closeButton] { addSubview(view) }
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    func configure(boardID: UUID, token: BoardWritingAidSessionToken, canEdit: Bool, settings: BoardWritingAidSettings,
                   color: UIColor, worldAnchor: CGPoint) {
        if self.token != token || self.canEdit != canEdit {
            cancelPendingSubmission(); editingToken = nil; textView.resignFirstResponder()
        }
        if let previousBoardID = self.boardID, previousBoardID != boardID {
            // The host receives the old draft before it changes sessions. It can
            // keep one draft per board without putting it into the ink document.
            sessionDrafts[previousBoardID] = (draftText, draftAnchor)
            onDraftChanged?(previousBoardID, draftText)
            let restored = sessionDrafts[boardID]
            draftText = restored?.text ?? ""; textView.text = draftText
            draftAnchor = restored?.anchor ?? worldAnchor
            draftGeneration += 1
            active = false; isHidden = true; textView.resignFirstResponder()
        }
        self.boardID = boardID; self.token = token; self.canEdit = canEdit; self.settings = settings.normalized
        if draftText.isEmpty { draftAnchor = worldAnchor }
        textView.font = .systemFont(ofSize: self.settings.fontSize)
        textView.textColor = color
        textView.isEditable = canEdit && active
        createButton.isEnabled = canEdit && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !canEdit { textView.resignFirstResponder() }
        updateHint()
    }

    /// Restoring a draft never submits it. The next edit or explicit Create does.
    func restoreDraft(_ text: String, worldAnchor: CGPoint) {
        cancelPendingSubmission()
        draftText = text; textView.text = text; draftAnchor = worldAnchor
        draftGeneration += 1; updateHint()
    }
    func setActive(_ active: Bool) {
        guard self.active != active else { isHidden = !active; return }
        cancelPendingSubmission()
        self.active = active; isHidden = !active
        textView.isEditable = canEdit && active
        if !active {
            isScribbling = false; editingToken = nil; textView.resignFirstResponder()
            if let boardID { onDraftChanged?(boardID, draftText) }
        }
        updateHint()
    }
    func cancelPendingSubmission() { idleWork?.cancel(); idleWork = nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        title.frame = CGRect(x: 12, y: 8, width: max(0, bounds.width - 24), height: 25)
        status.frame = CGRect(x: 12, y: 34, width: max(0, bounds.width - 24), height: 36)
        textView.frame = CGRect(x: 10, y: 74, width: max(0, bounds.width - 20), height: max(44, bounds.height - 126))
        createButton.frame = CGRect(x: 8, y: bounds.height - 48, width: max(0, bounds.width * 0.42 - 8), height: 44)
        closeButton.frame = CGRect(x: bounds.width * 0.42, y: bounds.height - 48, width: max(0, bounds.width * 0.58 - 8), height: 44)
    }
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        guard canEdit, active, let stringRange = Range(range, in: textView.text ?? "") else { return false }
        let candidate = (textView.text ?? "").replacingCharacters(in: stringRange, with: text)
        if candidate.count > 20_000 {
            status.text = String(localized: "草稿已达 20000 字，请先生成文字卡或分段书写。")
            return false
        }
        return true
    }
    func textViewDidChange(_ textView: UITextView) {
        draftText = textView.text ?? ""; draftGeneration += 1
        if let boardID { onDraftChanged?(boardID, draftText) }
        updateHint(); scheduleIfNeeded()
    }
    func textViewDidBeginEditing(_ textView: UITextView) { editingToken = token }
    func textViewDidEndEditing(_ textView: UITextView) { editingToken = nil; cancelPendingSubmission() }
    func scribbleInteraction(_ interaction: UIScribbleInteraction, shouldBeginAt location: CGPoint) -> Bool { canEdit && active }
    func scribbleInteractionWillBeginWriting(_ interaction: UIScribbleInteraction) { isScribbling = true; editingToken = token; cancelPendingSubmission() }
    func scribbleInteractionDidFinishWriting(_ interaction: UIScribbleInteraction) { isScribbling = false; scheduleIfNeeded() }

    private func scheduleIfNeeded() {
        cancelPendingSubmission()
        guard active, canEdit, settings.automaticallyCreatesText, !isScribbling, editingToken == token,
              !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              draftText.count <= 20_000, let expectedToken = token else { return }
        let expectedDraft = draftGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.canEdit, self.token == expectedToken,
                  self.draftGeneration == expectedDraft, !self.isScribbling else { return }
            self.idleWork = nil; self.submit()
        }
        idleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.pauseDuration, execute: work)
    }
    private func submit() {
        cancelPendingSubmission()
        guard active, canEdit, !isScribbling, let token else { return }
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 20_000 else { return }
        let submission = BoardWritingAidTextSubmission(token: token, text: text, fontSize: settings.fontSize,
            worldAnchor: BoardWritingAidPoint(draftAnchor))
        guard onCreateText?(submission) == true else {
            status.text = String(localized: "文字卡尚未保存，草稿已保留，请重试。")
            return
        }
        // Clear only after the host has accepted the transaction for this token.
        guard self.token == token else { return }
        draftText = ""; textView.text = ""; draftGeneration += 1
        if let boardID { onDraftChanged?(boardID, "") }; updateHint()
    }
    private func updateHint() {
        createButton.isEnabled = active && canEdit && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        status.text = settings.automaticallyCreatesText
            ? String(localized: "固定 \(Int(settings.fontSize)) 点；停顿 \(settings.pauseDuration.formatted(.number.precision(.fractionLength(1)))) 秒后生成文字卡。")
            : String(localized: "在输入框内手写；固定 \(Int(settings.fontSize)) 点。核对后点“生成文字卡”。")
    }
}
