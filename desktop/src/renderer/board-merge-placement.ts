export type MergePoint={x:number;y:number};
export type MergeRect=MergePoint&{width:number;height:number};
export const MERGE_WORLD_LIMIT=8_000_000;
export function validMergeBounds(rect:MergeRect):boolean{return [rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)&&rect.width>0&&rect.height>0&&rect.width<=MERGE_WORLD_LIMIT&&rect.height<=MERGE_WORLD_LIMIT;}
/** Placement is the union's upper-left corner; no source coordinates are changed here. */
export function clampMergePosition(point:MergePoint,bounds:MergeRect):MergePoint {
 if(!validMergeBounds(bounds)||![point.x,point.y].every(Number.isFinite))throw Error('Invalid merge placement');
 return{x:Math.max(0,Math.min(MERGE_WORLD_LIMIT-bounds.width,point.x)),y:Math.max(0,Math.min(MERGE_WORLD_LIMIT-bounds.height,point.y))};
}
export function defaultMergePosition(source:MergeRect,target:MergeRect|null):MergePoint {
 return clampMergePosition(target?{x:Math.max(0,target.x),y:target.y+target.height+120}:{x:120,y:120},source);
}
export function mergePlacementCamera(source:MergeRect,point:MergePoint,target:MergeRect|null){
 const x=Math.min(point.x,target?.x??point.x),y=Math.min(point.y,target?.y??point.y),right=Math.max(point.x+source.width,target?target.x+target.width:0),bottom=Math.max(point.y+source.height,target?target.y+target.height:0);
 return{x:(x+right)/2,y:(y+bottom)/2,zoom:Math.max(.00001,Math.min(1,800/Math.max(1,right-x),460/Math.max(1,bottom-y)))};
}
/** Previews stay bounded even when the actual source contains millions of points. */
export function mergePreviewPlan(bounds:MergeRect,pointCount:number){
 const scale=Math.min(1,1400/Math.max(bounds.width,bounds.height));
 return{width:Math.max(1,Math.ceil(bounds.width*scale)),height:Math.max(1,Math.ceil(bounds.height*scale)),scale,stride:Math.max(1,Math.ceil(pointCount/180_000))};
}
