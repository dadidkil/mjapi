'use strict';
// Queue exports without a running HTTP service; no Discord credentials are read.
const path=require('node:path'),fs=require('node:fs');
const {loadConfig}=require('../src/config'),{Store}=require('../src/store'),{DiscordBridge}=require('../src/discord-bridge');
async function main(args=process.argv.slice(2)){
  const envFile=path.resolve(__dirname,'../../.env');if(fs.existsSync(envFile))process.loadEnvFile(envFile);
  const cfg=loadConfig(),store=new Store(cfg);try{
    await store.backup();const bridge=new DiscordBridge(store,cfg),ids=args.filter(x=>!x.startsWith('--'));
    const selected=ids.length?ids:cfg.guildIds;if(!selected.length)throw Error('No selected guilds; configure cloud/config/discord-guilds.json');
    const result=selected.map(id=>args.includes('--status')?bridge.status(id):bridge.request(id,{full:!args.includes('--update')}));
    console.log(JSON.stringify({exports:result}));
  }finally{store.close();}
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({code:e.code||'EXPORT_REQUEST_FAILED',message:e.code?'Check Discord export configuration':e.message}));process.exitCode=1;});
module.exports={main};
