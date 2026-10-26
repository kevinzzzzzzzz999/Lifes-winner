import {useEffect,useRef,useState} from 'react';
import {History,RefreshCw,FilePlus2} from 'lucide-react';
import {Button,Modal,basename} from './ui';
import type {Language} from './i18n';
import type {OpenedFile,ApiResult} from '../shared/desktop-api';
import type {BoardVersionList,BoardVersionDiff,BoardVersionEntry} from '../shared/board-versions';
import './board-versions.css';
const value=<T,>(result:ApiResult<T>):T=>{if(!result.ok)throw Error(result.error.message);return result.value;};
export default function BoardVersionsDialog({vaultId,file,language,onClose,onOpen}:{vaultId:string;file:OpenedFile;language:Language;onClose:()=>void;onOpen:(path:string)=>Promise<void>}){
 const zh=language==='zh',label=(a:string,b:string)=>zh?a:b;
 const [list,setList]=useState<BoardVersionList|null>(null),[from,setFrom]=useState(''),[to,setTo]=useState(''),[diff,setDiff]=useState<BoardVersionDiff|null>(null);
 const [loading,setLoading]=useState(false),[comparing,setComparing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [name,setName]=useState(()=>basename(file.path).replace(/\.inkspace\.json$/i,'').slice(0,40)+' · 版本副本-'+new Date().toISOString().replace(/\D/g,'').slice(0,14)+'.inkspace.json');
 const [restored,setRestored]=useState<OpenedFile|null>(null);
 const alive=useRef(true),loadEpoch=useRef(0),compareEpoch=useRef(0),pending=useRef(false);
 const request={vaultId,path:file.path,expectedSHA256:file.sha256};
 async function reload(){const epoch=++loadEpoch.current;setLoading(true);setError('');try{const next=value(await window.desktop.boardVersionsList(request));if(!alive.current||epoch!==loadEpoch.current)return;setList(next);const first=next.entries.find(v=>v.available&&!v.current)||next.entries[0];setFrom(first?.sha256||'');setTo(next.entries[0]?.sha256||'');setRestored(null);}catch(e){if(alive.current&&epoch===loadEpoch.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current&&epoch===loadEpoch.current)setLoading(false);}}
 useEffect(()=>{alive.current=true;void reload();return()=>{alive.current=false;loadEpoch.current++;compareEpoch.current++;};},[vaultId,file.path,file.sha256]);
 useEffect(()=>{const epoch=++compareEpoch.current;setDiff(null);if(!from||!to)return;setComparing(true);void window.desktop.boardVersionsCompare({...request,fromSHA256:from,toSHA256:to}).then(result=>{if(!alive.current||epoch!==compareEpoch.current)return;setDiff(value(result));setError('');}).catch(e=>{if(alive.current&&epoch===compareEpoch.current)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(alive.current&&epoch===compareEpoch.current)setComparing(false);});},[from,to,vaultId,file.path,file.sha256]);
 const entryName=(entry:BoardVersionEntry,index:number)=>`${entry.current?label('当前白板','Current board'):label('保留版本 '+index,'Snapshot '+index)} · ${entry.recordedAt?new Date(entry.recordedAt).toLocaleString(zh?'zh-CN':'en'):label('记录不可用','Unavailable')} · ${entry.sha256.slice(0,8)}`;
 async function restore(){if(pending.current||!from)return;pending.current=true;setBusy(true);setError('');try{const next=value(await window.desktop.boardVersionsRestoreCopy({...request,versionSHA256:from,name}));if(alive.current)setRestored(next);}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{pending.current=false;if(alive.current)setBusy(false);}}
 const changeLabel={added:label('新增','Added'),removed:label('移除','Removed'),changed:label('修改','Changed')};
 return <Modal title={label('白板版本与对比','Board versions & comparison')} closeOnBackdrop={false} onClose={()=>{if(!pending.current)onClose();}}><div className="board-versions" data-testid="board-versions">
  <p><History/>{basename(file.path)}</p><p className="muted">{label('本机保留的最近白板操作快照；不是全部 iCloud 历史。时间为本机记录时间，原笔迹数据完整保留。','Recent whiteboard snapshots kept on this Mac, not the entire iCloud history. Times reflect local records; original ink data is retained.')}</p>
  <Button disabled={loading||busy} onClick={()=>void reload()}><RefreshCw/>{label('重新读取','Refresh')}</Button>
  {loading&&<p role="status">{label('正在读取本机版本…','Reading local snapshots…')}</p>}
  {list&&<><p>{list.entries.length} {label('个可核对记录','records')} · {list.summary.items} {label('个对象','objects')} · {list.summary.webStrokes} {label('笔网页预览','preview strokes')}</p>
   {list.entries.length===1&&<p className="muted">{label('尚无更早的可用操作快照。以后在本机保存白板操作后，会在这里出现。','No earlier local snapshots yet. Future saved board operations appear here.')}</p>}
   <div className="board-version-pickers"><label>{label('之前 / 要恢复的版本','Before / version to restore')}<select aria-label={label('之前的白板版本','Before board version')} value={from} disabled={busy} onChange={e=>{setFrom(e.target.value);setRestored(null);}}>{list.entries.map((v,i)=><option key={v.sha256} value={v.sha256} disabled={!v.available}>{entryName(v,i)}</option>)}</select></label><label>{label('之后 / 对比版本','After / compare with')}<select aria-label={label('之后的白板版本','After board version')} value={to} disabled={busy} onChange={e=>setTo(e.target.value)}>{list.entries.map((v,i)=><option key={v.sha256} value={v.sha256} disabled={!v.available}>{entryName(v,i)}</option>)}</select></label></div>
   {!!list.warnings.length&&<p role="status" className="board-version-warning">{label('部分本机记录不可用，原白板保持不变。','Some local records are unavailable. The current board is unchanged.')}</p>}
  </>}
  {comparing&&<p role="status">{label('正在核对差异…','Comparing…')}</p>}
  {diff&&<section aria-label={label('差异摘要','Change summary')} className="board-version-diff"><table><thead><tr><th>{label('内容','Content')}</th><th>{label('之前','Before')}</th><th>{label('之后','After')}</th></tr></thead><tbody>{(['items','edges','pins','webStrokes'] as const).map(k=><tr key={k}><th>{{items:label('对象','Objects'),edges:label('连线','Links'),pins:label('定位','Pins'),webStrokes:label('预览笔迹','Preview strokes')}[k]}</th><td>{diff.before[k]}</td><td>{diff.after[k]}</td></tr>)}</tbody></table>
   <p>{label('对象：新增','Objects: added')} {diff.items.added} · {label('移除','removed')} {diff.items.removed} · {label('修改','changed')} {diff.items.changed}</p>
   <p>{[diff.nativeInkChanged&&label('原生笔迹已变动','Native ink changed'),diff.webInkChanged&&label('笔迹预览已变动','Ink preview changed'),diff.paperChanged&&label('纸张已变动','Paper changed'),diff.viewportChanged&&label('阅读视口已变动','Viewport changed'),diff.titleChanged&&label('标题已变动','Title changed')].filter(Boolean).join(' · ')||label('这些主要属性没有变化','These main properties are unchanged')}</p>
   {diff.otherFields.length>0&&<p className="muted">{label('其他变化：','Other changes: ')}{diff.otherFields.join('、')}</p>}
   <div className="board-version-detail-list">{diff.details.map(row=><article key={row.kind+row.id}><strong>{changeLabel[row.change]} · {row.title}</strong>{row.fields.length>0&&<small>{row.fields.join('、')}</small>}{(row.beforeText||row.afterText)&&<div className="board-version-text"><pre>{row.beforeText||'—'}</pre><pre>{row.afterText||'—'}</pre></div>}{row.textPreviewLimited&&<small>{label('长文字仅显示摘要；恢复副本不截断原文。','Long text is summarized here; recovery copies keep the full text.')}</small>}</article>)}</div>
   {diff.detailsLimited&&<p className="muted">{label('上方完整统计全部变化，明细只列前200项；恢复副本不会丢弃其余内容。','All changes are counted above; the first 200 details are shown. Recovery copies preserve the remaining contents.')}</p>}
  </section>}
  <section className="board-version-recovery"><h3>{label('恢复为独立副本','Recover as a separate copy')}</h3><p>{label('恢复“之前”所选版本，在原目录新建白板，保留当前白板。原PDF、独立批注、胶带和学习卡记录不属于这些白板操作快照，不会复制或回退。','Recover the selected Before version into a new board in the same folder, keeping the current board. Original PDFs and separate review, tape and study-card records are not part of these snapshots and are not copied or reverted.')}</p>
   {!restored?<><label>{label('副本文件名','Copy filename')}<input aria-label={label('版本副本文件名','Recovery copy filename')} value={name} maxLength={180} disabled={busy} onChange={e=>setName(e.target.value)}/></label><Button disabled={!diff||!from||busy||!name.endsWith('.inkspace.json')} onClick={()=>void restore()}><FilePlus2/>{busy?label('正在创建副本…','Creating copy…'):label('恢复所选版本为新副本','Recover selected version as new copy')}</Button></>:<><p role="status">{label('已创建：','Created: ')}{restored.path}</p><Button disabled={busy} onClick={async()=>{setBusy(true);try{await onOpen(restored.path);onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}>{label('打开恢复副本','Open recovered copy')}</Button></>}
  </section>
  {error&&<p className="inline-error" role="alert">{error}<br/>{label('当前白板保持；若它已在别处修改，请关闭窗口后重新打开。若副本已存在，请先检查它。','The current board is kept. Reopen this dialog after external changes. If a copy already exists, check it first.')}</p>}
 </div></Modal>;
}
