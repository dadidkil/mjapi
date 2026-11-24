'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');const{files}=require('../scripts/release');
test('cloud release allowlist excludes roles, case files, cookies, .env, models and runtime data',()=>{for(const file of files()){assert.ok(fs.existsSync(path.resolve(file)),file);assert.ok(!/(^majestic\/|^extension\/|node_modules|cookies|^\.env$|\.runtime|profile\.json)/.test(file),file);}assert.ok(files().includes('package-lock.json'));assert.ok(files().includes('tools/laws-sync.js'));});
