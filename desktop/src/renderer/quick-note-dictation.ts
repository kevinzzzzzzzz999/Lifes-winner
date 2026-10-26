import type {QuickNoteDraft} from './quick-notes';
export type DictationDraftTarget={sessionId:string;draftId:string;baseText:string;sequence:number;latestText:string};
export function dictationDraftText(base:string,text:string):string{
 const spoken=text.trim();if(!spoken)return base;
 return base+(base&&!/\s$/.test(base)?'\n':'')+spoken;
}
export function canApplyDictation(target:DictationDraftTarget,current:QuickNoteDraft):boolean{return target.draftId===current.id&&target.baseText===current.text;}
export function dictationContextWords(text:string):string[]{return [...new Set(text.split(/[,，、;；\n]/).map(s=>s.trim()).filter(Boolean))].filter(s=>s.length<=80).slice(0,100);}
export function dictationErrorMessage(code:string|undefined,zh:boolean):string{
 const values:Record<string,[string,string]>={
  'microphone-denied':['麦克风权限未开启，请在系统设置 → 隐私与安全性 → 麦克风中允许“人生赢家”。','Allow microphone access for Life\'s Winner in System Settings → Privacy & Security → Microphone.'],
  'permission-pending':['系统麦克风授权仍在处理中，请先完成当前授权提示，再重新开始。','System microphone permission is still pending. Finish the current permission prompt before starting again.'],
  'foreground-required':['请先点 Dock 中的“人生赢家”，让这个窗口处于前台，再点语音输入。',"Click Life's Winner in the Dock to bring this window to the front, then click Dictate."],
  'microphone-restricted':['系统限制了本应用的麦克风访问，请在系统设置检查相关限制；没有启动听写。','Microphone access is restricted by the system. Check system restrictions; dictation did not start.'],
  'microphone-permission-required':['听写组件尚未获得麦克风许可，没有启动录音。请在主窗口完成系统授权后再次点语音输入；必要时重新打开应用。','The dictation component has no microphone permission and did not start capture. Complete authorization in the main window and retry; reopen the app if required.'],
  'speech-permission-denied':['本机听写权限未开启，请在系统设置中允许语音识别。','Allow speech recognition in System Settings.'],
  'model-unavailable':['本机语言资源暂不可用，请联网后重试，或切换语言。','The local language model is unavailable. Connect to the internet and retry, or choose another language.'],
  'language-unavailable':['这台Mac暂不支持所选听写语言，请切换语言。','This Mac does not support the selected dictation language.'],
  'audio-unavailable':['麦克风暂不可用，请检查系统输入设备。','The microphone is unavailable. Check the system input device.'],
  'startup-timeout':['听写准备超时，尚未进入可以说话状态。原草稿保留，请重试。','Dictation preparation timed out before it was ready. Your draft is kept; retry.'],
  'audio-not-ready':['没有持续收到麦克风音频，听写已停止。请检查系统输入设备，再等到“可以开始说话”后重试。','Microphone audio did not arrive or stopped arriving. Check your input device, then wait for Ready to speak before retrying.'],
  'transcription-range-unavailable':['本机引擎返回的文字范围无法安全合并，听写已停止；已识别文字保留，请核对后重试。','The local engine returned text ranges that could not be safely merged. Dictation stopped and recognized text is kept; review it before retrying.'],
  'timeout':['本次听写已结束，已识别文字仍保留。','This dictation session ended; recognized text is kept.'],
  'text-limit':['本次听写内容较长，已识别文字仍保留，请分段继续。','This dictation is long. Recognized text is kept; continue in shorter sections.']
 };
 return (values[code||'']||['听写已停止，已有草稿和识别文字均保留，可以重试。','Dictation stopped. Your draft and recognized text are kept; you can retry.'])[zh?0:1];
}

export type DictationCorrectionCandidate={draftId:string;machineText:string;prefix:string;insertionStart:number;insertionEnd:number};
export function dictationCorrectionCandidate(run:DictationDraftTarget,text:string):DictationCorrectionCandidate|null{
 const machineText=text.trim();if(!machineText||machineText.length>4000)return null;const appended=dictationDraftText(run.baseText,machineText),insertionStart=appended.length-machineText.length;
 return{draftId:run.draftId,machineText,prefix:appended.slice(0,insertionStart),insertionStart,insertionEnd:appended.length};
}
export function currentDictationCorrection(candidate:DictationCorrectionCandidate|null,draft:QuickNoteDraft):{originalText:string;correctedText:string}|null{
 if(!candidate||candidate.draftId!==draft.id||!draft.text.startsWith(candidate.prefix))return null;
 const correctedText=draft.text.slice(candidate.insertionStart).trim();if(!correctedText||correctedText===candidate.machineText||correctedText.length>4000)return null;
 return{originalText:candidate.machineText,correctedText};
}
