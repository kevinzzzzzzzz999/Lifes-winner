'use strict';const {fail}=require('./errors.cjs');
const sites=Object.freeze({qq:'https://mail.qq.com/',gmail:'https://mail.google.com/mail/u/0/#inbox','outlook-personal':'https://outlook.live.com/mail/','outlook-work':'https://outlook.office.com/mail/'});
function mailWebsite(request){if(!request||Object.keys(request).length!==1||!Object.hasOwn(sites,request.provider))fail('INVALID_REQUEST');return sites[request.provider];}
module.exports={mailWebsite};
