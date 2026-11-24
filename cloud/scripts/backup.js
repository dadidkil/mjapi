'use strict';
const {loadConfig}=require('../src/config');
const {Store}=require('../src/store');
async function main(){const s=new Store(loadConfig());try{console.log(await s.backup());}finally{s.close();}}
if(require.main===module)main().catch(()=>{console.error('Backup failed');process.exitCode=1;});
