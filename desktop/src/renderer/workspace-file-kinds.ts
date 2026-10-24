import type {VaultEntry} from '../shared/desktop-api';
export type WorkspaceFileKind = 'py'|'ipynb'|'md'|'tex'|'pdf'|'reviews'|'originals'|'ocr';
export function matchesWorkspaceFile(entry:VaultEntry,kind:WorkspaceFileKind):boolean{
 if(entry.kind==='folder')return true;
 if(entry.kind==='unsupported'||entry.kind==='video')return false;
 const path=entry.path.toLowerCase();
 if(/\.(inkcheck|inkcalendar|inkcut)\.json$/.test(path))return false;
 if(kind==='ocr')return /\.(pdf|png|jpe?g)$/.test(path);
 if(kind==='reviews')return true;
 if(kind==='originals')return entry.kind!=='board';
 if(kind==='md')return /\.(md|markdown)$/.test(path);
 return path.endsWith('.'+kind);
}
