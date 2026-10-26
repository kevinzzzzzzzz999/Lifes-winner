'use strict';
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const run=path.join(root,'.development','runs',crypto.randomUUID());
for(const dir of ['profile','session','logs','vault'])fs.mkdirSync(path.join(run,dir),{recursive:true});
app.setAppPath(root);
app.setPath('userData',path.join(run,'profile'));
app.setPath('sessionData',path.join(run,'session'));
app.setPath('logs',path.join(run,'logs'));
process.env.INKSPACE_QA_USER_DATA=path.join(run,'profile');
process.env.INKSPACE_QA_VAULT=path.join(run,'vault');
process.env.INKSPACE_DISABLE_NOTIFICATIONS='1';
// The installed mail helper's system notification identity is shared; keep it
// disabled in this isolated development launcher. Production code is unchanged.
require('../src/main/work-mail-service.cjs').WorkMailDriver.prototype.available=()=>false;
console.log('Isolated development data:',run);
require('../src/main/main.cjs');
