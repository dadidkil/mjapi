'use strict';
// Wispbyte's default startup launches /home/container/index.js.
const fs=require('node:fs'),path=require('node:path');
function supportsRuntime(version){const [major,minor]=String(version).split('.').map(Number);return major===24&&minor>=18||major===26;}
function boot({runtime=process.versions.node,envFile=path.join(__dirname,'.env'),loadEnvFile=file=>process.loadEnvFile(file),run}={}){
  if(!supportsRuntime(runtime))throw Object.assign(Error('Select Node.js 24.18+ (24 LTS) or 26 in Startup > Docker Image; Node.js 19 is not supported.'),{code:'NODE_VERSION'});
  if(fs.existsSync(envFile))loadEnvFile(envFile);
  return (run||require('./cloud/src/server').run)();
}
if(require.main===module){try{boot();}catch(e){console.error(JSON.stringify({event:'startup_failed',code:e.code||'STARTUP_ERROR',message:e.code==='NODE_VERSION'?e.message:'Check the .env file and server configuration'}));process.exitCode=1;}}
module.exports={boot,supportsRuntime};
