import {boardPDFOwnerIDs} from '../shared/board-pdf-owners';
import {useEffect, useState} from 'react';
import {PDFPage} from './PDFViewer';
import MindInkPreview from './MindInkPreview';

export default function MindSourcePreview({vaultId, board, id, sourcePath, page, width, height}: {
  vaultId?: string; board: Record<string, unknown>; id: string; sourcePath: string; page: number; width: number; height: number;
}) {
  const [url, setURL] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setURL(null);
    if (vaultId && window.desktop) void window.desktop.getAssetUrl({vaultId, path:sourcePath, hideBoardIDs:boardPDFOwnerIDs(board)}).then(result => {
      if (live && result.ok) setURL(result.value.url);
    }).catch(() => {});
    return () => {live=false;};
  }, [vaultId, sourcePath, board]);
  const item = (board.items as {id:string;width:number;height:number}[])?.find(item => item.id===id);
  const ratio = item ? item.width/item.height : 612/792;
  const w = Math.min(width, height*ratio), h=w/ratio;
  return <div style={{width,height,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}>
    <div className="mind-source-preview" style={{width:w,height:h,position:'relative',overflow:'hidden',background:'#fff'}}>
      {url && <PDFPage url={url} page={page} width={Math.min(720,w)} annotationMode={1}/>}
      <div style={{position:'absolute',inset:0}}><MindInkPreview board={board} id={id} width={w} height={h}/></div>
    </div>
  </div>;
}
