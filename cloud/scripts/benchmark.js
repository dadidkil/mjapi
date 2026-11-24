'use strict';
const fs=require('node:fs'),path=require('node:path');
const {loadConfig}=require('../src/config'),{Store}=require('../src/store'),{createApp}=require('../src/server');
const mib=n=>Math.round(n/1048576*100)/100;
function bytes(dir){let n=0;if(!fs.existsSync(dir))return 0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())n+=bytes(p);else n+=fs.statSync(p).size;}return n;}
async function main(){const root=path.resolve(__dirname,'../..'),parent=path.join(root,'.runtime/cloud-bench');fs.mkdirSync(parent,{recursive:true});const dir=fs.mkdtempSync(path.join(parent,'run-')),cfg={...loadConfig({SCHEDULER_ENABLED:'0',DATA_DIR:dir}),sources:[],backupCount:0};const store=new Store(cfg),app=createApp({cfg,store,httpClient:{close(){}},relay:{online:()=>false,close(){}}});
  let sdkLoaded=false;try{require('@modelcontextprotocol/server');require('zod/v4');sdkLoaded=true;}catch{}
  // Include the existing real forum HTML parser and its installed dependencies, even in offline runs.
  app.forum.parser();if(global.gc)global.gc();const idle=process.memoryUsage();let peak=idle.rss;
  const body='Статья 1. Гарантии\n'+('Каждый гражданин имеет право на защиту и обжалование решения.\n'.repeat(120));
  for(let version=1;version<=3;version++)for(let i=0;i<200;i++){store.upsertDocument({id:'bench:'+i,sourceId:'bench',title:'Уголовный кодекс '+i,server:i%2?'houston':'miami',organization:'DOJ',category:'criminal_code',source:'mock',url:'https://docossum.com/legal/houston',body:body+'\nРедакция '+version});if(i%20===0)peak=Math.max(peak,process.memoryUsage().rss);}
  const rounds=[];for(let round=0;round<5;round++){for(let i=0;i<100;i++)store.search({q:'право защита',server:'houston',limit:10});store.maintain();if(global.gc)global.gc();const sample=process.memoryUsage();peak=Math.max(peak,sample.rss);rounds.push({rssMiB:mib(sample.rss),heapUsedMiB:mib(sample.heapUsed)});}
  const stats=store.stats(),dbBytes=bytes(dir);await app.close();
  const result={timestamp:new Date().toISOString(),node:process.version,platform:process.platform,sdkLoaded,measurementScope:sdkLoaded?'Core, parser and MCP dependency loaded; no live network':'Core and existing real parser; MCP dependency not installed; no live network',workload:{documents:200,editions:3,searches:500},idleMiB:{rss:mib(idle.rss),heapUsed:mib(idle.heapUsed)},peakRssMiB:mib(peak),samples:rounds,database:stats,databaseFilesMiB:mib(dbBytes),cloudSourceMiB:mib(bytes(path.join(root,'cloud/src'))),installedRootDependenciesMiB:mib(bytes(path.join(root,'node_modules'))),existingParserDependenciesMiB:mib(bytes(path.join(root,'majestic-forum-api/node_modules')))};
  fs.writeFileSync(path.join(root,'cloud/docs/benchmark.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  const real=fs.realpathSync(dir);if(!real.startsWith(fs.realpathSync(parent)+path.sep))throw Error('Unexpected benchmark directory');fs.rmSync(real,{recursive:true});
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
