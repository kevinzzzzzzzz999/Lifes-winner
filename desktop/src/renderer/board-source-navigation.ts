import type {PDFSourceReference} from '../shared/pdf-extend';

/** Read a saved excerpt anchor without trusting arbitrary board JSON fields. */
export function boardPDFSourceReference(value:unknown):PDFSourceReference|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const ref=value as Record<string,unknown>,rect=ref.rect as Record<string,unknown>|undefined;
 if(ref.schemaVersion!==1||typeof ref.path!=='string'||!ref.path||ref.path.length>4096||!/\.pdf$/i.test(ref.path)||/^[\/]|[\\:\u0000-\u001f\u007f]/.test(ref.path)||ref.path.split('/').some(part=>!part||part==='.'||part==='..')||typeof ref.sourceSHA256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sourceSHA256)||!Number.isSafeInteger(ref.page)||Number(ref.page)<1||!rect||typeof rect!=='object'||Array.isArray(rect))return;
 const coordinates=['x','y','width','height'] as const;
 if(!coordinates.every(key=>typeof rect[key]==='number'&&Number.isFinite(rect[key])&&Number(rect[key])>=0&&Number(rect[key])<=1)||Number(rect.width)<=0||Number(rect.height)<=0||Number(rect.x)+Number(rect.width)>1.000001||Number(rect.y)+Number(rect.height)>1.000001)return;
 const extendBlockID=typeof ref.extendBlockID==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref.extendBlockID)?ref.extendBlockID:undefined;
 return {schemaVersion:1,path:ref.path,sourceSHA256:ref.sourceSHA256,page:Number(ref.page),rect:{x:Number(rect.x),y:Number(rect.y),width:Number(rect.width),height:Number(rect.height)},quote:typeof ref.quote==='string'?ref.quote:'',...(extendBlockID?{extendBlockID}:{})};
}
