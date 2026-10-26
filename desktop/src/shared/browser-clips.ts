export type BrowserClipReference={path:string;sourceKind:'text'|'board'|'inkclip'|'pdf';sha256:string;itemID?:string;imagePath?:string;recordPath?:string;recordSHA256?:string};
export type BrowserClipEntry={id:string;title:string;url:string;capturedAt:string;kind:'selection'|'page'|'link'|'image'|'screenshot'|'pdf';characters:number;textPreview:string;ref:BrowserClipReference};
export type BrowserClipList={entries:BrowserClipEntry[];warnings:string[];truncated:boolean;folderPath:string};
export type BrowserClipInspection={contentSHA256:string;title:string;url:string;capturedAt:string;characters:number;hasImage:boolean;imagePreviewDataURL?:string;kind:'text'|'image'|'pdf';bounds:{x:number;y:number;width:number;height:number};ghost:Record<string,unknown>};
