import {useEffect,useMemo,useRef,useState} from 'react';
import type {DesktopAPI,NotebookEvent,OpenedFile} from '../shared/desktop-api';
import {NotebookRunController,type NotebookRunState} from './notebook-run-controller';
export {notebookKey} from './notebook-run-controller';
export type {NotebookRunState} from './notebook-run-controller';
export function useNotebookRuns({api,prepare,apply}:{api:DesktopAPI;prepare:(vaultId:string,path:string)=>Promise<OpenedFile>;apply:(vaultId:string,path:string,events:NotebookEvent[],source:string)=>void}){
 const [states,setStates]=useState<Record<string,NotebookRunState>>({});const callbacks=useRef({prepare,apply});callbacks.current={prepare,apply};
 const controller=useMemo(()=>new NotebookRunController({api,prepare:(vaultId,path)=>callbacks.current.prepare(vaultId,path),apply:(vaultId,path,events,source)=>callbacks.current.apply(vaultId,path,events,source),changed:(key,state)=>setStates(old=>{const next={...old};if(state)next[key]=state;else delete next[key];return next;})}),[api]);
 useEffect(()=>controller.connect(),[controller]);
 return {states,execute:controller.execute,interrupt:controller.interrupt,restart:controller.restart,close:controller.close,isRunning:controller.isRunning};
}
