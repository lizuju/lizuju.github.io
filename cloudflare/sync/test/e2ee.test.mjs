import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

let runtime;
const sockets = new Set();
let ip = 1;
const origin = 'https://lizuju.github.io';
const cipher = (keyId, value = 'encrypted-content') => `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: randomBytes(12).toString('base64url'), ciphertext: Buffer.from(value.padEnd(48, '.')).toString('base64url') })).toString('base64url')}`;
const pairCipher = () => `pair1.${randomBytes(128).toString('base64url')}`;
const relay = () => randomBytes(128).toString('base64');
before(async () => {
  runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: { name: 'sync-e2ee-test', compatibilityDate: '2026-10-23',
    manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
      'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
      'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') }
    } }, env: { ALLOWED_ORIGINS: { type: 'text', value: origin },
      ...Object.fromEntries([['E2EE_PAIRING_REGISTRY','E2eePairingRegistry'],['E2EE_SYNC_ROOMS','E2eeSyncRoom'],['E2EE_FILE_SHARDS','E2eeFileShard']].map(([key,name]) => [key,{type:'durable-object',worker:'sync-e2ee-test',exportName:name}])) },
    exports: Object.fromEntries(['E2eePairingRegistry','E2eeSyncRoom','E2eeFileShard'].map(name => [name,{type:'durable-object',storage:'sqlite'}]))
  } }] });
  await runtime.ready;
});
after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime.dispose();
});
async function request(path, { method = 'GET', token, keyId, json, headers = {}, body } = {}) {
  if (json !== undefined) { body = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  const response = await runtime.dispatchFetch(`https://sync.test${path}`, { method, body, headers: { Origin: origin, 'CF-Connecting-IP': `198.51.100.${ip++}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(keyId ? {'X-Sync-Key-Id':keyId} : {}), ...headers } });
  return { status: response.status, headers: response.headers, body: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
async function space() {
  const keyId = randomUUID();
  const created = await request('/v1/spaces', { method:'POST',json:{keyId} });
  assert.equal(created.status,201,JSON.stringify(created.body));
  return {...created.body,keyId};
}
async function connect(owner) {
  const response = await runtime.dispatchFetch(`https://sync.test/v1/spaces/${owner.roomId}/socket`, { headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': `198.51.100.${ip++}` } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  sockets.add(socket);
  const ready = new Promise(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true }));
  socket.send(JSON.stringify({ type: 'auth', token: owner.token }));
  assert.equal((await ready).type, 'ready');
  return socket;
}
async function beginPair(owner) {
  let offerId = randomUUID();
  const offer = await request(`/v1/spaces/${owner.roomId}/pair-code`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{offerId,secret:cipher(owner.keyId)}});
  assert.equal(offer.status,200,JSON.stringify(offer.body));
  offerId = offer.body.offerId;
  const requestId=randomUUID(),requestToken=randomBytes(32).toString('hex');
  const started=await request('/v1/pair',{method:'POST',json:{requestId,requestToken,requests:[{offerId,startLoginRequest:relay()}]}});
  assert.equal(started.status,202,JSON.stringify(started.body));
  return {offerId,requestId,requestToken};
}
async function accept(owner,pair,beforeAccept) {
  const path=`/v1/spaces/${owner.roomId}`;
  assert.equal((await request(`${path}/pair-challenge`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{...pair,loginResponse:relay()}})).status,200);
  assert.equal((await request(`/v1/pair/${pair.requestId}`,{method:'POST',token:pair.requestToken,json:{offerId:pair.offerId,finishLoginRequest:relay(),clientData:pairCipher()}})).status,200);
  const joined={deviceId:randomUUID(),token:randomBytes(32).toString('hex')},newKeyId=randomUUID();
  const body={requestId:pair.requestId,offerId:pair.offerId,...joined,name:cipher(newKeyId),grant:pairCipher(),rotationId:randomUUID(),newKeyId,grants:[{deviceId:owner.deviceId,envelope:cipher(owner.keyId)}]};
  if(beforeAccept) await beforeAccept();
  const result=await request(`${path}/pair-accept`,{method:'POST',token:owner.token,keyId:owner.keyId,json:body});
  assert.equal(result.status,200,JSON.stringify(result.body));
  return {...joined,roomId:owner.roomId,keyId:newKeyId,body};
}

test('only ciphertext is accepted, epoch headers and actual envelope keys must agree',async()=>{
 const owner=await space(),path=`/v1/spaces/${owner.roomId}`;
 assert.equal(owner.code,undefined);
 for(const text of ['plaintext','e2ee1.bad']) assert.equal((await request(`${path}/messages`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{clientId:randomUUID(),text}})).status,400);
 const encrypted=cipher(owner.keyId);
 assert.equal((await request(`${path}/messages`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{clientId:randomUUID(),text:encrypted}})).status,201);
 assert.equal((await request(`${path}/messages`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{clientId:randomUUID(),text:cipher(randomUUID())}})).status,409);
 assert.equal((await request(`${path}/devices/${owner.deviceId}`,{method:'PATCH',token:owner.token,keyId:owner.keyId,json:{name:'Mac'}})).status,400);
 const preflight=await request('/v1/pair',{method:'OPTIONS'});assert.match(preflight.headers.get('Access-Control-Allow-Headers'),/X-Sync-Key-Id/);
});

test('opaque offers relay PAKE frames without codes; accept and key rotation are atomic',async()=>{
 const owner=await space(),pair=await beginPair(owner),path=`/v1/spaces/${owner.roomId}`;
 await connect(owner);
 const listed=await request('/v1/pair/offers');assert.deepEqual(Object.keys(listed.body.offers.find(o=>o.offerId===pair.offerId)).sort(),['expiresAt','offerId']);
 assert.equal((await request(`/v1/pair/${pair.requestId}`,{token:randomBytes(32).toString('hex')})).status,401);
 const pending=await request(`${path}/pair-requests`,{token:owner.token});assert.equal(pending.body.requests[0].type,'pair-request');
 const joined=await accept(owner,pair);
 const read=await request(`/v1/pair/${pair.requestId}`,{token:pair.requestToken});assert.equal(read.body.grant,joined.body.grant);
 const registryStorage=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eePairingRegistry',{name:'registry'});
 await registryStorage.exec('UPDATE pair_requests SET grant = NULL, accepted_device = NULL WHERE request_id = ?',pair.requestId);
 await registryStorage.exec('INSERT INTO offers (offer_id,room_id,owner_device_id,secret,expires_at) VALUES (?,?,?,?,?)',pair.offerId,owner.roomId,owner.deviceId,cipher(owner.keyId),Date.now()+60000);
 const recovered=await request(`/v1/pair/${pair.requestId}`,{token:pair.requestToken});assert.equal(recovered.body.grant,joined.body.grant,'A joiner recovers an atomically committed grant without its host retrying');
 const info=await request(path,{token:joined.token});assert.equal(info.body.currentKeyId,joined.keyId);
 assert.equal((await request(`${path}/messages`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{clientId:randomUUID(),text:cipher(owner.keyId)}})).status,409);
 const grants=await request(`${path}/key-grants`,{token:owner.token,keyId:owner.keyId});assert.equal(grants.body.grants.length,1);
 assert.deepEqual((await request(`${path}/key-grants`,{token:owner.token,keyId:joined.keyId})).body.grants,[]);
 assert.deepEqual((await request(`${path}/key-grants`,{token:joined.token,keyId:joined.keyId})).body.grants,[]);
 assert.equal((await request(`${path}/pair-accept`,{method:'POST',token:owner.token,keyId:owner.keyId,json:joined.body})).status,200);
});

test('leaving gates old-key writes until surviving devices rotate, and removed tokens stay revoked',async()=>{
 const owner=await space(),pair=await beginPair(owner),joined=await accept(owner,pair),path=`/v1/spaces/${owner.roomId}`;
 assert.equal((await request(`${path}/device`,{method:'DELETE',token:joined.token})).status,200);
 assert.equal((await request(path,{token:owner.token})).body.rekeyRequired,true);
 const write={method:'POST',token:owner.token,keyId:joined.keyId,json:{clientId:randomUUID(),text:cipher(joined.keyId)}};
 assert.equal((await request(`${path}/messages`,write)).body.error,'rekey_required');
 const newKeyId=randomUUID();
 assert.equal((await request(`${path}/key-rotation`,{method:'POST',token:owner.token,keyId:joined.keyId,json:{rotationId:randomUUID(),newKeyId,removedDeviceId:null,grants:[{deviceId:owner.deviceId,envelope:cipher(joined.keyId)}]}})).status,200);
 assert.equal((await request(`${path}/messages`,{...write,keyId:newKeyId,json:{clientId:randomUUID(),text:cipher(newKeyId)}})).status,201);
 assert.equal((await request(path,{token:joined.token})).status,401);
 const chain=await request(`${path}/key-grants`,{token:owner.token,keyId:owner.keyId});assert.equal(chain.body.grants.length,2);
});

test('pairing rejects plaintext discovery, excess candidates, unowned challenges and expired or cancelled requests',async()=>{
 assert.equal((await request('/v1/pair',{method:'POST',json:{code:'1234'}})).status,400);
 const malformed={requestId:randomUUID(),requestToken:randomBytes(32).toString('hex'),requests:Array.from({length:31},()=>({offerId:randomUUID(),startLoginRequest:relay()}))};
 assert.equal((await request('/v1/pair',{method:'POST',json:malformed})).status,400);
 const owner=await space(),stranger=await space(),pair=await beginPair(owner),path=`/v1/spaces/${owner.roomId}`;
 const foreign=await request(`/v1/spaces/${stranger.roomId}/pair-challenge`,{method:'POST',token:stranger.token,keyId:stranger.keyId,json:{requestId:pair.requestId,offerId:pair.offerId,loginResponse:relay()}});
 assert.equal(foreign.status,404);
 assert.equal((await request(`${path}/pair-accept`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{...pair,deviceId:randomUUID(),token:randomBytes(32).toString('hex'),name:cipher(owner.keyId),grant:pairCipher(),rotationId:randomUUID(),newKeyId:randomUUID(),grants:[{deviceId:owner.deviceId,envelope:cipher(owner.keyId)}]}})).body.error,'pairing_incomplete');
 assert.equal((await request(`/v1/pair/${pair.requestId}`,{method:'DELETE',token:pair.requestToken})).status,200);
 assert.equal((await request(`/v1/pair/${pair.requestId}`,{token:pair.requestToken})).status,404);
 assert.deepEqual((await request(`${path}/pair-requests`,{token:owner.token})).body.requests,[]);
 const second=await beginPair(owner);
 const registry=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eePairingRegistry',{name:'registry'});
 await registry.exec('UPDATE pair_requests SET expires_at = ? WHERE request_id = ?',Date.now()-1,second.requestId);
 assert.equal((await request(`/v1/pair/${second.requestId}`,{token:second.requestToken})).status,404);
 assert.equal((await request(`${path}/pair-code`,{method:'DELETE',token:owner.token,keyId:owner.keyId})).status,200);
 assert.equal((await request(path,{token:owner.token})).body.pairing.enabled,false);
});

test('encrypted file transport admits full 2 GiB plus tags while rejecting identifying metadata and oversize ciphertext',async()=>{
 const owner=await space(),path=`/v1/spaces/${owner.roomId}`;
 const maximum=2*1024**3+Math.ceil(2*1024**3/(512*1024-16))*16;
 const metadata={clientId:randomUUID(),name:randomUUID(),type:'application/octet-stream',size:maximum,text:cipher(owner.keyId),fingerprint:randomBytes(32).toString('hex')};
 for(const change of [{name:'private-video.mp4'},{type:'video/mp4'},{text:'private caption'},{fingerprint:undefined},{size:maximum+1}]) {
  const result=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{...metadata,...change}});
  assert.ok([400,413].includes(result.status),JSON.stringify(result));
 }
 const started=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:owner.keyId,json:metadata});
 assert.equal(started.status,201,JSON.stringify(started.body));assert.equal(started.body.chunkSize,8*1024**2);
 const storage=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eeSyncRoom',{name:owner.roomId});
 const rows=await storage.exec('SELECT name,type,size,text,fingerprint FROM files WHERE file_id = ?',started.body.uploadId);
 assert.deepEqual(rows,[{name:metadata.name,type:metadata.type,size:maximum,text:metadata.text,fingerprint:metadata.fingerprint}]);
 assert.equal((await request(`${path}/files/uploads/${started.body.uploadId}`,{method:'DELETE',token:owner.token})).status,200);
});

test('admission membership and rotation envelopes are checked before any device token is enrolled',async()=>{
 const owner=await space(),pair=await beginPair(owner),path=`/v1/spaces/${owner.roomId}`;
 const challenge=relay();
 assert.equal((await request(`${path}/pair-challenge`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{requestId:pair.requestId,offerId:pair.offerId,loginResponse:challenge}})).status,200);
 assert.equal((await request(`${path}/pair-challenge`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{requestId:pair.requestId,offerId:pair.offerId,loginResponse:relay()}})).status,409);
 assert.equal((await request(`/v1/pair/${pair.requestId}`,{method:'POST',token:pair.requestToken,json:{offerId:pair.offerId,finishLoginRequest:relay(),clientData:pairCipher()}})).status,200);
 const token=randomBytes(32).toString('hex'),newKeyId=randomUUID(),deviceId=randomUUID();
 const body={requestId:pair.requestId,offerId:pair.offerId,deviceId,token,name:cipher(newKeyId),grant:pairCipher(),rotationId:randomUUID(),newKeyId,grants:[{deviceId:randomUUID(),envelope:cipher(owner.keyId)}]};
 assert.equal((await request(`${path}/pair-accept`,{method:'POST',token:owner.token,keyId:owner.keyId,json:body})).status,400);
 assert.equal((await request(path,{token})).status,401);
 assert.equal((await request(path,{token:owner.token})).body.currentKeyId,owner.keyId);
 const invalid=await request(`${path}/key-rotation`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{rotationId:randomUUID(),newKeyId,removedDeviceId:null,grants:[{deviceId:owner.deviceId,envelope:cipher(randomUUID())}]}});
 assert.equal(invalid.status,400);
});

test('thirty spaces can pair concurrently and released or expired slots are reusable',async()=>{
 const registry=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eePairingRegistry',{name:'registry'});
 await registry.exec('DELETE FROM offers');
 const owners=await Promise.all(Array.from({length:31},space));
 await Promise.all(owners.map(connect));
 for(const owner of owners.slice(0,30)) {
  const result=await request(`/v1/spaces/${owner.roomId}/pair-code`,{method:'POST',token:owner.token,keyId:owner.keyId,json:{offerId:randomUUID(),secret:cipher(owner.keyId)}});
  assert.equal(result.status,200);
 }
 const last=owners[30],body={offerId:randomUUID(),secret:cipher(last.keyId)};
 const rejected=await request(`/v1/spaces/${last.roomId}/pair-code`,{method:'POST',token:last.token,keyId:last.keyId,json:body});
 assert.equal(rejected.status,503);assert.equal(rejected.body.error,'pairing_busy');
 const offers=(await request('/v1/pair/offers')).body.offers;
 assert.equal(offers.length,30);
 const requestId=randomUUID(),requestToken=randomBytes(32).toString('hex');
 assert.equal((await request('/v1/pair',{method:'POST',json:{requestId,requestToken,requests:offers.map(offer=>({offerId:offer.offerId,startLoginRequest:relay()}))}})).status,202);
 assert.equal((await request(`/v1/pair/${requestId}`,{method:'DELETE',token:requestToken})).status,200);
 const closed=await request(`/v1/spaces/${owners[0].roomId}/pair-code`,{method:'DELETE',token:owners[0].token,keyId:owners[0].keyId});
 assert.equal(closed.status,200);
 assert.equal((await request(`/v1/spaces/${last.roomId}/pair-code`,{method:'POST',token:last.token,keyId:last.keyId,json:body})).status,200);
 assert.equal((await request('/v1/pair/offers')).body.offers.length,30);
 await registry.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?',Date.now()-1,last.roomId);
 assert.equal((await request(`/v1/spaces/${owners[0].roomId}/pair-code`,{method:'POST',token:owners[0].token,keyId:owners[0].keyId,json:{offerId:randomUUID(),secret:cipher(owners[0].keyId),reopen:true,revision:closed.body.revision}})).status,200);
 assert.equal((await request('/v1/pair/offers')).body.offers.length,30);
 await registry.exec('DELETE FROM offers');
});

test('device activity writes coalesce while expiry and revocation still apply to every request',async()=>{
 const owner=await space(),path=`/v1/spaces/${owner.roomId}`;
 const storage=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eeSyncRoom',{name:owner.roomId});
 await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?',Date.now()-61000,owner.deviceId);
 await storage.exec('CREATE TABLE activity_writes (device_id TEXT)');
 await storage.exec('CREATE TRIGGER count_activity_writes AFTER UPDATE OF last_active_at ON devices BEGIN INSERT INTO activity_writes (device_id) VALUES (NEW.device_id); END');
 for(let index=0;index<40;index++) assert.equal((await request(`${path}/devices`,{token:owner.token})).status,200);
 assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM activity_writes'),[{count:1}]);
 await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?',Date.now()-61000,owner.deviceId);
 await storage.exec('DELETE FROM activity_writes');
 assert.equal((await request(`${path}/devices`,{token:owner.token})).status,200);
 assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM activity_writes'),[{count:1}]);
 await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?',Date.now()-7*24*60*60*1000,owner.deviceId);
 await storage.exec('DELETE FROM activity_writes');
 assert.equal((await request(`${path}/devices`,{token:owner.token})).status,401);
 assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM activity_writes'),[{count:0}]);
 const removed=await space(),removedPath=`/v1/spaces/${removed.roomId}`;
 assert.equal((await request(`${removedPath}/device`,{method:'DELETE',token:removed.token})).status,200);
 assert.ok([401,404].includes((await request(`${removedPath}/devices`,{token:removed.token})).status));
});

test('pairing preserves encrypted upload chunks but requires current-key metadata before publication',async()=>{
 const owner=await space(),path=`/v1/spaces/${owner.roomId}`;
 const bytes=randomBytes(8*1024**2+17);
 const metadata={clientId:randomUUID(),name:randomUUID(),type:'application/octet-stream',size:bytes.length,text:cipher(owner.keyId),fingerprint:randomBytes(32).toString('hex')};
 const begin=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:owner.keyId,json:metadata});
 assert.equal(begin.status,201,JSON.stringify(begin.body));
 const uploadPath=`${path}/files/uploads/${begin.body.uploadId}`;
 assert.equal((await request(`${uploadPath}/chunks/0`,{method:'PUT',token:owner.token,keyId:owner.keyId,headers:{'Content-Type':'application/octet-stream'},body:bytes.subarray(0,8*1024**2)})).status,200);
 const joined=await accept(owner,await beginPair(owner));
 const storage=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eeSyncRoom',{name:owner.roomId});
 assert.deepEqual(await storage.exec('SELECT status,received_bytes,received_chunks FROM files WHERE file_id = ?',begin.body.uploadId),[{status:'uploading',received_bytes:8*1024**2,received_chunks:1}]);
 assert.equal((await request(`${uploadPath}/chunks/1`,{method:'PUT',token:owner.token,keyId:owner.keyId,headers:{'Content-Type':'application/octet-stream'},body:bytes.subarray(8*1024**2)})).body.error,'key_changed');
 assert.equal((await request(`${uploadPath}/chunks/1`,{method:'PUT',token:owner.token,keyId:joined.keyId,headers:{'Content-Type':'application/octet-stream'},body:bytes.subarray(8*1024**2)})).status,200);
 assert.equal((await request(`${uploadPath}/complete`,{method:'POST',token:owner.token,keyId:joined.keyId})).body.error,'key_changed');
 const text=cipher(joined.keyId);
 const mismatch=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:joined.keyId,json:{...metadata,name:randomUUID(),text}});
 assert.equal(mismatch.body.error,'upload_conflict');
 const resumed=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:joined.keyId,json:{...metadata,text}});
 assert.equal(resumed.status,200);assert.equal(resumed.body.uploadId,begin.body.uploadId);assert.equal(resumed.body.receivedBytes,bytes.length);
 const complete=await request(`${uploadPath}/complete`,{method:'POST',token:owner.token,keyId:joined.keyId});
 assert.equal(complete.status,201,JSON.stringify(complete.body));assert.equal(complete.body.text,text);
 assert.deepEqual((await request(`${path}/files/${complete.body.id}`,{token:joined.token})).body,bytes);
 assert.equal((await request(`${uploadPath}/complete`,{method:'POST',token:owner.token,keyId:joined.keyId})).status,200);
});

test('revocation rotations discard in-flight uploads even when the rotation admits a new device',async()=>{
 const owner=await space(),joined=await accept(owner,await beginPair(owner)),path=`/v1/spaces/${owner.roomId}`;
 owner.keyId=joined.keyId;
 const metadata={clientId:randomUUID(),name:randomUUID(),type:'application/octet-stream',size:32,text:cipher(owner.keyId),fingerprint:randomBytes(32).toString('hex')};
 const begin=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:owner.keyId,json:metadata});
 assert.equal(begin.status,201);
 const nextPair=await beginPair(owner);
 const replacement=await accept(owner,nextPair,async()=>{
  assert.equal((await request(`${path}/devices/${joined.deviceId}`,{method:'DELETE',token:owner.token})).status,200);
  assert.equal((await request(`${path}/devices`,{token:joined.token})).status,401);
 });
 const storage=await runtime.unsafeGetDurableObjectStorage('sync-e2ee-test','E2eeSyncRoom',{name:owner.roomId});
 assert.equal((await storage.exec('SELECT status FROM files WHERE file_id = ?',begin.body.uploadId))[0]?.status,'deleting');
 const chunk=await request(`${path}/files/uploads/${begin.body.uploadId}/chunks/0`,{method:'PUT',token:owner.token,keyId:replacement.keyId,headers:{'Content-Type':'application/octet-stream'},body:randomBytes(32)});
 assert.equal(chunk.status,404);
 const ordinary=await request(`${path}/files/uploads`,{method:'POST',token:owner.token,keyId:replacement.keyId,json:{...metadata,clientId:randomUUID(),text:cipher(replacement.keyId)}});
 assert.equal(ordinary.status,201);
 const newKeyId=randomUUID();
 assert.equal((await request(`${path}/key-rotation`,{method:'POST',token:owner.token,keyId:replacement.keyId,json:{rotationId:randomUUID(),newKeyId,removedDeviceId:replacement.deviceId,grants:[{deviceId:owner.deviceId,envelope:cipher(replacement.keyId)}]}})).status,200);
 assert.equal((await storage.exec('SELECT status FROM files WHERE file_id = ?',ordinary.body.uploadId))[0]?.status,'deleting');
 assert.equal((await request(`${path}/devices`,{token:replacement.token})).status,401);
});
