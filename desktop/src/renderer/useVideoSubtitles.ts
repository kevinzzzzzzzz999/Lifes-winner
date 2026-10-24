import {useEffect,useMemo,useRef,useState} from 'react';
import type {VideoPlaybackState} from '../shared/video-playback';
import {decodeSubtitleBytes,parseLocalSubtitles,type LocalSubtitles} from './video-controls';
import {VideoSubtitlePersistence,type SubtitleAssociationResult,type SubtitlePersistenceState} from './video-subtitle-persistence';

type AssociationAPI={getVideoSubtitles?:(request:{vaultId:string;path:string})=>Promise<{ok:true;value:SubtitleAssociationResult}|{ok:false;error:{code:string}}>;
 saveVideoSubtitles?:(request:{vaultId:string;path:string;subtitle:{name:string;text:string;enabled:boolean}|null;expectedSHA256:string|null})=>Promise<{ok:true;value:SubtitleAssociationResult}|{ok:false;error:{code:string}}>};
export function useVideoSubtitles(vaultId:string,path:string,initialPlayback:VideoPlaybackState|undefined){
 const controller=useMemo(()=>{const api=window.desktop as unknown as AssociationAPI;
  const transport=typeof api?.getVideoSubtitles==='function'&&typeof api?.saveVideoSubtitles==='function'?{read:()=>api.getVideoSubtitles!({vaultId,path}),save:(subtitle:SubtitleAssociationResult['subtitle'],expectedSHA256:string|null)=>api.saveVideoSubtitles!({vaultId,path,subtitle,expectedSHA256})}:null;
  return new VideoSubtitlePersistence(transport);
 },[vaultId,path]);
 const active=useRef(controller);active.current=controller;
 const fileRead=useRef(0),live=useRef(true);
 const [observed,setObserved]=useState<{owner:VideoSubtitlePersistence;state:SubtitlePersistenceState}>(()=>({owner:controller,state:controller.snapshot()}));
 const [fileState,setFileState]=useState<{owner:VideoSubtitlePersistence;reading:boolean;error:string}>({owner:controller,reading:false,error:''});
 const [provisionalEnabled,setProvisionalEnabled]=useState<{owner:VideoSubtitlePersistence;enabled:boolean}>({owner:controller,enabled:initialPlayback?.subtitles?.enabled??true});
 const state=observed.owner===controller?observed.state:controller.snapshot(),readingFile=fileState.owner===controller&&fileState.reading;
 useEffect(()=>{live.current=true;const off=controller.subscribe(state=>setObserved({owner:controller,state}));controller.start();return()=>{live.current=false;fileRead.current++;off();};},[controller]);
 useEffect(()=>{const refresh=(event:Event)=>{if((event as CustomEvent).detail?.vaultId===vaultId)controller.refresh();};window.addEventListener('inkspace-board-refresh',refresh);return()=>window.removeEventListener('inkspace-board-refresh',refresh);},[controller,vaultId]);
 const parsed=useMemo(()=>{if(state.value===undefined)return{subtitles:initialPlayback?.subtitles?.data||null,error:''};if(state.value===null)return{subtitles:null,error:''};try{return{subtitles:parseLocalSubtitles(state.value.name,state.value.text),error:''};}catch{return{subtitles:null,error:'INVALID_SAVED_SUBTITLE'};}},[state.value,initialPlayback?.subtitles]);
 const enabled=state.value===undefined?(provisionalEnabled.owner===controller?provisionalEnabled.enabled:initialPlayback?.subtitles?.enabled??true):state.value?.enabled??true;
 const loadFile=async(file?:File)=>{if(!file)return;const request=++fileRead.current,owner=controller;setFileState({owner,reading:true,error:''});
  try{const nameCharacters=Array.from(file.name);if(file.size>2*1024*1024||nameCharacters.length>255||nameCharacters.some(c=>c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff))throw Error('SUBTITLE_TOO_LARGE');const text=decodeSubtitleBytes(await file.arrayBuffer());if(new TextEncoder().encode(text).byteLength>2*1024*1024)throw Error('SUBTITLE_TOO_LARGE');parseLocalSubtitles(file.name,text);
   if(!live.current||active.current!==owner||request!==fileRead.current)return;controller.edit({name:file.name,text,enabled:true});setFileState({owner,reading:false,error:''});
  }catch{if(live.current&&active.current===owner&&request===fileRead.current)setFileState({owner,reading:false,error:'INVALID_IMPORTED_SUBTITLE'});}
 };
 const toggle=()=>{const current=controller.snapshot();if(current.value){controller.edit({...current.value,enabled:!current.value.enabled});}else if(current.phase==='unavailable')setProvisionalEnabled({owner:controller,enabled:!enabled});};
 const remove=()=>{fileRead.current++;setFileState({owner:controller,reading:false,error:''});controller.edit(null);};
 return{subtitles:parsed.subtitles as LocalSubtitles|null,name:state.value===undefined?initialPlayback?.subtitles?.name||'':state.value?.name||'',enabled,loadFile,toggle,remove,
  hasAssociation:state.value===undefined?!!initialPlayback?.subtitles:!!state.value,state,readingFile,
  error:fileState.owner===controller&&fileState.error?fileState.error:parsed.error,
  canToggle:!readingFile&&(state.value!==undefined||state.phase==='unavailable'),blockTransfer:readingFile||state.dirty||state.phase==='loading'||state.phase==='saving',
  retry:()=>controller.retry(),replaceSaved:()=>controller.replaceAfterConflict(),reloadSaved:()=>{fileRead.current++;setFileState({owner:controller,reading:false,error:''});controller.reloadSaved();}};
}
