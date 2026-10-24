export type AIWebProviderID = 'chatgpt'|'deepseek'|'claude'|'gemini';
export type AIWebProvider = {id:AIWebProviderID;label:string;url:string;pasteMode:'composer'|'manual'};
export type AIWebSettings = {provider:AIWebProviderID;providers:AIWebProvider[];storageIssue:boolean};
export type AIWebStatus = {audioPermission?:'prompting'|'granted'|'system-denied'|'system-restricted'|'cancelled'|'unavailable';provider:AIWebProviderID;label:string;pasteMode:'composer'|'manual';visible:boolean;loading:boolean;loadError:boolean;loadTimedOut?:boolean;pageState?:'idle'|'loading'|'ready'|'failed'|'closed'|'crashed'|'unresponsive';url:string;download?:{id:string;state:'saving'|'completed'|'cancelled'|'failed';filename:string}};
import type {StudyDelimiter,StudyImportPreview,StudyImportResult,StudyExportResult} from './study-transfer';
import type {StudyEvent,StudyProjection} from './study';
export type FilePreparationProgress = {phase:'idle'|'scanning'|'preparing'|'checking'|'moving';completed:number;total:number;currentPath?:string;cancellable:boolean};
import type {ExtendEvent,ExtendProjection,PDFNativeInkArchive} from './pdf-extend';
export type LocalOCRResult = {id:string;sourcePath:string;sourceSHA256:string;pageCount:number;requestedPages:number[];pages:Array<{page:number;text:string;error?:string;boxes?:Array<{text:string;x:number;y:number;width:number;height:number;rotation?:number}>}>;cancelled:boolean;outputLimited:boolean};
import type {MediaSource,MediaProject,MediaEditorEvent} from './media-editor';
export type {MediaSource,MediaClip,MediaProject,MediaEditorEvent,MediaOverlay,MediaCaption,MediaCaptionStyle} from './media-editor';
export type BoardClipboardSnapshot={text:string;html:string;image?:{dataURL:string;width:number;height:number};files?:Array<{token:string;name:string}>;warnings:string[]};
export type BoardPasteContent={text?:{text:string;title?:string;richTextHTML?:string;textFormat?:BoardTextFormat|'web';url?:string;width?:number;height?:number};images?:Array<{dataURL:string;title?:string}>;files?:Array<{token:string;name:string}>};
export type TranslationProvider='openai'|'deepseek'|'gemini';
export type TranslationInfo={hasKey:boolean;available:boolean;locked:boolean;hasStoredSettings:boolean;provider:TranslationProvider;model:string;providers:Array<{id:TranslationProvider;label:string;hasKey:boolean;model:string;endpoint:string}>};
export type PDFLayer={id:string;name:string;visible:boolean;locked:boolean;order:number};
export type PDFLayerAnnotation={id:string;layerID:string;sourceSHA256:string;page:number;kind:'ink'|'highlight'|'text';color:string;width:number;points:Array<[number,number]>;rect:{x:number;y:number;width:number;height:number};text:string;nativeInk?:PDFNativeInkArchive};
export type PDFLayerRecord={schemaVersion:1;id:string;createdAt:string}&({kind:'layer';layer:PDFLayer}|{kind:'annotation';annotation:PDFLayerAnnotation}|{kind:'deleteLayer'|'deleteAnnotation';targetID:string});
export type PDFLayerProjection={sourceSHA256:string;assetUrl:string;layers:PDFLayer[];annotations:PDFLayerAnnotation[];annotationTimes?:Record<string,string>;warnings:string[]};
export type PDFTranslationExportRequest={vaultId:string;path:string;sourceSHA256:string;target:'zh-Hans'|'en';provider:TranslationProvider;model:string;range:{from:number;to:number};pages:Array<{page:number;text:string}>;omittedPages:number[];status:'complete'|'cancelled'|'failed'};
import type {VideoPlaybackState} from './video-playback';
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type Vault = { id: string; name: string; recentId?: string };
export type ExternalOpenRequest={id:string;vault:Vault;path:string;error?:never}|{id:string;error:{code:string;message:string};vault?:never;path?:never};
export type RecentVault = { id: string; name: string; lastOpenedAt: string };
export type FileKind = 'folder' | 'board' | 'text' | 'media' | 'docx' | 'pptx' | 'spreadsheet' | 'video' | 'unsupported';
export type VaultEntry = { name: string; path: string; kind: FileKind; bytes: number };
export type DirectoryListing = { path: string; parent: string | null; entries: VaultEntry[]; warnings: string[] };
export type VideoSubtitleAssociation = {name:string;text:string;enabled:boolean};
export type VideoSubtitleResult = {subtitle:VideoSubtitleAssociation|null;sha256:string|null;backupId?:string};
export type VideoSource = {url:string;path:string;name:string;bytes:number;mime:string;/** Metadata identity, not a content digest. */version:string};
export type FileRequest = { vaultId: string; path: string };
export type VaultWatchStatus = { watchId: string; vaultId: string; mode: 'native' | 'manual'; limited: boolean };
export type VaultChangeEvent = { watchId: string; vaultId: string; sequence: number; paths: string[]; rescan: boolean; reviewsChanged: boolean; reason: 'change' | 'unavailable' | 'limit' | 'poll' | 'resume' | 'unlock' };

export type OpenedFile = {
  path: string; name: string; kind: Exclude<FileKind, 'folder' | 'unsupported' | 'video'>;
  sha256: string; bytes: number; text?: string; board?: Record<string, unknown>;
  assetUrl?: string; html?: string; warnings?: string[];
  encoding?: { bom: boolean; newline: 'lf' | 'crlf' | 'mixed' };
};
export type PythonEvent = {
  runId: string; kind: 'stdout' | 'stderr' | 'exit'; text?: string;
  exitCode?: number | null; signal?: string | null;
  reason?: 'completed' | 'cancelled' | 'timeout' | 'output_limit' | 'failed';
};
export type NotebookOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { output_type: 'execute_result' | 'display_data'; data: Record<string, unknown>; metadata: Record<string, unknown>; execution_count?: number | null }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };
export type NotebookEvent = {
  vaultId: string; path: string; kernelId: string; runId: string;
  kind: 'cell-start' | 'output' | 'clear-output' | 'cell-end' | 'run-end';
  cellIndex?: number; executionCount?: number; output?: NotebookOutput; wait?: boolean;
  status?: 'ok' | 'error'; reason?: 'completed' | 'error' | 'cancelled' | 'timeout' | 'output_limit' | 'memory_limit' | 'closed' | 'restarted' | 'failed';
  kernelAlive?: boolean;
};
export type NotebookRuntimeInfo = { available: boolean; pythonVersion: string; engine: 'IPython'; packages: Record<string,string>; maxKernelCount: number; timeoutSeconds: number; sandboxed: false };
export type DiagnosticReport = { schemaVersion: number; storageIssue: boolean; events: Array<{ operation: string; code: string; count: number; firstAt: string; lastAt: string }> };
export type NoteSearchResult = { path: string; name: string; snippet: string; tags: string[] };
export type NoteSearchResponse = { results: NoteSearchResult[]; truncated: boolean; warnings: string[]; scannedFiles: number };
export type NoteLink = { label: string; target?: string; path?: string; ambiguous?: boolean };
export type NoteLinksResponse = { outgoing: NoteLink[]; backlinks: Array<{ path: string; name: string; snippet: string }>; tags: string[]; truncated: boolean; warnings: string[]; scannedFiles: number };
export type KnowledgeGraphResponse = { nodes: Array<{ id: string; path: string; label: string }>; edges: Array<{ from: string; to: string }>; truncated: boolean; warnings: string[] };
export type BoardEdgeStyle = {strokeColor:string;strokeWidth:number;arrow:'none'|'end'|'both';dash?:'solid'|'dashed'|'dotted'|'dashDot';opacity?:number};
export type BoardChildPresentation={expanded:boolean;x:number;y:number;width:number;height:number;viewport?:{x:number;y:number;zoom:number}};
export type BoardChildLink={id:string;path:string;title:string;presentation?:BoardChildPresentation};
export type BoardHistoryState={canUndo:boolean;canRedo:boolean;warning?:string};
export type BoardRelinkProgress={active:boolean;phase:'checking'|'hashing'|'metadata'|'saving'|'done'|'cancelled'|'failed';bytesDone:number;bytesTotal:number;cancellable:boolean};
export type BoardRelinkPreview={id:string;field:'sourcePath'|'originalSourcePath';oldPath:string;candidatePath:string;oldFullPath:string;candidateFullPath:string;candidateSHA256:string;bytes:number;pageCount?:number;page:number;fingerprintMatched:boolean;affectedCount:number;previewUnavailable?:boolean;previewURL?:string};
export type BoardSourceResolution={path:string;match:'direct'|'root-prefix'|'board-relative';sha256?:string;fingerprintMatched:boolean};
export type BoardElementStyle = { fillColor: string; strokeColor: string; textColor: string; fontSize: number; shape: 'rectangle' | 'rounded' | 'ellipse'; strokeWidth: number };
export type BoardItemPatch = { id: string; x?: number; y?: number; width?: number; height?: number; title?: string; text?: string; url?: string; textFormat?: BoardTextFormat|'web'; style?: Partial<BoardElementStyle> | null };
export type BoardOperation =
  | {type:'relinkSource';id:string;field:'sourcePath'|'originalSourcePath';oldPath:string;candidatePath:string;candidateSHA256:string;confirmed:true;requestId:string}
  | {type:'remove';ids:string[]}
  | {type:'setChildBoards';id:string;links:BoardChildLink[]}
  | {type:'setChildBoardPresentations';updates:Array<{id:string;childID:string;presentation:BoardChildPresentation}>}
  | {type:'addChildBoardCard';link:BoardChildLink;x:number;y:number}
  | { type: 'move'; ids: string[]; dx: number; dy: number }
  | { type: 'patchItems'; items: BoardItemPatch[] }
  | { type: 'frameInk'; rect: { x: number; y: number; width: number; height: number }; title?: string }
  | { type: 'unpackInk'; ids: string[] }
  | { type: 'expandDocument'; id: string; direction: 'vertical' | 'horizontal' | 'grid' | 'onenote'; scale: number; x?: number; y?: number; columns?: number }
  | { type: 'collapseDocument'; id: string }
  | { type: 'connect'; ids: string[] };
export type BoardMutationResult = OpenedFile & { backupId?: string; selectedIDs?: string[]; history?:BoardHistoryState; unchanged?: boolean };
export type BoardMergeCounts={items:number;edges:number;pins:number;printFrames:number;nativeStrokes:number;webStrokes:number;tapes:number;reviews:number;studyEvents:number};
export type BoardMergeRequest=FileRequest & {expectedSHA256:string;sourcePath:string;expectedSourceSHA256:string;direction?:'below'|'right';position?:{x:number;y:number};mode?:'intoTarget'|'newCopy';newPath?:string};
export type BoardMergeInspectionRequest=Pick<BoardMergeRequest,'vaultId'|'path'|'expectedSHA256'|'sourcePath'|'expectedSourceSHA256'>;
export type BoardMergeInspection={sourceBounds:CaptureRect;targetBounds:CaptureRect|null;sourceCounts:BoardMergeCounts;expectedSHA256:string;expectedSourceSHA256:string};
export type BoardMergeResult=BoardMutationResult & {mode:'intoTarget'|'newCopy';sourcePath:string;sourceSHA256:string;translation:{dx:number;dy:number};sourceBounds:CaptureRect;outputBounds:CaptureRect;focusRect:CaptureRect|null;mergedCounts:BoardMergeCounts;journalID:string;recoveryRecordPath:string;preMergeBackupId:string};
export type BoardMergeUndoResult=BoardMutationResult & {journalID:string;undone:true;alreadyUndone:boolean;removedMergedPath?:string;recoveryRecordPath:string;warnings?:string[]};
export type CaptureRect = { x: number; y: number; width: number; height: number };
export type ReviewRecord = {
  style?: 'comment'|'highlight'; strokeWidth?: number;
  schemaVersion: 1; id: string; boardPath: string; boardID: string; createdAt: string;
  comment: string; color: string; rect: CaptureRect; points: Array<[number, number]>;
  anchor?: { itemID: string; sourcePath?: string; originalSourcePath?: string; page?: number; rect: CaptureRect };
  sourceSHA256?: string;
};
export type ReviewListResponse = { reviews: ReviewRecord[]; warnings: string[]; truncated: boolean };
export type BoardTextFormat = 'richText' | 'markdown' | 'latex' | 'python';
export type EditableDocumentBlock = { kind: 'paragraph' | 'heading' | 'bullet'; text: string };
export type EditableDocumentModel = {
  version: 1; format: 'docx' | 'pptx' | 'pdf'; title: string;
  blocks: EditableDocumentBlock[];
  slides?: Array<{ title: string; blocks: EditableDocumentBlock[] }>;
};
export type EditableDocumentResponse = {
  editable: boolean; document?: EditableDocumentModel; opened: OpenedFile;
  reason?: 'external_or_modified'; warnings: string[];
};
export type SavedDocumentResponse = EditableDocumentResponse & { editable: true; document: EditableDocumentModel; backupId: string };

export type FileMoveResult = { moved: Array<{from:string;to:string}>; updatedReferences:number; warnings:string[] };
export type TrashEntry = { id:string;createdAt:string;entries:Array<{originalPath:string;storedName:string}>;status:string;state?:string };
export type LastInkLocationResult={location:CaptureRect|null;source:'saved'|'native'|'preview'|'none'|'unavailable';boardID:string;sha256:string};
export type BrowserTarget={vaultId:string;parentPath:string;boardPath?:string};
export type CalendarReminderSchedule={eventId:string;occurrenceStart:string;minutes:number;fireAt:number;title:string;body:string};
export type CalendarReminderStatus={status:'idle'|'scheduled'|'unsupported'|'suppressed'|'error';scheduled:number;permission:'system-managed';error?:string};
export type CalendarReminderOpen={vaultId:string;vault?:Vault;eventId:string;occurrenceStart:string};
export type NoteExchangeApp='boardnotes'|'goodnotes'|'notability'|'onenote'|'other';
export type NoteExchangeItem={name:string;path?:string;status:'imported'|'archive'|'exported'|'failed';readable:boolean;bytes?:number;sha256?:string;sourceSHA256?:string;archivePath?:string;manifestPath?:string;report?:{currentStrokes:number;historyFiles:number;assets:number;objects?:number;notes?:string[];unsupported?:string[]};recovery?:{id:string;phase?:string;reason?:string;rollback?:string;committed:boolean;recordSaved:boolean;recordPath?:string;retainedTemporaryDirectory?:string};note?:string;error?:{code:string;message:string}};
export type NoteExchangeResult={cancelled:boolean;results:NoteExchangeItem[];folderName?:string};
export interface DesktopAPI {
 importNoteExchange(request:{vaultId:string;parentPath:string;source:NoteExchangeApp}):Promise<ApiResult<NoteExchangeResult>>;
 exportNoteExchange(request:{vaultId:string;paths:string[];target:NoteExchangeApp;mode:'original'|'outline'}):Promise<ApiResult<NoteExchangeResult>>;
 importNoteOutline(request:FileRequest&{expectedSHA256:string}):Promise<ApiResult<{path:string;nodeCount:number}>>;

  readCalendarFile(request:{vaultId:string}):Promise<ApiResult<OpenedFile|null>>;
  importCalendarICS():Promise<ApiResult<{name:string;text:string}|null>>;
  exportCalendarICS(request:{name:string;text:string}):Promise<ApiResult<{saved:boolean}>>;
  scheduleCalendarReminders(request:{vaultId:string;enabled:boolean;schedules:CalendarReminderSchedule[]}):Promise<ApiResult<CalendarReminderStatus>>;
  calendarReminderStatus():Promise<ApiResult<CalendarReminderStatus>>;
  consumeCalendarReminder():Promise<ApiResult<CalendarReminderOpen|null>>;
  onCalendarReminder(callback:(event:CalendarReminderOpen)=>void):()=>void;
  onCalendarReminderStatus(callback:(event:CalendarReminderStatus)=>void):()=>void;
  mediaEditorInfo():Promise<ApiResult<{available:boolean;reason?:string}>>;
  mediaEditorImport(request:{vaultId:string}):Promise<ApiResult<{sources:MediaSource[];canceled:boolean}>>;
  mediaEditorOpen(request:{vaultId:string;path?:string}):Promise<ApiResult<{project:MediaProject;path:string;sha256:string}|null>>;
  mediaEditorSave(request:{vaultId:string;path?:string;expectedSHA256?:string;project:MediaProject}):Promise<ApiResult<{path:string;sha256:string}|null>>;
  mediaEditorPreview(request:{vaultId:string;sourceID:string;path:string}):Promise<ApiResult<{url:string;token:string}>>;
  mediaEditorCompositionPreview(request:{vaultId:string;project:MediaProject}):Promise<ApiResult<{jobId:string}>>;
  mediaEditorImportCaptions(request?:Record<string,never>):Promise<ApiResult<{name:string;text:string}|null>>;
  mediaEditorRelease(request:{token:string}):Promise<ApiResult<{released:true}>>;
  mediaEditorExport(request:{vaultId:string;project:MediaProject}):Promise<ApiResult<{jobId:string}|null>>;
  mediaEditorCancel(request:{jobId:string}):Promise<ApiResult<{cancelled:boolean}>>;
  onMediaEditorEvent(callback:(event:MediaEditorEvent)=>void):()=>void;
  openBrowser(request?:BrowserTarget|Record<string,never>):Promise<ApiResult<{opened:boolean}>>;
  importBrowserClip(request:BrowserTarget):Promise<ApiResult<{path:string;kind:string;imagePath?:string;warning?:string}|null>>;
  readBoardClipboard(request?:Record<string,never>):Promise<ApiResult<BoardClipboardSnapshot>>;
  pasteBoardContent(request:FileRequest & {expectedSHA256:string;content:BoardPasteContent;x:number;y:number}):Promise<ApiResult<BoardMutationResult>>;
 translationInfo():Promise<ApiResult<TranslationInfo>>;
 unlockTranslation():Promise<ApiResult<TranslationInfo>>;
 setTranslationKey(request:{key:string|null;provider?:TranslationProvider}):Promise<ApiResult<TranslationInfo>>;
 setTranslationModel(request:{model:string;provider?:TranslationProvider}):Promise<ApiResult<TranslationInfo>>;
 setTranslationProvider(request:{provider:TranslationProvider}):Promise<ApiResult<TranslationInfo>>;
 translateSelection(request:{requestId:string;target:'zh-Hans'|'en';provider?:TranslationProvider;imageDataURL?:string;text?:string;purpose?:'selection'|'page';expectedModel?:string}):Promise<ApiResult<{text:string;provider:TranslationProvider;model:string}>>;
 cancelTranslation(request:{requestId:string}):Promise<ApiResult<{cancelled:boolean}>>;
 getLastInkLocation(request:FileRequest&{expectedSHA256:string}):Promise<ApiResult<LastInkLocationResult>>;
 openVideoWindow(request:FileRequest&{playback?:VideoPlaybackState}):Promise<ApiResult<{opened:boolean}>>;
 videoWindowInfo():Promise<ApiResult<{vaultId:string;path:string;pinned:boolean;playback?:VideoPlaybackState}|null>>;
 setVideoWindowPinned(request:{pinned:boolean}):Promise<ApiResult<{pinned:boolean}>>;
  openOriginal(request:FileRequest&{application:"default"|"choose"}):Promise<ApiResult<{opened:boolean}>>;
  boardHistoryState(request:FileRequest):Promise<ApiResult<BoardHistoryState>>;
  undoBoard(request:FileRequest&{expectedSHA256:string}):Promise<ApiResult<BoardMutationResult>>;
  redoBoard(request:FileRequest&{expectedSHA256:string}):Promise<ApiResult<BoardMutationResult>>;
  getFolderOrder(request:FileRequest):Promise<ApiResult<{paths:string[]}>>;
  setFolderOrder(request:FileRequest&{paths:string[]}):Promise<ApiResult<{paths:string[]}>>;
  moveFiles(request:{vaultId:string;paths:string[];targetPath:string}):Promise<ApiResult<FileMoveResult>>;
  getFilePreparationProgress(request:{vaultId:string}):Promise<ApiResult<FilePreparationProgress>>;
  cancelFilePreparation(request:{vaultId:string}):Promise<ApiResult<{cancelled:boolean}>>;
  renameFiles(request:FileRequest&{name:string}):Promise<ApiResult<FileMoveResult>>;
  revealInFinder(request:FileRequest):Promise<ApiResult<{revealed:boolean}>>;
  copyFileReference(request:FileRequest&{kind:"path"|"link"}):Promise<ApiResult<{copied:boolean}>>;
  trashFiles(request:{vaultId:string;paths:string[]}):Promise<ApiResult<{id:string;trashed:string[];warnings:string[]}>>;
  listTrash(request:{vaultId:string}):Promise<ApiResult<{entries:TrashEntry[];warnings:string[]}>>;
  restoreTrash(request:{vaultId:string;id:string}):Promise<ApiResult<{restored:string[];updatedReferences:number;warnings:string[]}>>;
  shareFiles(request:{vaultId:string;paths:string[]}):Promise<ApiResult<{opened:boolean}>>;
  mergeBoards(request:BoardMergeRequest):Promise<ApiResult<BoardMergeResult>>;
  inspectBoardMerge(request:BoardMergeInspectionRequest):Promise<ApiResult<BoardMergeInspection>>;
  undoBoardMerge(request:FileRequest&{expectedSHA256:string;journalID:string}):Promise<ApiResult<BoardMergeUndoResult>>;
  mutateBoard(request: FileRequest & { expectedSHA256: string; operation: BoardOperation }): Promise<ApiResult<BoardMutationResult>>;
  prepareBoardRelink(request:FileRequest & {expectedSHA256:string;id:string;field:'sourcePath'|'originalSourcePath';candidatePath:string;requestId:string}):Promise<ApiResult<BoardRelinkPreview>>;
  resolveBoardSource(request:{vaultId:string;boardPath:string;expectedBoardSHA256:string;sourcePath:string}):Promise<ApiResult<BoardSourceResolution>>;
  getBoardRelinkProgress(request:{vaultId:string;requestId:string}):Promise<ApiResult<BoardRelinkProgress>>;
  cancelBoardRelink(request:{vaultId:string;requestId:string}):Promise<ApiResult<{cancelled:boolean}>>;
  setBoardSpeechActive(request:{active:boolean}):Promise<ApiResult<{active:boolean}>>;
  recognizeBoardText(request:{requestId:string;imageDataURL:string;customWords?:string[]}):Promise<ApiResult<LocalOCRResult>>;
  copyBoardText(request:{text:string}):Promise<ApiResult<{copied:boolean}>>;
  localOCRInfo():Promise<ApiResult<{available:boolean;maxPages:number;pdfMiB:number;imageMiB:number;timeoutSeconds:number}>>;
  recognizeLocalOCR(request:{vaultId:string;path:string;requestId:string;startPage:number;endPage:number}):Promise<ApiResult<LocalOCRResult>>;
  cancelLocalOCR(request:{requestId:string}):Promise<ApiResult<{cancelled:boolean}>>;
  copyLocalOCR(request:{vaultId:string;path:string;resultId:string}):Promise<ApiResult<{copied:boolean}>>;
  saveLocalOCR(request:{vaultId:string;path:string;resultId:string}):Promise<ApiResult<OpenedFile & {backupId:string}>>;
  latexInfo(): Promise<ApiResult<{ available: boolean }>>;
  compileLatex(request: FileRequest & { expectedSHA256: string }): Promise<ApiResult<{ path: string | null; log: string }>>;
  createDocument(request: { vaultId: string; parentPath: string; name: string; document: EditableDocumentModel }): Promise<ApiResult<SavedDocumentResponse>>;
  readEditableDocument(request: FileRequest): Promise<ApiResult<EditableDocumentResponse>>;
  saveDocument(request: FileRequest & { expectedSHA256: string; document: EditableDocumentModel }): Promise<ApiResult<SavedDocumentResponse>>;
  watchVault(request: { vaultId: string }): Promise<ApiResult<VaultWatchStatus>>;
  unwatchVault(request: { watchId: string }): Promise<ApiResult<{ stopped: boolean }>>;
  onVaultChange(callback: (event: VaultChangeEvent) => void): () => void;
  addBoardFileCards(request: FileRequest & { expectedSHA256: string; sourcePaths: string[]; x: number; y: number }): Promise<ApiResult<BoardMutationResult>>;
  addBoardFileCard(request: FileRequest & { expectedSHA256: string; sourcePath: string; x: number; y: number }): Promise<ApiResult<OpenedFile & { backupId: string; itemId: string }>>;

  listReviews(request: FileRequest): Promise<ApiResult<ReviewListResponse>>;
  deleteReview(request: { vaultId: string; id: string }): Promise<ApiResult<{ deleted: true; id: string }>>;
  createReview(request: { vaultId: string; review: ReviewRecord }): Promise<ApiResult<{ review: ReviewRecord; backupId: string }>>;

  aiWebSettings(): Promise<ApiResult<AIWebSettings>>;
  setAIWebProvider(request:{provider:AIWebProviderID}): Promise<ApiResult<AIWebSettings>>;
  onAIWebProviderChanged(callback:(settings:AIWebSettings)=>void): ()=>void;
  aiSetVisible(request: { visible: boolean; bounds?: CaptureRect }): Promise<ApiResult<{ visible: boolean }>>;
  aiStatus(): Promise<ApiResult<AIWebStatus>>;
  aiReload(): Promise<ApiResult<{ reloading: boolean }>>;
  captureSelection(request: { rect: CaptureRect }): Promise<ApiResult<{ dataURL: string; width: number; height: number }>>;
  aiDragImage(request: { dataURL: string; provider: AIWebProviderID }): Promise<ApiResult<{ dragStarted: true }>>;
  aiPasteImage(request: { dataURL: string; provider: AIWebProviderID; copyOnly?: boolean }): Promise<ApiResult<{ copied: boolean; pasteAttempted: boolean; attachmentConfirmed: boolean; reason?: 'unsupported' | 'providerChanged' | 'notVisible' | 'navigation' | 'composerMissing' | 'composerFocus' | 'nativeFocus' | 'clipboardMismatch' | 'pasteFailed' | 'cancelled' }>>;
  importImage(request: { vaultId: string; parentPath: string }): Promise<ApiResult<{ path: string; assetUrl: string } | null>>;
  notebookInfo(): Promise<ApiResult<NotebookRuntimeInfo>>;
  notebookDataInfo(request: FileRequest): Promise<ApiResult<{sheets:Array<{name:string;hidden:boolean}>}>>;
  runNotebookCells(request: FileRequest & { expectedSHA256: string; runId: string; cellIndices: number[] }): Promise<ApiResult<{ runId: string; kernelId: string }>>;
  interruptNotebook(request: FileRequest): Promise<ApiResult<{ interrupted: boolean }>>;
  restartNotebook(request: FileRequest): Promise<ApiResult<{ restarted: boolean }>>;
  closeNotebook(request: FileRequest): Promise<ApiResult<{ closed: boolean }>>;
  onNotebookEvent(callback: (event: NotebookEvent) => void): () => void;
  info(): Promise<ApiResult<{ version: string; platform: string; python: { available: boolean; version: string; sandboxed: false } }>>;
  readPDFSourceInfo(request:FileRequest):Promise<ApiResult<{sourceSHA256:string;assetUrl:string}>>;
  selectStudyImport(request:FileRequest):Promise<ApiResult<StudyImportPreview|null>>;
  previewStudyImport(request:FileRequest&{token:string;delimiter:StudyDelimiter;header:boolean}):Promise<ApiResult<StudyImportPreview>>;
  commitStudyImport(request:FileRequest&{token:string;delimiter:StudyDelimiter;header:boolean;indices:number[];expectedSHA256:string}):Promise<ApiResult<StudyImportResult>>;
  exportStudyCards(request:FileRequest&{delimiter:StudyDelimiter;formulaProtection:boolean}):Promise<ApiResult<StudyExportResult>>;
  createPDFVisualExcerpt(request:FileRequest&{boardID:string;expectedSHA256:string;itemID:string;title:string;sourceReference:import('./pdf-extend').PDFSourceReference;dataURL:string;x:number;y:number}):Promise<ApiResult<BoardMutationResult>>;
  readStudyImage(request:FileRequest&{boardID:string;itemID?:string;sourcePath?:string}):Promise<ApiResult<{dataURL:string;sha256:string;width:number;height:number;sourcePath:string}>>;
  readStudy(request:FileRequest):Promise<ApiResult<StudyProjection>>;
  appendStudy(request:FileRequest&{event:StudyEvent}):Promise<ApiResult<StudyProjection>>;
  readPDFExtend(request:FileRequest):Promise<ApiResult<ExtendProjection>>;
  appendPDFExtend(request:FileRequest&{expectedSourceSHA256:string;record:ExtendEvent}):Promise<ApiResult<ExtendProjection>>;
  importPDFExtendImage(request:FileRequest&{expectedSourceSHA256:string}):Promise<ApiResult<{resource:string;sha256:string;width:number;height:number}|null>>;
  readPDFExtendImage(request:FileRequest&{resource:string;sha256:string}):Promise<ApiResult<{dataURL:string}>>;
  readPDFLayers(request:FileRequest):Promise<ApiResult<PDFLayerProjection>>;
  appendPDFLayerRecord(request:FileRequest&{expectedSourceSHA256:string;record:PDFLayerRecord}):Promise<ApiResult<{record:PDFLayerRecord;projection:PDFLayerProjection;backupId?:string}>>;
  exportPDFTranslation(request:PDFTranslationExportRequest):Promise<ApiResult<{saved:boolean}>>;
  chooseVault(): Promise<ApiResult<Vault | null>>;
  openFolderWindow(): Promise<ApiResult<{opened:boolean}>>;
  initialWindowVault(): Promise<ApiResult<Vault | null>>;
  externalOpenRequests():Promise<ApiResult<ExternalOpenRequest[]>>;
  acknowledgeExternalOpen(request:{id:string}):Promise<ApiResult<{acknowledged:boolean}>>;
  moveExternalOpenToNewWindow(request:{id:string}):Promise<ApiResult<{opened:boolean}>>;
  onExternalOpenRequests(callback:()=>void):()=>void;
  listRecentVaults(): Promise<ApiResult<{ entries: RecentVault[]; storageIssue: boolean }>>;
  reopenRecentVault(request: { id: string }): Promise<ApiResult<Vault>>;
  forgetRecentVault(request: { id: string }): Promise<ApiResult<{ forgotten: boolean }>>;
  listDirectory(request: FileRequest): Promise<ApiResult<DirectoryListing>>;
  knowledgeGraph(request: { vaultId: string }): Promise<ApiResult<KnowledgeGraphResponse>>;
  createBoard(request: { vaultId: string; parentPath: string; name: string }): Promise<ApiResult<OpenedFile & { backupId: string }>>;
  saveBoardElements(request: FileRequest & { expectedSHA256: string; items: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }): Promise<ApiResult<OpenedFile & { backupId: string }>>;
  searchNotes(request: { vaultId: string; query: string }): Promise<ApiResult<NoteSearchResponse>>;
  noteLinks(request: FileRequest): Promise<ApiResult<NoteLinksResponse>>;
  readFile(request: FileRequest): Promise<ApiResult<OpenedFile>>;
  getVideoSubtitles(request:FileRequest):Promise<ApiResult<VideoSubtitleResult>>;
  saveVideoSubtitles(request:FileRequest & {subtitle:VideoSubtitleAssociation|null;expectedSHA256:string|null}):Promise<ApiResult<VideoSubtitleResult>>;
  getVideoUrl(request: FileRequest): Promise<ApiResult<VideoSource>>;
  releaseVideoUrl(request: {url:string}): Promise<ApiResult<{released:true}>>;
  getAssetUrl(request: FileRequest & { hideBoardID?: string;hideBoardIDs?:string[] }): Promise<ApiResult<{ url: string; sha256: string }>>;
  saveText(request: FileRequest & { expectedSHA256: string; text: string }): Promise<ApiResult<{ sha256: string; backupId: string; bytes: number }>>;
  createFolder(request: { vaultId: string; parentPath: string; name: string }): Promise<ApiResult<VaultEntry>>;
  createTextFile(request: { vaultId: string; parentPath: string; name: string; content: string }): Promise<ApiResult<OpenedFile & { backupId: string }>>;
  openExternal(request: { url: string; application?: 'browser'|'system' }): Promise<ApiResult<{ opened: boolean }>>;
  getDiagnostics(): Promise<ApiResult<DiagnosticReport>>;
  exportDiagnostics(): Promise<ApiResult<{ saved: boolean }>>;
  runPython(request: FileRequest & { expectedSHA256: string; runId: string }): Promise<ApiResult<{ runId: string }>>;
  cancelPython(request: { runId: string }): Promise<ApiResult<{ cancelled: boolean }>>;
  onPythonEvent(callback: (event: PythonEvent) => void): () => void;
  /** Prints the current renderer reading/editing view, not a whole infinite board. */
  exportMathWorksheet(request:{name:string;mime:string;dataBase64:string}): Promise<ApiResult<{saved:boolean}>>;
  exportCurrentViewPDF(request?:{name:string;source?:FileRequest & {expectedSHA256:string}}): Promise<ApiResult<{ saved: boolean }>>;
  exportSourceFile(request:FileRequest & {expectedSHA256:string}):Promise<ApiResult<{saved:boolean;name?:string;bytes?:number}>>;
}
declare global { interface Window { desktop: DesktopAPI } }
