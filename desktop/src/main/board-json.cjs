'use strict';
const {fail}=require('./errors.cjs');

// JSON's native parser handles the large ink arrays without invoking JavaScript
// for every coordinate. Check every parsed number, including unknown fields,
// afterward so the reader retains its unsafe-integer rejection rule.
function parseBoardJSON(text){
 const board=JSON.parse(text),pending=[board];
 while(pending.length){
  const value=pending.pop();
  if(typeof value==='number')checkNumber(value);
  else if(value&&typeof value==='object'){
   if(Array.isArray(value)){
    for(let i=0;i<value.length;i++)visit(value[i],pending);
   }else{
    for(const key of Object.keys(value))visit(value[key],pending);
   }
  }
 }
 return board;
}
function checkNumber(value){if(Number.isInteger(value)&&!Number.isSafeInteger(value))fail('INVALID_BOARD');}
function visit(value,pending){if(typeof value==='number')checkNumber(value);else if(value&&typeof value==='object')pending.push(value);}

module.exports={parseBoardJSON};
