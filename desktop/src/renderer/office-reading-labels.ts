import type {Language} from './i18n';
const notices:Record<string,string>={
 'Legacy Word .doc is shown as a read-only preview. Layout, tables and images may differ; open the original application for the complete document.':'旧版 Word .doc 以只读阅读版展示。排版、表格和图片可能与原件不同；完整效果可通过“打开方式”使用原应用查看。',
 'Read-only slide text and slide-body PNG/JPEG picture supplements. Original slide layout, master/background artwork, crops, rotations, effects, charts and SmartArt are not reproduced.':'只读展示幻灯片文字及本页内嵌的 PNG/JPEG 图片补充区；不还原原版排版、母版和背景图、裁剪、旋转、效果、图表或 SmartArt。',
 'Embedded PNG/JPEG pictures are shown after their worksheet with cell-anchor labels; original placement, crops, rotations and effects are not reproduced.':'内嵌 PNG/JPEG 图片显示在所属工作表后，并标出锚定单元格；不还原原位置、裁剪、旋转或效果。',
 'Picture supplement: original image pixels, not the original placement, crop, rotation or effects.':'图片补充区保留原图片像素，不还原原位置、裁剪、旋转或效果。',
 'Some embedded images were omitted because their format, reference, byte size or pixel count is unsupported.':'部分内嵌图片因格式、引用、文件大小或像素数不受支持而未显示。',
 'Linked external images were not loaded.':'未自动加载链接到外部的图片。',
 'Charts, SmartArt, drawing shapes and other floating objects are not reproduced. Open the original application for their full appearance.':'图表、SmartArt、绘图形状及其他浮动对象尚未还原；完整效果请用原应用打开。',
 'Cell reading layout: visible worksheets and row/column bands; original print areas and merged-cell layout are not used.':'单元格阅读版按可见工作表与列分区展示，不沿用原打印区域及合并单元格版式。',
 'Formulas show saved results only. No recalculation, macros or external-link execution.':'公式只显示已保存的结果，不重新计算，不执行宏或外部链接。',
 'Cells marked [=] have no saved result and display the original formula instead.':'标记 [=] 的单元格没有已保存结果，显示原公式。',
 'Hidden worksheets and standalone chart sheets are not included.':'不显示隐藏的工作表及独立图表页。',
 'Charts, images and floating objects are not included; open the original Excel file to see them.':'此旧格式只展示单元格，不显示图表、图片或浮动对象；请用原应用打开查看。',
 'This reading PDF contains cells only. Embedded pictures remain available in the original reading view.':'此阅读 PDF 仅包含单元格；内嵌图片仍可在原件阅读画面查看。'
};
export const officeReadingNotice=(text:string,language:Language)=>language==='zh'?(notices[text]||text):text;
export function localizeOfficeHTML(html:string,language:Language){
 if(language!=='zh')return html;const root=document.createElement('div');root.innerHTML=html;
 for(const p of root.querySelectorAll('.office-reading-notices p,.office-embedded-pictures>p'))p.textContent=officeReadingNotice(p.textContent||'',language);
 for(const h of root.querySelectorAll('.office-embedded-pictures>h3'))h.textContent=(h.textContent||'').replace(/^Embedded pictures/,'内嵌图片');
 for(const c of root.querySelectorAll('.office-embedded-pictures figcaption'))c.textContent=(c.textContent||'').replace(/^Image (\d+)/,'图片 $1').replace(/Anchor /,'锚定 ').replace(/Absolute position/,'绝对位置');
 for(const h of root.querySelectorAll('.office-slide-reading>h2'))h.textContent=(h.textContent||'').replace(/^Slide (\d+)$/,'第 $1 页');
 return root.innerHTML;
}
