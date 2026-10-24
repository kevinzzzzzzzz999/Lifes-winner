'use strict';
const {object}=require('./browser-security.cjs');
const {externalURL}=require('./security.cjs');
const {fail}=require('./errors.cjs');
async function routeWebLink(request,{openBrowser,openSystem}){
 object(request,['url','application']);const url=externalURL(request.url);
 if(request.application!==undefined&&!['browser','system'].includes(request.application))fail('INVALID_REQUEST');
 return request.application==='system'?openSystem(url):openBrowser(url);
}
module.exports={routeWebLink};
