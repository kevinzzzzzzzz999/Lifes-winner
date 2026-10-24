import {Minus,Plus} from 'lucide-react';
import {Button} from './ui';
import type {Language} from './i18n';
import {MIN_DOCUMENT_ZOOM,MAX_DOCUMENT_ZOOM} from './document-zoom';
export default function DocumentZoomControls({zoom,onZoom,language}:{zoom:number;onZoom:(value:number)=>void;language:Language}){
 const zh=language==='zh';return <div className="document-zoom-controls" role="group" aria-label={zh?'文档缩放':'Document zoom'} title={zh?'双指捏合缩放；普通双指滑动滚动页面':'Pinch to zoom; swipe with two fingers to scroll'}>
 <Button data-testid="document-zoom-out" aria-label={zh?'缩小文档':'Zoom document out'} disabled={zoom<=MIN_DOCUMENT_ZOOM} onClick={()=>onZoom(zoom/1.2)}><Minus/></Button>
 <Button data-testid="document-zoom-reset" aria-label={zh?'恢复文档为100%':'Reset document to 100%'} onClick={()=>onZoom(1)}>{Math.round(zoom*100)}%</Button>
 <Button data-testid="document-zoom-in" aria-label={zh?'放大文档':'Zoom document in'} disabled={zoom>=MAX_DOCUMENT_ZOOM} onClick={()=>onZoom(zoom*1.2)}><Plus/></Button></div>;
}
