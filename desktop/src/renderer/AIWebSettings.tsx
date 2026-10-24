import {useEffect,useRef,useState} from 'react';
import {Button} from './ui';
import type {Language} from './i18n';
import type {AIWebSettings as Settings,AIWebProviderID} from '../shared/desktop-api';

export default function AIWebSettings({language,onOpen}:{language:Language;onOpen?:()=>void}){
 const zh=language==='zh',alive=useRef(true),[info,setInfo]=useState<Settings|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{alive.current=true;let changed=false;const off=window.desktop.onAIWebProviderChanged(value=>{changed=true;if(alive.current)setInfo(value);});void window.desktop.aiWebSettings().then(result=>{if(!alive.current||changed)return;if(result.ok)setInfo(result.value);else setMessage(zh?'无法读取网页 AI 设置，请稍后重试。':'Could not read web AI settings. Try again later.');}).catch(()=>{if(alive.current)setMessage(zh?'无法读取网页 AI 设置，请稍后重试。':'Could not read web AI settings. Try again later.');});return()=>{alive.current=false;off();};},[]);
 const change=async(provider:AIWebProviderID)=>{setBusy(true);setMessage('');try{const result=await window.desktop.setAIWebProvider({provider});if(alive.current){if(result.ok){setInfo(result.value);setMessage(zh?'已记住，下次打开仍使用此 AI。':'Saved. This AI will be used next time.');}else setMessage(zh?'未能保存，仍使用之前的 AI。请重试。':'Could not save. The previous AI remains selected. Please retry.');}}catch{if(alive.current)setMessage(zh?'未能保存，请重试。':'Could not save. Please retry.');}finally{if(alive.current)setBusy(false);}};
 const provider=info?.providers.find(value=>value.id===info.provider);
 return <section className="translation-settings" data-testid="ai-web-settings"><h3>{zh?'网页 AI 助手':'Web AI assistant'}</h3><p>{zh?'在网页内自行登录；下次打开仍使用当前 AI。网页账号与下方翻译 API 单独配置。':'Sign in on the webpage. The same AI opens next time. Website accounts and the translation API below are configured separately.'}</p>
  <label className="form-label">{zh?'右侧网页':'Sidebar website'}<select data-testid="ai-web-provider" value={info?.provider||'chatgpt'} disabled={busy||!info} onChange={event=>void change(event.target.value as AIWebProviderID)}>{(info?.providers||[{id:'chatgpt',label:'ChatGPT'},{id:'deepseek',label:'DeepSeek'},{id:'claude',label:'Claude'},{id:'gemini',label:'Gemini'}]).map(value=><option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
  {provider&&<p className="muted" data-testid="ai-web-address">{provider.url}</p>}
  {onOpen&&<Button data-testid="ai-web-open" disabled={busy||!info} onClick={onOpen}>{zh?'打开右侧网页':'Open sidebar website'}</Button>}
  <p className="muted">{zh?'侧栏关闭时，选择只保存偏好。切换保留本次会话的输入草稿；退出应用前请处理未发送内容。':'With the sidebar closed, choosing only saves the preference. Switching preserves drafts in this app session; finish unsent drafts before quitting.'}</p>
  {(message||info?.storageIssue)&&<p role="status" data-testid="ai-web-settings-status">{message||(zh?'之前的偏好未能读取，当前使用 ChatGPT；重新选择可保存。':'The previous preference could not be read. ChatGPT is selected; choose a service to save it.')}</p>}
 </section>;
}
