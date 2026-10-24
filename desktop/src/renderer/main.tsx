import { createRoot } from 'react-dom/client';
import { Component,type ReactNode } from 'react';
import App from './App';
import DetachedVideoWindow from './DetachedVideoWindow';
import './styles.css';
import './panel-layout.css';
import './workspace-theme.css';
class Boundary extends Component<{children:ReactNode},{error:boolean}>{state={error:false};static getDerivedStateFromError(){return{error:true}}render(){return this.state.error?<div className="empty-state"><h1>视图无法打开 · View unavailable</h1><p>请重开软件后导出诊断记录。Please reopen the app and export diagnostics.</p></div>:this.props.children;}}
async function start(){if(import.meta.env.DEV&&new URLSearchParams(location.search).has('preview')){const {installPreviewFixture}=await import('./preview-fixture');installPreviewFixture();}createRoot(document.getElementById('root')!).render(window.desktop?<Boundary>{new URLSearchParams(location.search).has('playerWindow')?<DetachedVideoWindow/>:<App/>}</Boundary>:<div className="empty-state"><h1>人生赢家 · life'winner</h1><p>请从桌面安装的软件打开。Open the installed desktop app.</p></div>);}
void start();
