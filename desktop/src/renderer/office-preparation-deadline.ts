export const OFFICE_PREPARATION_TIMEOUT_MS=15000;

/** Bounds preparation only. Capture/decode cannot always be interrupted by the
 * platform, so every continuation must checkpoint before its next side effect. */
export function beginOfficePreparation<T>(prepare:(checkpoint:()=>void)=>Promise<T>,timeoutMs=OFFICE_PREPARATION_TIMEOUT_MS){
 let settled=false,rejectStop:(error:Error)=>void=()=>{};
 const interrupted=new Promise<never>((_resolve,reject)=>{rejectStop=reject;});
 const stop=(code:string)=>{if(settled)return;settled=true;rejectStop(Error(code));};
 const checkpoint=()=>{if(settled)throw Error('CANCELLED');};
 const timer=setTimeout(()=>stop('OFFICE_PREPARATION_TIMEOUT'),timeoutMs);
 const promise=Promise.race([Promise.resolve().then(()=>{checkpoint();return prepare(checkpoint);}),interrupted]).finally(()=>{settled=true;clearTimeout(timer);});
 return{promise,cancel:()=>stop('CANCELLED')};
}
