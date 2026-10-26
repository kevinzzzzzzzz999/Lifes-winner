import BoardRegionStudyDialog from './BoardRegionStudyDialog';
import type {BoardRegionCardPreview,BoardRegionCardResult} from '../shared/board-region-study';
import type {CaptureRect} from '../shared/desktop-api';
import type {WordAnnotationTarget} from '../shared/word-annotations';
import BoardImageOrganizationDialog from './BoardImageOrganizationDialog';
import type {FileMoveResult} from '../shared/desktop-api';
import {UnifiedSearchDialog} from './UnifiedSearchDialog';
import type {UnifiedSearchTarget} from '../shared/unified-search';
import StudyCaptureDialog from './StudyCaptureDialog';
import WorkSpace from './WorkSpace';
import RecognitionLearningCenter from './RecognitionLearningCenter';
import type {RecognitionDraft} from '../shared/recognition-samples';
import {displayBrand} from '../shared/brand';
import BoardVersionsDialog from './BoardVersionsDialog';
import {History as VersionHistoryIcon} from 'lucide-react';
import RecentVaultRelink from './RecentVaultRelink';
import BrowserWorkbench from './BrowserWorkbench';
import {Globe} from 'lucide-react';
import type {BrowserClipEntry,BrowserClipInspection} from '../shared/browser-clips';
import {useWorkspacePositions} from './useWorkspacePositions';
import CourseWorkspaces from './CourseWorkspaces';
import ReviewQueue from './ReviewQueue';
import type {PDFAnnotationTarget} from '../shared/pdf-annotations';
import type {CourseWorkspaceLayout,CourseWorkspaceList,CourseWorkspaceSummary} from '../shared/course-workspaces';
import {captureWorkspaceReading,hydrateWorkspaceReading,prepareCourseWorkspace,workspaceSessionKey} from './course-workspace-session';
import {acceptBoardMergeResult,boardMergeUndoState} from './board-merge-tabs';
import {captureExportView,type ExportView} from './export-view';
import ExportDialog from './ExportDialog';
import BoardMergeDialog,{type BoardMergePair} from './BoardMergeDialog';
import type {MergePoint} from './board-merge-placement';
import {officeReadingNotice} from './office-reading-labels';
import type {PDFExcerpt,PDFSourceFocus,PDFSourceReference} from '../shared/pdf-extend';
import {autosaveTabs} from './autosave-tabs';
import {retainExternalTab} from './external-open-tabs';
import MediaEditor from './MediaEditor';
import StudyPanel from './StudyPanel';
import {usePDFBoardLinks,PDFBoardLinkToolbar} from './usePDFBoardLinks';
import {excerptPosition,sameExcerptNode,type PDFBoardRequest,type PDFBoardTarget} from './pdf-board-links';
import CourseChecklist from './CourseChecklist';
import QuickNotes from './QuickNotes';
import MathWorkbench from './MathWorkbench';
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { Home,Search,ListChecks,Plus,X,Save,Play,RefreshCw,FolderOpen,CheckCircle2,Download,PanelLeft,PanelLeftClose,PanelRight,PanelRightClose,AlertCircle,Link2,Network,StickyNote,MessageSquare,Shapes,FileOutput,MessageSquareText,ScanText,Combine,Undo2 } from 'lucide-react';
import type { ApiResult,DiagnosticReport,DirectoryListing,OpenedFile,Vault,RecentVault,EditableDocumentModel,BoardTextFormat,BoardOperation,BoardMutationResult,BoardMergeResult,ExternalOpenRequest } from '../shared/desktop-api';
import {KnowledgePanel,useNoteLinks} from './KnowledgePanel';
import {AIWebPanel,LassoOverlay} from './AIPanel';
import {usePanelLayout,PanelSeparator} from './PanelLayout';
import MarginPanel from './MarginPanel';
import ReviewPanel,{useReviews,type ReviewFocus} from './ReviewPanel';
import type {ReviewRecord} from '../shared/desktop-api';
import {KnowledgeGraph,MindMapEditor,addMindNode,patchMindNode,reparentMindNode} from './GraphWorkspace';
import {BoardChooser} from './BoardEmbed';
import type {KnowledgeGraphResponse} from '../shared/desktop-api';
import TextBoxEditor from './TextBoxEditor';
import StandaloneDocumentEditor,{initialDocument} from './StandaloneDocumentEditor';
import NewDocumentDialog,{textTemplate,type NewDocumentKind} from './NewDocumentDialog';
import KnowledgeSpace from './KnowledgeSpace';
import {isVideoPath,type VideoPlaybackState} from './VideoPlayer';
import FloatingVideo from './FloatingVideo';
import Sidebar,{FileIcon} from './Sidebar';
import ChildBoardsDialog from './ChildBoardsDialog';
import type {BoardChildLink,BoardHistoryState} from '../shared/desktop-api';
import FileManagementDialog,{type FileAction} from './FileManagementDialog';
import RenameFileDialog from './RenameFileDialog';
import EditorPane from './EditorPane';
import DocumentPreview from './DocumentPreview';
import {extractPDFText} from './PDFViewer';
import PDFWorkspace,{type ReadingWorkspaceSession} from './PDFWorkspace';
import {boardPDFSourceReference} from './board-source-navigation';
import PDFBoardStudyLayout,{type PDFBoardStudyState} from './PDFBoardStudyLayout';
import {remapReadingWorkspace} from './reading-session-files';
import {pdfWorkspaceBusy} from './PDFWorkspaceState';
import BoardViewer from './BoardViewer';
import TranslationSettings from './TranslationSettings';
import AIWebSettings from './AIWebSettings';
import NotebookEditor from './NotebookEditor';
import WorkspaceFileEditor from './WorkspaceFileEditor';
import {isQuickOpenShortcut,isSaveShortcut} from './app-shortcuts';
import HomeDashboard from './HomeDashboard';
import WorkspaceFilePicker from './WorkspaceFilePicker';
import LocalOCRDialog from './LocalOCRDialog';
import NoteExchange from './NoteExchange';
import type {WorkspaceFileKind} from './workspace-file-kinds';
import CommandPalette,{type QuickAction} from './CommandPalette';
import {historyKey,parseFileHistory,rememberFile,remapRecentFiles,type FileHistory} from './recent-files';
import Calendar from './Calendar';
import {useCalendarReminders} from './useCalendarReminders';
import {useNotebookRuns,notebookKey} from './NotebookRuns';
import {normalizeNotebookSession,notebookSessionKey,retainNotebookSessions,remapNotebookSessions,type NotebookEditorSession} from './notebook-session';
import {applyNotebookEvents} from './notebook-events';
import {HtmlPreview,CsvPreview} from './DataFilePreview';
import PythonConsole,{type ConsoleState} from './PythonConsole';
import { Button,Modal,extname,basename } from './ui';
import { initialLanguage,tr,type Language,type TextKey } from './i18n';
type LoadedFields={file:OpenedFile;draft:string;document?:EditableDocumentModel;documentWarnings?:string[]};
type Tab=LoadedFields&{vaultId:string;dirty:boolean;initialPage?:number};
type ConfirmAction={run:()=>void;tabs:Tab[]};
const externalOpenSuperseded=new Error('External open was superseded.');
export default function App(){
 const [space,setSpace]=useState<'study'|'work'>(()=>{try{return sessionStorage.getItem('inkspace.space.v1')==='work'?'work':'study';}catch{return'study';}});
 const [notificationTarget,setNotificationTarget]=useState<string|null>(null),[pendingNotificationTarget,setPendingNotificationTarget]=useState<string|null>(null);
 useEffect(()=>{const receive=(value:{itemId:string})=>setPendingNotificationTarget(value.itemId);const off=window.desktop.onWorkNotificationOpen(receive);void window.desktop.workNotificationOpenPending().then(r=>{if(r.ok&&r.value)receive(r.value);});return off;},[]);
 const spaceRef=useRef(space);spaceRef.current=space;const[workEverOpened,setWorkEverOpened]=useState(space==='work');
 useEffect(()=>{try{sessionStorage.setItem('inkspace.space.v1',space);}catch{}},[space]);

 const [studyCapture,setStudyCapture]=useState<{vaultId:string;path:string;category:'focus'|'question';initialText?:string;excerpt?:string}|null>(null);
 const [boardVersionsRequest,setBoardVersionsRequest]=useState<{vaultId:string;file:OpenedFile}|null>(null);
 const [recentRelink,setRecentRelink]=useState<{id:string;name:string}|null>(null);
 const [browserWorkbench,setBrowserWorkbench]=useState<{vaultId:string;folderPath:string}|null>(null);
 const [courseWorkspacesOpen,setCourseWorkspacesOpen]=useState(false);
 const [reviewQueueRequest,setReviewQueueRequest]=useState<{vaultId:string;folderPath:string}|null>(null);
 const workspaceRestorePending=useRef(false),workspaceCameras=useRef(new Map<string,{x:number;y:number;zoom:number}>());
 const [mergeSource,setMergeSource]=useState<{vaultId:string;path:string}|null>(null);
 const [mergeUndo,setMergeUndo]=useState<{vaultId:string;result:BoardMergeResult}|null>(null);
 const [mergeUndoBusy,setMergeUndoBusy]=useState(false);
 const mergeUndoPending=useRef(false);
 const [exportFile,setExportFile]=useState<{file:OpenedFile;vaultId:string;view:ExportView}|null>(null);
 const [calendarOpen,setCalendarOpen]=useState(false);
 const [openingFolderWindow,setOpeningFolderWindow]=useState(false);
 const openingFolderWindowRef=useRef(false);
 const externalOpenHandler=useRef<(request:ExternalOpenRequest)=>Promise<void>>(async()=>{});
 const [calendarDate,setCalendarDate]=useState<string|undefined>();
 const [quickOpen,setQuickOpen]=useState(false),[recentVaults,setRecentVaults]=useState<RecentVault[]>([]),[folderHistoryIssue,setFolderHistoryIssue]=useState(false),[fileHistoryIssue,setFileHistoryIssue]=useState(false),[historyBusy,setHistoryBusy]=useState(false);
 const historyIssue=folderHistoryIssue||fileHistoryIssue;
 const [fileHistory,setFileHistory]=useState<FileHistory>(()=>{try{return parseFileHistory(localStorage.getItem(historyKey));}catch{return{};}});
 const historyRef=useRef(fileHistory);historyRef.current=fileHistory;
 const persistHistory=(next:FileHistory)=>{historyRef.current=next;setFileHistory(next);try{localStorage.setItem(historyKey,JSON.stringify(next));setFileHistoryIssue(false);}catch{setFileHistoryIssue(true);}};
 const reloadRecentVaults=async()=>{try{const result=await window.desktop.listRecentVaults();if(result.ok){setRecentVaults(result.value.entries);setFolderHistoryIssue(result.value.storageIssue);}else setFolderHistoryIssue(true);}catch{setFolderHistoryIssue(true);}};
 useEffect(()=>{void reloadRecentVaults();},[]);
 const [calendarFocus,setCalendarFocus]=useState<{eventId:string;occurrenceStart:string}|null>(null);
 const [quickNotesVault,setQuickNotesVault]=useState<Vault|null>(null);
 const [checklistRequest,setChecklistRequest]=useState<{vault:Vault;folder?:string;path?:string;taskId?:string;sourcePath?:string}|null>(null);
 const panels=usePanelLayout();const{aiOpen}=panels;
 const mediaState=useRef({dirty:false,busy:false});const[mediaVisible,setMediaVisible]=useState(false);const[mediaRequest,setMediaRequest]=useState<{vaultId:string;path?:string;nonce:number}|null>(null);
 const[mathVisible,setMathVisible]=useState(false);const[mathEverOpened,setMathEverOpened]=useState(false);
 const[learningRequest,setLearningRequest]=useState<{draft?:RecognitionDraft;nonce:number}|null>(null);
 const[language,setLanguage]=useState<Language>(initialLanguage);const[vault,setVault]=useState<Vault|null>(null);const[listing,setListing]=useState<DirectoryListing|null>(null);const[tabs,setTabs]=useState<Tab[]>([]);const[active,setActive]=useState<string|null>(null);const[error,setError]=useState('');const[status,setStatus]=useState('');const[loading,setLoading]=useState(false);const[mode,setMode]=useState<'source'|'split'|'preview'>('split');const[showNew,setShowNew]=useState(false);const[diagnostics,setDiagnostics]=useState<DiagnosticReport|null>(null);const[showSettings,setShowSettings]=useState(false);const[video,setVideo]=useState<{vaultId:string;path:string;playback?:VideoPlaybackState;session:string}|null>(null);const[confirm,setConfirm]=useState<ConfirmAction|null>(null);const[pythonConfirm,setPythonConfirm]=useState(false);const[notebookConfirm,setNotebookConfirm]=useState<{vaultId:string;path:string;indices:number[]}|null>(null);const notebookConsent=useRef(false);const notebookDeferredClear=useRef(new Map<string,Set<number>>());const[rememberRun,setRememberRun]=useState(false);const runConsent=useRef(false);const[consoleState,setConsole]=useState<ConsoleState>({output:'',running:false,status:'noOutput'});const run=useRef<{id:string;started:number}|null>(null);const state=useRef({tabs,vault,active});state.current={tabs,vault,active};const saves=useRef(new Set<string>());const homeSource=useRef<{vaultId:string;path:string}|null>(null);const requestEpoch=useRef(0);const listingEpoch=useRef(0);const chooseEpoch=useRef(0);const refreshListing=useRef<()=>Promise<void>>(async()=>{});const lastAutoPasted=useRef<string|null>(null);
 const[managementRevision,setManagementRevision]=useState(0);const[videoSeekSeconds,setVideoSeekSeconds]=useState(()=>{const n=Number(localStorage.getItem('inkspace.video.seekSeconds'));return [1,3,5,15,30].includes(n)?n:5;});
 const[boardReplayActive,setBoardReplayActive]=useState(false);
 const notebookSessions=useRef(new Map<string,NotebookEditorSession>());
 const rememberNotebookSession=(vaultId:string,path:string,session:NotebookEditorSession)=>{if(state.current.tabs.some(file=>file.vaultId===vaultId&&file.file.path===path&&/\.ipynb$/i.test(path)))notebookSessions.current.set(notebookSessionKey(vaultId,path),normalizeNotebookSession(session));};
 const[comparisonReadingKeys,setComparisonReadingKeys]=useState<Set<string>>(()=>new Set());
 const readingSessions=useRef(new Map<string,ReadingWorkspaceSession>());
 const readingGeneration=useRef(0);const[readingRevision,setReadingRevision]=useState(0);
 const readingTabKey=(vaultId:string,path:string)=>JSON.stringify([vaultId,path]);
 const focusedReadingFile=useRef<{owner:string;vaultId:string;path:string}|null>(null);
 const setComparisonReading=(vaultId:string,path:string,enabled:boolean)=>setComparisonReadingKeys(old=>{const key=readingTabKey(vaultId,path);if(old.has(key)===enabled)return old;const next=new Set(old);if(enabled)next.add(key);else next.delete(key);return next;});
 useEffect(()=>{const openKeys=new Set(tabs.filter(t=>t.vaultId===vault?.id).map(t=>readingTabKey(t.vaultId,t.file.path)));for(const key of readingSessions.current.keys())if(!openKeys.has(key))readingSessions.current.delete(key);setComparisonReadingKeys(old=>{const next=new Set([...old].filter(key=>openKeys.has(key)));return next.size===old.size?old:next;});},[tabs,vault?.id]);
 const [studyTarget,setStudyTarget]=useState<{vaultId:string;boardID:string;focus?:{id:string;nonce:number}}|null>(null);
 const studyState=useRef({dirty:false,busy:false});
 const onStudyState=useCallback((value:{dirty:boolean;busy:boolean})=>{studyState.current=value;},[]);
 const [studyCover,setStudyCover]=useState(false);
 const [mindFocus,setMindFocus]=useState<{id:string;nonce:number;highlight?:boolean}|undefined>();
 const[pdfStudies,setPDFStudies]=useState(new Map<string,PDFBoardStudyState>());
 const pdfStudyCameras=useRef(new Map<string,{x:number;y:number;zoom:number}>());
 const pdfStudyFocusConsumed=useRef(new Map<string,number>());
 const pdfStudyNavigationEpoch=useRef(0);
 const pdfStudyCameraKey=(value:PDFBoardStudyState)=>JSON.stringify([value.vaultId,value.ownerPath,value.target.boardID]);
 const pdfStudiesRef=useRef(pdfStudies);pdfStudiesRef.current=pdfStudies;
 const pdfLinks=usePDFBoardLinks({vault,language,save:(request,target)=>saveLinkedExcerpt(request,target),open:(target,sourcePath)=>openLinkedBoard(target,sourcePath)});
 const excerptRequest=pdfLinks.request;
 const[sourceFocus,setSourceFocus]=useState<PDFSourceFocus|undefined>();
 const[sourceReturn,setSourceReturn]=useState<{vaultId:string;path:string}|null>(null);

 const[exchangeOpen,setExchangeOpen]=useState(false);
 const[ocrSource,setOCRSource]=useState<{vault:Vault;path:string}|null>(null);
 const workspacePositions=useWorkspacePositions(vault?.id,active,mode,readingRevision,readingGeneration);
 const [workspacePicker,setWorkspacePicker]=useState<{vault:Vault;kind:WorkspaceFileKind;folder:string}|null>(null);const[manageRequest,setManageRequest]=useState(0);
 const [regionCard,setRegionCard]=useState<{vaultId:string;path:string;boardID:string;requestId:string;preview?:BoardRegionCardPreview}|null>(null);const regionCardRef=useRef<typeof regionCard>(null);regionCardRef.current=regionCard;const regionGeneration=useRef(0),regionSaving=useRef(false);
 const [boardImageOrganization,setBoardImageOrganization]=useState<{vaultId:string;path:string}|null>(null);const [fileAction,setFileAction]=useState<FileAction|null>(null);const[fileBusy,setFileBusy]=useState(false);const fileMutationBusy=useRef(false);const[newKind,setNewKind]=useState<NewDocumentKind>('md');const[newParent,setNewParent]=useState<string|null>(null);
 useCalendarReminders(vault);
 useEffect(()=>{if(!vault)return;let disposed=false;void window.desktop.workSourceRegister({vaultId:vault.id}).then(result=>{if(result.ok&&!disposed)return window.desktop.workSourceRefresh({sourceId:result.value.sourceId});}).catch(()=>{});return()=>{disposed=true;};},[vault?.id]);
 useEffect(()=>{
  let disposed=false;
  const consume=async()=>{
   const result=await window.desktop.consumeCalendarReminder();if(disposed||!result.ok||!result.value)return;
   const event=result.value,current=state.current.vault;
   if(current?.id===event.vaultId){setCalendarFocus(event);setCalendarOpen(true);return;}
   if(!current&&event.vault){
    const restored=event.vault;state.current={...state.current,vault:restored};setVault(restored);setCalendarFocus(event);setCalendarOpen(true);
    const entries=await window.desktop.listDirectory({vaultId:restored.id,path:''});if(!disposed&&state.current.vault?.id===restored.id&&entries.ok)setListing(entries.value);
   }else setStatus('日历提醒 / Calendar reminder: '+(event.vault?.name||''));
  };
  const off=window.desktop.onCalendarReminder?.(()=>{void consume().catch(()=>{});});void consume().catch(()=>{});
  return()=>{disposed=true;off?.();};
 },[]);
 useEffect(()=>{const report=(event:Event)=>setError(String((event as CustomEvent).detail||''));window.addEventListener('inkspace-context-menu-error',report);return()=>window.removeEventListener('inkspace-context-menu-error',report);},[]);
 const[openChoice,setOpenChoice]=useState<{path:string;page?:number}|null>(null),[externalBusy,setExternalBusy]=useState(false);
 const[childTarget,setChildTarget]=useState<{vaultId:string;path:string;itemID?:string;x?:number;y?:number}|null>(null);const childSessionsBusy=useRef(false);const[boardHistory,setBoardHistory]=useState<BoardHistoryState>({canUndo:false,canRedo:false});
 useEffect(()=>{const update=()=>{const seconds=Number(localStorage.getItem('inkspace.video.seekSeconds'));if([1,3,5,15,30].includes(seconds))setVideoSeekSeconds(seconds);};window.addEventListener('inkspace-video-settings',update);return()=>window.removeEventListener('inkspace-video-settings',update);},[]);
 const boardOperationLocks=useRef(new Set<string>());const savedBoardFiles=useRef(new Map<string,OpenedFile>());const[boardOperationKey,setBoardOperationKey]=useState<string|null>(null);
 const[graph,setGraph]=useState<KnowledgeGraphResponse|null>(null);const[graphVisible,setGraphVisible]=useState(false);const[knowledgeMode,setKnowledgeMode]=useState<'space'|'links'>('space');const[mapEditing,setMapEditing]=useState(false);const[lassoArea,setLassoArea]=useState<DOMRect|null>(null);const[capture,setCapture]=useState<string|null>(null);const[captureNonce,setCaptureNonce]=useState(0);const[marginPaths,setMarginPaths]=useState<Record<string,string>>({});const[marginPosition,setMarginPosition]=useState<'right'|'bottom'>('right');
 const[boardRefreshing,setBoardRefreshing]=useState(false);const manualRefresh=useRef(false);
 useEffect(()=>{const open=()=>setShowSettings(true);window.addEventListener('inkspace-open-translation-settings',open);return()=>window.removeEventListener('inkspace-open-translation-settings',open);},[]);
 const[translationVisible,setTranslationVisible]=useState(false);
 const[pdfBusyUI,setPDFBusyUI]=useState(false);useEffect(()=>{const update=()=>setPDFBusyUI(pdfWorkspaceBusy());window.addEventListener('inkspace-pdf-workspace-busy',update);return()=>window.removeEventListener('inkspace-pdf-workspace-busy',update);},[]);
 useEffect(()=>{const change=(event:Event)=>setTranslationVisible((event as CustomEvent).detail?.active===true);window.addEventListener('inkspace-translation-visibility',change);return()=>window.removeEventListener('inkspace-translation-visibility',change);},[]);
 const[assetRevision,setAssetRevision]=useState(0);const[watchMessage,setWatchMessage]=useState('');const[watchError,setWatchError]=useState('');const addFileEpoch=useRef(0);const transientBoxDirty=useRef(false);const[insertBoard,setInsertBoard]=useState(false);const[addFileAt,setAddFileAt]=useState<{vaultId:string;path:string;x:number;y:number}|null>(null);const[boardText,setBoardText]=useState<{vaultId:string;path:string;id?:string;x:number;y:number;title:string;text:string;kind:'text'|'formula';textFormat:BoardTextFormat;richTextHTML?:string;originalContent?:string}|null>(null);
 const[latexConfirm,setLatexConfirm]=useState(false);const[latexBusy,setLatexBusy]=useState(false);const[latexResult,setLatexResult]=useState<{vaultId:string;path:string|null;log:string}|null>(null);
 const[reviewsOpen,setReviewsOpen]=useState(false);const[reviewOverlays,setReviewOverlays]=useState(true);const[reviewFocus,setReviewFocus]=useState<ReviewFocus|null>(null);
 const[showSearch,setShowSearch]=useState(false);const[searchQuery,setSearchQuery]=useState('');const[connections,setConnections]=useState(()=>window.innerWidth>1050);
 useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail?.vaultId===state.current.vault?.id)setAssetRevision(n=>n+1);};window.addEventListener('inkspace-folder-order',changed);return()=>window.removeEventListener('inkspace-folder-order',changed);},[]);
 const t=(key:TextKey)=>tr(language,key);const tab=tabs.find(x=>x.file.path===active);const comparisonReadingKey=tab&&comparisonReadingKeys.has(readingTabKey(tab.vaultId,tab.file.path))?tab.vaultId+':'+tab.file.path:null;const extension=extname(active||'')==='markdown'?'md':extname(active||'');const api=window.desktop;const hasTextPreview=['md','tex','html','htm','csv','tsv'].includes(extension);const isPDFReader=extension==='pdf'&&!tab?.document&&!!tab?.file.assetUrl;
 const activePDFStudy=tab?pdfStudies.get(readingTabKey(tab.vaultId,tab.file.path)):undefined;
 const linkedBoardTab=activePDFStudy?tabs.find(x=>x.vaultId===activePDFStudy.vaultId&&x.file.path===activePDFStudy.target.path&&x.file.kind==='board'&&String(x.file.board?.id).toLowerCase()===activePDFStudy.target.boardID.toLowerCase()):undefined;
 const historyOwner=tab?.file.kind==='board'?tab:linkedBoardTab;
 useEffect(()=>{setPDFStudies(old=>{const next=new Map([...old].filter(([key,value])=>vault?.id===value.vaultId&&tabs.some(x=>readingTabKey(x.vaultId,x.file.path)===key)&&tabs.some(x=>x.vaultId===value.vaultId&&x.file.path===value.target.path)));return next.size===old.size?old:next;});},[vault?.id,tabs.map(x=>readingTabKey(x.vaultId,x.file.path)).join('\0')]);
 useEffect(()=>{if(!isPDFReader||!tab||activePDFStudy)return;const target=pdfLinks.target(tab.file.path);if(!target)return;let cancelled=false;void openLinkedBoard(target,tab.file.path,()=>cancelled).catch(()=>{if(!cancelled)setStatus(language==='zh'?'关联白板暂不可用；可从“关联”重新选择，原文仍可阅读。':'The linked board is unavailable. Relink it from Board; the PDF remains readable.');});return()=>{cancelled=true;};},[vault?.id,active,pdfLinks.links]);
 useEffect(()=>{setPDFStudies(old=>{const next=new Map([...old].filter(([,v])=>{const linked=pdfLinks.target(v.sourcePath);return v.vaultId!==vault?.id||linked?.boardID===v.target.boardID&&linked.path===v.target.path;}));return next.size===old.size?old:next;});},[vault?.id,pdfLinks.links]);
 useEffect(()=>{const keys=new Set([...pdfStudies.values()].map(pdfStudyCameraKey));for(const values of [pdfStudyCameras.current,pdfStudyFocusConsumed.current])for(const key of values.keys())if(!keys.has(key))values.delete(key);},[pdfStudies]);
 const reviewState=useReviews(vault?.id,tab?.file.path);
 const parsedBoard=useMemo(()=>{if(tab?.file.kind!=='board')return null;if(!tab.dirty&&tab.file.board)return tab.file.board;try{return JSON.parse(tab.draft||JSON.stringify(tab.file.board));}catch{return tab.file.board;}},[tab?.vaultId,tab?.file.path,tab?.file.board,tab?.dirty,tab?.draft]);
 useEffect(()=>{let stopped=false;setBoardHistory({canUndo:false,canRedo:false});if(historyOwner&&api.boardHistoryState)void api.boardHistoryState({vaultId:historyOwner.vaultId,path:historyOwner.file.path}).then(r=>{if(!stopped&&r.ok)setBoardHistory(r.value);});return()=>{stopped=true;};},[historyOwner?.vaultId,historyOwner?.file.path,historyOwner?.file.sha256]);
 const studyTab=studyTarget&&studyTarget.vaultId===vault?.id?tabs.find(t=>t.vaultId===studyTarget.vaultId&&t.file.kind==='board'&&String(t.file.board?.id).toLowerCase()===studyTarget.boardID.toLowerCase()):undefined;
 const studyBoard=useMemo(()=>{if(!studyTab)return null;try{return JSON.parse(studyTab.draft);}catch{return studyTab.file.board;}},[studyTab?.vaultId,studyTab?.file.path,studyTab?.draft]);
 const studyLocked=()=>!!regionCardRef.current||studyState.current.dirty||studyState.current.busy;
 const studyBlocked=()=>{setError(language==='zh'?'学习卡片有未保存的修改，请先保存、重试或取消草稿。':'Study changes are not saved. Save, retry or discard the draft first.');};
 const openStudy=(target:Tab,id?:string)=>{if(studyLocked()){studyBlocked();return;}setStudyTarget({vaultId:target.vaultId,boardID:String(target.file.board?.id),...(id?{focus:{id,nonce:Date.now()}}:{})});setReviewsOpen(false);setConnections(false);};
 const boxSignature=(item:Record<string,unknown>)=>JSON.stringify([item.title,item.text||'',item.kind,item.textFormat||(item.kind==='formula'?'latex':'richText'),item.richTextHTML||'']);
 transientBoxDirty.current=!!boardText&&(boardText.id?boxSignature({title:boardText.title,text:boardText.text,kind:boardText.textFormat==='latex'?'formula':'text',textFormat:boardText.textFormat,richTextHTML:boardText.richTextHTML})!==boardText.originalContent:!!(boardText.text||boardText.title));
 const notePath=tab&&['md'].includes(extension)?tab.file.path:undefined;const noteLinks=useNoteLinks(vault?.id,notePath,tab?.file.sha256);const openSearch=(query='')=>{setSearchQuery(query);setShowSearch(true);};
 const unwrap=<T,>(result:ApiResult<T>):T=>{if(!result.ok)throw Error(result.error.code==='CONFLICT'?t('sourceChanged'):language==='zh'&&({REMOVE_PAGE_HAS_INK:'请先将手写框成节点或移走，再移除页面。',FILE_PREPARATION_CANCELLED:'已取消准备，所选文件没有移动。',FILE_OPERATION_RECOVERY:'部分文件已保留在原位置或目标位置，自动回滚未完成。请勿重复操作，请查看恢复记录。',REVIEWS_BLOCK_MOVE:'这些文件还有待修改批注，请先处理批注后再移动。',FILE_SCAN_TIMEOUT:'资料库中仍有文件未能及时读取。请检查 iCloud 网络与下载状态后重试；本次移动尚未开始。',INK_RUNTIME_UNAVAILABLE:'此功能需要 Mac 安装包内的手写处理组件。',INK_CROSSES_BOUNDARY:'部分笔画跨出了选区或多个页面，请框入完整笔画后重试。',INK_TRANSFORM_FAILED:'笔迹未能安全处理，白板内容已保留。',COLLAPSE_HAS_CONTENT:'这些页面已有笔迹或连线，请保持展开以保留内容。',RECENT_VAULT_UNAVAILABLE:'文件夹已移动、更改或暂不可用，请重新选择文件夹。',BOARD_SPACE_INSUFFICIENT:'这里放不下全部页面，请调整位置或缩小页面比例。',NO_INK_SELECTED:'选区没有包含完整的可编辑笔画。',EXCEL_UNREADABLE:'无法读取这份 Excel，原文件和批注已保留。',EXCEL_TIMEOUT:'读取 Excel 超时，请使用较小的工作簿重试。',PDF_REQUIRED:'请选择 PDF 或 Excel 文件卡展开；其他资料可打开原文件。',ONENOTE_LAYOUT_UNSUPPORTED:'这份 PDF 的分页结构暂不能可靠拼接。请检查列数，或使用普通 PDF 展开；原文件与白板保持不变。'} as Record<string,string>)[result.error.code]||result.error.message);return result.value;};
 useEffect(()=>{if(vault?.recentId&&tab&&tab.vaultId===vault.id)persistHistory(rememberFile(historyRef.current,vault.recentId,tab.file.path));},[vault?.recentId,tab?.file.path]);
 const recentFiles=vault?.recentId?(fileHistory[vault.recentId]||[]):[];
 const attempt=async(action:()=>Promise<void>)=>{setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}};
 const readTabFile=async(vaultId:string,path:string):Promise<ApiResult<LoadedFields>>=>{
  if(/\.(docx|pptx|pdf)$/i.test(path)){
   const result=await api.readEditableDocument({vaultId,path});if(!result.ok)return result;
   const value=result.value;const document=value.editable?value.document:undefined;
   return {ok:true,value:{file:value.opened,document,draft:document?JSON.stringify(document):value.opened.text||'',documentWarnings:value.warnings}};
  }
  const result=await api.readFile({vaultId,path});if(!result.ok)return result;
  const file=result.value;return {ok:true,value:{file,draft:file.kind==='board'?JSON.stringify(file.board):file.text||'',document:undefined,documentWarnings:undefined}};
 };
 const prepareReadingFile=async(file:OpenedFile,refresh=false):Promise<OpenedFile>=>{
  const owner=state.current.vault,generation=readingGeneration.current;if(!owner||fileMutationBusy.current)throw Error(language==='zh'?'请先完成文件整理。':'Finish organizing files first.');
  const observed=state.current.tabs.find(x=>x.vaultId===owner.id&&x.file.path===file.path);
  if(observed&&!refresh)return observed.file;
  if(observed&&(observed.dirty||notebooks.isRunning(owner.id,file.path)))throw Error(language==='zh'?'请先保存修改并结束运行，再刷新此文档。':'Save changes and finish running before refreshing this document.');
  const loaded=unwrap(await readTabFile(owner.id,file.path));
  if(state.current.vault?.id!==owner.id||generation!==readingGeneration.current||fileMutationBusy.current)throw Error(t('sourceChanged'));
  const latest=state.current.tabs.find(x=>x.vaultId===owner.id&&x.file.path===file.path);
  if(latest&&(latest.dirty||latest.draft!==observed?.draft||latest.file.sha256!==observed?.file.sha256||notebooks.isRunning(owner.id,file.path)))return latest.file;
  setTabs(old=>{const existing=old.find(x=>x.vaultId===owner.id&&x.file.path===file.path);return existing?old.map(x=>x===existing&&!x.dirty&&x.draft===observed?.draft&&x.file.sha256===observed?.file.sha256?{...x,...loaded}:x):[...old,{vaultId:owner.id,...loaded,dirty:false}];});
  return loaded.file;
 };
 const focusedSaveTarget=()=>{
  const current=state.current,focus=focusedReadingFile.current;
  const study=current.vault&&current.active?pdfStudiesRef.current.get(readingTabKey(current.vault.id,current.active)):undefined;
  if(study?.mode==='board')return current.tabs.find(x=>x.vaultId===study.vaultId&&x.file.path===study.target.path);
  return focus&&focus.vaultId===current.vault?.id&&focus.owner===current.active?current.tabs.find(x=>x.vaultId===focus.vaultId&&x.file.path===focus.path)||current.tabs.find(x=>x.file.path===current.active):current.tabs.find(x=>x.file.path===current.active);
 };
 const refresh=async(path=listing?.path||'')=>{if(!vault)return;const vaultId=vault.id;const epoch=++listingEpoch.current;const result=unwrap(await api.listDirectory({vaultId,path}));if(epoch===listingEpoch.current&&state.current.vault?.id===vaultId)setListing(result);};
 refreshListing.current=()=>refresh();
 const saveTab=async(target:Tab,preparingOperation=false):Promise<boolean>=>{
 if(fileMutationBusy.current&&!preparingOperation)return false;
 if(!preparingOperation&&boardOperationLocks.current.has(target.vaultId+':'+target.file.path))return false;
 const currentVault=state.current.vault;if(!currentVault||currentVault.id!==target.vaultId)return false;if(!target.dirty)return true;
 const saveKey=target.vaultId+':'+target.file.path;if(saves.current.has(saveKey))return false;saves.current.add(saveKey);
 try{
  if(target.document){
   const result=unwrap(await api.saveDocument({vaultId:target.vaultId,path:target.file.path,expectedSHA256:target.file.sha256,document:JSON.parse(target.draft)}));
   if(state.current.vault?.id!==target.vaultId)return false;
   setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path&&x.file.sha256===target.file.sha256?{...x,file:result.opened,document:result.document,documentWarnings:result.warnings,draft:x.draft===target.draft?JSON.stringify(result.document):x.draft,dirty:x.draft!==target.draft}:x));
  }else if(target.file.kind==='board'){
   const next=JSON.parse(target.draft);const result=unwrap(await api.saveBoardElements({vaultId:target.vaultId,path:target.file.path,expectedSHA256:target.file.sha256,items:next.items,edges:next.edges}));
   savedBoardFiles.current.set(saveKey,result);
   if(state.current.vault?.id!==target.vaultId)return false;setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path&&x.file.sha256===target.file.sha256?{...x,file:result,draft:x.draft===target.draft?JSON.stringify(result.board):x.draft,dirty:x.draft!==target.draft}:x));
  }else{
   const result=unwrap(await api.saveText({vaultId:target.vaultId,path:target.file.path,expectedSHA256:target.file.sha256,text:target.draft}));
   if(state.current.vault?.id!==target.vaultId)return false;setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path&&x.file.sha256===target.file.sha256?{...x,file:{...x.file,sha256:result.sha256,bytes:result.bytes,text:target.draft},dirty:x.draft!==target.draft}:x));
  }
  const latest=state.current.tabs.find(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path);const unchanged=latest?.draft===target.draft;if(unchanged)setStatus(t('saved'));return unchanged;
 }finally{saves.current.delete(saveKey);}
 };
 const notebooks=useNotebookRuns({api,prepare:async(vaultId,path)=>{
  const target=state.current.tabs.find(x=>x.vaultId===vaultId&&x.file.path===path);if(!target||state.current.vault?.id!==vaultId)throw Error(t('sourceChanged'));
  if(!await saveTab(target))throw Error(language==='zh'?'请先保存 Notebook 的修改，再运行。':'Save Notebook changes before running.');
  const file=unwrap(await api.readFile({vaultId,path}));if(file.text?.replace(/\r\n/g,'\n')!==target.draft.replace(/\r\n/g,'\n'))throw Error(t('sourceChanged'));
  notebookDeferredClear.current.set(notebookKey(vaultId,path),new Set());return file;
 },apply:(vaultId,path,events,source)=>{
  const key=notebookKey(vaultId,path),waiting=notebookDeferredClear.current.get(key)||new Set<number>(),beforeClear=new Set(waiting);
  for(const event of events){const index=event.cellIndex;if(index===undefined)continue;if(event.kind==='clear-output'&&event.wait)waiting.add(index);else if(event.kind==='cell-start'||event.kind==='output'||event.kind==='clear-output')waiting.delete(index);}notebookDeferredClear.current.set(key,waiting);
  setTabs(old=>old.map(item=>{if(item.vaultId!==vaultId||item.file.path!==path)return item;
   try{const draft=applyNotebookEvents(item.draft,source,events,new Set(beforeClear));return {...item,draft,dirty:draft!==item.file.text};}
   catch(e){queueMicrotask(()=>{setError(e instanceof Error?e.message:String(e));void api.interruptNotebook({vaultId,path});});return item;}
  }));
 }});
 const previousNotebookFiles=useRef(new Map<string,{vaultId:string;path:string}>());
 useEffect(()=>{const next=new Map(tabs.filter(x=>/\.ipynb$/i.test(x.file.path)).map(x=>[notebookKey(x.vaultId,x.file.path),{vaultId:x.vaultId,path:x.file.path}]));for(const[key,file]of previousNotebookFiles.current)if(!next.has(key)){notebookDeferredClear.current.delete(key);void notebooks.close(file.vaultId,file.path).catch(error=>setError(error instanceof Error?error.message:String(error)));}retainNotebookSessions(notebookSessions.current,[...next.values()]);previousNotebookFiles.current=next;},[tabs.map(x=>x.vaultId+':'+x.file.path).join('\0')]);
 const restartNotebook=async(vaultId:string,path:string)=>{
  if(!state.current.tabs.some(target=>target.vaultId===vaultId&&target.file.path===path))throw Error(t('sourceChanged'));
  await notebooks.restart(vaultId,path);
  if(state.current.tabs.some(target=>target.vaultId===vaultId&&target.file.path===path))setStatus(language==='zh'?'运行环境已重启；代码和已有输出保留，Python 变量已清空。':'Kernel restarted; code and existing outputs retained. Python variables were cleared.');
 };
 const requestNotebookRun=(target:Tab,indices:number[])=>{if(!indices.length)return;if(notebookConsent.current)void notebooks.execute(target.vaultId,target.file.path,indices);else setNotebookConfirm({vaultId:target.vaultId,path:target.file.path,indices});};
 const performBoardChange=async(target:Tab,write:(sha256:string)=>Promise<ApiResult<BoardMutationResult>>)=>{
  if(fileMutationBusy.current)throw Error(language==='zh'?'文件正在整理，请稍候。':'Files are being organized.');
  const key=target.vaultId+':'+target.file.path;
  if(boardOperationLocks.current.has(key))throw Error(language==='zh'?'上一项整理仍在保存，请稍候。':'The previous change is still saving.');
  boardOperationLocks.current.add(key);setBoardOperationKey(key);setError('');
  try{
   if(target.dirty&&!await saveTab(target,true))throw Error(language==='zh'?'请先处理未保存的修改，再整理白板。':'Save pending edits before arranging the board.');
   const base=target.dirty?savedBoardFiles.current.get(key):target.file;
   if(!base||state.current.vault?.id!==target.vaultId)throw Error(t('sourceChanged'));
   const result=unwrap(await write(base.sha256));
   if(state.current.vault?.id!==target.vaultId)return;
   const acceptedDrafts=new Set([target.draft,JSON.stringify(base.board)]);
   setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path&&acceptedDrafts.has(x.draft)&&(x.file.sha256===base.sha256||x.file.sha256===target.file.sha256)?{...x,file:result,draft:JSON.stringify(result.board),dirty:false}:x));
   savedBoardFiles.current.set(key,result);if(result.history)setBoardHistory(result.history);setAssetRevision(n=>n+1);setStatus(language==='zh'?'白板整理已保存 · 等待 iCloud 同步':'Board changes saved · waiting for iCloud');
   if(result.history?.warning)setStatus(language==='zh'?'白板已保存，但本地撤销记录暂不可用。':'Board saved, but local undo history is unavailable.');return {selectedIDs:result.selectedIDs};
  }finally{boardOperationLocks.current.delete(key);setBoardOperationKey(current=>current===key?null:current);}
 };
 const performBoardOperation=(target:Tab,operation:BoardOperation)=>performBoardChange(target,expectedSHA256=>api.mutateBoard({vaultId:target.vaultId,path:target.file.path,expectedSHA256,operation}));
 const openBoardVersions=async(target:Tab)=>{
  if(target.dirty||fileMutationBusy.current||boardOperationLocks.current.size||childSessionsBusy.current||transientBoxDirty.current||pdfWorkspaceBusy()||studyLocked())throw Error(language==='zh'?'请先保存或完成当前编辑，再查看版本。':'Save or finish current edits before opening versions.');
  const observed=state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.file.path);if(!observed||state.current.vault?.id!==target.vaultId)throw Error(t('sourceChanged'));
  const fresh=unwrap(await api.readFile({vaultId:target.vaultId,path:target.file.path}));
  if(fresh.kind!=='board'||state.current.vault?.id!==target.vaultId||state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.file.path)!==observed||observed.dirty)throw Error(t('sourceChanged'));
  setTabs(old=>old.map(t=>t===observed?{...t,file:fresh,draft:JSON.stringify(fresh.board),dirty:false}:t));setBoardVersionsRequest({vaultId:target.vaultId,file:fresh});
 };
 const beginBoardMerge=async(target:Tab)=>{
  if(boardOperationLocks.current.size||fileMutationBusy.current||childSessionsBusy.current||transientBoxDirty.current||pdfWorkspaceBusy()||studyLocked())throw Error(language==='zh'?'请先完成当前编辑或保存。':'Finish the current edit or save first.');
  if(target.dirty&&!await saveTab(target))throw Error(t('sourceChanged'));
  if(state.current.vault?.id===target.vaultId)setMergeSource({vaultId:target.vaultId,path:target.file.path});
 };
 const prepareBoardMerge=async(targetPath:string)=>{
  const source=mergeSource;if(!source||state.current.vault?.id!==source.vaultId||targetPath===source.path)throw Error(t('sourceChanged'));
  for(const path of [source.path,targetPath]){const existing=state.current.tabs.find(x=>x.vaultId===source.vaultId&&x.file.path===path);if(existing?.dirty&&!await saveTab(existing))throw Error(t('sourceChanged'));}
  const files=await Promise.all([source.path,targetPath].map(path=>api.readFile({vaultId:source.vaultId,path}).then(unwrap)));
  if(state.current.vault?.id!==source.vaultId||files.some(file=>file.kind!=='board'||!file.board))throw Error(t('sourceChanged'));
  const inspection=unwrap(await api.inspectBoardMerge({vaultId:source.vaultId,path:files[1].path,expectedSHA256:files[1].sha256,sourcePath:files[0].path,expectedSourceSHA256:files[0].sha256}));
  if(state.current.vault?.id!==source.vaultId)throw Error(t('sourceChanged'));
  return {source:files[0],target:files[1],inspection};
 };
 const commitBoardMerge=async(pair:BoardMergePair,position:MergePoint):Promise<BoardMergeResult>=>{
  const source=mergeSource;if(!source||state.current.vault?.id!==source.vaultId||source.path!==pair.source.path||fileMutationBusy.current||boardOperationLocks.current.size)throw Error(t('sourceChanged'));
  const keys=[pair.source,pair.target].map(file=>source.vaultId+':'+file.path);
  for(const file of [pair.source,pair.target]){const current=state.current.tabs.find(x=>x.vaultId===source.vaultId&&x.file.path===file.path);if(current&&(current.dirty||current.file.sha256!==file.sha256))throw Error(language==='zh'?'白板在预览后有了修改，请重新选择目标后再合并。':'A board changed since the preview. Select the destination again.');}
  const observedTarget=state.current.tabs.find(x=>x.vaultId===source.vaultId&&x.file.path===pair.target.path)??null;
  keys.forEach(key=>boardOperationLocks.current.add(key));setBoardOperationKey(keys[1]);
  try{
   const result=unwrap(await api.mergeBoards({vaultId:source.vaultId,path:pair.target.path,expectedSHA256:pair.target.sha256,sourcePath:pair.source.path,expectedSourceSHA256:pair.source.sha256,position,mode:'intoTarget'}));
   savedBoardFiles.current.set(keys[1],result);
   if(state.current.vault?.id===source.vaultId){
    setMergeUndo({vaultId:source.vaultId,result});
    const accepted=acceptBoardMergeResult(state.current.tabs,source.vaultId,pair.target,observedTarget,result).accepted;
    setTabs(old=>acceptBoardMergeResult(old,source.vaultId,pair.target,observedTarget,result).tabs);
    if(accepted){setActive(result.path);setMapEditing(false);if(result.history)setBoardHistory(result.history);}
    setAssetRevision(n=>n+1);setStatus(!accepted?(language==='zh'?'磁盘上的白板已合并；等待期间的新草稿或关闭状态已保留，请先处理草稿再重新打开目标。':'The board was merged on disk. New edits or a closed tab were preserved; resolve the draft before reopening the destination.'):(language==='zh'?'白板已合并并保存，原白板和目标备份均已保留。':'Boards merged and saved. The source board and destination backup were retained.'));
   }
   return result;
  }finally{keys.forEach(key=>boardOperationLocks.current.delete(key));setBoardOperationKey(null);}
 };
 const changeChildLinks=async(target:{vaultId:string;path:string;itemID:string},change:(links:BoardChildLink[])=>BoardChildLink[])=>{const parent=state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.path);if(!parent)throw Error(t('sourceChanged'));const item=JSON.parse(parent.draft).items.find((i:{id:string})=>i.id===target.itemID);if(!item)throw Error(t('sourceChanged'));const links=change(item.childBoards||[]);await performBoardOperation(parent,{type:'setChildBoards',id:target.itemID,links});};
 const manageFiles=async(action:FileAction,option?:string,organization?:()=>Promise<FileMoveResult>)=>{if(pdfWorkspaceBusy())throw Error(language==='zh'?'请先保存或丢弃 PDF 批注草稿。':'Save or discard PDF annotation drafts first.');
  const currentVault=state.current.vault;if(!currentVault||action.vaultId!==currentVault.id)throw Error(language==='zh'?'资料文件夹已改变，请重新选择要整理的文件。':'The vault changed. Select the files again.');
  if(pdfLinks.hasPending()||studyLocked()||childSessionsBusy.current||fileMutationBusy.current||boardOperationLocks.current.size||saves.current.size||run.current||notebooks.isRunning()||latexBusy||transientBoxDirty.current)throw Error(language==='zh'?'请先完成正在进行的编辑或运行，再整理文件。':'Finish the current edit or running operation first.');
  fileMutationBusy.current=true;setFileBusy(true);requestEpoch.current++;listingEpoch.current++;setLoading(false);setVideo(null);
  try{
   const before=state.current.tabs;
   for(const target of before.filter(x=>x.dirty))if(!await saveTab(target,true))throw Error(language==='zh'?'尚有内容未保存，已停止整理。':'Some changes are unsaved; organization stopped.');
   let moves:Array<{from:string;to:string}>=[],removed:string[]=[],warnings:string[]=[];
   if(organization){if(state.current.vault?.id!==currentVault.id)throw Error(t('sourceChanged'));const result=await organization();if(state.current.vault?.id!==currentVault.id)return;moves=result.moved;warnings=result.warnings;}
   else if(action.kind==='move'){const result=unwrap(await api.moveFiles({vaultId:currentVault.id,paths:action.paths,targetPath:option||''}));moves=result.moved;warnings=result.warnings;}
   else if(action.kind==='rename'){const result=unwrap(await api.renameFiles({vaultId:currentVault.id,path:action.paths[0],name:option||''}));moves=result.moved;warnings=result.warnings;}
   else if(action.kind==='trash'){const result=unwrap(await api.trashFiles({vaultId:currentVault.id,paths:action.paths}));removed=result.trashed;warnings=result.warnings;}
   else{const result=unwrap(await api.restoreTrash({vaultId:currentVault.id,id:option||''}));warnings=result.warnings;}
   const mapPath=(path:string)=>{const match=[...moves].sort((a,b)=>b.from.length-a.from.length).find(m=>path===m.from||path.startsWith(m.from+'/'));return match?match.to+path.slice(match.from.length):path;};
   const isRemoved=(path:string)=>removed.some(p=>path===p||path.startsWith(p+'/'));
   if(currentVault.recentId)persistHistory(remapRecentFiles(historyRef.current,currentVault.recentId,moves,removed));
   pdfLinks.remap(currentVault,moves,removed);
   for(const[key,nonce]of [...pdfStudyFocusConsumed.current]){const [v,path,id]=JSON.parse(key) as [string,string,string];if(v!==currentVault.id)continue;pdfStudyFocusConsumed.current.delete(key);if(!isRemoved(path))pdfStudyFocusConsumed.current.set(JSON.stringify([v,mapPath(path),id]),nonce);}
   for(const[key,camera]of [...pdfStudyCameras.current]){const [v,path,id]=JSON.parse(key) as [string,string,string];if(v!==currentVault.id)continue;pdfStudyCameras.current.delete(key);if(!isRemoved(path))pdfStudyCameras.current.set(JSON.stringify([v,mapPath(path),id]),camera);}
   setPDFStudies(old=>new Map([...old].flatMap(([,v])=>v.vaultId!==currentVault.id?[[readingTabKey(v.vaultId,v.ownerPath),v] as const]:isRemoved(v.ownerPath)||isRemoved(v.target.path)||isRemoved(v.sourcePath)?[]:[[readingTabKey(v.vaultId,mapPath(v.ownerPath)),{...v,ownerPath:mapPath(v.ownerPath),sourcePath:mapPath(v.sourcePath),target:{...v.target,path:mapPath(v.target.path)},navigation:undefined}] as const])));
   const next:Tab[]=[];
   for(const previous of before){if(isRemoved(previous.file.path))continue;const path=mapPath(previous.file.path);const result=await readTabFile(currentVault.id,path);if(result.ok)next.push({vaultId:currentVault.id,...result.value,dirty:false,initialPage:previous.initialPage});else warnings.push('reload:'+path);}
   // Keep each tab's reading layout attached to the same files after a successful
   // move. A generation fence prevents the outgoing mounted pane from restoring
   // stale paths in its cleanup callback.
   if(moves.length||removed.length){
    const reloaded=new Map(next.map(target=>[target.file.path,target.file]));
    for(const session of readingSessions.current.values())for(const pane of session.panes){const oldPath=pane.file?.path;if(!oldPath||isRemoved(oldPath))continue;const path=mapPath(oldPath);if(path===oldPath||reloaded.has(path))continue;const result=await api.readFile({vaultId:currentVault.id,path});if(result.ok)reloaded.set(path,result.value);else warnings.push('reading-reload:'+path);}
    readingGeneration.current++;
    const migrated=new Map<string,ReadingWorkspaceSession>();
    for(const session of readingSessions.current.values()){const value=remapReadingWorkspace(session,moves,removed,reloaded);if(value&&next.some(target=>target.file.path===value.primaryPath))migrated.set(readingTabKey(currentVault.id,value.primaryPath),value);}
    readingSessions.current=migrated;
    remapNotebookSessions(notebookSessions.current,currentVault.id,moves,removed);
    setComparisonReadingKeys(old=>new Set(before.filter(target=>old.has(readingTabKey(target.vaultId,target.file.path))&&!isRemoved(target.file.path)&&next.some(value=>value.file.path===mapPath(target.file.path))).map(target=>readingTabKey(target.vaultId,mapPath(target.file.path)))));
    setReadingRevision(value=>value+1);
   }
   const nextActive=state.current.active?mapPath(state.current.active):null;const acceptedActive=next.some(x=>x.file.path===nextActive)?nextActive:next.at(-1)?.file.path||null;
   state.current={vault:currentVault,tabs:next,active:acceptedActive};setTabs(next);setActive(acceptedActive);setMapEditing(false);setReviewFocus(null);setCapture(null);savedBoardFiles.current.clear();setMarginPaths(old=>Object.fromEntries(Object.entries(old).filter(([a,b])=>!isRemoved(a)&&!isRemoved(b)).map(([a,b])=>[mapPath(a),mapPath(b)])));setAssetRevision(n=>n+1);
   let folder=action.kind==='move'?(option||''):mapPath(listing?.path||'');if(isRemoved(folder))folder='';try{await refresh(folder);}catch{warnings.push('folder-reload');setListing(null);}
   setManagementRevision(n=>n+1);setStatus(warnings.length?(language==='zh'?'整理完成；请检查普通笔记链接，暂未载入的文件可重新打开。':'Organization complete; check text links and reopen unavailable files.'):(language==='zh'?'文件整理已保存 · 等待 iCloud 同步':'File organization saved · waiting for iCloud'));
  }finally{fileMutationBusy.current=false;setFileBusy(false);}
 };
 const manageBoardImages=async<T extends FileMoveResult,>(vaultId:string,operation:()=>Promise<T>):Promise<T>=>{let outcome:T|undefined;await manageFiles({vaultId,kind:'restore',paths:[]},undefined,async()=>{outcome=await operation();return outcome;});if(!outcome)throw Error(t('sourceChanged'));return outcome;};
 const guard=(action:()=>void,targets=tabs)=>{if(pdfLinks.hasPending()){setError(language==='zh'?'请先完成或明确丢弃待加入白板的摘录。':'Finish or explicitly discard the pending excerpt first.');return;}if(studyLocked()){studyBlocked();return;}if(childSessionsBusy.current){setError(language==='zh'?'请先保存或取消子白板中的编辑。':'Save or cancel the child board edit first.');return;}if(targets.some(x=>notebooks.isRunning(x.vaultId,x.file.path))){setError(language==='zh'?'Notebook 正在运行，请先中断，再关闭或切换资料文件夹。':'A Notebook is running. Interrupt it before closing it or changing folders.');return;}if(pdfWorkspaceBusy()){setError(language==='zh'?'PDF 批注尚未保存，请完成、重试或丢弃草稿后继续。':'PDF annotations are not yet saved. Finish, retry or discard the draft first.');return;}const dirty=targets.filter(x=>x.dirty);if(dirty.length)setConfirm({run:action,tabs:dirty});else action();};
 const canUndoLastBoardMerge=(target:Tab)=>!!mergeUndo&&mergeUndo.vaultId===target.vaultId&&mergeUndo.result.path===target.file.path&&!target.dirty&&target.file.sha256===mergeUndo.result.sha256;
 const undoLastBoardMerge=async()=>{
  const receipt=mergeUndo;if(!receipt||mergeUndoPending.current)return;
  if(state.current.vault?.id!==receipt.vaultId||fileMutationBusy.current||boardOperationLocks.current.size||childSessionsBusy.current||transientBoxDirty.current||pdfWorkspaceBusy()||studyLocked())throw Error(language==='zh'?'请先完成当前编辑或保存，再撤回合并。':'Finish the current edit or save before undoing this merge.');
  const current=state.current.tabs.find(item=>item.vaultId===receipt.vaultId&&item.file.path===receipt.result.path);
  const undoState=boardMergeUndoState(state.current.tabs,receipt.vaultId,receipt.result);
  if(!current||undoState==='closed')throw Error(language==='zh'?'请重新打开合并后的目标白板，再撤回本次合并。':'Reopen the merged destination before undoing this merge.');
  if(undoState!=='ready')throw Error(language==='zh'?'目标白板在合并后有了新的修改，已保留这些内容。请先另存这些修改，再处理合并备份。':'The destination has newer changes, which have been preserved. Save a separate copy before using the merge backup.');
  const key=receipt.vaultId+':'+receipt.result.path;mergeUndoPending.current=true;setMergeUndoBusy(true);boardOperationLocks.current.add(key);setBoardOperationKey(key);
  try{
   const result=unwrap(await api.undoBoardMerge({vaultId:receipt.vaultId,path:receipt.result.path,expectedSHA256:receipt.result.sha256,journalID:receipt.result.journalID}));
   savedBoardFiles.current.set(key,result);
   if(state.current.vault?.id===receipt.vaultId){
    const accepted=acceptBoardMergeResult(state.current.tabs,receipt.vaultId,receipt.result,current,result).accepted;
    setTabs(old=>acceptBoardMergeResult(old,receipt.vaultId,receipt.result,current,result).tabs);
    setMergeUndo(old=>old?.result.journalID===receipt.result.journalID?null:old);
    if(accepted){setActive(result.path);setMapEditing(false);if(result.history)setBoardHistory(result.history);}
    setAssetRevision(n=>n+1);setStatus(accepted?(language==='zh'?'本次合并已撤回，来源白板仍保留。':'This merge was undone. The source board is retained.'):(language==='zh'?'磁盘合并已撤回；等待期间的新草稿仍保留，请先处理草稿再重新打开目标。':'The merge was undone on disk. A newer draft has been retained; resolve it before reopening the destination.'));
   }
  }finally{mergeUndoPending.current=false;setMergeUndoBusy(false);boardOperationLocks.current.delete(key);setBoardOperationKey(null);}
 };
 const activateVault=(chosen:Vault)=>guard(()=>{readingGeneration.current++;readingSessions.current.clear();setComparisonReadingKeys(new Set());requestEpoch.current++;const epoch=++listingEpoch.current;state.current={vault:chosen,tabs:[],active:null};notebookSessions.current.clear();setVault(chosen);setRegionCard(null);setBoardImageOrganization(null);setBoardVersionsRequest(null);setRecentRelink(null);setBrowserWorkbench(null);setReviewQueueRequest(null);setWorkspacePicker(null);setExchangeOpen(false);setOCRSource(null);setBoardReplayActive(false);setSourceFocus(undefined);setSourceReturn(null);setStudyTarget(null);homeSource.current=null;setCalendarOpen(false);setCalendarDate(undefined);setChecklistRequest(null);setFileAction(null);setShowNew(false);setNewParent(null);setTabs([]);setActive(null);setListing(null);setGraph(null);setGraphVisible(false);setMarginPaths({});setMapEditing(false);setCapture(null);setReviewFocus(null);setReviewsOpen(false);addFileEpoch.current++;setWatchError('');setInsertBoard(false);setAddFileAt(null);setMergeSource(null);setMergeUndo(null);setBoardText(null);setLoading(false);void reloadRecentVaults();void attempt(async()=>{const result=unwrap(await api.listDirectory({vaultId:chosen.id,path:''}));if(epoch===listingEpoch.current&&state.current.vault?.id===chosen.id)setListing(result);});},state.current.tabs);
 const choose=()=>void attempt(async()=>{if(fileMutationBusy.current)throw Error(language==='zh'?'请等待文件整理完成。':'Wait for file organization to finish.');const selection=++chooseEpoch.current;const chosen=unwrap(await api.chooseVault());if(chosen&&selection===chooseEpoch.current)activateVault(chosen);});
 // New windows receive their own folder before loading; opening one never
 // replaces or saves the current window's tabs and drafts.
 const openFolderWindow=()=>void attempt(async()=>{
  if(openingFolderWindowRef.current)return;
  openingFolderWindowRef.current=true;setOpeningFolderWindow(true);
  try{unwrap(await api.openFolderWindow());await reloadRecentVaults();}
  finally{openingFolderWindowRef.current=false;setOpeningFolderWindow(false);}
 });
 useEffect(()=>{
  let disposed=false;
  void (async()=>{try{const result=await api.initialWindowVault?.();if(!disposed&&result){const initial=unwrap(result);if(initial&&!state.current.vault)activateVault(initial);}}catch(error){if(!disposed)setError(error instanceof Error?error.message:String(error));}})();
  return()=>{disposed=true;};
 },[]);
 useEffect(()=>{document.title=vault?`${displayBrand(language)} · ${vault.name}`:displayBrand(language);},[vault?.name,language]);
 const reopenRecent=(id:string)=>void attempt(async()=>{if(historyBusy||fileMutationBusy.current)return;const selection=++chooseEpoch.current;setHistoryBusy(true);try{const chosen=unwrap(await api.reopenRecentVault({id}));if(selection===chooseEpoch.current)activateVault(chosen);}finally{setHistoryBusy(false);}});
 const forgetRecent=(id:string)=>void attempt(async()=>{if(historyBusy)return;setHistoryBusy(true);try{unwrap(await api.forgetRecentVault({id}));const next={...historyRef.current};delete next[id];persistHistory(next);await reloadRecentVaults();}finally{setHistoryBusy(false);}});
 const forgetRecentFile=(path:string)=>{const id=vault?.recentId;if(id)persistHistory({...historyRef.current,[id]:(historyRef.current[id]||[]).filter(f=>f.path!==path)});};

 const open=async(path:string,page?:number,force=false,playback?:VideoPlaybackState,fromFinder=false,expectedBoardID?:string,expectedSourceSHA256?:string)=>{if(excerptRequest)throw Error(language==='zh'?'请先完成或丢弃未保存摘录。':'Finish or discard the pending excerpt first.');if(studyLocked())throw Error(language==='zh'?'请先保存或取消学习卡片草稿。':'Save or discard the study draft first.');if(childSessionsBusy.current)throw Error(language==='zh'?'请先保存或取消子白板中的编辑。':'Save or cancel the child board edit first.');if(pdfWorkspaceBusy())throw Error(language==='zh'?'PDF 批注尚未保存，请先完成或重试。':'PDF annotations are not saved yet. Finish or retry first.');const currentVault=state.current.vault;if(!currentVault)return;if(/\.inkcheck\.json$/i.test(path)){setChecklistRequest({vault:currentVault,path,folder:path.split('/').slice(0,-1).join('/')});return;}if(path==='人生赢家日历.inkcalendar.json'){setCalendarOpen(true);return;}if(isVideoPath(path)){setVideo({vaultId:currentVault.id,path,playback,session:crypto.randomUUID()});return;}setGraphVisible(false);setMapEditing(false);const existing=state.current.tabs.find(x=>x.vaultId===currentVault.id&&x.file.path===path);if(existing&&!force){if(expectedSourceSHA256&&existing.file.sha256!==expectedSourceSHA256)throw Error(language==='zh'?'已开标签与索引版本不同；原草稿保留。':'The open tab differs from the indexed version; its draft was kept.');if(expectedBoardID&&(existing.file.kind!=='board'||String(existing.file.board?.id).toLowerCase()!==expectedBoardID.toLowerCase()))throw Error(language==='zh'?'原白板身份已变化，未打开其他白板。':'The original board identity changed; a different board was not opened.');requestEpoch.current++;setLoading(false);if(page!==undefined)setTabs(old=>old.map(x=>x.file.path===path?{...x,initialPage:page}:x));setActive(path);panels.closeCompactLeft();return;}const epoch=++requestEpoch.current;setLoading(true);try{const loaded=unwrap(await readTabFile(currentVault.id,path));const file=loaded.file;if(expectedSourceSHA256&&file.sha256!==expectedSourceSHA256)throw Error(language==='zh'?'来源在索引后发生变化；未替换当前标签，请更新索引后重试。':'The source changed after indexing. The current tab was kept; update the index and retry.');if(expectedBoardID&&(file.kind!=='board'||String(file.board?.id).toLowerCase()!==expectedBoardID.toLowerCase()))throw Error(language==='zh'?'原白板身份已变化，未打开其他白板。':'The original board identity changed; a different board was not opened.');if(epoch!==requestEpoch.current||state.current.vault?.id!==currentVault.id||pdfWorkspaceBusy()||(fromFinder&&fileMutationBusy.current)){if(fromFinder)throw externalOpenSuperseded;return;}const latest=state.current.tabs.find(x=>x.vaultId===currentVault.id&&x.file.path===path);if(force&&existing&&(latest?.draft!==existing.draft||latest?.file.sha256!==existing.file.sha256)){setStatus(language==='zh'?'已保留刷新期间的新修改。':'Changes made during reload were preserved.');return;}if(fromFinder){const added:Tab={vaultId:currentVault.id,...loaded,dirty:false,initialPage:page};state.current={...state.current,tabs:retainExternalTab(state.current.tabs,added),active:path};setTabs(old=>retainExternalTab(old,added));}else setTabs(old=>[...old.filter(x=>x.file.path!==path),{vaultId:currentVault.id,...loaded,dirty:false,initialPage:page}]);setActive(path);panels.closeCompactLeft();if(file.kind==='text'&&/\.(html?|csv|tsv)$/i.test(path))setMode('preview');if(file.kind==='text'&&/\.(md|markdown)$/i.test(path)&&/^```inkspace\s*$/m.test(file.text||''))setMode('preview');}finally{if(epoch===requestEpoch.current)setLoading(false);}};
 // Finder requests stay in main until acknowledged. A changed workspace or
 // pending editor operation receives a separate window instead of losing work.
 externalOpenHandler.current=async request=>{
  if(request.error){unwrap({ok:false,error:request.error});return;}
  const current=state.current.vault;
  if((current&&current.id!==request.vault.id)||fileMutationBusy.current||studyLocked()||childSessionsBusy.current||pdfWorkspaceBusy()||pdfLinks.hasPending()||transientBoxDirty.current){unwrap(await api.moveExternalOpenToNewWindow({id:request.id}));return;}
  if(!current)activateVault(request.vault);
  if(state.current.vault?.id!==request.vault.id)throw Error(language==='zh'?'资料文件夹已更换，请重新打开文档。':'The folder changed. Open the document again.');
  try{const pending=open(request.path,request.page,false,undefined,true,request.expectedBoardID,request.expectedSourceSHA256),epoch=requestEpoch.current;await pending;if(request.sourceFocus){if(state.current.vault?.id!==request.vault.id||requestEpoch.current!==epoch||pdfWorkspaceBusy())throw externalOpenSuperseded;setSourceFocus({...request.sourceFocus,nonce:Date.now()});}}catch(error){if(error!==externalOpenSuperseded)throw error;unwrap(await api.moveExternalOpenToNewWindow({id:request.id}));}
 };
 useEffect(()=>{
  if(!api.externalOpenRequests||!api.onExternalOpenRequests)return;
  let disposed=false,pumping=false,again=false;
  const pump=async()=>{
   if(pumping){again=true;return;}pumping=true;
   try{do{
    again=false;const requests=unwrap(await api.externalOpenRequests());if(disposed)return;
    for(const request of requests){
     if(disposed)return;
     try{await externalOpenHandler.current(request);}catch(error){if(!disposed)setError(error instanceof Error?error.message:String(error));}
     if(!disposed)unwrap(await api.acknowledgeExternalOpen({id:request.id}));
    }
   }while(again&&!disposed);}catch(error){if(!disposed)setError(error instanceof Error?error.message:String(error));}
   finally{pumping=false;if(again&&!disposed)void pump();}
  };
  const unsubscribe=api.onExternalOpenRequests(()=>void pump());void pump();
  return()=>{disposed=true;unsubscribe();};
 },[]);
 const refreshCurrentBoard=async()=>{
  const target=state.current.tabs.find(x=>x.vaultId===state.current.vault?.id&&x.file.path===state.current.active);
  if(!target||target.file.kind!=='board'||manualRefresh.current)return;
  const key=target.vaultId+':'+target.file.path;
  if(target.dirty||transientBoxDirty.current||boardOperationLocks.current.has(key)||fileMutationBusy.current||saves.current.has(key)){
   setStatus(language==='zh'?'当前修改已保留，请先保存或结束操作，再刷新白板。':'Current edits are preserved. Save or finish the operation before refreshing.');return;
  }
  manualRefresh.current=true;setBoardRefreshing(true);setError('');setStatus(language==='zh'?'正在重新读取白板和资料…':'Refreshing the board and materials…');
  try{
   const loaded=unwrap(await readTabFile(target.vaultId,target.file.path));
   const latest=state.current.tabs.find(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path);
   if(state.current.vault?.id!==target.vaultId||state.current.active!==target.file.path)return;
   if(!latest||latest.dirty||latest.draft!==target.draft||latest.file.sha256!==target.file.sha256||transientBoxDirty.current||boardOperationLocks.current.has(key)||fileMutationBusy.current||saves.current.has(key)){
    setStatus(language==='zh'?'已保留刷新期间的新修改，请保存后再试。':'Changes made during refresh were preserved. Save them and try again.');return;
   }
   if(loaded.file.kind!=='board'||(loaded.file.board as {id?:string})?.id!==(target.file.board as {id?:string})?.id)throw Error(language==='zh'?'文件已被替换，当前白板保留；请重新打开对应白板。':'The file was replaced. The current board is preserved; reopen the intended board.');
   setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path&&!x.dirty&&x.draft===target.draft&&x.file.sha256===target.file.sha256&&loaded.file.sha256!==x.file.sha256?{...x,...loaded}:x));
   setAssetRevision(n=>n+1);window.dispatchEvent(new CustomEvent('inkspace-board-refresh',{detail:{vaultId:target.vaultId}}));
   setWatchError('');setStatus((language==='zh'?'已刷新本机可用文件 · ':'Available local files refreshed · ')+new Date().toLocaleTimeString(language==='zh'?'zh-CN':'en')+(language==='zh'?'；iCloud 尚未传到的更改仍需等待。':'. Changes still transferring through iCloud will appear when they arrive.'));
  }catch(e){if(state.current.vault?.id===target.vaultId&&state.current.active===target.file.path){setStatus('');setError((language==='zh'?'刷新未完成，当前白板已保留。请等待 iCloud 下载后重试。 ':'Refresh did not finish; the current board is preserved. Wait for iCloud downloads and retry. ')+(e instanceof Error?e.message:String(e)));}}
  finally{manualRefresh.current=false;setBoardRefreshing(false);}
 };
 const openMindSource=async(path:string,reference?:PDFSourceReference)=>{
  const from=state.current.tabs.find(x=>x.file.path===state.current.active),owner=state.current.vault?.id;
  await open(path,reference?.page);
  if(state.current.vault?.id!==owner)return;
  setSourceFocus(reference?{...reference,nonce:Date.now()}:undefined);
  if(from?.file.kind==='board')setSourceReturn({vaultId:from.vaultId,path:from.file.path});
 };
 const attachPDFStudy=(owner:Vault,ownerPath:string,sourcePath:string,target:PDFBoardTarget,file:OpenedFile,focusID?:string,observedSHA?:string)=>{
  if(state.current.vault?.id!==owner.id||!state.current.tabs.some(x=>x.vaultId===owner.id&&x.file.path===ownerPath))return;
  setTabs(old=>old.some(x=>x.vaultId===owner.id&&x.file.path===target.path)?old.map(x=>x.vaultId===owner.id&&x.file.path===target.path&&!x.dirty&&(!observedSHA||x.file.sha256===observedSHA||x.file.sha256===file.sha256)&&String(x.file.board?.id).toLowerCase()===target.boardID.toLowerCase()?{...x,file,draft:JSON.stringify(file.board)}:x):[...old,{vaultId:owner.id,file,draft:JSON.stringify(file.board),dirty:false}]);
  setPDFStudies(old=>{const key=readingTabKey(owner.id,ownerPath),prior=old.get(key),same=prior?.target.boardID.toLowerCase()===target.boardID.toLowerCase()&&prior.target.path===target.path;const follow=!same||prior.autoLocate;return new Map(old).set(key,{...(same?prior:{}),vaultId:owner.id,ownerPath,sourcePath,target,mode:focusID&&!follow?prior!.mode:'split',ratio:same?prior.ratio:.5,autoLocate:same?prior.autoLocate:true,...(focusID?{lastExcerptID:focusID,...(follow?{focus:{id:focusID,nonce:Date.now()}}:{})}:{})});});
 };
 const openLinkedBoard=async(target:PDFBoardTarget,sourcePath:string,cancelled:()=>boolean=()=>false)=>{
  const owner=state.current.vault,ownerPath=state.current.active;if(!owner||!ownerPath)throw Error('NO_VAULT');
  const observed=state.current.tabs.find(x=>x.vaultId===owner.id&&x.file.path===target.path);
  const file=unwrap(await api.readFile({vaultId:owner.id,path:target.path}));
  if(cancelled())return;
  if(file.kind!=='board'||String(file.board?.id).toLowerCase()!==target.boardID.toLowerCase()||state.current.vault?.id!==owner.id||state.current.active!==ownerPath)throw Error('PDF_TARGET_UNAVAILABLE');
  const existing=state.current.tabs.find(x=>x.vaultId===owner.id&&x.file.path===target.path);
  if(existing&&String(existing.file.board?.id).toLowerCase()!==target.boardID.toLowerCase())throw Error('PDF_TARGET_UNAVAILABLE');
  attachPDFStudy(owner,ownerPath,sourcePath,target,existing&&(existing.dirty||existing.file.sha256!==observed?.file.sha256)?existing.file:file,undefined,observed?.file.sha256);
 };
 const changePDFStudy=(key:string,patch:Partial<PDFBoardStudyState>)=>setPDFStudies(old=>{const value=old.get(key);return value?new Map(old).set(key,{...value,...patch}):old;});
 const navigatePDFStudy=async(owner:PDFBoardStudyState,path:string,reference?:PDFSourceReference,page?:number)=>{
  if(pdfWorkspaceBusy()||childSessionsBusy.current||transientBoxDirty.current||studyLocked()||pdfLinks.hasPending())throw Error(language==='zh'?'请先完成当前编辑。':'Finish the current edit first.');
  const epoch=++pdfStudyNavigationEpoch.current;
  const file=unwrap(await api.readFile({vaultId:owner.vaultId,path}));
  if(epoch!==pdfStudyNavigationEpoch.current)return;
  if(pdfWorkspaceBusy()||childSessionsBusy.current||transientBoxDirty.current||studyLocked()||pdfLinks.hasPending())throw Error(language==='zh'?'来源已就绪，请完成当前编辑后再次定位。':'The source is ready. Finish the current edit and locate it again.');
  const key=readingTabKey(owner.vaultId,owner.ownerPath),current=pdfStudiesRef.current.get(key);
  if(state.current.vault?.id!==owner.vaultId||state.current.active!==owner.ownerPath||current?.target.boardID!==owner.target.boardID)return;
  if(!/\.pdf$/i.test(file.path)||!file.assetUrl)throw Error(language==='zh'?'来源 PDF 暂不可读，原白板保留。':'The source PDF is unavailable. The board is retained.');
  const nonce=Date.now();setSourceFocus(reference?{...reference,path:file.path,nonce}:undefined);
  changePDFStudy(key,{mode:'split',navigation:{file,page:reference?.page??page,nonce}});
 };
 const saveLinkedExcerpt=async(request:PDFBoardRequest,target:PDFBoardTarget|{path:string}):Promise<PDFBoardTarget>=>{
  if(state.current.vault?.id!==request.vaultId)throw Error('NO_VAULT');
  const owner=state.current.vault!,ownerPath=state.current.active;
  let fresh=unwrap(await api.readFile({vaultId:request.vaultId,path:target.path}));
  if(fresh.kind!=='board'||!fresh.board||('boardID' in target&&String(fresh.board.id).toLowerCase()!==target.boardID.toLowerCase()))throw Error('PDF_TARGET_UNAVAILABLE');
  const boardID=String(fresh.board.id),existing=state.current.tabs.find(x=>x.vaultId===request.vaultId&&x.file.path===target.path);
  if(existing&&String(existing.file.board?.id).toLowerCase()!==boardID.toLowerCase())throw Error('PDF_TARGET_UNAVAILABLE');
  if(!request.excerpt){if(ownerPath)attachPDFStudy(owner,ownerPath,request.sourcePath,{path:target.path,boardID},fresh,undefined,existing?.file.sha256);return{path:target.path,boardID};}
  if(existing?.dirty){
   if(existing.file.sha256!==fresh.sha256||!await saveTab(existing))throw Error('CONFLICT');
   fresh=unwrap(await api.readFile({vaultId:request.vaultId,path:target.path}));
   if(fresh.kind!=='board'||String(fresh.board?.id).toLowerCase()!==boardID.toLowerCase())throw Error('PDF_TARGET_UNAVAILABLE');
  }
  const e=request.excerpt,base=fresh.board as Record<string,unknown>,old=(base.items as Array<Record<string,unknown>>).find(n=>String(n.id).toLowerCase()===request.id.toLowerCase());
  let saved=fresh;
  if(e.image){
   const scale=Math.min(1,640/e.image.width,640/e.image.height),size={width:e.image.width*scale,height:e.image.height*scale};
   const result=unwrap(await api.createPDFVisualExcerpt({vaultId:request.vaultId,path:target.path,boardID,expectedSHA256:fresh.sha256,itemID:request.id,title:e.title,sourceReference:{schemaVersion:1,path:e.path,sourceSHA256:e.sourceSHA256,page:e.page,rect:e.rect,quote:''},dataURL:e.image.dataURL,...(old?{x:Number(old.x),y:Number(old.y)}:excerptPosition(base,size))}));
   saved=result;savedBoardFiles.current.set(request.vaultId+':'+target.path,saved);
  }else if(old){if(!sameExcerptNode(old,e))throw Error('CONFLICT');}
  else{
   const targetTab:Tab={vaultId:request.vaultId,file:fresh,draft:JSON.stringify(base),dirty:false};
   await performBoardChange(targetTab,expectedSHA256=>{
    const next=addMindNode(base,e.title,excerptPosition(base),undefined,request.id) as {items:Array<Record<string,unknown>>;edges:Array<Record<string,unknown>>};
    const node=next.items.find(item=>item.id===request.id);if(!node)throw Error('TOO_LARGE');
    Object.assign(node,{width:360,height:220,text:e.text,textFormat:'richText',sourcePath:e.path,page:e.page,sourceReference:{schemaVersion:1,path:e.path,sourceSHA256:e.sourceSHA256,page:e.page,rect:e.rect,quote:e.text,...(e.extendBlockID?{extendBlockID:e.extendBlockID}:{})}});
    return api.saveBoardElements({vaultId:request.vaultId,path:target.path,expectedSHA256,items:next.items,edges:next.edges});
   });
   saved=savedBoardFiles.current.get(request.vaultId+':'+target.path)||fresh;
   if(!(saved.board?.items as Array<{id:string}>|undefined)?.some(n=>n.id===request.id))throw Error('SAVE_UNCONFIRMED');
  }
  if(state.current.vault?.id!==request.vaultId)throw Error('NO_VAULT');
  setTabs(old=>old.some(x=>x.vaultId===request.vaultId&&x.file.path===target.path)?old.map(x=>x.vaultId===request.vaultId&&x.file.path===target.path&&!x.dirty&&(x.file.sha256===fresh.sha256||x.file.sha256===saved.sha256)?{...x,file:saved,draft:JSON.stringify(saved.board)}:x):[...old,{vaultId:request.vaultId,file:saved,draft:JSON.stringify(saved.board),dirty:false}]);
  if(ownerPath)attachPDFStudy(owner,ownerPath,request.sourcePath,{path:target.path,boardID},saved,request.id,fresh.sha256);
  // Keep the PDF pane mounted at its current page, zoom and scroll position.
  // If review is already open, refresh its selection without interrupting drafts.
  if(studyTarget&&!studyLocked())setStudyTarget({vaultId:request.vaultId,boardID,focus:{id:request.id,nonce:Date.now()}});
  return{path:target.path,boardID};
 };
 const requestOpen=async(path:string,page?:number,playback?:VideoPlaybackState)=>{if(/\.(xlsx?|xlsm|csv|docx?|pptx?)$/i.test(path)){setOpenChoice({path,page});return;}await open(path,page,false,playback);};
 const externalOpen=async(application:'default'|'choose')=>{if(!openChoice||!vault||externalBusy)return;setExternalBusy(true);try{const target=state.current.tabs.find(t=>t.vaultId===vault.id&&t.file.path===openChoice.path);if(target?.dirty&&!await saveTab(target))return;const result=unwrap(await api.openOriginal({vaultId:vault.id,path:openChoice.path,application}));if(result.opened){setOpenChoice(null);setStatus(language==='zh'?'已交给外部应用。保存后返回，人生赢家会检查更新。':'Opened in the selected app. Save there and return to check updates.');}}finally{setExternalBusy(false);}};
 const openUnifiedSearchTarget=async(target:UnifiedSearchTarget)=>{
  const owner=state.current.vault?.id,imageOCR=target.origin==='board-image-ocr';if(!owner||owner!==target.vaultId)throw Error(language==='zh'?'资料夹已更换，请重新检索。':'The folder changed. Search again.');
  if(imageOCR&&(!target.resultId||!target.boardID||!target.nodeID||!target.imagePath||!target.imageSHA256))throw Error(language==='zh'?'图片来源定位不完整，请重新建立索引。':'The image source locator is incomplete. Rebuild the index.');
  const existing=state.current.tabs.find(t=>t.vaultId===owner&&t.file.path===target.path);if(imageOCR&&existing?.dirty)throw Error(language==='zh'?'这块白板有未保存草稿，已保留。请先保存或取消编辑，再定位图片OCR结果。':'This board has an unsaved draft, which was kept. Save or discard the edit before locating an image OCR result.');if(existing&&existing.file.sha256!==target.sourceSHA256)throw Error(language==='zh'?'已开标签的版本与索引不同；原草稿保留，请先核对或更新索引。':'The open tab differs from the indexed version. Its draft was kept; review it or update the index.');
  const pending=open(target.path,imageOCR?undefined:target.page,false,undefined,false,target.boardID,target.sourceSHA256),epoch=requestEpoch.current;await pending;
  const ensureOwner=()=>{if(state.current.vault?.id!==owner||requestEpoch.current!==epoch||pdfWorkspaceBusy())throw Error(language==='zh'?'页面已改变，请重试。':'The page changed. Retry.');};ensureOwner();
  if(imageOCR){const verified=unwrap(await api.unifiedSearchResolve({vaultId:owner,resultId:target.resultId!}));ensureOwner();if(['path','kind','sourceSHA256','boardID','nodeID','origin','imagePath','imageSHA256'].some(key=>verified[key as keyof UnifiedSearchTarget]!==target[key as keyof UnifiedSearchTarget]))throw Error(language==='zh'?'来源白板或图片已经变化，尚未高亮旧图片；请更新索引。':'The source board or image changed. The old image was not highlighted; update the index.');if(state.current.tabs.some(t=>t.vaultId===owner&&t.file.path===target.path&&t.dirty))throw Error(language==='zh'?'白板出现未保存草稿，已保留；请处理后重试。':'The board has a new unsaved draft, which was kept. Resolve it and retry.');}
  if(target.nodeID)setMindFocus({id:target.nodeID,nonce:Date.now(),...(imageOCR?{highlight:true}:{})});
  if(target.kind==='pdf'&&target.page&&target.rect)setSourceFocus({schemaVersion:1,path:target.path,page:target.page,rect:target.rect,sourceSHA256:target.sourceSHA256,quote:target.quote,nonce:Date.now()});
 };
 const openWordAnnotationTarget=async(target:WordAnnotationTarget)=>{
  const owner=state.current.vault?.id;if(!owner||owner!==target.vaultId)throw Error(language==='zh'?'资料夹已更换，请重新扫描。':'The folder changed. Scan again.');
  const existing=state.current.tabs.find(t=>t.vaultId===owner&&t.file.path===target.path);if(existing&&(existing.dirty||existing.file.sha256!==target.sourceSHA256))throw Error(language==='zh'?'已开文件有未保存编辑或版本不同，草稿保留，请先核对。':'The open file has unsaved edits or another version. It was kept; review it first.');
  const pending=open(target.path,undefined,false,undefined,false,undefined,target.sourceSHA256),epoch=requestEpoch.current;await pending;
  const current=()=>state.current.vault?.id===owner&&requestEpoch.current===epoch&&!pdfWorkspaceBusy();if(!current())throw Error(language==='zh'?'页面已改变，请重试。':'The page changed. Retry.');
  const verified=unwrap(await api.wordAnnotationsResolve({scanToken:target.scanToken,resultId:target.resultId}));if(!current())throw Error(language==='zh'?'页面已改变，请重试。':'The page changed. Retry.');
  if(['vaultId','path','sourceSHA256','annotationID','kind'].some(key=>verified[key as keyof WordAnnotationTarget]!==target[key as keyof WordAnnotationTarget]))throw Error(language==='zh'?'Word来源已变化，请重新扫描。':'The Word source changed. Scan again.');setSourceFocus(undefined);
 };
 const openPDFAnnotationTarget=async(target:PDFAnnotationTarget)=>{
  const owner=state.current.vault?.id;if(!owner||owner!==target.vaultId)throw Error(language==='zh'?'资料夹已更换，请重新扫描。':'The folder changed. Scan again.');
  const existing=state.current.tabs.find(t=>t.vaultId===owner&&t.file.path===target.path);if(existing&&(existing.dirty||existing.file.sha256!==target.sourceSHA256))throw Error(language==='zh'?'已开文件与扫描版本不同或有未保存草稿，已保留；请先核对原件。':'The open file differs from the scanned version or has an unsaved draft. It was kept; review the original first.');
  const pending=open(target.path,target.page,false,undefined,false,undefined,target.sourceSHA256),epoch=requestEpoch.current;await pending;
  const current=()=>state.current.vault?.id===owner&&requestEpoch.current===epoch&&!pdfWorkspaceBusy();if(!current())throw Error(language==='zh'?'页面已改变，请重试。':'The page changed. Retry.');
  const verified=unwrap(await api.pdfAnnotationsResolve({scanToken:target.scanToken,resultId:target.resultId}));if(!current())throw Error(language==='zh'?'页面已改变，请重试。':'The page changed. Retry.');
  if(['vaultId','path','sourceSHA256','page','annotationID'].some(key=>verified[key as keyof PDFAnnotationTarget]!==target[key as keyof PDFAnnotationTarget])||JSON.stringify(verified.rect)!==JSON.stringify(target.rect))throw Error(language==='zh'?'来源 PDF 批注已变化，未定位旧位置；请重新扫描。':'The source PDF annotation changed. Its old position was not highlighted; scan again.');
  setMapEditing(false);setSourceFocus(verified.rect?{schemaVersion:1,path:verified.path,page:verified.page,rect:verified.rect,sourceSHA256:verified.sourceSHA256,quote:verified.quote,nonce:Date.now()}:undefined);
 };
 const locateReviewAt=async(review:ReviewRecord)=>{
  const currentVault=state.current.vault?.id;const currentPath=state.current.active;
  let path=review.boardPath;
  if(currentPath===review.boardPath)path=currentPath;
  else if(review.anchor?.page&&currentPath===review.anchor.sourcePath&&extname(currentPath)==='pdf')path=currentPath;
  else if(review.anchor?.page&&review.anchor.sourcePath&&extname(review.anchor.sourcePath)==='pdf')path=review.anchor.sourcePath;
  const pending=open(path,review.anchor?.page);const navigation=requestEpoch.current;await pending;
  if(!currentVault||state.current.vault?.id!==currentVault||navigation!==requestEpoch.current||pdfWorkspaceBusy())throw Error(language==='zh'?'页面在定位时已改变，请重试。':'The page changed while locating. Retry.');
  setMapEditing(false);setReviewOverlays(true);setReviewsOpen(true);setConnections(false);setReviewFocus({review,nonce:Date.now()});
 };
 const locateReview=(review:ReviewRecord)=>void attempt(()=>locateReviewAt(review));
 const openReviewSourceAt=async(review:ReviewRecord)=>{
  const path=review.anchor?.originalSourcePath||review.anchor?.sourcePath;if(!path)return;
  const currentVault=state.current.vault?.id;const pending=open(path,review.anchor?.page);const navigation=requestEpoch.current;await pending;
  if(!currentVault||state.current.vault?.id!==currentVault||navigation!==requestEpoch.current||pdfWorkspaceBusy())throw Error(language==='zh'?'页面在定位时已改变，请重试。':'The page changed while locating. Retry.');
  setReviewsOpen(true);setConnections(false);setReviewFocus({review,nonce:Date.now()});
 };
 const openReviewSource=(review:ReviewRecord)=>void attempt(()=>openReviewSourceAt(review));
 const closeTab=(target:Tab)=>guard(()=>{
  // A secondary editor is a real tab. Closing it also releases pane references;
  // otherwise restoring its owner's layout could silently reopen the document.
  readingGeneration.current++;const remaining=new Map<string,ReadingWorkspaceSession>();
  for(const[key,session]of readingSessions.current){const next=session.vaultId===target.vaultId?remapReadingWorkspace(session,[],[target.file.path],new Map()):session;if(next)remaining.set(key,next);}
  readingSessions.current=remaining;setReadingRevision(n=>n+1);
  if(focusedReadingFile.current?.path===target.file.path)focusedReadingFile.current=null;
  const remainingTabs=state.current.tabs.filter(x=>x.vaultId!==target.vaultId||x.file.path!==target.file.path),wasActive=state.current.active===target.file.path,nextActive=wasActive?remainingTabs.at(-1)?.file.path||null:state.current.active;state.current={...state.current,tabs:remainingTabs,active:nextActive};notebookSessions.current.delete(notebookSessionKey(target.vaultId,target.file.path));setTabs(old=>old.filter(x=>x.vaultId!==target.vaultId||x.file.path!==target.file.path));if(wasActive)setActive(nextActive);
 },[target]);
 const updateDraft=(value:string)=>setTabs(old=>old.map(x=>x.file.path===active?{...x,draft:value,dirty:value!==(x.document?JSON.stringify(x.document):x.file.text)}:x));
 const runPython=async()=>{if(!tab||!vault||run.current)return;const info=unwrap(await api.info());if(!info.python.available)throw Error(t('pythonUnavailable'));if(!await saveTab(tab))return;const latest=unwrap(await api.readFile({vaultId:vault.id,path:tab.file.path}));if(latest.text!==tab.draft)throw Error(t('sourceChanged'));const id=crypto.randomUUID();run.current={id,started:performance.now()};setConsole({output:'',running:true,status:'running',file:tab.file.name});try{unwrap(await api.runPython({vaultId:vault.id,path:tab.file.path,expectedSHA256:latest.sha256,runId:id}));}catch(e){run.current=null;setConsole(old=>({...old,running:false,status:'failed'}));throw e;}};
 const compileLatex=async()=>{
  if(!tab||!vault||latexBusy)return;const target=tab;const currentVault=vault.id;setLatexBusy(true);setLatexResult(null);
  try{const info=unwrap(await api.latexInfo());if(!info.available)throw Error(language==='zh'?'此安装包没有 LaTeX 编译环境。Mac 完整版包含基础编译器。':'This installation does not include a LaTeX compiler. The complete Mac package includes the basic compiler.');
   if(!await saveTab(target))return;const latest=unwrap(await api.readFile({vaultId:currentVault,path:target.file.path}));if(latest.text!==target.draft)throw Error(t('sourceChanged'));
   const result=unwrap(await api.compileLatex({vaultId:currentVault,path:target.file.path,expectedSHA256:latest.sha256}));if(state.current.vault?.id!==currentVault)return;
   setLatexResult({vaultId:currentVault,...result});setAssetRevision(n=>n+1);await refreshListing.current();
  }finally{setLatexBusy(false);}
 };
 useEffect(()=>{const narrow=matchMedia('(max-width:1050px)');const change=()=>{if(narrow.matches)setConnections(false);};narrow.addEventListener('change',change);return()=>narrow.removeEventListener('change',change);},[]);
 useEffect(()=>{setStatus('');localStorage.setItem('inkspace.language',language);document.documentElement.lang=language==='zh'?'zh-CN':'en';void api.setInterfaceLanguage?.({language}).catch(()=>{});},[language]);
 useEffect(()=>api.onPythonEvent(event=>{if(event.runId!==run.current?.id)return;if(event.kind==='exit'){const elapsed=(performance.now()-run.current.started)/1000;run.current=null;setConsole(old=>({...old,running:false,status:event.exitCode!==0&&event.reason==='completed'?'failed':event.reason||'completed',seconds:elapsed}));}else setConsole(old=>({...old,output:(old.output+(event.text||'')).slice(-2*1024*1024)}));}),[api]);
 useEffect(()=>{const listener=(event:BeforeUnloadEvent)=>{if(pdfLinks.hasPending()||studyLocked()||mediaState.current.dirty||mediaState.current.busy||childSessionsBusy.current||pdfWorkspaceBusy()||fileMutationBusy.current||boardOperationLocks.current.size||transientBoxDirty.current||notebooks.isRunning()||state.current.tabs.some(x=>x.dirty)){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',listener);return()=>window.removeEventListener('beforeunload',listener);},[]);
 useEffect(()=>{const handler=(event:KeyboardEvent)=>{if(spaceRef.current==='study'&&isSaveShortcut(event)&&!document.querySelector('.study-space-layer [role="dialog"]')){event.preventDefault();const target=focusedSaveTarget();if(target)void attempt(async()=>{await saveTab(target);});}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[language]);
 // Saving keeps its existing cadence. Read-only polling is owned by the main process, even when this window is minimized.
 useEffect(()=>{let saving=false;const timer=setInterval(()=>{if(fileMutationBusy.current||saving)return;saving=true;void attempt(async()=>{try{await autosaveTabs(()=>state.current.tabs,saveTab);}finally{saving=false;}});},60000);return()=>clearInterval(timer);},[language]);
 useEffect(()=>{
  if(!vault||!api.watchVault)return;let disposed=false,watchId:string|undefined;let pending=false,again=false;const vaultId=vault.id;
  const canReload=(target:Tab)=>{if(notebooks.isRunning(target.vaultId,target.file.path))return false;const key=target.vaultId+':'+target.file.path;return !studyLocked()&&!pdfWorkspaceBusy(vaultId)&&!target.dirty&&!transientBoxDirty.current&&!manualRefresh.current&&!fileMutationBusy.current&&!boardOperationLocks.current.has(key)&&!saves.current.has(key);};
  const unavailable=()=>{if(!disposed&&state.current.vault?.id===vaultId)setWatchError(language==='zh'?'同步中的文件暂不可读，已保留当前内容。':'A syncing file is temporarily unavailable; the current content is preserved.');};
  const rescan=async()=>{
   if(disposed||fileMutationBusy.current)return;if(pending){again=true;return;}pending=true;
   try{do{again=false;
    const current=state.current.tabs.find(x=>x.file.path===state.current.active&&x.vaultId===vaultId);
    if(current&&canReload(current)){
     const result=await readTabFile(vaultId,current.file.path);
     if(disposed||fileMutationBusy.current||state.current.vault?.id!==vaultId)break;
     const latest=state.current.tabs.find(x=>x.file.path===current.file.path&&x.vaultId===vaultId);
     if(latest&&canReload(latest)&&latest.draft===current.draft&&latest.file.sha256===current.file.sha256){
      const sameBoard=result.ok&&(current.file.kind!=='board'||(result.value.file.kind==='board'&&(result.value.file.board as {id?:string})?.id===(current.file.board as {id?:string})?.id));
      if(result.ok&&sameBoard){setWatchError('');setTabs(old=>old.map(x=>x.vaultId===vaultId&&x.file.path===current.file.path&&x.file.sha256===current.file.sha256&&x.draft===current.draft&&canReload(x)&&result.value.file.sha256!==x.file.sha256?{...x,...result.value}:x));}
      else unavailable();
     }
    }
    if(!disposed&&state.current.vault?.id===vaultId)setAssetRevision(n=>n+1);
   }while(again&&!disposed);}catch{unavailable();}finally{pending=false;}
  };
  const unsubscribe=api.onVaultChange(event=>{if(disposed||fileMutationBusy.current||event.vaultId!==vaultId||event.watchId!==watchId)return;if(event.reason==='change'&&!event.rescan&&event.paths.length>0&&event.paths.every(path=>/(^|\/)\.[^/]+\.pdf\.inkspace-pdf$/i.test(path)))return;if(event.reason==='unavailable')setWatchMessage(language==='zh'?'资料文件夹暂不可用，请重新打开':'The folder is unavailable; reopen it');else if(event.reason==='limit')setWatchMessage(language==='zh'?'自动监听受限 · 每分钟补查':'Limited watch · checks every minute');void rescan();void refreshListing.current().catch(()=>{});});
  void api.watchVault({vaultId}).then(result=>{if(!result.ok){if(!disposed)setWatchMessage(language==='zh'?'自动监听不可用，请重新打开资料文件夹':'File watching is unavailable; reopen the folder');return;}if(disposed){void api.unwatchVault({watchId:result.value.watchId});return;}watchId=result.value.watchId;setWatchMessage(result.value.limited||result.value.mode!=='native'?(language==='zh'?'自动监听受限 · 每分钟补查':'Limited watch · checks every minute'):(language==='zh'?'自动检查文件变化':'Watching file changes'));void rescan();});
  const focus=()=>void rescan();window.addEventListener('focus',focus);return()=>{disposed=true;unsubscribe();window.removeEventListener('focus',focus);if(watchId)void api.unwatchVault({watchId});};
 },[vault?.id,language]);
 const wikiLink=(target:string)=>{const link=noteLinks.data?.outgoing.find(x=>x.target===target);if(link?.path)void attempt(()=>open(link.path!));else setError(t('wikiUnresolved'));};
 const localLink=(path:string)=>{let decoded:string;try{decoded=decodeURIComponent(path);}catch{setError(t('error'));return;}const parts=(active?.split('/').slice(0,-1)||[]);for(const p of decoded.split('/')){if(p==='..')parts.pop();else if(p!=='.'&&p)parts.push(p);}void attempt(()=>open(parts.join('/')));};
 const marginPath=active?marginPaths[active]:undefined;const marginTab=tabs.find(x=>x.file.path===marginPath);
 const resolveAsset=useCallback(async(source:string,basePath:string)=>{if(!vault)return;const parts=basePath.split('/').slice(0,-1);let decoded;try{decoded=decodeURIComponent(source);}catch{return;}for(const part of decoded.split('/')){if(part==='..'){if(!parts.length)return;parts.pop();}else if(part&&part!=='.')parts.push(part);}const result=await api.getAssetUrl({vaultId:vault.id,path:parts.join('/')});return result.ok?result.value.url:undefined;},[vault?.id]);
 const mediaResolver=useCallback((source:string)=>resolveAsset(source,active||''),[resolveAsset,active]);
 const marginResolver=useCallback((source:string)=>resolveAsset(source,marginPath||''),[resolveAsset,marginPath]);
 const openMargin=()=>void attempt(async()=>{if(!vault||!tab)return;const source=tab.file.path;const notePath=source+'.notes.md';const existing=tabs.find(x=>x.file.path===notePath);if(!existing){const result=await api.readFile({vaultId:vault.id,path:notePath});let file:OpenedFile;if(result.ok)file=result.value;else if(result.error.code==='NOT_FOUND'){file=unwrap(await api.createTextFile({vaultId:vault.id,parentPath:source.split('/').slice(0,-1).join('/'),name:basename(notePath),content:'# '+tab.file.name+'\n\n['+(language==='zh'?'原文件':'Source file')+']('+encodeURIComponent(tab.file.name)+')\n\n'}));}else throw Error(result.error.message);if(state.current.vault?.id!==vault.id)return;setTabs(old=>[...old,{vaultId:vault.id,file,draft:file.text||'',dirty:false}]);}setConnections(false);setMarginPaths(old=>({...old,[source]:notePath}));});
 const insertMarginImage=()=>void attempt(async()=>{if(!vault||!marginTab)return;const result=unwrap(await api.importImage({vaultId:vault.id,parentPath:marginTab.file.path.split('/').slice(0,-1).join('/')}));if(!result)return;if(state.current.vault?.id!==vault.id)return;const imageName=basename(result.path);setTabs(old=>old.map(x=>x.file.path===marginTab.file.path?{...x,draft:x.draft+'\n\n!['+imageName.replace(/[\[\]]/g,'')+']('+encodeURIComponent(imageName)+')\n',dirty:true}:x));});
 const openGraph=()=>guard(()=>{if(vault){setKnowledgeMode('space');setGraphVisible(true);}},[]);
 const openKnowledgeLinks=()=>void attempt(async()=>{if(!vault)return;setKnowledgeMode('links');setGraph(null);const result=unwrap(await api.knowledgeGraph({vaultId:vault.id}));if(state.current.vault?.id===vault.id)setGraph(result);});
 const beginLasso=()=>{const area=document.querySelector('.content-and-links')?.getBoundingClientRect();if(area)setLassoArea(area);};
 const extractNote=()=>void attempt(async()=>{if(!vault||!tab)return;let text='';let truncated=false;if(tab.document){const model=JSON.parse(tab.draft) as EditableDocumentModel;const lines=(blocks:EditableDocumentModel['blocks'])=>blocks.map(b=>(b.kind==='heading'?'## ':b.kind==='bullet'?'- ':'')+b.text).join('\n\n');text=model.format==='pptx'?(model.slides||[]).map(s=>'# '+s.title+'\n\n'+lines(s.blocks)).join('\n\n---\n\n'):'# '+model.title+'\n\n'+lines(model.blocks);}else if(tab.file.kind==='docx'||tab.file.kind==='pptx'||tab.file.kind==='spreadsheet'){const parsed=new DOMParser().parseFromString(tab.file.html||'','text/html');text=Array.from(parsed.querySelectorAll('p,h1,h2,h3,li,tr')).map(node=>node.textContent||'').join('\n\n');}else if(extension==='pdf'&&tab.file.assetUrl){setLoading(true);try{const result=await extractPDFText(tab.file.assetUrl);text=result.text;truncated=result.truncated;}finally{setLoading(false);}}else return;if(!text.trim())throw Error(language==='zh'?'未找到可提取的文字；扫描件需要先进行文字识别。':'No text found. Scanned pages need OCR first.');const suffix=language==='zh'?'.提取.md':'.extracted.md';const source=tab.file.path;const content='# '+tab.file.name+'\n\n['+(language==='zh'?'原文件':'Source file')+']('+encodeURIComponent(tab.file.name)+')\n\n'+(truncated?(language==='zh'?'> 提取达到长度限制，以下不是完整原文。\n\n':'> Extraction reached its limit; this is not the complete source.\n\n'):'')+text;const file=unwrap(await api.createTextFile({vaultId:vault.id,parentPath:source.split('/').slice(0,-1).join('/'),name:tab.file.name+suffix,content}));if(state.current.vault?.id!==vault.id)return;setTabs(old=>[...old,{vaultId:vault.id,file,draft:file.text||'',dirty:false}]);setActive(file.path);await refresh();});
 const exportCurrentPDF=async()=>{if(tab&&!tab.document&&['docx','pptx','spreadsheet'].includes(tab.file.kind)){const images=Array.from(document.querySelectorAll<HTMLImageElement>('.document-preview img[src]'));if(images.some(image=>!image.complete||!image.naturalWidth))throw Error(language==='zh'?'有图片仍在加载或无法显示，尚未导出；请等待加载完成或用原应用查看。':'An image is still loading or cannot be displayed. Export has not started; wait for loading or inspect it in the original application.');}if(extension==='pdf'&&!tab?.document){const image=document.querySelector<HTMLImageElement>('.pdf-reader [data-current=true] .pdf-print-image');if(!image?.complete||!image.naturalWidth)throw Error(language==='zh'?'页面仍在加载，请显示完整后再导出。':'The page is still loading. Export after it finishes rendering.');}const result=unwrap(await api.exportCurrentViewPDF(tab?{name:displayBrand(language)+'-current-view.pdf',source:{vaultId:tab.vaultId,path:tab.file.path,expectedSHA256:tab.file.sha256}}:undefined));if(result.saved)setStatus(t('exportDone'));};
 const exportPDF=()=>void attempt(async()=>{if(!tab||!vault)return;if(pdfWorkspaceBusy()||transientBoxDirty.current||childSessionsBusy.current||boardOperationLocks.current.size)throw Error(language==='zh'?'请先完成并保存当前编辑。':'Finish and save the current edit first.');if(tab.dirty&&!await saveTab(tab))return;const file=unwrap(await api.readFile({vaultId:vault.id,path:tab.file.path}));setExportFile({file,vaultId:vault.id,view:captureExportView(file)});});
 const browserTarget=async()=>{const source=state.current.active||((homeSource.current?.vaultId===state.current.vault?.id)?homeSource.current?.path:null);const current=state.current.tabs.find(x=>x.file.path===source&&x.vaultId===state.current.vault?.id);if(!state.current.vault)return undefined;if(current?.file.kind==='board'){if(pdfWorkspaceBusy()||transientBoxDirty.current||childSessionsBusy.current||boardOperationLocks.current.size)throw Error(language==='zh'?'请先完成当前编辑。':'Finish the current edit first.');if(current.dirty&&!await saveTab(current))throw Error(language==='zh'?'请先保存当前白板。':'Save the current board first.');return{vaultId:state.current.vault.id,parentPath:current.file.path.split('/').slice(0,-1).join('/'),boardPath:current.file.path};}return{vaultId:state.current.vault.id,parentPath:listing?.path||''};};
 const openBrowser=()=>void attempt(async()=>{unwrap(await api.openBrowser(await browserTarget()||{}));});
 const openBrowserWorkbench=()=>{const owner=state.current.vault;if(!owner){openBrowser();return;}setBrowserWorkbench({vaultId:owner.id,folderPath:listing?.path||''});};
 const clipBoardReady=()=>{if(fileMutationBusy.current||boardOperationLocks.current.size||saves.current.size||pdfWorkspaceBusy()||childSessionsBusy.current||transientBoxDirty.current||pdfLinks.hasPending()||studyLocked())throw Error(language==='zh'?'请先完成当前编辑或保存，再放置剪藏。':'Finish current edits or saves before placing a clip.');};
 const prepareClipBoard=async(path:string)=>{clipBoardReady();const owner=state.current.vault;if(!owner||owner.id!==browserWorkbench?.vaultId)throw Error(t('sourceChanged'));let current=state.current.tabs.find(t=>t.vaultId===owner.id&&t.file.path===path);if(current?.dirty){if(!await saveTab(current))throw Error(t('sourceChanged'));await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));current=state.current.tabs.find(t=>t.vaultId===owner.id&&t.file.path===path);}const file=unwrap(await api.readFile({vaultId:owner.id,path}));const latest=state.current.tabs.find(t=>t.vaultId===owner.id&&t.file.path===path);if(state.current.vault?.id!==owner.id||file.kind!=='board'||latest?.dirty||latest!==current)throw Error(t('sourceChanged'));if(latest){const observed=latest;setTabs(old=>old.map(t=>t===observed?{...t,file,draft:JSON.stringify(file.board),dirty:false}:t));}return file;};

 const placeBrowserClip=async(entry:BrowserClipEntry,inspection:BrowserClipInspection,target:OpenedFile,point:MergePoint)=>{clipBoardReady();const owner=state.current.vault;if(!owner||owner.id!==browserWorkbench?.vaultId)throw Error(t('sourceChanged'));const current=state.current.tabs.find(t=>t.vaultId===owner.id&&t.file.path===target.path);if(current&&(current.dirty||current.file.sha256!==target.sha256))throw Error(language==='zh'?'白板在预览后有变化，请重新选择白板和位置；现有内容保留。':'The board changed after preview. Choose it and its position again; current content was kept.');const targetTab:Tab=current||{vaultId:owner.id,file:target,draft:JSON.stringify(target.board),dirty:false};const placed=await performBoardChange(targetTab,expectedSHA256=>api.clipCatalogPlace({vaultId:owner.id,ref:entry.ref,targetPath:target.path,expectedSHA256,contentSHA256:inspection.contentSHA256,...point}));await open(target.path,undefined,true);if(state.current.vault?.id===owner.id){if(placed?.selectedIDs?.[0])setMindFocus({id:placed.selectedIDs[0],nonce:Date.now()});setBrowserWorkbench(null);}};
 const importBrowserClip=()=>void attempt(async()=>{const target=await browserTarget();if(!target)return;const result=unwrap(await api.importBrowserClip(target));if(result){setStatus(result.warning||(language==='zh'?'已导入网页剪藏：':'Imported web clip: ')+result.path);await refresh();setAssetRevision(n=>n+1);}});
 const goHome=()=>guard(()=>{if(state.current.active&&state.current.vault)homeSource.current={vaultId:state.current.vault.id,path:state.current.active};requestEpoch.current++;setLoading(false);setGraphVisible(false);setActive(null);},[]);
 const newFromHome=(kind:NewDocumentKind)=>{if(!vault)return;setNewParent(listing?.path||'');setNewKind(kind);setShowNew(true);};
 const browseWorkspaceFiles=(kind:WorkspaceFileKind)=>{if(vault)guard(()=>{if(kind==='reviews')setReviewQueueRequest({vaultId:vault.id,folderPath:listing?.path||''});else setWorkspacePicker({vault,kind,folder:listing?.path||''});},[]);};
 const manageFromHome=()=>{if(!vault)return;guard(()=>{if(!panels.leftOpen)panels.toggleLeft();setManageRequest(n=>n+1);setStatus(language==='zh'?'在文件栏选择项目，然后移动、分享或删除。':'Select files in the sidebar, then move, share or delete them.');},[]);};
 const taskForCurrent=()=>{if(vault&&tab)guard(()=>setChecklistRequest({vault,folder:tab.file.path.split('/').slice(0,-1).join('/'),sourcePath:tab.file.path}),[]);};
 const pdfFileActions=(file:OpenedFile)=>{const primary=tab?.file.path===file.path;return <div className="pdf-file-menu-actions" inert={pdfBusyUI||undefined}>
  {primary&&sourceReturn?.vaultId===tab?.vaultId&&<Button data-testid="pdf-return-mind-map" onClick={()=>void attempt(async()=>{const back=sourceReturn;await open(back.path);if(state.current.vault?.id===back.vaultId){setMapEditing(true);setSourceFocus(undefined);}})}>{language==='zh'?'返回思维导图':'Back to mind map'}</Button>}
  <Button data-testid="file-create-task" onClick={()=>{if(vault)guard(()=>setChecklistRequest({vault,folder:file.path.split('/').slice(0,-1).join('/'),sourcePath:file.path}),[]);}}><ListChecks/>{language==='zh'?'创建任务':'Create task'}</Button>
  {['doc','docx','ppt','pptx','xls','xlsx','xlsm','csv','pdf','txt','md','markdown','tex','png','jpg','jpeg','mp4','mov','m4v'].includes(extname(file.path))&&<Button onClick={()=>setOpenChoice({path:file.path})}>{language==='zh'?'打开方式':'Open with'}</Button>}
  {['pdf','png','jpg','jpeg'].includes(extname(file.path))&&<Button data-testid="file-ocr" onClick={()=>{if(vault)guard(()=>setOCRSource({vault,path:file.path}),[]);}}><ScanText/>{language==='zh'?'图文识别':'OCR'}</Button>}
  {primary?<>{(tab?.document||['docx','pptx','spreadsheet'].includes(file.kind)||extname(file.path)==='pdf')&&<Button onClick={extractNote}><FileOutput/>{language==='zh'?'提取为笔记':'Extract text to note'}</Button>}<Button className="review-toolbar-button" data-testid="review-toggle" data-has-reviews={reviewState.reviews.length>0} onClick={()=>{setReviewsOpen(v=>!v);setConnections(false);}}><MessageSquareText/>{language==='zh'?'待修改批注':'Review annotations'}{reviewState.reviews.length>0&&<span className="review-count">{reviewState.reviews.length}</span>}</Button><Button onClick={openMargin}><StickyNote/>{language==='zh'?'旁注笔记':'Margin notes'}</Button><Button title={language==='zh'?'下载与导出':'Download & export'} onClick={exportPDF}><Download/>{language==='zh'?'下载与导出':'Download & export'}</Button></>:<><Button onClick={()=>void attempt(()=>open(file.path))}>{language==='zh'?'在独立标签页打开':'Open in its own tab'}</Button><p>{language==='zh'?'在独立标签页可提取文字、添加旁注和导出当前视图。':'Open its own tab to extract text, add margin notes and export the current view.'}</p></>}
 </div>;};
 const readingDocumentLink=(source:string,target:string)=>{let decoded:string;try{decoded=decodeURIComponent(target);}catch{setError(t('error'));return;}const parts=source.split('/').slice(0,-1);for(const part of decoded.split('/')){if(part==='..'){if(!parts.length){setError(t('error'));return;}parts.pop();}else if(part&&part!=='.')parts.push(part);}void attempt(()=>requestOpen(parts.join('/')));};
 const closeRegionCard=()=>{if(regionSaving.current)return;regionGeneration.current++;const value=regionCardRef.current;regionCardRef.current=null;setRegionCard(null);if(value)void api.cancelBoardRegionCard({requestId:value.requestId,...(value.preview?{token:value.preview.token}:{})});};
 useEffect(()=>{const value=regionCardRef.current;if(value&&(value.vaultId!==vault?.id||value.path!==active))closeRegionCard();},[vault?.id,active]);
 useEffect(()=>()=>{const value=regionCardRef.current;regionGeneration.current++;if(value)void api.cancelBoardRegionCard({requestId:value.requestId,...(value.preview?{token:value.preview.token}:{})});},[]);
 const prepareRegionCard=async(target:Tab)=>{if(studyLocked()||fileMutationBusy.current||boardOperationLocks.current.size||childSessionsBusy.current||pdfWorkspaceBusy()||transientBoxDirty.current)throw Error(language==='zh'?'请先完成当前编辑。':'Finish the current edit first.');const latest=state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.file.path);if(!latest||state.current.vault?.id!==target.vaultId||state.current.active!==target.file.path)throw Error('CONFLICT');if(latest.dirty&&!await saveTab(latest))throw Error(language==='zh'?'白板尚未保存，未开始制卡。':'The board was not saved; region capture did not start.');};
 const captureRegionCard=async(target:Tab,value:{rect:CaptureRect;screenRect:CaptureRect;canvasID:string})=>{if(studyLocked()||fileMutationBusy.current||boardOperationLocks.current.size||childSessionsBusy.current||pdfWorkspaceBusy())throw Error('BUSY');const latest=state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.file.path),canvas=()=>document.querySelector(`[data-region-canvas-id="${value.canvasID}"]`);if(!latest||latest.dirty||state.current.vault?.id!==target.vaultId||state.current.active!==target.file.path||!canvas())throw Error(language==='zh'?'白板或选区已变化，请重新框选。':'The board or selection changed. Select again.');const requestId=crypto.randomUUID(),n=++regionGeneration.current,request={vaultId:latest.vaultId,path:latest.file.path,boardID:String(latest.file.board?.id),requestId};regionCardRef.current=request;setRegionCard(request);try{const preview=unwrap(await api.prepareBoardRegionCard({...request,expectedSHA256:latest.file.sha256,...value}));if(n!==regionGeneration.current||regionCardRef.current?.requestId!==requestId||state.current.vault?.id!==request.vaultId||state.current.active!==request.path||!canvas()){void api.cancelBoardRegionCard({requestId,token:preview.token});if(regionCardRef.current?.requestId===requestId){regionCardRef.current=null;setRegionCard(null);}return;}regionCardRef.current={...request,preview};setRegionCard({...request,preview});}catch(e){if(n===regionGeneration.current&&regionCardRef.current?.requestId===requestId){regionCardRef.current=null;setRegionCard(null);throw e;}}};
 const regionCardSaved=(result:BoardRegionCardResult)=>{const request=regionCardRef.current;if(!request||result.file.path!==request.path||String(result.file.board?.id).toLowerCase()!==request.boardID.toLowerCase())throw Error('CONFLICT');const latest=state.current.tabs.find(t=>t.vaultId===request.vaultId&&t.file.path===request.path);if(!latest||latest.dirty)throw Error('CONFLICT');savedBoardFiles.current.set(request.vaultId+':'+request.path,result.file);setTabs(old=>old.map(t=>t.vaultId===request.vaultId&&t.file.path===request.path&&!t.dirty?{...t,file:result.file,draft:JSON.stringify(result.file.board),dirty:false}:t));regionSaving.current=false;regionCardRef.current=null;setRegionCard(null);regionGeneration.current++;setAssetRevision(n=>n+1);setStatus(language==='zh'?'区域卡片已保存；原内容保持不变。':'Region card saved; originals stay in place.');openStudy({...latest,file:result.file},result.itemID);};
 const renderBoard=(target:Tab,board:Record<string,unknown>,focus?:{id:string;nonce:number},onSource?:(path:string,reference?:PDFSourceReference,page?:number)=>void,onViewport?:(camera:{x:number;y:number;zoom:number})=>void,initialViewport?:{x:number;y:number;zoom:number},onFocusApplied?:(request:{id:string;nonce:number})=>void)=><BoardViewer disabled={!!mergeSource||!!regionCard} onPrepareRegionCard={!onSource?()=>prepareRegionCard(target):undefined} onCreateRegionCard={!onSource?value=>captureRegionCard(target,value):undefined} onFocusApplied={onFocusApplied} initialCompact={!!onSource} initialDirectoryOpen={!onSource} focusItemRequest={focus} onOpenSource={onSource} onViewportChange={camera=>{workspaceCameras.current.set(workspaceSessionKey(target.vaultId,target.file.path),camera);onViewport?.(camera);}} initialViewport={initialViewport||workspaceCameras.current.get(workspaceSessionKey(target.vaultId,target.file.path))} onReplayActiveChange={setBoardReplayActive} key={`${target.vaultId}:${target.file.path}`} raw={board} boardPath={target.file.path} boardSHA={target.file.sha256} assetRevision={assetRevision} operationBusy={boardOperationKey===target.vaultId+':'+target.file.path} onBoardOperation={operation=>performBoardOperation(target,operation)} onAddNote={point=>setBoardText({vaultId:target.vaultId,path:target.file.path,...point,title:'',text:'',kind:'text',textFormat:'richText'})} canUndo={boardHistory.canUndo||target.dirty||canUndoLastBoardMerge(target)} canRedo={boardHistory.canRedo&&!target.dirty&&!canUndoLastBoardMerge(target)} onUndo={()=>canUndoLastBoardMerge(target)?undoLastBoardMerge():performBoardChange(target,expectedSHA256=>api.undoBoard({vaultId:target.vaultId,path:target.file.path,expectedSHA256})).then(()=>{})} onRedo={()=>performBoardChange(target,expectedSHA256=>api.redoBoard({vaultId:target.vaultId,path:target.file.path,expectedSHA256})).then(()=>{})} onChildBoards={itemID=>setChildTarget({vaultId:target.vaultId,path:target.file.path,itemID})}
 onAddChildBoard={point=>setChildTarget({vaultId:target.vaultId,path:target.file.path,...point})}
 onChildBusyChange={busy=>{childSessionsBusy.current=busy;}}
 onBeforeChildMutation={async path=>{const current=state.current.tabs.find(x=>x.vaultId===target.vaultId&&x.file.path===path);const key=target.vaultId+':'+path;if(state.current.vault?.id!==target.vaultId||fileMutationBusy.current||current?.dirty||saves.current.has(key)||boardOperationLocks.current.has(key)||(boardText?.vaultId===target.vaultId&&boardText.path===path))throw Error(language==='zh'?'这个子白板正在另一处编辑，请先保存或取消那里的修改。':'This child board has another active edit. Save or cancel it first.');}}
 onChildSaved={file=>{if(state.current.vault?.id!==target.vaultId)return;savedBoardFiles.current.set(target.vaultId+':'+file.path,file);setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===file.path&&!x.dirty?{...x,file,draft:JSON.stringify(file.board),dirty:false}:x));setAssetRevision(n=>n+1);}} onPasteContent={(content,point)=>performBoardChange(target,expectedSHA256=>api.pasteBoardContent({vaultId:target.vaultId,path:target.file.path,expectedSHA256,...point,content}))} onDropFiles={(paths,point)=>performBoardChange(target,expectedSHA256=>api.addBoardFileCards({vaultId:target.vaultId,path:target.file.path,expectedSHA256,sourcePaths:paths,x:point.x,y:point.y})).then(()=>{})} onAddFile={point=>setAddFileAt({vaultId:target.vaultId,path:target.file.path,...point})} onEditItem={id=>{const item=(board.items as Array<Record<string,unknown>>).find((x:Record<string,unknown>)=>x.id===id);if(item&&(item.kind==='text'||item.kind==='formula')){if(item.textFormat&&!['richText','markdown','latex','python'].includes(String(item.textFormat))){setError(language==='zh'?'这个文本框使用更新版本的格式，请先更新软件。':'This box uses a newer format. Update the app before editing it.');return;}setBoardText({vaultId:target.vaultId,path:target.file.path,id,x:Number(item.x),y:Number(item.y),title:String(item.title||''),text:String(item.text||''),kind:item.kind,textFormat:(item.textFormat||(item.kind==='formula'?'latex':'richText')) as BoardTextFormat,richTextHTML:typeof item.richTextHTML==='string'?item.richTextHTML:undefined,originalContent:boxSignature(item)});}}} vaultId={target.vaultId} language={language} reviews={reviewOverlays?reviewState.reviews:[]} reviewFocus={reviewFocus} onReview={review=>{setReviewFocus({review,nonce:Date.now()});setReviewsOpen(true);setConnections(false);}} onOpen={(path,page,playback)=>void attempt(()=>requestOpen(path,page,playback))}/>;
 const renderReadingEditor=(file:OpenedFile)=>{
  const target=tabs.find(x=>x.vaultId===vault?.id&&x.file.path===file.path);
  if(file.kind!=='text'&&!target?.document)return undefined;
  const ownerVault=vault!.id,path=file.path;
  const current=()=>state.current.tabs.find(x=>x.vaultId===ownerVault&&x.file.path===path);
  return <WorkspaceFileEditor key={ownerVault+':'+path} notebookSession={notebookSessions.current.get(notebookSessionKey(ownerVault,path))} onNotebookSessionChange={session=>rememberNotebookSession(ownerVault,path,session)} file={target?.file||file} draft={target?.draft} document={target?.document} dirty={!!target?.dirty} language={language} vaultId={ownerVault} runState={notebooks.states[notebookKey(ownerVault,path)]} onPrepare={()=>prepareReadingFile(file)} onChange={value=>setTabs(old=>old.map(x=>x.vaultId===ownerVault&&x.file.path===path?{...x,draft:value,dirty:value!==(x.document?JSON.stringify(x.document):x.file.text)}:x))} onSave={async()=>{const latest=current();return latest?saveTab(latest):false;}} onRun={indices=>{const latest=current();if(latest)requestNotebookRun(latest,indices);}} onInterrupt={()=>void attempt(()=>notebooks.interrupt(ownerVault,path))} onRestart={()=>void attempt(()=>restartNotebook(ownerVault,path))} resolveMedia={source=>resolveAsset(source,path)} onLocalLink={target=>readingDocumentLink(path,target)}/>;
 };
 const readingWorkspace=(file:OpenedFile)=>{const generation=readingGeneration.current;const key=readingTabKey(tab!.vaultId,file.path),study=pdfStudies.get(key),target=study?tabs.find(x=>x.vaultId===study.vaultId&&x.file.path===study.target.path&&String(x.file.board?.id).toLowerCase()===study.target.boardID.toLowerCase()):undefined;let board:Record<string,unknown>|undefined;try{board=target?(target.dirty?JSON.parse(target.draft):target.file.board):undefined;}catch{board=target?.file.board;}const blocked=pdfBusyUI||!!boardOperationKey||childSessionsBusy.current||transientBoxDirty.current||studyLocked()||pdfLinks.pending||pdfLinks.busy;return <PDFBoardStudyLayout key={key} study={study} language={language} onBoardFocus={()=>{if(target)focusedReadingFile.current={owner:file.path,vaultId:target.vaultId,path:target.file.path};}} blocked={blocked} dirty={!!target?.dirty} onSave={()=>{if(target)void attempt(async()=>{await saveTab(target);});}} onChange={patch=>changePDFStudy(key,patch)} onLocate={()=>{if(study?.lastExcerptID)changePDFStudy(key,{mode:'split',focus:{id:study.lastExcerptID,nonce:Date.now()}});}} board={target&&board?renderBoard(target,board,study?.focus&&pdfStudyFocusConsumed.current.get(pdfStudyCameraKey(study))!==study.focus.nonce?study.focus:undefined,(path,reference,page)=>{if(study)void attempt(()=>navigatePDFStudy(study,path,reference,page));},camera=>{if(study)pdfStudyCameras.current.set(pdfStudyCameraKey(study),camera);},study?pdfStudyCameras.current.get(pdfStudyCameraKey(study)):undefined,request=>{if(study)pdfStudyFocusConsumed.current.set(pdfStudyCameraKey(study),request.nonce);}):undefined} reader={<PDFWorkspace renderEditor={renderReadingEditor} prepareFile={prepareReadingFile} getCurrentFile={source=>{const current=tabs.find(x=>x.vaultId===tab!.vaultId&&x.file.path===source.path);return current?{...current.file,...(current.file.kind==='text'?{text:current.draft}:{}),...(current.document&&current.dirty?{warnings:[...(current.file.warnings||[]),language==='zh'?'有未保存的修改：阅读预览显示已保存版本，编辑模式保留最新草稿。':'Unsaved changes: reading shows the saved version; editing keeps your latest draft.']}: {})}:source;}} onPaneFocus={source=>{focusedReadingFile.current={owner:file.path,vaultId:tab!.vaultId,path:source.path};}} session={readingSessions.current.get(readingTabKey(tab!.vaultId,file.path))} onSessionChange={session=>{const ownerVault=tab!.vaultId;if(generation===readingGeneration.current&&session.vaultId===ownerVault&&session.primaryPath===file.path&&state.current.vault?.id===ownerVault&&state.current.tabs.some(t=>t.vaultId===ownerVault&&t.file.path===file.path))readingSessions.current.set(readingTabKey(ownerVault,file.path),session);}} onPrimaryRefresh={async()=>{const current=state.current.tabs.find(t=>t.vaultId===tab!.vaultId&&t.file.path===file.path);if(!current||current.dirty)throw Error(language==='zh'?'请先保存当前文档。':'Save the current document first.');await open(file.path,current.initialPage,true);}} fileActions={pdfFileActions} excerptBlocked={pdfLinks.pending||pdfLinks.busy} boardLinkToolbar={path=><PDFBoardLinkToolbar compact c={pdfLinks} path={path} language={language}/>} onCreateExcerpt={pdfLinks.receive} sourceFocus={sourceFocus} sourceNavigation={study?.navigation} linkedExcerpts={board&&Array.isArray(board.items)?board.items.flatMap(item=>{const ref=boardPDFSourceReference(item.sourceReference);return ref?[{id:String(item.id),title:String(item.title||''),reference:ref}]:[] }):[]} onLocateExcerpt={id=>{if(study)changePDFStudy(key,{mode:'split',focus:{id,nonce:Date.now()}});}} key={tab!.vaultId+':'+file.path+':'+readingRevision} vaultId={tab!.vaultId} file={file} initialPage={tab!.initialPage} language={language} reviews={reviewOverlays?reviewState.reviews:[]} reviewFocus={reviewFocus} onReview={review=>{setReviewFocus({review,nonce:Date.now()});setReviewsOpen(true);setConnections(false);}} onDocumentLink={readingDocumentLink} onRootFileLink={path=>void attempt(()=>requestOpen(path))} onWikiLink={wikiLink} onReadingOpen={(path,page,playback)=>void attempt(()=>requestOpen(path,page,playback))} resolveDocumentMedia={(source,path)=>resolveAsset(path,source)}/>}/>;};
 const assertWorkspaceReady=()=>{
  if(pdfLinks.hasPending()||studyLocked()||childSessionsBusy.current||transientBoxDirty.current||pdfWorkspaceBusy()||fileMutationBusy.current||boardOperationLocks.current.size||saves.current.size||mediaState.current.dirty||mediaState.current.busy||excerptRequest||mergeSource||run.current||notebooks.isRunning()||latexBusy)
   throw Error(language==='zh'?'请先完成或保存当前批注、卡片、文本框与运行任务，再保存或切换工作区；现有内容已保留。':'Finish or save pending annotations, cards, text boxes and running jobs before saving or switching workspaces. Current content was kept.');
 };
 const captureCourseWorkspace=():CourseWorkspaceLayout=>{
  assertWorkspaceReady();window.dispatchEvent(new Event('inkspace:capture-reading-session'));
  const current=state.current;if(!current.vault)throw Error(language==='zh'?'请先打开资料文件夹。':'Open a folder first.');
  return{version:1,folderPath:listing?.path||'',tabs:current.tabs.filter(x=>x.vaultId===current.vault!.id).map(target=>{
   const key=workspaceSessionKey(target.vaultId,target.file.path),reading=captureWorkspaceReading(readingSessions.current.get(key)),boardCamera=workspaceCameras.current.get(key);
   return{path:target.file.path,...(target.initialPage!==undefined?{initialPage:target.initialPage}:{}),...(reading?{reading}:{}),...(boardCamera?{boardCamera}:{}),...(workspacePositions.current.has(key)?{surfacePosition:workspacePositions.current.get(key)}:{})};
  }),activePath:current.active,presentation:mode,panels:panels.snapshot()};
 };
 const saveCourseWorkspace=async(name:string,revision:string|null):Promise<CourseWorkspaceList>=>{
  const layout=captureCourseWorkspace(),owner=state.current.vault!;
  return unwrap(await api.saveCourseWorkspace({vaultId:owner.id,name,layout,revision}));
 };
 const restoreCourseWorkspace=async(entry:CourseWorkspaceSummary,saveEdits:boolean)=>{
  assertWorkspaceReady();if(workspaceRestorePending.current)throw Error(language==='zh'?'工作区仍在准备中。':'A workspace is still preparing.');
  workspaceRestorePending.current=true;
  try{
   if(saveEdits){for(const target of state.current.tabs.filter(x=>x.dirty)){if(!await saveTab(target))throw Error(language==='zh'?'当前修改未能完整保存，工作区没有切换。':'Current changes could not be fully saved. The workspace was not switched.');}
    // Let React publish the save results before taking the transaction fence.
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
   }
   assertWorkspaceReady();if(state.current.tabs.some(x=>x.dirty))throw Error(language==='zh'?'仍有未保存修改，工作区没有切换。':'Unsaved changes remain. The workspace was not switched.');
   const before={...state.current},generation=readingGeneration.current;
   const stillCurrent=()=>state.current.vault===before.vault&&state.current.tabs===before.tabs&&state.current.active===before.active&&readingGeneration.current===generation;
   const prepared=unwrap(await api.prepareCourseWorkspace({id:entry.id}));if(!stillCurrent())throw Error(language==='zh'?'当前页面在准备时发生变化，请重试；修改已保留。':'The current pages changed while preparing. Retry; changes were kept.');
   const chosen=prepared.vault,layout=prepared.layout;
   const nextListing=unwrap(await api.listDirectory({vaultId:chosen.id,path:layout.folderPath}));
   if(layout.tabs.some(saved=>isVideoPath(saved.path)))throw Error(language==='zh'?'视频浮窗不能作为主标签恢复，请从并排窗格打开视频。':'Floating videos cannot be restored as primary tabs. Open the video in a reading pane.');
   const {loaded}=await prepareCourseWorkspace(layout,async path=>{
    if(!isVideoPath(path))return unwrap(await readTabFile(chosen.id,path));
    const probe=unwrap(await api.getVideoUrl({vaultId:chosen.id,path}));unwrap(await api.releaseVideoUrl({url:probe.url}));
    // Only the video pane's fresh name/path are consumed; no URL, playback,
    // subtitle payload or fictitious content digest enters the saved layout.
    return{file:{path:probe.path,name:probe.name,kind:'media' as const,sha256:'',bytes:probe.bytes},draft:''};
   },stillCurrent);
   assertWorkspaceReady();if(!stillCurrent()||state.current.tabs.some(x=>x.dirty))throw Error(language==='zh'?'当前编辑已变化，工作区没有切换。':'Current edits changed. The workspace was not switched.');
   const files=new Map([...loaded].map(([path,value])=>[path,value.file]));
   const nextTabs:Tab[]=layout.tabs.map(saved=>({vaultId:chosen.id,...loaded.get(saved.path)!,dirty:false,initialPage:saved.initialPage}));
   const nextSessions=new Map<string,ReadingWorkspaceSession>(),nextCameras=new Map<string,{x:number;y:number;zoom:number}>();
   for(const saved of layout.tabs){const key=workspaceSessionKey(chosen.id,saved.path);if(saved.reading)nextSessions.set(key,hydrateWorkspaceReading(saved.reading,chosen.id,files));if(saved.boardCamera)nextCameras.set(key,saved.boardCamera);}
   // All IO and validation succeeded. Outgoing pane cleanup is fenced before the
   // new metadata is committed; it cannot overwrite the restored view snapshot.
   readingGeneration.current++;requestEpoch.current++;listingEpoch.current++;chooseEpoch.current++;addFileEpoch.current++;
   state.current={vault:chosen,tabs:nextTabs,active:layout.activePath};readingSessions.current=nextSessions;workspaceCameras.current=nextCameras;workspacePositions.current=new Map(layout.tabs.filter(saved=>saved.surfacePosition).map(saved=>[workspaceSessionKey(chosen.id,saved.path),saved.surfacePosition!]));notebookSessions.current.clear();
   setComparisonReadingKeys(new Set([...nextSessions].filter(([,s])=>s.panes.length>1).map(([key])=>key)));setReadingRevision(v=>v+1);
   setVault(chosen);setTabs(nextTabs);setActive(layout.activePath);setListing(nextListing);setMode(layout.presentation);if(layout.panels)panels.restore(layout.panels);
   setGraph(null);setGraphVisible(false);setMapEditing(false);setPDFStudies(new Map());setReviewFocus(null);setReviewsOpen(false);setSourceFocus(undefined);setSourceReturn(null);setStudyTarget(null);homeSource.current=null;
   setBoardReplayActive(false);setMarginPaths({});setCapture(null);setInsertBoard(false);setAddFileAt(null);setMergeSource(null);setMergeUndo(null);setBoardText(null);setWatchError('');setLoading(false);setError('');setBoardVersionsRequest(null);setRecentRelink(null);setBrowserWorkbench(null);setReviewQueueRequest(null);setCourseWorkspacesOpen(false);
   setStatus(language==='zh'?`已恢复工作区「${entry.name}」；运行环境和资料内容保持各自管理。`:`Restored “${entry.name}”. Runtime state and document content keep their own lifecycle.`);
   void reloadRecentVaults();
  }finally{workspaceRestorePending.current=false;}
 };

 const quickActions:QuickAction[]=[
  {id:'course-workspaces',title:language==='zh'?'课程工作区':'Course workspaces',keywords:'workspace 工作区 课程 保存 布局 并排 恢复',run:()=>setCourseWorkspacesOpen(true)},
  {id:'home',title:language==='zh'?'返回工作台':'Go to Home',keywords:'home 首页 工作台',run:goHome},
  {id:'folder',title:language==='zh'?'打开资料文件夹':'Open a folder',keywords:'folder 文件夹 iCloud',run:choose},
  ...(vault?[
   {id:'calendar',title:language==='zh'?'打开日历':'Open calendar',keywords:'calendar 日程 提醒',run:()=>{setCalendarDate(undefined);setCalendarFocus(null);setCalendarOpen(true);}},
   {id:'quick-notes',title:language==='zh'?'随手便签':'Quick notes',keywords:'quick notes 便签 临时 提醒',run:()=>setQuickNotesVault(vault)},
   {id:'checklist',title:language==='zh'?'打开课程清单':'Open course checklist',keywords:'checklist 任务 课程',run:()=>setChecklistRequest({vault,folder:tab?tab.file.path.split('/').slice(0,-1).join('/'):(listing?.path||'')})},
   ...(tab?[{id:'task-source',title:language==='zh'?'为当前资料创建任务':'Create a task for this file',detail:tab.file.name,keywords:'task 任务 关联',run:taskForCurrent}]:[]),
   {id:'board',title:language==='zh'?'新建白板':'New whiteboard',keywords:'board 白板',run:()=>newFromHome('board')},
   {id:'document',title:language==='zh'?'新建文档':'New document',keywords:'markdown word pdf ppt 文档',run:()=>newFromHome('md')},
   ...(['py','ipynb','md','tex'] as const).map(kind=>({id:'new-'+kind,title:(language==='zh'?'新建 ':'New ')+({py:'Python',ipynb:'Notebook',md:'Markdown',tex:'LaTeX'}[kind]),keywords:kind+' code 创作 文档',run:()=>newFromHome(kind)})),
   {id:'manage',title:language==='zh'?'管理文件':'Manage files',keywords:'files move share 文件 移动 分享',run:manageFromHome},
   {id:'note-exchange',title:language==='zh'?'笔记交换':'Note exchange',keywords:'import export goodnotes boardnotes notability onenote 导入 导出',run:()=>setExchangeOpen(true)},
   {id:'ocr',title:language==='zh'?'图文识别 OCR':'Local OCR',keywords:'scan text recognize OCR 文字 扫描 识别',run:()=>browseWorkspaceFiles('ocr')},
   {id:'reviews',title:language==='zh'?'接续手机批注':'Continue phone reviews',keywords:'iphone reviews 手机 批注',run:()=>browseWorkspaceFiles('reviews')},
   {id:'scans',title:language==='zh'?'打开扫描件 / PDF':'Open scans / PDF',keywords:'scan pdf iphone 扫描 高亮',run:()=>browseWorkspaceFiles('pdf')},
   {id:'search',title:language==='zh'?'搜索知识库内容':'Search library contents',keywords:'search 全文 搜索',run:()=>openSearch()},
   {id:'graph',title:language==='zh'?'知识空间 / 图谱':'Knowledge space / graph',keywords:'graph 宫殿',run:openGraph},
   {id:'media',title:language==='zh'?'音视频剪辑':'Media editor',keywords:'media video audio 音频 视频 剪辑',run:()=>{setMediaRequest({vaultId:vault.id,nonce:Date.now()});setMediaVisible(true);}},
  ]:[]),
  {id:'browser',title:language==='zh'?'浏览器与剪藏':'Browser & clipper',keywords:'browser 浏览器 网页 剪藏 来源 检索',run:openBrowserWorkbench},
  {id:'calculator',title:language==='zh'?'科学计算器':'Scientific calculator',keywords:'math calculator 数学 计算器',run:()=>{setMathEverOpened(true);setMathVisible(true);}},
  {id:'ai',title:language==='zh'?'打开 AI 助手侧栏':'Open AI assistant sidebar',keywords:'ai chatgpt deepseek claude gemini 助手',run:()=>{if(!panels.aiOpen)panels.toggleAI();}},
  {id:'settings',title:language==='zh'?'设置':'Settings',keywords:'settings 设置 语言 翻译 诊断',run:()=>setShowSettings(true)},
 ];
 const quickPaths=Array.from(new Set([...tabs.map(t=>t.file.path),...recentFiles.map(f=>f.path),...(listing?.entries.filter(e=>e.kind!=='folder').map(e=>e.path)||[])])).slice(0,250);
 const fileQuickActions=quickPaths.map(path=>({id:'file:'+path,title:basename(path),detail:path,file:true,run:()=>void attempt(()=>requestOpen(path))}));quickActions.unshift(...fileQuickActions.slice(0,6));quickActions.push(...fileQuickActions.slice(6));
 const quickBlocked=!!(regionCard||boardImageOrganization||studyCapture||learningRequest||boardVersionsRequest||recentRelink||browserWorkbench||reviewQueueRequest||courseWorkspacesOpen||mergeSource||exportFile||exchangeOpen||!!excerptRequest||boardReplayActive||ocrSource||workspacePicker||calendarOpen||quickNotesVault||checklistRequest||mediaVisible||mathVisible||translationVisible||openChoice||childTarget||fileAction||fileBusy||showNew||pythonConfirm||notebookConfirm||confirm||showSettings||video||diagnostics||showSearch||insertBoard||addFileAt||boardText||latexConfirm||latexResult||lassoArea||pdfBusyUI);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(spaceRef.current==='study'&&isQuickOpenShortcut(e,navigator.platform)&&!quickBlocked&&!document.querySelector('.study-space-layer [role="dialog"]')){e.preventDefault();e.stopPropagation();setQuickOpen(true);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[quickBlocked]);
 useEffect(()=>{if(!pendingNotificationTarget||quickBlocked)return;setWorkEverOpened(true);setSpace('work');setNotificationTarget(pendingNotificationTarget);void window.desktop.workNotificationOpenClaim({itemId:pendingNotificationTarget});setPendingNotificationTarget(null);},[pendingNotificationTarget,quickBlocked]);
 const diagnosticsAction=()=>void attempt(async()=>{setDiagnostics(unwrap(await api.getDiagnostics()));});
 const switchSpace=(next:'study'|'work')=>{if(next===space)return;if(space==='study'&&quickBlocked){setError(language==='zh'?'请先完成当前对话框或放置，再切换空间；内容仍保留。':'Finish the current dialog or placement before switching spaces. Your content is kept.');return;}if(document.activeElement instanceof HTMLElement)document.activeElement.blur();if(next==='work')setWorkEverOpened(true);setSpace(next);};
 return <div className="space-shell" data-testid="space-shell" data-space={space}><header className="space-switcher"><strong>{displayBrand(language)}</strong>{space==='study'&&tab&&<button data-testid="study-capture-current" disabled={quickBlocked} onClick={()=>{const selected=window.getSelection()?.toString()||'';setStudyCapture({vaultId:tab.vaultId,path:tab.file.path,category:'focus',...(selected&&selected.length<=4000?{initialText:selected,excerpt:selected}:{})});}}>{language==='zh'?'加入工作空间…':'Add to Work…'}</button>}<button data-testid="space-study" aria-pressed={space==='study'} onClick={()=>switchSpace('study')}>{language==='zh'?'学习空间':'Study'}</button><button data-testid="space-work" aria-pressed={space==='work'} onClick={()=>switchSpace('work')}>{language==='zh'?'工作空间':'Work'}</button></header><div className="space-stage"><div className={'study-space-layer'+(space==='work'?' space-inactive':'')} data-testid="study-space-layer" aria-hidden={space==='work'} inert={space==='work'||undefined}><div className={`app resizable-panels ${panels.dragging?'is-resizing':''}`} style={panels.style}>
 <div inert={fileBusy||undefined} id="file-sidebar" className="file-sidebar-shell" data-testid="panel-sidebar" hidden={!panels.leftOpen}>
 <Sidebar onOrganizeBoardImages={path=>{const owner=state.current.vault;if(owner&&!fileMutationBusy.current)setBoardImageOrganization({vaultId:owner.id,path});}} onStudyCapture={(path,category)=>{if(vault)setStudyCapture({vaultId:vault.id,path,category});}} managementRequest={manageRequest} onHome={goHome} onChecklist={folder=>{if(vault)setChecklistRequest({vault,folder:folder??listing?.path??''});}} onMedia={()=>{if(vault){setMediaRequest({vaultId:vault.id,nonce:Date.now()});setMediaVisible(true);}}} onBrowser={openBrowserWorkbench} onImportClip={importBrowserClip} onMath={()=>{setMathEverOpened(true);setMathVisible(true)}} managementRevision={managementRevision} revision={assetRevision} language={language} setLanguage={setLanguage} vault={vault} listing={listing} active={active} onChoose={choose} onOpen={entry=>{if(vault&&entry.path.toLowerCase().endsWith('.inkcheck.json')){setChecklistRequest({vault,path:entry.path});}else if(vault&&entry.path.toLowerCase().endsWith('.inkcut.json')){setMediaRequest({vaultId:vault.id,path:entry.path,nonce:Date.now()});setMediaVisible(true);}else void attempt(()=>requestOpen(entry.path));}} onFolder={path=>void attempt(()=>refresh(path))} onRefresh={()=>void attempt(async()=>{await refresh();const current=state.current.tabs.find(x=>x.file.path===state.current.active);if(current)guard(()=>void attempt(()=>open(current.file.path,current.initialPage,true)),[current]);})} actionsDisabled={fileBusy} onNew={parent=>{setNewParent(parent??listing?.path??'');setNewKind('md');setShowNew(true)}} onNewBoard={parent=>{setNewParent(parent??listing?.path??'');setNewKind('board');setShowNew(true)}} onExternalOpen={(path,application)=>void attempt(async()=>{if(!vault||externalBusy||fileMutationBusy.current)return;if(pdfWorkspaceBusy()||transientBoxDirty.current||childSessionsBusy.current)throw Error(language==='zh'?'请先完成当前批注或文本编辑。':'Finish the current annotation or text edit first.');setExternalBusy(true);try{const target=state.current.tabs.find(t=>t.vaultId===vault.id&&t.file.path===path);if(target?.dirty&&!await saveTab(target))throw Error(t('sourceChanged'));const result=unwrap(await api.openOriginal({vaultId:vault.id,path,application}));if(result.opened)setStatus(language==='zh'?'已交给外部应用。':'Opened in the selected application.');}finally{setExternalBusy(false);}})} onReveal={path=>void attempt(async()=>{if(vault)unwrap(await api.revealInFinder({vaultId:vault.id,path}));})} onCopyReference={(path,kind)=>void attempt(async()=>{if(!vault)return;unwrap(await api.copyFileReference({vaultId:vault.id,path,kind}));setStatus(language==='zh'?(kind==='link'?'内部链接已复制。':'相对路径已复制。'):(kind==='link'?'Internal link copied.':'Relative path copied.'));})} onManage={action=>{if(!vault)return;const scoped={...action,vaultId:vault.id};setFileAction({...scoped,autoStart:action.kind==='move'&&action.targetPath!==undefined});}} onShare={paths=>void attempt(async()=>{if(!vault)return;if(fileMutationBusy.current||boardOperationLocks.current.size||saves.current.size||pdfWorkspaceBusy()||childSessionsBusy.current||transientBoxDirty.current)throw Error(language==='zh'?'请先完成正在编辑的内容，再分享。':'Finish current edits before sharing.');for(const target of state.current.tabs.filter(x=>x.dirty))if(!await saveTab(target))throw Error(language==='zh'?'请先保存再分享。':'Save changes before sharing.');unwrap(await api.shareFiles({vaultId:vault.id,paths}));})} onDiagnostics={diagnosticsAction} onSettings={()=>setShowSettings(true)} onSearch={()=>openSearch()} onGraph={openGraph}/>
 </div>
 {panels.leftOpen&&<PanelSeparator side="left" layout={panels} language={language}/>}
 <main inert={fileBusy||undefined} data-testid="panel-content" className={`workspace ${aiOpen?'with-ai':''}`}><div className="workspace-topbar"><Button className="panel-toggle" data-testid="panel-toggle-left" aria-expanded={panels.leftOpen} aria-controls="file-sidebar" aria-label={language==='zh'?(panels.leftOpen?'折叠文件栏':'展开文件栏'):(panels.leftOpen?'Collapse file sidebar':'Expand file sidebar')} title={language==='zh'?(panels.leftOpen?'折叠文件栏':'展开文件栏'):(panels.leftOpen?'Collapse file sidebar':'Expand file sidebar')} onClick={panels.toggleLeft}>{panels.leftOpen?<PanelLeftClose/>:<PanelLeft/>}</Button><button className="workspace-home-button" data-testid="workspace-home" aria-current={!tab&&!graphVisible?'page':undefined} onClick={goHome}><Home/>{language==='zh'?'首页':'Home'}</button><div className="tabs">{tabs.map(item=><div key={item.file.path} className={`tab ${active===item.file.path?'active':''}`}><button className="tab-select" title={item.file.path} onClick={()=>guard(()=>{requestEpoch.current++;setLoading(false);setGraphVisible(false);setActive(item.file.path)},[])}><FileIcon kind={item.file.kind} path={item.file.path}/><span>{item.file.name}</span>{item.dirty&&<span aria-label={t('modified')} className="dirty-dot"/>}</button><button className="tab-close" aria-label={`${t('close')} ${item.file.name}`} onClick={()=>closeTab(item)}><X/></button></div>)}<Button className="icon-button add-tab" data-testid="open-folder-window" disabled={openingFolderWindow} aria-label={language==='zh'?'在新窗口打开文件夹':'Open folder in a new window'} title={language==='zh'?'在新窗口打开文件夹':'Open folder in a new window'} onClick={openFolderWindow}><Plus/></Button></div><Button className="icon-button" data-testid="review-queue-open" disabled={!vault||quickBlocked} aria-label={language==='zh'?'跨文件待批注':'Cross-file reviews'} title={language==='zh'?'跨文件待批注总览':'Cross-file review queue'} onClick={()=>browseWorkspaceFiles('reviews')}><MessageSquareText/></Button><Button className="icon-button" data-testid="browser-workbench-open" disabled={quickBlocked} title={language==='zh'?'浏览器与剪藏目录':'Browser and web clips'} aria-label={language==='zh'?'浏览器与剪藏目录':'Browser and web clips'} onClick={openBrowserWorkbench}><Globe/></Button><Button className="course-workspaces-open" data-testid="course-workspaces-open" disabled={quickBlocked} onClick={()=>setCourseWorkspacesOpen(true)}><FolderOpen/>{language==='zh'?'工作区':'Workspaces'}</Button><Button className="quick-notes-global" data-testid="quick-notes-open" disabled={!vault||quickBlocked} title={language==='zh'?'随手便签 · 记下即进入待完成清单':'Quick notes · save straight to your checklist'} onClick={()=>{if(vault)setQuickNotesVault(vault);}}><StickyNote/>{language==='zh'?'便签':'Notes'}</Button><Button className="quick-launch" data-testid="quick-launch" title={language==='zh'?'快速前往（⌘K）':'Quick switcher (⌘K)'} aria-label={language==='zh'?'快速前往':'Quick switcher'} disabled={quickBlocked} onClick={()=>setQuickOpen(true)}><Search/><kbd>⌘ K</kbd></Button><Button className="panel-toggle" data-testid="panel-toggle-right" aria-expanded={aiOpen} aria-controls="chatgpt-sidebar" aria-label={language==='zh'?'AI 助手':'AI assistant'} title={language==='zh'?(aiOpen?'折叠 AI 助手':'展开 AI 助手'):(aiOpen?'Collapse AI assistant':'Expand AI assistant')} onClick={panels.toggleAI}>{aiOpen?<PanelRightClose/>:<PanelRight/>}</Button></div>
 {error&&<div className="error-banner" role="alert"><AlertCircle/><span>{error}</span><Button className="icon-button" aria-label={t('close')} onClick={()=>setError('')}><X/></Button></div>}
 {watchError&&<div className="error-banner" role="status"><AlertCircle/><span>{watchError}</span></div>}
 {import.meta.env.DEV&&new URLSearchParams(location.search).has('preview')&&<div className="preview-banner">{t('browserPreview')}</div>}
 {excerptRequest&&!pdfLinks.choosing&&!pdfLinks.busy&&!isPDFReader&&<div className="pdf-board-link-toolbar" data-testid="pdf-pending-excerpt-global" role="status"><span>{language==='zh'?'有一条摘录尚未加入白板；内容仍保留。':'An excerpt has not been added yet; its contents are retained.'}</span><Button onClick={pdfLinks.resume}>{language==='zh'?'继续选择白板':'Continue choosing a board'}</Button><Button onClick={pdfLinks.discard}>{language==='zh'?'丢弃此未保存摘录':'Discard this pending excerpt'}</Button></div>}{graphVisible&&vault?<><div className="toolbar"><Network/><div className="segmented"><button className={knowledgeMode==='space'?'selected':''} onClick={()=>setKnowledgeMode('space')}>{language==='zh'?'知识空间':'Knowledge space'}</button><button className={knowledgeMode==='links'?'selected':''} onClick={openKnowledgeLinks}>{language==='zh'?'引用关系':'Linked notes'}</button></div><span className="spacer"/>{knowledgeMode==='links'&&<Button onClick={openKnowledgeLinks}>{t('refresh')}</Button>}<Button onClick={()=>setGraphVisible(false)}>{t('close')}</Button></div><div className="main-content">{knowledgeMode==='space'?<KnowledgeSpace key={vault.id} vaultId={vault.id} language={language} revision={assetRevision} onOpen={path=>void attempt(()=>open(path))}/>:graph?<><KnowledgeGraph nodes={graph.nodes} edges={graph.edges} language={language} onOpen={path=>void attempt(()=>open(path))}/>{graph.truncated&&<p className="preview-notice">{t('limitedIndex')}</p>}</>:<p role="status">{language==='zh'?'正在读取引用关系…':'Loading linked notes…'}</p>}</div></>:tab?<>{!isPDFReader&&<div className="toolbar" inert={pdfBusyUI||undefined}>{extension==='pdf'&&sourceReturn?.vaultId===tab.vaultId&&<Button data-testid="pdf-return-mind-map" onClick={()=>void attempt(async()=>{const back=sourceReturn;await open(back.path);if(state.current.vault?.id===back.vaultId){setMapEditing(true);setSourceFocus(undefined);}})}>{language==='zh'?'返回思维导图':'Back to mind map'}</Button>}<span className="breadcrumb" title={tab.file.path}>{vault?.name}<span>/</span>{tab.file.name}</span><div className="spacer"/><Button data-testid="file-create-task" onClick={taskForCurrent} title={language==='zh'?'为当前资料创建任务':'Create a task for this file'} aria-label={language==='zh'?'为当前资料创建任务':'Create a task for this file'}><ListChecks/></Button>{tab.file.kind==='text'&&hasTextPreview&&<div className="segmented">{(['source','split','preview'] as const).map(option=><button key={option} className={mode===option?'selected':''} onClick={()=>setMode(option)}>{t(option)}</button>)}</div>}{tab.file.kind==='text'&&extension==='md'&&<Button onClick={()=>setInsertBoard(true)}><Shapes/>{language==='zh'?'插入白板':'Insert board'}</Button>}{tab.file.kind==='board'&&<Button data-testid="board-refresh" disabled={boardRefreshing||!!boardOperationKey||fileBusy||loading} onClick={()=>void refreshCurrentBoard()} title={language==='zh'?'重新读取已到达本机的白板和资料，保留当前视角；iCloud 传输仍需等待。':'Reload the board and materials available locally, keeping the current view. iCloud transfers may still be pending.'}><RefreshCw/>{boardRefreshing?(language==='zh'?'刷新中…':'Refreshing…'):t('refresh')}</Button>}{tab.file.kind==='board'&&<Button data-testid="board-image-organize-open" disabled={!!boardOperationKey||fileBusy||loading} onClick={()=>setBoardImageOrganization({vaultId:tab.vaultId,path:tab.file.path})}>{language==='zh'?'整理图片':'Organize images'}</Button>}{tab.file.kind==='board'&&<Button data-testid="board-versions-open" disabled={tab.dirty||!!boardOperationKey||fileBusy||loading} title={language==='zh'?'本机白板版本、差异与恢复副本':'Local board versions, differences and recovery copy'} onClick={()=>void attempt(()=>openBoardVersions(tab))}><VersionHistoryIcon/>{language==='zh'?'版本':'Versions'}</Button>}{tab.file.kind==='board'&&<Button data-testid="board-merge-open" disabled={!!boardOperationKey||fileBusy||loading} onClick={()=>void attempt(()=>beginBoardMerge(tab))}><Combine/>{language==='zh'?'合并白板':'Merge boards'}</Button>}{tab.file.kind==='board'&&<Button data-testid="study-open" disabled={!!boardOperationKey} onClick={()=>openStudy(tab)}>{language==='zh'?'学习与复习':'Study & review'}</Button>}{tab.file.kind==='board'&&<Button disabled={!!boardOperationKey} onClick={()=>guard(()=>setMapEditing(v=>!v))}><Shapes/>{mapEditing?(language==='zh'?'阅读白板':'Read board'):(language==='zh'?'思维导图':'Edit mind map')}</Button>}{(tab.document||tab.file.kind==='text'||tab.file.kind==='board')&&<Button disabled={boardOperationKey===tab.vaultId+':'+tab.file.path} onClick={()=>void attempt(async()=>{const target=focusedSaveTarget();if(target)await saveTab(target)})} title={t('backup')}><Save/>{t('save')}</Button>}{(tab.document||tab.file.kind==='text'||tab.file.kind==='board')&&<Button data-testid="reading-mode" onClick={()=>void attempt(async()=>{if(pdfWorkspaceBusy()||childSessionsBusy.current||transientBoxDirty.current||studyLocked()||pdfLinks.hasPending()||notebooks.isRunning(tab.vaultId,tab.file.path)||boardOperationLocks.current.size)throw Error(language==='zh'?'请先完成当前编辑或运行任务。':'Finish the current edit or running task first.');if(comparisonReadingKey===tab.vaultId+':'+tab.file.path){setComparisonReading(tab.vaultId,tab.file.path,false);return;}if(tab.dirty&&!await saveTab(tab))return;if(state.current.vault?.id===tab.vaultId&&state.current.active===tab.file.path)setComparisonReading(tab.vaultId,tab.file.path,true);})}>{comparisonReadingKey===tab.vaultId+':'+tab.file.path?(language==='zh'?'返回编辑':'Back to editing'):(language==='zh'?'并排工作':'Side-by-side workspace')}</Button>}{(tab.file.kind==='docx'||tab.file.kind==='pptx'||tab.file.kind==='spreadsheet'||extension==='pdf')&&<Button onClick={()=>setOpenChoice({path:tab.file.path})}>{language==='zh'?'打开方式':'Open with'}</Button>}{(tab.file.kind==='docx'||tab.file.kind==='pptx'||tab.file.kind==='spreadsheet'||extension==='pdf')&&<Button onClick={extractNote} title={language==='zh'?'提取为笔记':'Extract text to note'} aria-label={language==='zh'?'提取为笔记':'Extract text to note'}><FileOutput/></Button>}<Button className="review-toolbar-button" data-testid="review-toggle" data-has-reviews={reviewState.reviews.length>0} onClick={()=>{setReviewsOpen(v=>!v);setConnections(false);}} title={language==='zh'?'待修改批注':'Review annotations'} aria-label={language==='zh'?'待修改批注':'Review annotations'}><MessageSquareText/>{reviewState.reviews.length>0&&<span className="review-count">{reviewState.reviews.length}</span>}</Button><Button onClick={openMargin} title={language==='zh'?'插入旁注空白区':'Add margin notes'} aria-label={language==='zh'?'插入旁注空白区':'Add margin notes'}><StickyNote/></Button>{extension==='md'&&<Button title={t('noteConnections')} aria-label={t('noteConnections')} onClick={()=>setConnections(v=>!v)}><Link2/></Button>}{['pdf','png','jpg','jpeg'].includes(extension)&&<Button data-testid="file-ocr" onClick={()=>{if(vault&&tab)guard(()=>setOCRSource({vault,path:tab.file.path}),[]);}}><ScanText/>{language==='zh'?'图文识别':'OCR'}</Button>}{extension==='tex'&&<Button disabled={latexBusy} onClick={()=>setLatexConfirm(true)}><Play/>{latexBusy?(language==='zh'?'正在编译…':'Compiling…'):(language==='zh'?'编译 PDF':'Compile PDF')}</Button>}{extension==='py'?<Button className="primary" disabled={consoleState.running} onClick={()=>{if(runConsent.current)void attempt(runPython);else setPythonConfirm(true)}}><Play/>{t('run')}</Button>:<Button title={language==='zh'?'下载与导出':'Download & export'} aria-label={language==='zh'?'下载与导出':'Download & export'} onClick={exportPDF}><Download/></Button>}</div>}
 <div className={`content-and-links ${marginTab&&marginPosition==='bottom'?'margin-bottom':''} ${studyCover&&studyTab?'study-context-covered':''}`} data-study-cover-label={language==='zh'?'先回忆右侧问题 · 查看原文或显示答案后恢复笔记':'Recall the question · View source or reveal the answer to restore your notes'}><div className={"main-content "+(studyCover&&studyTab?"study-context-hidden":"")} data-print-content="true" inert={studyCover&&studyTab?true:undefined} aria-hidden={studyCover&&studyTab?true:undefined}>{!tab.document&&!!tab.documentWarnings?.length&&['docx','pptx'].includes(tab.file.kind)&&<div className="document-warning">{language==='zh'?'此文件按原样阅读；来源于其他应用或已在外部修改。可提取文字，也可添加旁注。':'This file is shown for reading because it comes from another app or was modified externally. You can extract its text or add margin notes.'}</div>}{reviewsOpen&&reviewState.reviews.length>0&&['text','docx'].includes(tab.file.kind)&&<div className="review-source-note">{language==='zh'?'在这里修改原文。点批注的“定位”查看当时圈画的页面；改完后删除批注。':'Edit the source here. Use Locate to see the marked page, then delete the completed review.'}</div>}{comparisonReadingKey===tab.vaultId+':'+tab.file.path?readingWorkspace(tab.file):tab.document?<StandaloneDocumentEditor zoomKey={tab.vaultId+':'+tab.file.path} key={tab.file.path} value={JSON.parse(tab.draft)} language={language} onChange={value=>updateDraft(JSON.stringify(value))}/>:tab.file.kind==='text'&&extension==='ipynb'?<NotebookEditor session={notebookSessions.current.get(notebookSessionKey(tab.vaultId,tab.file.path))} onSessionChange={session=>rememberNotebookSession(tab.vaultId,tab.file.path,session)} vaultId={tab.vaultId} onSave={()=>void attempt(async()=>{const current=state.current.tabs.find(x=>x.vaultId===tab.vaultId&&x.file.path===tab.file.path);if(current)await saveTab(current);})} key={tab.vaultId+':'+tab.file.path} value={tab.draft} path={tab.file.path} language={language} runState={notebooks.states[notebookKey(tab.vaultId,tab.file.path)]} onChange={value=>setTabs(old=>old.map(x=>x.vaultId===tab.vaultId&&x.file.path===tab.file.path?{...x,draft:value,dirty:value!==x.file.text}:x))} onRun={indices=>requestNotebookRun(tab,indices)} onInterrupt={()=>void attempt(()=>notebooks.interrupt(tab.vaultId,tab.file.path))} onRestart={()=>void attempt(()=>restartNotebook(tab.vaultId,tab.file.path))} resolveMedia={mediaResolver} onLocalLink={localLink}/>:tab.file.kind==='text'?<div className={`text-workspace ${hasTextPreview?mode:'source'}`}>{(!hasTextPreview||mode!=='preview')&&<EditorPane key={tab.file.path} path={tab.file.path} value={tab.draft} onChange={updateDraft}/>}<pre className="print-source">{tab.draft}</pre>{hasTextPreview&&mode!=='source'&&(['html','htm'].includes(extension)?<HtmlPreview text={tab.draft} title={tab.file.name} language={language} onLocalLink={localLink} onExternalLink={url=>void api.openExternal({url})} resolveMedia={mediaResolver}/>:['csv','tsv'].includes(extension)?<CsvPreview text={tab.draft} language={language} delimiter={extension==='tsv'?'\t':undefined}/>:<DocumentPreview text={tab.draft} vaultId={vault?.id} assetRevision={assetRevision} onBoardOpen={(path,page,playback)=>void attempt(()=>open(path,page,false,playback))} onBoardReview={locateReview} format={extension} language={language} onLocalLink={localLink} onWikiLink={wikiLink} onRootFileLink={path=>void attempt(()=>requestOpen(path))} resolveMedia={mediaResolver}/>)}</div>:['docx','pptx','spreadsheet'].includes(tab.file.kind)?readingWorkspace(tab.file):tab.file.kind==='board'&&tab.file.board?mapEditing?<MindMapEditor studyFocus={mindFocus} hideInspector={!!studyTab} onStudyNode={id=>openStudy(tab,id)} key={`${tab.vaultId}:${tab.file.path}`} board={parsedBoard} inkReference={tab.file.board} vaultId={tab.vaultId} language={language} onOpenSource={(path,reference)=>void attempt(()=>openMindSource(path,reference))} onRemoveNode={id=>performBoardOperation(tab,{type:'remove',ids:[id]}).then(()=>{})} canUndo={boardHistory.canUndo||tab.dirty||canUndoLastBoardMerge(tab)} canRedo={boardHistory.canRedo&&!tab.dirty&&!canUndoLastBoardMerge(tab)} onUndo={()=>canUndoLastBoardMerge(tab)?undoLastBoardMerge():performBoardChange(tab,expectedSHA256=>api.undoBoard({vaultId:tab.vaultId,path:tab.file.path,expectedSHA256})).then(()=>{})} onRedo={()=>performBoardChange(tab,expectedSHA256=>api.redoBoard({vaultId:tab.vaultId,path:tab.file.path,expectedSHA256})).then(()=>{})} onChange={next=>setTabs(old=>old.map(x=>x.file.path===tab.file.path?{...x,draft:JSON.stringify(next),dirty:JSON.stringify(next)!==JSON.stringify(x.file.board)}:x))} onError={setError}/>:renderBoard(tab,parsedBoard,mindFocus):tab.file.assetUrl&&extension==='pdf'?readingWorkspace(tab.file):tab.file.assetUrl?readingWorkspace(tab.file):<p>{t('docLegacy')}</p>}</div>{studyTab&&studyBoard&&<StudyPanel onImported={file=>{if(file.path!==studyTab.file.path||String(file.board?.id).toLowerCase()!==String(studyBoard.id).toLowerCase())throw Error('Imported board identity changed');const latest=state.current.tabs.find(x=>x.vaultId===studyTab.vaultId&&x.file.path===file.path);if(!latest||latest.dirty||String(latest.file.board?.id).toLowerCase()!==String(file.board?.id).toLowerCase())throw Error('Board changed while importing');savedBoardFiles.current.set(studyTab.vaultId+':'+file.path,file);setTabs(old=>old.map(x=>x.vaultId===studyTab.vaultId&&x.file.path===file.path&&!x.dirty?{...x,file,draft:JSON.stringify(file.board),dirty:false}:x));}} key={studyTab.vaultId+':'+String(studyBoard.id)} vaultId={studyTab.vaultId} path={studyTab.file.path} board={studyBoard} language={language} focusItem={studyTarget?.focus} onRecallCover={setStudyCover} onStateChange={onStudyState} onClose={()=>setStudyTarget(null)} onPrepare={async()=>{const latest=state.current.tabs.find(t=>t.vaultId===studyTab.vaultId&&t.file.path===studyTab.file.path);if(!latest)throw Error('missing');if(latest.dirty&&!await saveTab(latest))throw Error('save');}} onLocate={id=>{if(studyLocked()){studyBlocked();return;}setActive(studyTab.file.path);const itemIndex=(studyBoard.items as Array<Record<string,unknown>>).filter(i=>['text','formula','inkGroup','pdfPage','document','link'].includes(String(i.kind))).findIndex(i=>String(i.id).toLowerCase()===id.toLowerCase());if(itemIndex>=1000||!mapEditing)setMapEditing(false);setMindFocus({id,nonce:Date.now()});}} onSource={async(path,reference)=>{await openMindSource(path,reference);setSourceReturn({vaultId:studyTab.vaultId,path:studyTab.file.path});}} onOutlineChange={async(id,title,parentID,previousParentID)=>{const latest=state.current.tabs.find(t=>t.vaultId===studyTab.vaultId&&t.file.path===studyTab.file.path);if(!latest)throw Error('missing');await performBoardChange(latest,expectedSHA256=>{let next=patchMindNode(JSON.parse(latest.draft),id,{title});if(parentID!==previousParentID){if(parentID)next=reparentMindNode(next,id,parentID);else next={...next,edges:(next.edges as Array<Record<string,unknown>>).filter(e=>!(String(e.to).toLowerCase()===id.toLowerCase()&&(!e.relation||e.relation==='child')))};}return api.saveBoardElements({vaultId:latest.vaultId,path:latest.file.path,expectedSHA256,items:next.items as Array<Record<string,unknown>>,edges:next.edges as Array<Record<string,unknown>>});});}}/>}{reviewsOpen&&!studyTab&&<ReviewPanel language={language} {...reviewState} visible={reviewOverlays} currentPath={tab.file.path} currentSHA={tab.file.sha256} currentBoardID={tab.file.kind==='board'?String(parsedBoard?.id||''):undefined} selected={reviewFocus?.review.id} onSelect={locateReview} onOpenOriginal={openReviewSource} onDelete={id=>void reviewState.remove(id)} onReload={()=>void reviewState.reload()} onClose={()=>setReviewsOpen(false)} onToggle={()=>setReviewOverlays(v=>!v)}/>} {marginTab&&!studyTab&&<MarginPanel language={language} path={marginTab.file.path} text={marginTab.draft} dirty={marginTab.dirty} onChange={text=>setTabs(old=>old.map(x=>x.file.path===marginTab.file.path?{...x,draft:text,dirty:text!==x.file.text}:x))} onSave={()=>void attempt(async()=>{await saveTab(marginTab)})} onImage={insertMarginImage} onClose={()=>setMarginPaths(old=>{const next={...old};if(active)delete next[active];return next;})} position={marginPosition} onPosition={()=>setMarginPosition(p=>p==='right'?'bottom':'right')} resolveMedia={marginResolver}/>} {notePath&&connections&&!studyTab&&<KnowledgePanel onClose={()=>setConnections(false)} language={language} data={noteLinks.data} error={noteLinks.error} onOpen={path=>void attempt(()=>open(path))} onTag={tag=>openSearch('#'+tag)}/>}</div>{(extension==='py'||consoleState.running)&&<PythonConsole language={language} state={consoleState} onClear={()=>setConsole({output:'',running:false,status:'noOutput'})} onStop={()=>void attempt(async()=>{if(run.current)unwrap(await api.cancelPython({runId:run.current.id}));})}/> }</>:<HomeDashboard onRelink={(id,name)=>setRecentRelink({id,name})} onQuickNotes={()=>{if(vault)setQuickNotesVault(vault);}} onNoteExchange={()=>guard(()=>setExchangeOpen(true),[])} recentVaults={recentVaults} recentFiles={recentFiles} historyIssue={historyIssue} historyBusy={historyBusy} onReopen={reopenRecent} onForget={forgetRecent} onOpenRecent={path=>void attempt(()=>requestOpen(path))} onForgetFile={forgetRecentFile} onQuick={()=>setQuickOpen(true)} language={language} clipTarget={tabs.find(x=>x.vaultId===vault?.id&&x.file.path===homeSource.current?.path&&x.file.kind==='board')?.file.name} vault={vault} folder={listing?.path||''} onChoose={choose} onCalendar={()=>{setCalendarDate(undefined);setCalendarFocus(null);setCalendarOpen(true);}} onChecklist={()=>{if(vault)setChecklistRequest({vault,folder:listing?.path||''});}} onGraph={openGraph} onSearch={()=>openSearch()} onNew={newFromHome} onOpenKind={browseWorkspaceFiles} onManageFiles={manageFromHome} onBrowser={openBrowserWorkbench} onImportClip={importBrowserClip} onMath={()=>{setMathEverOpened(true);setMathVisible(true);}} onMedia={()=>{if(vault){setMediaRequest({vaultId:vault.id,nonce:Date.now()});setMediaVisible(true);}}} onAI={()=>{if(!panels.aiOpen)panels.toggleAI();}} onSettings={()=>{setShowSettings(true);setDiagnostics(null);}}/>}
 {loading&&<div className="loading-indicator" role="status">{t('loading')}</div>}</main>
 {studyCapture&&<StudyCaptureDialog key={studyCapture.vaultId+':'+studyCapture.path} {...studyCapture} language={language} onClose={()=>setStudyCapture(null)} onSaved={()=>{setStudyCapture(null);setStatus(language==='zh'?'已保存到工作空间，当前学习内容保持原位。':'Saved in Work; your Study content stays in place.');}}/>}
 {mergeUndo&&mergeUndo.vaultId===vault?.id&&!mergeSource&&<div className="board-merge-success" role="status" data-testid="merge-undo-bar"><span>{language==='zh'?`已合并到「${mergeUndo.result.name}」。原白板已保留。`:`Merged into “${mergeUndo.result.name}”. The source is retained.`}</span><Button data-testid="merge-undo" disabled={mergeUndoBusy||!!boardOperationKey||fileBusy} onClick={()=>void attempt(undoLastBoardMerge)}><Undo2/>{mergeUndoBusy?(language==='zh'?'正在撤回…':'Undoing…'):(language==='zh'?'撤回本次合并':'Undo this merge')}</Button><Button className="icon-button" disabled={mergeUndoBusy} aria-label={language==='zh'?'收起合并提示':'Dismiss merge notice'} onClick={()=>setMergeUndo(null)}><X/></Button></div>}
 <footer className="statusbar"><CheckCircle2/><span>{tab?.dirty?t('modified'):status||(tab?t('saved'):'0.8.5')}</span><div className="spacer"/>{watchMessage&&<span title={watchMessage}>{watchMessage}</span>}<span>{tab?.file.kind==='text'?`UTF-8 · ${extension==='py'?'Python':extension.toUpperCase()}`:tab?.file.kind==='board'?(language==='zh'?'键鼠工作区':'Desktop workspace'):tab?.document?(language==='zh'?'文档编辑':'Document editor'):tab?t('readonly'):'0.8.5'}</span></footer>
 {panels.aiEverOpened&&<AIWebPanel language={language} collapsed={!aiOpen} resizing={!!panels.dragging} layoutRevision={panels.revision} onClose={panels.closeAI} onLasso={beginLasso} capture={capture} captureNonce={captureNonce} lastAutoPasted={lastAutoPasted} blocked={space==='work'||!!(regionCard||boardImageOrganization||studyCapture||learningRequest||boardVersionsRequest||recentRelink||browserWorkbench||reviewQueueRequest||courseWorkspacesOpen||mergeSource||exchangeOpen||!!excerptRequest||boardReplayActive||ocrSource||workspacePicker||quickOpen||calendarOpen||quickNotesVault||checklistRequest||mediaVisible||mathVisible||translationVisible||openChoice||childTarget||fileAction||fileBusy||showNew||pythonConfirm||notebookConfirm||confirm||showSettings||video||diagnostics||showSearch||insertBoard||addFileAt||boardText||latexConfirm||latexResult)}/>}
 {aiOpen&&<PanelSeparator side="right" layout={panels} language={language}/>}
 {panels.dragging&&<div className="panel-resize-shield" aria-hidden="true"/>}
 {lassoArea&&<LassoOverlay language={language} area={lassoArea} onComplete={data=>{setLassoArea(null);setCapture(data);setCaptureNonce(n=>n+1);}} onCancel={()=>setLassoArea(null)}/>}
 {openChoice&&<Modal title={language==='zh'?'选择打开方式':'Choose how to open'} onClose={()=>{if(!externalBusy)setOpenChoice(null);}}><p>{basename(openChoice.path)}</p><p>{language==='zh'?'在这里阅读和批注，或交给 Excel、Word、PowerPoint、WPS 等应用编辑原文件。外部保存后会重新检查内容。':'Read and annotate here, or edit the original in Excel, Word, PowerPoint, WPS or another app. Changes are checked when you return.'}</p><div className="file-manager-folders"><Button disabled={externalBusy} onClick={()=>{const selection=openChoice;setOpenChoice(null);void attempt(()=>open(selection.path,selection.page));}}>{language==='zh'?'在人生赢家中阅读':"Read in Life's Winner"}</Button><Button disabled={externalBusy} onClick={()=>void attempt(()=>externalOpen('default'))}>{language==='zh'?'使用系统默认应用':'Use default application'}</Button><Button disabled={externalBusy} onClick={()=>void attempt(()=>externalOpen('choose'))}>{language==='zh'?'选择其他应用…':'Choose another application…'}</Button></div>{error&&<p className="form-error" role="alert">{error}</p>}</Modal>}
 {childTarget&&(()=>{
 const target=childTarget;
 const parent=tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.path);
 if(!parent)return null;
 const item=target.itemID?JSON.parse(parent.draft).items.find((i:{id:string})=>i.id===target.itemID):null;
 if(target.itemID&&!item)return null;
 const link=async(path:string)=>{
  const file=unwrap(await api.readFile({vaultId:target.vaultId,path}));
  if(file.kind!=='board'||!file.board)throw Error(t('invalidBoard'));
  const entry={id:String(file.board.id),path,title:String(file.board.title||file.name)};
  if(target.itemID)await changeChildLinks({...target,itemID:target.itemID},links=>links.some(l=>l.id===entry.id)?links:[...links,entry]);
  else {
   const current=state.current.tabs.find(t=>t.vaultId===target.vaultId&&t.file.path===target.path);
   if(!current)throw Error(t('sourceChanged'));
   await performBoardOperation(current,{type:'addChildBoardCard',link:entry,x:target.x??100,y:target.y??100});
   setChildTarget(null);
  }
 };
 return <ChildBoardsDialog key={target.vaultId+':'+target.path+':'+(target.itemID||'new')} vaultId={target.vaultId}
  parentPath={target.path.split('/').slice(0,-1).join('/')} language={language}
  title={item?.title||String(JSON.parse(parent.draft).title||parent.file.name)} links={item?.childBoards||[]}
  onClose={()=>setChildTarget(null)} onOpen={path=>{setChildTarget(null);void attempt(()=>open(path));}}
  onLink={link} onRemove={id=>target.itemID?changeChildLinks({...target,itemID:target.itemID},links=>links.filter(l=>l.id!==id)):Promise.resolve()}
  onCreate={async(name,folder)=>{
   const file=unwrap(await api.createBoard({vaultId:target.vaultId,parentPath:folder,name:name.replace(/\.inkspace\.json$/i,'')+'.inkspace.json'}));
   try{await link(file.path);}catch(e){throw Error((language==='zh'?'子白板已创建在 '+file.path+'，关联暂未保存；请用“关联已有白板”选择该文件重试。':'The child board was created at '+file.path+' but not linked. Use Link existing board to retry.')+' '+(e instanceof Error?e.message:String(e)));}
   await refresh();
  }}/>
 })()}
 {fileBusy&&<div className="file-mutation-shield" role="status"><span>{language==='zh'?'正在保存并整理文件…':'Saving and organizing files…'}</span></div>}
 {boardImageOrganization&&vault?.id===boardImageOrganization.vaultId&&<BoardImageOrganizationDialog key={boardImageOrganization.vaultId+':'+boardImageOrganization.path} vaultId={boardImageOrganization.vaultId} boardPath={boardImageOrganization.path} vaultName={vault.name} language={language} onClose={()=>{if(!fileMutationBusy.current)setBoardImageOrganization(null);}} onCommit={token=>manageBoardImages(boardImageOrganization.vaultId,async()=>unwrap(await api.pngOrganizationCommit({token})))} onUndo={id=>manageBoardImages(boardImageOrganization.vaultId,async()=>unwrap(await api.pngOrganizationUndo({vaultId:boardImageOrganization.vaultId,id})))}/> }
 {fileAction?.kind==='rename'&&vault&&<RenameFileDialog key={vault.id+':'+fileAction.paths[0]} path={fileAction.paths[0]} isFolder={fileAction.isFolder} language={language} onClose={()=>{if(!fileMutationBusy.current)setFileAction(null);}} onRename={name=>manageFiles(fileAction,name)}/>}
 {fileAction&&fileAction.kind!=='rename'&&vault&&<FileManagementDialog key={vault.id+':'+fileAction.kind} vaultId={vault.id} language={language} action={fileAction} onClose={()=>{if(!fileMutationBusy.current)setFileAction(null);}} onMove={target=>manageFiles(fileAction,target)} onTrash={()=>manageFiles(fileAction)} onRestore={id=>manageFiles(fileAction,id)}/>}
 
 {exchangeOpen&&vault&&<NoteExchange vault={vault} initialFolder={listing?.path||''} language={language} onClose={()=>setExchangeOpen(false)} onOpen={path=>requestOpen(path)} onChanged={async()=>{await refresh();}}/>}
 {ocrSource&&vault?.id===ocrSource.vault.id&&<LocalOCRDialog onLearningSample={draft=>{setOCRSource(null);setLearningRequest({draft,nonce:Date.now()});}} key={ocrSource.vault.id+':'+ocrSource.path} vault={ocrSource.vault} path={ocrSource.path} language={language} onClose={()=>setOCRSource(null)} onSaved={async path=>{if(state.current.vault?.id!==ocrSource.vault.id)throw Error(language==='zh'?'资料文件夹已更换。':'The folder changed.');await refresh();await open(path);}}/>}
 {reviewQueueRequest&&reviewQueueRequest.vaultId===vault?.id&&<ReviewQueue key={JSON.stringify(reviewQueueRequest)} {...reviewQueueRequest} language={language} onOpenPDFAnnotation={openPDFAnnotationTarget} onOpenWordAnnotation={openWordAnnotationTarget} onLocate={async review=>{if(state.current.vault?.id!==reviewQueueRequest.vaultId)throw Error('NO_VAULT');await locateReviewAt(review);}} onOpenSource={async review=>{if(state.current.vault?.id!==reviewQueueRequest.vaultId)throw Error('NO_VAULT');await openReviewSourceAt(review);}} onClose={()=>setReviewQueueRequest(null)}/>}
 {recentRelink&&<RecentVaultRelink {...recentRelink} language={language} onClose={()=>setRecentRelink(null)} onLinked={async linked=>{if(state.current.vault?.id===linked.id){state.current={...state.current,vault:linked};setVault(linked);setAssetRevision(n=>n+1);await reloadRecentVaults();await refreshListing.current();}else activateVault(linked);}}/>}
 {boardVersionsRequest&&vault?.id===boardVersionsRequest.vaultId&&<BoardVersionsDialog key={boardVersionsRequest.vaultId+':'+boardVersionsRequest.file.path+':'+boardVersionsRequest.file.sha256} {...boardVersionsRequest} language={language} onClose={()=>setBoardVersionsRequest(null)} onOpen={async path=>{if(state.current.vault?.id!==boardVersionsRequest.vaultId)throw Error(t('sourceChanged'));await open(path);}}/>}
 {browserWorkbench&&vault?.id===browserWorkbench.vaultId&&<BrowserWorkbench vaultId={browserWorkbench.vaultId} folderPath={browserWorkbench.folderPath} language={language} onClose={()=>setBrowserWorkbench(null)} onBrowser={async()=>{unwrap(await api.openBrowser({vaultId:browserWorkbench.vaultId,parentPath:browserWorkbench.folderPath}));}} onImport={async()=>{const result=unwrap(await api.importBrowserClip({vaultId:browserWorkbench.vaultId,parentPath:browserWorkbench.folderPath}));if(result){setStatus(result.warning||(language==='zh'?'已导入剪藏：':'Imported clip: ')+result.path);await refresh();}}} onOpen={async entry=>{if(state.current.vault?.id!==browserWorkbench.vaultId)throw Error(t('sourceChanged'));await open(entry.ref.path);if(entry.ref.itemID)setMindFocus({id:entry.ref.itemID,nonce:Date.now()});}} onPrepareBoard={prepareClipBoard} onPlace={placeBrowserClip}/>}
 {courseWorkspacesOpen&&<CourseWorkspaces language={language} folderName={vault?.name} onSave={saveCourseWorkspace} onRestore={restoreCourseWorkspace} onClose={()=>setCourseWorkspacesOpen(false)}/>}
 {workspacePicker&&vault?.id===workspacePicker.vault.id&&<WorkspaceFilePicker key={workspacePicker.vault.id+':'+workspacePicker.kind} vault={workspacePicker.vault} initialPath={workspacePicker.folder} kind={workspacePicker.kind} language={language} onClose={()=>setWorkspacePicker(null)} onOpen={async path=>{
  if(state.current.vault?.id!==workspacePicker.vault.id)throw Error(language==='zh'?'资料文件夹已更换，请重新选择。':'The folder changed. Choose the file again.');
  if(workspacePicker.kind==='ocr'){setOCRSource({vault:workspacePicker.vault,path});return;}
  if(workspacePicker.kind==='reviews'){await open(path);if(state.current.vault?.id===workspacePicker.vault.id){setReviewOverlays(true);setReviewsOpen(true);setConnections(false);}}else await requestOpen(path);
 }}/>}
 {showSearch&&vault&&<UnifiedSearchDialog key={vault.id} language={language} vaultId={vault.id} initialQuery={searchQuery} onClose={()=>setShowSearch(false)} onOpen={openUnifiedSearchTarget}/>}
 {showNew&&vault&&<NewDocumentDialog initialKind={newKind} language={language} error={error} folder={[vault.name,newParent??listing?.path].filter(Boolean).join(' / ')} onClose={()=>{setShowNew(false);setNewParent(null);}} onCreate={(kind:NewDocumentKind,name:string)=>attempt(async()=>{
  if(childSessionsBusy.current)throw Error(language==='zh'?'请先保存或取消子白板中的编辑。':'Save or cancel the child board edit first.');
  const targetVault=vault.id;const parentPath=newParent??listing?.path??'';let loaded:LoadedFields;
  if(kind==='folder'){
   unwrap(await api.createFolder({vaultId:targetVault,parentPath,name}));
   if(state.current.vault?.id!==targetVault)return;
   setShowNew(false);setNewParent(null);setAssetRevision(n=>n+1);setStatus(language==='zh'?'文件夹已创建。':'Folder created.');await refresh(parentPath);return;
  }
  if(['docx','pptx','pdf'].includes(kind)){
   const result=unwrap(await api.createDocument({vaultId:targetVault,parentPath,name,document:initialDocument(kind as EditableDocumentModel['format'],name.replace(/\.[^.]+$/,''))}));
   loaded={file:result.opened,document:result.document,draft:JSON.stringify(result.document),documentWarnings:result.warnings};
  }else{
   const file=unwrap(kind==='board'?await api.createBoard({vaultId:targetVault,parentPath,name}):await api.createTextFile({vaultId:targetVault,parentPath,name,content:textTemplate(kind,language==='zh')}));
   loaded={file,draft:file.kind==='board'?JSON.stringify(file.board):file.text||''};
  }
  if(state.current.vault?.id!==targetVault)return;
  requestEpoch.current++;setTabs(old=>[...old.filter(x=>x.file.path!==loaded.file.path),{vaultId:targetVault,...loaded,dirty:false}]);setGraphVisible(false);setMapEditing(false);setActive(loaded.file.path);setShowNew(false);setNewParent(null);setAssetRevision(n=>n+1);if(kind==='tex')setMode('source');await refresh(parentPath);
 })}/>}
 {excerptRequest&&pdfLinks.choosing&&<BoardChooser notice={pdfLinks.message||(language==='zh'?'此 PDF 会记住你选择的白板。后续摘录自动加入，并保持阅读位置；关闭此选择框会保留待加入的摘录。':'This Mac remembers a board for this PDF. Future excerpts are added without leaving the page. Closing this chooser keeps the pending excerpt.')} vaultId={excerptRequest.vaultId} language={language} initialPath={excerptRequest.sourcePath.split('/').slice(0,-1).join('/')} onClose={pdfLinks.pause} onChoose={pdfLinks.choose}/>}
 {insertBoard&&vault&&tab&&<BoardChooser vaultId={vault.id} language={language} onClose={()=>setInsertBoard(false)} onChoose={path=>{const fence='\n\n```inkspace\n'+JSON.stringify({file:path})+'\n```\n';updateDraft(tab.draft+fence);setInsertBoard(false);setMode('preview');}}/>}
 {regionCard&&!regionCard.preview&&<aside className="board-region-capture-pending" role="status" data-testid="region-card-preparing">{language==='zh'?'正在准备选区快照…':'Preparing region snapshot…'}<Button onClick={closeRegionCard}>{language==='zh'?'取消':'Cancel'}</Button></aside>}
 {regionCard?.preview&&<BoardRegionStudyDialog key={regionCard.preview.token} preview={regionCard.preview} vaultId={regionCard.vaultId} path={regionCard.path} language={language} onBusy={busy=>{regionSaving.current=busy;}} onClose={closeRegionCard} onSaved={regionCardSaved}/>}
 {mergeSource&&<BoardMergeDialog key={mergeSource.vaultId+':'+mergeSource.path} vaultId={mergeSource.vaultId} sourcePath={mergeSource.path} language={language} onPrepare={prepareBoardMerge} onMerge={commitBoardMerge} onClose={()=>setMergeSource(null)}/>}
 {addFileAt&&vault&&<BoardChooser initialPath={addFileAt.path.split('/').slice(0,-1).join('/')} kind="source" vaultId={addFileAt.vaultId} language={language} onClose={()=>{addFileEpoch.current++;setAddFileAt(null);}} onChoose={()=>{}} onChooseMany={async sourcePaths=>{const placement=addFileAt;const target=state.current.tabs.find(x=>x.vaultId===placement.vaultId&&x.file.path===placement.path);if(!target||state.current.vault?.id!==placement.vaultId)throw Error(t('sourceChanged'));await performBoardChange(target,expectedSHA256=>api.addBoardFileCards({vaultId:target.vaultId,path:target.file.path,expectedSHA256,sourcePaths,x:placement.x,y:placement.y}));setAddFileAt(current=>current===placement?null:current);}}/>}
 {boardText&&<Modal closeOnBackdrop={false} title={language==='zh'?'编辑文本框':'Edit text box'} onClose={()=>setBoardText(null)}><form onSubmit={event=>{event.preventDefault();void attempt(async()=>{
  if(boardText.text.length>100000||(boardText.richTextHTML?.length||0)>300000)throw Error(language==='zh'?'请把过长内容拆成多个文本框。':'Split long content into multiple text boxes.');
  const target=state.current.tabs.find(x=>x.vaultId===boardText.vaultId&&x.file.path===boardText.path);if(!target)return;const board=JSON.parse(target.draft);if(boardText.id){const item=board.items.find((i:Record<string,unknown>)=>i.id===boardText.id);if(!item||boxSignature(item)!==boardText.originalContent)throw Error(language==='zh'?'这个文本框已在其他位置修改。已保留你的输入；请复制后重新打开文本框合并。':'This box changed elsewhere. Your input is preserved; copy it, then reopen the box to merge.');}const id=boardText.id||crypto.randomUUID();const base=boardText.id?board:addMindNode(board,boardText.title,{x:boardText.x,y:boardText.y},undefined,id);
  const next=patchMindNode(base,id,{title:boardText.title,text:boardText.text,kind:boardText.textFormat==='latex'?'formula':'text',textFormat:boardText.textFormat,richTextHTML:boardText.richTextHTML||''});
  setTabs(old=>old.map(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path?{...x,draft:JSON.stringify(next),dirty:JSON.stringify(next)!==JSON.stringify(x.file.board)}:x));setBoardText(null);
 });}}><label className="form-label">{language==='zh'?'标题':'Title'}<input autoFocus value={boardText.title} maxLength={10000} onChange={e=>setBoardText({...boardText,title:e.target.value})}/></label><TextBoxEditor value={boardText} language={language} onChange={value=>setBoardText({...boardText,...value})}/>{error&&<p role="alert" className="form-error">{error}</p>}<div className="modal-actions"><Button type="button" onClick={()=>setBoardText(null)}>{t('cancel')}</Button><Button type="submit" className="primary" disabled={boardText.text.length>100000||(boardText.richTextHTML?.length||0)>300000}>{language==='zh'?'应用到白板':'Apply to board'}</Button></div></form></Modal>}
 {latexConfirm&&<Modal title={language==='zh'?'编译 LaTeX 文档':'Compile LaTeX document'} onClose={()=>setLatexConfirm(false)}><p>{language==='zh'?'将保存并编译这份源文档，在同一文件夹新增 PDF。编译在本机进行，可访问本机资源；请先确认源码内容。基础宏包已包含，缺少的宏包可能需要联网下载。':'Save and compile this source into a new PDF in the same folder. Compilation runs locally and can access local resources; review the source first. Basic packages are included; missing packages may need an internet download.'}</p><div className="modal-actions"><Button onClick={()=>setLatexConfirm(false)}>{t('cancel')}</Button><Button className="primary" onClick={()=>{setLatexConfirm(false);void attempt(compileLatex);}}>{language==='zh'?'保存并编译':'Save and compile'}</Button></div></Modal>}
 {latexResult&&<Modal title={latexResult.path?(language==='zh'?'PDF 已生成':'PDF created'):(language==='zh'?'编译未完成':'Compilation failed')} onClose={()=>setLatexResult(null)}><p>{latexResult.path||(language==='zh'?'源文档仍然保留，请根据下面的信息修改后重试。':'Your source is preserved. Correct the issue below and try again.')}</p><details open={!latexResult.path}><summary>{language==='zh'?'编译信息':'Compiler output'}</summary><pre className="tex-result">{latexResult.log}</pre></details><div className="modal-actions"><Button onClick={()=>setLatexResult(null)}>{t('close')}</Button>{latexResult.path&&<Button className="primary" onClick={()=>{const result=latexResult;setLatexResult(null);if(state.current.vault?.id===result.vaultId)void attempt(()=>open(result.path!));}}>{language==='zh'?'打开 PDF':'Open PDF'}</Button>}</div></Modal>}
 {notebookConfirm&&<Modal title={language==='zh'?'运行 Notebook':'Run Notebook'} onClose={()=>setNotebookConfirm(null)}><p>{basename(notebookConfirm.path)}</p><p>{language==='zh'?'将保存并在本机运行所选 Python 单元格。代码可以读写文件并访问网络，请先确认代码内容。':'Save and run the selected Python cells locally. Code can read and write files and access the network; review the code first.'}</p><label className="check-label"><input type="checkbox" checked={rememberRun} onChange={e=>setRememberRun(e.target.checked)}/>{language==='zh'?'本次打开软件期间记住此选择':'Remember this choice until the app closes'}</label><div className="modal-actions"><Button onClick={()=>setNotebookConfirm(null)}>{t('cancel')}</Button><Button data-testid="notebook-confirm-run" className="primary" onClick={()=>{const request=notebookConfirm;notebookConsent.current=rememberRun;setNotebookConfirm(null);void notebooks.execute(request.vaultId,request.path,request.indices);}}><Play/>{language==='zh'?'保存并运行':'Save and run'}</Button></div></Modal>}
 {pythonConfirm&&<Modal title={t('runTitle')} onClose={()=>setPythonConfirm(false)}><p>{t('runBody')}</p><label className="check-label"><input type="checkbox" checked={rememberRun} onChange={e=>setRememberRun(e.target.checked)}/>{t('runConsent')}</label><div className="modal-actions"><Button onClick={()=>setPythonConfirm(false)}>{t('cancel')}</Button><Button className="primary" onClick={()=>{setPythonConfirm(false);runConsent.current=rememberRun;void attempt(runPython)}}><Play/>{t('runNow')}</Button></div></Modal>}
 {confirm&&<Modal title={t('discardTitle')} onClose={()=>setConfirm(null)}><p>{t('discardBody')}</p><div className="modal-actions"><Button onClick={()=>setConfirm(null)}>{t('keep')}</Button><Button onClick={()=>{const action=confirm.run;setConfirm(null);action();}}>{t('discard')}</Button><Button className="primary" onClick={()=>void attempt(async()=>{for(const target of confirm.tabs){const latest=state.current.tabs.find(x=>x.vaultId===target.vaultId&&x.file.path===target.file.path);if(latest&&!await saveTab(latest))return;}const action=confirm.run;setConfirm(null);action();})}>{t('save')}</Button></div></Modal>}
 {video&&<FloatingVideo key={video.session} vaultId={video.vaultId} path={video.path} language={language} onDocumentLink={(source,target)=>{if(state.current.vault?.id===video.vaultId)readingDocumentLink(source,target);}} onRootFileLink={path=>{if(state.current.vault?.id===video.vaultId)void attempt(()=>requestOpen(path));}} onWikiLink={target=>{if(state.current.vault?.id===video.vaultId)wikiLink(target);}} onReadingOpen={(path,page,playback)=>{if(state.current.vault?.id===video.vaultId)void attempt(()=>requestOpen(path,page,playback));}} resolveDocumentMedia={(source,path)=>state.current.vault?.id===video.vaultId?resolveAsset(path,source):Promise.resolve(undefined)} initialPlayback={video.playback} onClose={()=>setVideo(null)}/>}
 {mediaRequest&&<MediaEditor onStateChange={state=>{mediaState.current=state;}} open={mediaVisible} request={mediaRequest} language={language} onClose={()=>setMediaVisible(false)} onSaved={()=>{setAssetRevision(value=>value+1);void refreshListing.current();}}/>}
 {quickOpen&&<CommandPalette language={language} actions={quickActions} onClose={()=>setQuickOpen(false)}/>}
 {calendarOpen&&vault&&<Calendar key={vault.id} vault={vault} language={language} initialDate={calendarDate} onOpenSource={path=>{setCalendarOpen(false);void attempt(()=>requestOpen(path));}} focus={calendarFocus||undefined} onClose={()=>{setCalendarOpen(false);setCalendarFocus(null);}} onOpenChecklist={(folder,path,taskId)=>{setCalendarOpen(false);setChecklistRequest({vault,folder,path,taskId});}} onSaved={()=>{setAssetRevision(n=>n+1);void refreshListing.current().catch(()=>{});}}/>}
 {quickNotesVault&&<QuickNotes key={quickNotesVault.id} vault={quickNotesVault} language={language} onClose={()=>setQuickNotesVault(null)} onSaved={()=>{setAssetRevision(value=>value+1);void refreshListing.current().catch(()=>{});}} onOpenChecklist={(path,taskId)=>{setQuickNotesVault(null);setChecklistRequest({vault:quickNotesVault,path,taskId});}}/>}
 {checklistRequest&&<CourseChecklist vault={checklistRequest.vault} initialFolder={checklistRequest.folder} initialPath={checklistRequest.path} initialTaskId={checklistRequest.taskId} initialSourcePath={checklistRequest.sourcePath} onOpenSource={path=>{setChecklistRequest(null);void attempt(()=>requestOpen(path));}} onOpenCalendar={date=>{setChecklistRequest(null);setCalendarDate(date);setCalendarFocus(null);setCalendarOpen(true);}} language={language} onClose={()=>setChecklistRequest(null)} onSaved={()=>{setAssetRevision(value=>value+1);void refreshListing.current().catch(()=>{});}}/>}
 {mathEverOpened&&<MathWorkbench open={mathVisible} language={language} onClose={()=>setMathVisible(false)}/>}
 {exportFile&&<ExportDialog file={exportFile.file} vaultId={exportFile.vaultId} view={exportFile.view} language={language} onClose={()=>setExportFile(null)} onCurrentView={exportCurrentPDF} onSaved={()=>setStatus(t('exportDone'))}/>}
 {learningRequest&&<RecognitionLearningCenter key={learningRequest.nonce} language={language} initialDraft={learningRequest.draft} onClose={()=>setLearningRequest(null)}/>}
 {showSettings&&<Modal title={language==='zh'?'设置':'Settings'} onClose={()=>{setShowSettings(false);setDiagnostics(null);}}><label className="form-label">{language==='zh'?'界面语言':'Display language'}<select aria-label="Language" value={language} onChange={event=>setLanguage(event.target.value as Language)}><option value="zh">中文</option><option value="en">English</option></select></label><label className="form-label">{language==='zh'?'视频左右键跳转秒数':'Video arrow-key seek interval'}<select aria-label={language==='zh'?'视频快进秒数':'Video seek seconds'} value={videoSeekSeconds} onChange={event=>{const seconds=Number(event.target.value);setVideoSeekSeconds(seconds);localStorage.setItem('inkspace.video.seekSeconds',String(seconds));window.dispatchEvent(new Event('inkspace-video-settings'));}}>{[1,3,5,15,30].map(seconds=><option key={seconds} value={seconds}>{seconds} {language==='zh'?'秒':'seconds'}</option>)}</select></label><h3>{language==='zh'?'个人识别学习':'Personal recognition learning'}</h3><p>{language==='zh'?'主动收集原始手写或语音和人工正确文字，管理本机样本；当前尚未训练识别模型。':'Collect original handwriting or speech with verified text and manage local samples. Recognition models have not been trained.'}</p><Button data-testid="settings-recognition-learning-open" onClick={()=>{setShowSettings(false);setDiagnostics(null);setLearningRequest({nonce:Date.now()});}}>{language==='zh'?'打开个人识别学习中心':'Open personal recognition learning center'}</Button><AIWebSettings language={language} onOpen={()=>{setShowSettings(false);if(!panels.aiOpen)panels.toggleAI();}}/><TranslationSettings language={language}/><h3>{t('diagnostics')}</h3><p>{t('diagnosticsBody')}</p><Button onClick={diagnosticsAction}>{language==='zh'?'查看诊断记录':'View diagnostic records'}</Button>{diagnostics&&<><div className="diagnostic-list">{diagnostics.events.length?diagnostics.events.map((event,i)=><div key={i}><strong>{event.operation} · {event.code}</strong><span>{new Date(event.lastAt).toLocaleString(language==='zh'?'zh-CN':'en')} · {event.count}</span></div>):<p className="muted">{t('noDiagnostics')}</p>}</div><div className="modal-actions"><Button className="primary" onClick={()=>void attempt(async()=>{const result=unwrap(await api.exportDiagnostics());if(result.saved)setStatus(t('exportDone'));})}><Download/>{t('exportReport')}</Button></div></>}</Modal>}
 </div></div>{workEverOpened&&<div className={'work-space-layer'+(space==='study'?' space-inactive':'')} data-testid="work-space-layer" aria-hidden={space==='study'} inert={space==='study'||undefined}><WorkSpace language={language} active={space==='work'} focusItemId={notificationTarget}/></div>}</div></div>;
}
