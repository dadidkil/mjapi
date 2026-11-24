'use strict';
const fs=require('node:fs'),path=require('node:path'),{token}=require('../src/util');
const GENERATED_KEYS=['API_READ_TOKEN','API_WRITE_TOKEN','EXECUTOR_TOKEN','OAUTH_CLIENT_SECRET','OWNER_PASSWORD','DISCORD_BRIDGE_TOKEN'];
function createEnv({root=path.resolve(__dirname,'../..'),generate=token}={}){
  const target=path.join(root,'.env');if(fs.existsSync(target))throw Error('.env already exists; no secrets were changed');
  let example=fs.readFileSync(path.join(root,'.env.example'),'utf8').replace(/\r\n?/g,'\n');
  const values=new Set();
  for(const key of GENERATED_KEYS){
    const line=new RegExp('^'+key+'=[ \\t]*$','m');if(!line.test(example))throw Error(key+' must have one empty placeholder in .env.example');
    const value=generate();if(typeof value!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(value)||values.has(value))throw Error('Credential generator returned an invalid or repeated value');
    values.add(value);example=example.replace(line,key+'='+value);
  }
  fs.writeFileSync(target,example,{mode:0o600,flag:'wx'});return target;
}
function main(){createEnv();console.log('Created private .env with distinct Workspace credentials. Wispbyte address and selected guilds come from .env.example. DISCORD_TOKEN stays empty in Vencord mode. Verify the exact OAuth redirect when connecting ChatGPT.');}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={main,createEnv,GENERATED_KEYS};
