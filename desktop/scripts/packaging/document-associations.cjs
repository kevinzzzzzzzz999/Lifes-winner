'use strict';
// Alternate lets Finder offer the app while retaining the user's chosen defaults.
// .inkspace.json has a terminal JSON extension. Do not claim the generic JSON
// UTI as an exported custom board format, or bind TypeScript to the MPEG .ts UTI.
const fileAssociations=[
 {name:'Jupyter Notebook',ext:['ipynb'],role:'Editor',rank:'Alternate'},
 {name:"Life's Winner Board and JSON Document",ext:['json'],role:'Editor',rank:'Alternate'},
 {name:'Text and Source Document',ext:['md','markdown','tex','py','js','ts','txt','html','htm','csv','tsv'],role:'Editor',rank:'Alternate'},
 {name:'Office, Image, PDF, and Video Document',ext:['pdf','png','jpg','jpeg','doc','docx','pptx','xls','xlsx','xlsm','mp4','mov','m4v'],role:'Viewer',rank:'Alternate'}
];
const documentTypes=fileAssociations.map(({name,ext,role,rank})=>({CFBundleTypeName:name,CFBundleTypeExtensions:ext,CFBundleTypeRole:role,LSHandlerRank:rank}));
module.exports={fileAssociations,documentTypes};
