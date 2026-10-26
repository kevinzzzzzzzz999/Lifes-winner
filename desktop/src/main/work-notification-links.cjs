'use strict';
function workItemURL(value){if(typeof value!=='string'||value.length>200||!/^lifeswinner-work:\/\/item\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))return null;try{const url=new URL(value);if(url.protocol!=='lifeswinner-work:'||url.hostname!=='item'||url.username||url.password||url.port||url.search||url.hash||!/^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname))return null;return url.pathname.slice(1).toLowerCase();}catch{return null;}}
async function resolveWorkNotification(store,itemId){const snapshot=await store.snapshot();if(snapshot.readOnly||!snapshot.items.some(item=>item.id.toLowerCase()===itemId))return null;return{itemId};}
module.exports={workItemURL,resolveWorkNotification};
