/** Application shortcuts must not replay keys already consumed by an editor. */
export type ShortcutEvent={key:string;metaKey:boolean;ctrlKey:boolean;altKey:boolean;shiftKey:boolean;defaultPrevented?:boolean;isComposing?:boolean;keyCode?:number;repeat?:boolean};
const plain=(event:ShortcutEvent,key:string)=>!event.defaultPrevented&&!event.isComposing&&event.keyCode!==229&&!event.altKey&&!event.shiftKey&&!event.repeat&&event.key.toLowerCase()===key;
export const isSaveShortcut=(event:ShortcutEvent)=>plain(event,'s')&&(event.metaKey!==event.ctrlKey);
export const isQuickOpenShortcut=(event:ShortcutEvent,platform:string)=>plain(event,'k')&&(/Mac|iPhone|iPad/i.test(platform)?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey);
