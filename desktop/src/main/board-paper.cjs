'use strict';
const {fail}=require('./errors.cjs');
function validatedBackground(value,allowUnknown=false){
 if(value===null)return null;
 const fields=['version','kind','color','lineColor','spacing','lineWidth','opacity'];
 if(!value||typeof value!=='object'||Array.isArray(value)||!allowUnknown&&Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||!['plain','ruled','grid','dots'].includes(value.kind)||!/^#[\da-f]{6}$/i.test(value.color)||!/^#[\da-f]{6}$/i.test(value.lineColor)||!Number.isFinite(value.spacing)||value.spacing<8||value.spacing>240||!Number.isFinite(value.lineWidth)||value.lineWidth<.25||value.lineWidth>4||!Number.isFinite(value.opacity)||value.opacity<0||value.opacity>1)fail('INVALID_REQUEST');
 return{version:1,kind:value.kind,color:value.color.toUpperCase(),lineColor:value.lineColor.toUpperCase(),spacing:value.spacing,lineWidth:value.lineWidth,opacity:value.opacity};
}
module.exports={validatedBackground};
