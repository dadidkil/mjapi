'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');let count=0;
const entryCheck=spawnSync(process.execPath,['--check',path.join(root,'index.js')],{encoding:'utf8',windowsHide:true});if(entryCheck.status!==0){console.error(entryCheck.stderr);process.exit(1);}count++;
for(const dir of ['cloud/src','cloud/scripts','cloud/test'])for(const file of fs.readdirSync(path.join(root,dir)).filter(x=>x.endsWith('.js'))){const r=spawnSync(process.execPath,['--check',path.join(root,dir,file)],{encoding:'utf8',windowsHide:true});if(r.status!==0){console.error(r.stderr);process.exit(1);}count++;}
const plugin=path.join(root,'integrations/vencord/majesticWorkspace');
for(const file of fs.readdirSync(plugin).filter(x=>x.endsWith('.ts')&&!x.endsWith('.d.ts'))){const source=require('node:module').stripTypeScriptTypes(fs.readFileSync(path.join(plugin,file),'utf8'));const r=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8',windowsHide:true});if(r.status!==0){console.error(r.stderr);process.exit(1);}count++;}
const {openapi}=require('../src/server');const {loadConfig}=require('../src/config');const spec=openapi(loadConfig({PUBLIC_URL:'https://YOUR-SUBDOMAIN.wispbyte.app',SCHEDULER_ENABLED:'0'}));
fs.writeFileSync(path.join(root,'cloud/docs/openapi.json'),JSON.stringify(spec,null,2)+'\n');
console.log(JSON.stringify({syntaxFiles:count,openapiPaths:Object.keys(spec.paths).length}));
