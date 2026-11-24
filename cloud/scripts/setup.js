'use strict';
const fs=require('node:fs'),path=require('node:path'),{token}=require('../src/util');
function main(){const root=path.resolve(__dirname,'../..'),target=path.join(root,'.env');if(fs.existsSync(target))throw Error('.env already exists; no secrets were changed');let example=fs.readFileSync(path.join(root,'.env.example'),'utf8');for(const key of ['API_READ_TOKEN','API_WRITE_TOKEN','EXECUTOR_TOKEN','OAUTH_CLIENT_SECRET','OWNER_PASSWORD'])example=example.replace(new RegExp('^'+key+'=$','m'),key+'='+token());fs.writeFileSync(target,example,{mode:0o600,flag:'wx'});console.log('Created .env. Set PUBLIC_URL, exact OAuth redirect, guild/channel allowlists and Discord token. Keep values private.');}
if(require.main===module)try{main();}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={main};
