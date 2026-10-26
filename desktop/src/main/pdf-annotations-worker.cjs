'use strict';
const {parentPort,workerData}=require('node:worker_threads');
require('./pdf-annotations-model.cjs').parsePDFAnnotations(workerData.data,workerData.options).then(value=>parentPort.postMessage({value})).catch(()=>parentPort.postMessage({error:'PDF_ANNOTATION_UNREADABLE'}));
