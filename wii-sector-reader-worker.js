function be32(b,o){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false)}
function hex(b,n=32){return Array.from(b.subarray(0,Math.min(n,b.length)),x=>x.toString(16).padStart(2,'0')).join(' ')}
function ascii(b,n=64){return Array.from(b.subarray(0,n),x=>x>=32&&x<127?String.fromCharCode(x):'.').join('')}
async function read(file,off,len){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<0||off+len>file.size)throw Error('Invalid range: 0x'+off.toString(16)+' + 0x'+len.toString(16));return new Uint8Array(await file.slice(off,off+len).arrayBuffer())}
self.onmessage=async e=>{
 const file=e.data&&e.data.file;if(!file){postMessage({ok:false,message:'No file selected.'});return}
 try{
  postMessage({status:'Reading disc header, partition metadata, and a few sector ranges…'});
  const header=await read(file,0,0x440);
  const gameId=ascii(header,6),magic=be32(header,0x18);
  if(magic!==0x5D1C9EA3)throw Error('Not a Wii disc header (magic at 0x18 is 0x'+magic.toString(16)+').');
  const ptab=await read(file,0x40000,0x20);let part=null;
  for(let g=0;g<4&&!part;g++){
   const count=be32(ptab,g*8),table=be32(ptab,g*8+4)*4;
   if(!count||table+8>file.size)continue;
   const entries=await read(file,table,Math.min(count*8,0x1000));
   for(let i=0;i<Math.floor(entries.length/8);i++){const off=be32(entries,i*8)*4,type=be32(entries,i*8+4);if(type===0){part={off,type};break}}
  }
  if(!part)throw Error('No type-0 data partition found in partition-table entries.');
  const ph=await read(file,part.off,0x2c0);
  const dataOff=part.off+be32(ph,0x2b8)*4,dataSize=be32(ph,0x2bc)*4;
  if(dataOff+0x8000>file.size||dataSize<0x8000)throw Error('Partition data area is too small or outside the file.');
  const spans=[0,0x8000,0x10000,0x18000],reports=[];
  for(const rel of spans){
   if(rel+0x8000>dataSize||dataOff+rel+0x8000>file.size)continue;
   const s=await read(file,dataOff+rel,0x8000),user=s.subarray(0x400);
   reports.push('Relative sector offset +0x'+rel.toString(16)+' (file 0x'+(dataOff+rel).toString(16)+')\n  physical first 32: '+hex(s,32)+'\n  physical ASCII: '+ascii(s,32)+'\n  +0x400 first 32: '+hex(user,32)+'\n  +0x400 ASCII: '+ascii(user,32));
  }
  const rawFst=be32(header,0x424),rawFstSize=be32(header,0x428);
  const version=header[0x61];
  const output='Disc ID: '+gameId+
   '\nDisc header byte 0x61 (disc version field): 0x'+version.toString(16)+
   '\nWii magic: 0x'+magic.toString(16)+
   '\nPartition offset: 0x'+part.off.toString(16)+
   '\nPartition data offset: 0x'+dataOff.toString(16)+
   '\nPartition data size: '+dataSize.toLocaleString()+' bytes'+
   '\nHeader FST raw fields: offset=0x'+rawFst.toString(16)+', size=0x'+rawFstSize.toString(16)+
   '\nBytes read: '+(0x440+0x20+8+0x2c0+reports.length*0x8000).toLocaleString()+
   '\nWhole ISO copied: NO\n\nSector samples (raw bytes; no decryption applied):\n\n'+reports.join('\n\n')+
   '\n\nImportant: byte 0x61 is the disc-version field, not an encryption flag. This diagnostic deliberately does not infer whether partition data is encrypted and does not yet decrypt or locate the FST.';
  postMessage({ok:true,message:output});
 }catch(err){postMessage({ok:false,message:(err&&err.stack)||String(err)})}
};