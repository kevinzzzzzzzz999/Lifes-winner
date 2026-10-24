const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {notebookHTMLFormattingClasses:classes}=require('../src/renderer/notebook-html-format.ts');
const style=values=>({getPropertyValue:property=>values[property]||''});
test('separate-cell course sublists retain the requested circle,20px indent and negative10px gap',()=>{
 assert.deepEqual(classes('ul',style({'margin-top':'-10px'})),['notebook-format-margin-top-n10']);
 assert.deepEqual(classes('LI',style({'list-style-type':'circle','margin-left':'20px'})),['notebook-format-marker-circle','notebook-format-margin-left-20']);
 assert.deepEqual(classes('OL',style({'list-style-type':'upper-roman','padding-left':'40px','margin-top':'0px'})),['notebook-format-marker-upper-roman','notebook-format-padding-left-40','notebook-format-margin-top-0']);
});
test('font presentation stays independent so nested bold and italic do not erase one another',()=>{
 assert.deepEqual(classes('SPAN',style({'font-size':'24px','font-weight':'bold','font-style':'italic'})),['notebook-format-font-size-24','notebook-format-font-weight-700','notebook-format-font-style-italic']);
 assert.deepEqual(classes('EM',style({'font-style':'italic'})),['notebook-format-font-style-italic']);
 assert.deepEqual(classes('STRONG',style({})),[]);
 assert.deepEqual(classes('P',style({'font-size':' large ','font-weight':'400','font-style':'normal'})),['notebook-format-font-size-large','notebook-format-font-weight-400','notebook-format-font-style-normal']);
});
test('unsupported tags and list presentation on non-list text never receive formatting classes',()=>{
 const values=style({'font-size':'18px','font-weight':'700','list-style-type':'circle','margin-left':'20px','padding-left':'20px','margin-top':'-10px'});
 for(const tag of ['IMG','VIDEO','SVG','PATH','MATH','SCRIPT','STYLE','IFRAME','FORM','INPUT','BUTTON','svg:li'])assert.deepEqual(classes(tag,values),[],tag);
 assert.deepEqual(classes('SPAN',values),['notebook-format-font-size-18','notebook-format-font-weight-700']);
});
test('URL,variables,calculations,relative sizes and out-of-range values cannot become CSS',()=>{
 for(const value of ['url(https://invalid.example/x)','var(--x)','calc(1px + 2px)','expression(alert(1))','inherit','initial','revert','unset','120px','-12px','1.5em','125%','constructor','__proto__']){
  assert.deepEqual(classes('LI',style({'font-size':value,'font-weight':value,'font-style':value,'list-style-type':value,'margin-left':value,'padding-left':value,'margin-top':value})),[],value);
 }
 assert.deepEqual(classes('SPAN',style({'font-size':'0px'})),[]);
 assert.deepEqual(classes('LI',style({'margin-left':'-20px','padding-left':'9999px','margin-top':'-100px','font-weight':'1000','font-style':'oblique 30deg'})),[]);
});
test('layout,visibility and resource declarations are not read or passed through',()=>{
 const values={'position':'fixed','display':'none','transform':'scale(100)','background-image':'url(https://invalid.example/x)','font-size':'16px'},read=[];
 const result=classes('DIV',{getPropertyValue:property=>{read.push(property);return values[property]||'';}});
 assert.deepEqual(read,['font-size','font-weight','font-style']);assert.deepEqual(result,['notebook-format-font-size-16']);
});
test('every emitted class has a scoped finite stylesheet rule and no raw CSS escapes the helper',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../src/renderer/notebook-html-format.css'),'utf8');
 const values={
  'font-size':['10px','11px','12px','13px','14px','15px','16px','18px','20px','21px','22px','24px','25px','28px','30px','32px','36px','40px','48px','x-small','small','medium','large','x-large','xx-large','xxx-large'],
  'font-weight':['normal','bold','100','200','300','400','500','600','700','800','900'],
  'font-style':['normal','italic','oblique'],
  'list-style-type':['disc','circle','square','decimal','decimal-leading-zero','lower-alpha','upper-alpha','lower-latin','upper-latin','lower-roman','upper-roman','none'],
  'margin-left':['0','0px','10px','20px','30px','40px','60px','80px'],
  'padding-left':['0','0px','10px','20px','30px','40px','60px','80px'],
  'margin-top':['0','-10px','-5px','0px','5px','10px','12px','16px','20px','24px','32px'],
 };
 for(const [property,options]of Object.entries(values))for(const option of options){const result=classes('LI',style({[property]:option}));assert.equal(result.length,1,property+':'+option);assert.match(result[0],/^notebook-format-[a-z0-9-]+$/);assert.ok(css.includes('.document-preview.notebook-formatting .paper .'+result[0]+'[class]{'),result[0]);}
 const rules=css.replace(/\/\*[\s\S]*?\*\//g,'').split('}').map(rule=>rule.trim()).filter(Boolean);assert.ok(rules.every(rule=>rule.startsWith('.document-preview.notebook-formatting .paper .notebook-format-')));assert.equal(/!important|url\s*\(|var\s*\(|position\s*:|display\s*:/i.test(css.replace(/\/\*[\s\S]*?\*\//g,'')),false);
});
