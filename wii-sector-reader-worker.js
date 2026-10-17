function be32(b,o){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false)}
function hex(b,n=32){return Array.from(b.subarray(0,Math.min(n,b.length)),x=>x.toString(16).padStart(2,'0')).join(' ')}
function ascii(b,n=64){return Array.from(b.subarray(0,n),x=>x>=32&&x<127?String.fromCharCode(x):'.').join('')}
async function read(file,off,len){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<0||off+len>file.size)throw Error('Invalid range: 0x'+off.toString(16)+' + 0x'+len.toString(16));return new Uint8Array(await file.slice(off,off+len).arrayBuffer())}
function concat(a,b){const o=new Uint8Array(a.length+b.length);o.set(a);o.set(b,a.length);return o}
async function importAes(raw,usage){return crypto.subtle.importKey('raw',raw,{name:'AES-CBC'},false,[usage])}
// WebCrypto AES-CBC applies PKCS#7 padding. Append a synthetic ciphertext block
// whose plaintext is 0x10 repeated, so decrypting preserves all original blocks.
async function decryptCbcNoPadding(keyBytes,iv,ciphertext){
 if(!ciphertext.length||ciphertext.length%16)throw Error('AES-CBC input must be a non-empty multiple of 16 bytes');
 const key=await importAes(keyBytes,'encrypt');
 const padPlain=new Uint8Array(16);padPlain.fill(16);
 const synthetic= new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv:ciphertext.slice(-16)},key,padPlain));
 const joined=concat(ciphertext,synthetic.slice(0,16));
 const dkey=await importAes(keyBytes,'decrypt');
 return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv},dkey,joined));
}
self.onmessage=async e=>{
 const file=e.data&&e.data.file;if(!file){postMessage({ok:false,message:'No file selected.'});return}
 try{
  postMessage({status:'Reading disc header and partition metadata only…'});
  const header=await read(file,0,0x440);
  const gameId=ascii(header,6);
  const magic=be32(header,0x18);
  if(magic!==0x5D1C9EA3)throw Error('Not a Wii disc header (magic at 0x18 is 0x'+magic.toString(16)+').');
  const unencrypted=header[0x61]!==0;
  const ptab=await read(file,0x40000,0x20);
  let part=null;
  for(let g=0;g<4&&!part;g++){
   const count=be32(ptab,g*8),table=be32(ptab,g*8+4)*4;
   if(!count||table+8>file.size)continue;
   const entries=await read(file,table,Math.min(count*8,0x1000));
   for(let i=0;i<Math.floor(entries.length/8);i++){
    const off=be32(entries,i*8)*4,type=be32(entries,i*8+4);
    if(type===0){part={off,type};break}
   }
  }
  if(!part)throw Error('No type-0 data partition found in the first 0x1000 bytes of partition-table entries.');
  const ph=await read(file,part.off,0x2c0);
  const dataOff=part.off+be32(ph,0x2b8)*4, dataSize=be32(ph,0x2bc)*4;
  if(dataOff+0x8000>file.size||dataSize<0x8000)throw Error('Partition data area is too small or outside the file.');
  const sector=await read(file,dataOff,0x8000);
  let output='Disc ID: '+gameId+'\nDisc header byte 0x61: 0x'+header[0x61].toString(16)+' ('+(unencrypted?'disc header marks data as unencrypted':'normal encrypted-disc flag')+')\nPartition offset: 0x'+part.off.toString(16)+'\nPartition data offset: 0x'+dataOff.toString(16)+'\nPartition data size: '+dataSize.toLocaleString()+' bytes\nPhysical sector bytes read: '+sector.length.toLocaleString()+'\nWhole ISO copied: NO\n\nPhysical sector start (first 64 bytes):\n'+hex(sector,64)+'\nASCII: '+ascii(sector,64)+'\n\nUser-data candidate at sector + 0x400 (first 64 bytes):\n'+hex(sector.subarray(0x400),64)+'\nASCII: '+ascii(sector.subarray(0x400),64);
  if(unencrypted){
   output+='\n\nHeader flag indicates unencrypted partition data; encrypted title-key path was not attempted.';
  } else {
   const encryptedTitleKey=ph.slice(0x1bf,0x1cf);
   const titleId=ph.slice(0x1dc,0x1e4);
   const commonKey=Uint8Array.from([0xeb,0xe4,0x2a,0x22,0x5e,0x85,0x93,0xe4,0x48,0xd9,0xc5,0x45,0x73,0x81,0xaa,0xf7]);
   const iv=new Uint8Array(16);iv.set(titleId,0);
   const titleKey=await decryptCbcNoPadding(commonKey,iv,encryptedTitleKey);
   const hashPlain=await decryptCbcNoPadding(titleKey,new Uint8Array(16),sector.slice(0,0x400));
   const dataIv=sector.slice(0x3d0,0x3e0);
   const userPlain=await decryptCbcNoPadding(titleKey,dataIv,sector.slice(0x400,0x8000));
   const m=be32(userPlain,0x18);
   const rawOffset=be32(userPlain,0x424),rawSize=be32(userPlain,0x428);
   output+='\n\nAES-128-CBC diagnostic: title key decrypted from partition ticket.\nDecrypted user-data first 64 bytes:\n'+hex(userPlain,64)+'\nASCII: '+ascii(userPlain,64)+'\nWii magic at user-data +0x18: 0x'+m.toString(16)+'\nFST fields at user-data +0x424: raw offset=0x'+rawOffset.toString(16)+', raw size=0x'+rawSize.toString(16)+'\nDecrypted H0/hash block first 32 bytes:\n'+hex(hashPlain,32);
   if(m===0x5d1c9ea3)output+='\n\nRESULT: decrypted user data begins with a Wii header signature. This is a strong first-sector check, not a game-boot test.';
   else output+='\n\nRESULT: expected Wii magic was not found in decrypted user data. This may indicate NKit-specific layout, a different sector interpretation, or a key/format issue; no boot claim is made.';
  }
  postMessage({ok:true,message:output});
 }catch(err){postMessage({ok:false,message:(err&&err.stack)||String(err)})}
};