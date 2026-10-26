'use strict';
const{parentPort,workerData}=require('node:worker_threads');
require('./word-annotations-model.cjs').parseWordAnnotations(workerData.data,workerData.options).then(value=>parentPort.postMessage({value})).catch(e=>parentPort.postMessage({error:e.code==='WORD_ANNOTATION_LIMIT'?e.code:'WORD_ANNOTATION_UNREADABLE'}));
