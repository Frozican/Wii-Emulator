function u32(b,o){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false)}
function hex(b,n=64){return Array.from(b.subarray(0,Math.min(n,b.length)),x=>x.toString(16).padStart(2,'0')).join(' ')}
function ascii(b,n=32){return Array.from(b.subarray(0,n),x=>x>=32&&x<127?String.fromCharCode(x):'.').join('')}
async function read(file,off,len){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<0||off+len>file.size)throw Error('Invalid file range 0x'+off.toString(16)+' + 0x'+len.toString(16));return new Uint8Array(await file.slice(off,off+len).arrayBuffer())}
function fmt(n){return '0x'+n.toString(16)}
self.onmessage=async e=>{
 const file=e.data&&e.data.file;if(!file){postMessage({ok:false,message:'No ISO selected.'});return}
 try{
  postMessage({status:'Running combined metadata, boot-header, FST-candidate and file-range checks…'});
  const disc=await read(file,0,0x440);
  const id=ascii(disc,6),magic=u32(disc,0x18);
  if(magic!==0x5D1C9EA3)throw Error('Wii disc magic mismatch: '+fmt(magic));
  const ptab=await read(file,0x40000,0x20);let part=null,tableSummary=[];
  for(let g=0;g<4;g++){
   const count=u32(ptab,g*8),table=u32(ptab,g*8+4)*4;
   tableSummary.push('type '+g+': count='+count+', table='+fmt(table));
   if(!count||table+8>file.size)continue;
   const entries=await read(file,table,Math.min(count*8,0x1000));
   for(let i=0;i<Math.floor(entries.length/8);i++){const off=u32(entries,i*8)*4,type=u32(entries,i*8+4);if(type===0&&!part)part={off,type,group:g,index:i}}
  }
  if(!part)throw Error('Could not find a type-0 data partition.');
  const ph=await read(file,part.off,0x2c0);
  const dataRel=u32(ph,0x2b8)*4,dataSize=u32(ph,0x2bc)*4,dataOff=part.off+dataRel;
  const out=[];
  out.push('Disc ID: '+id);
  out.push('File size: '+file.size.toLocaleString()+' bytes');
  out.push('Partition table: '+tableSummary.join(' | '));
  out.push('Data partition: '+fmt(part.off)+' (group '+part.group+', entry '+part.index+')');
  out.push('Partition header fields: data offset raw='+fmt(u32(ph,0x2b8))+' words -> '+fmt(dataRel)+' bytes; data size raw='+fmt(u32(ph,0x2bc))+' words -> '+dataSize.toLocaleString()+' bytes');
  out.push('Computed data start: '+fmt(dataOff)+'; data end: '+fmt(dataOff+dataSize)+'; ends at file EOF: '+(dataOff+dataSize===file.size?'YES':'NO'));
  out.push('');
  out.push('CHECK 1 — partition metadata and boundaries');
  out.push('Wii disc magic: '+fmt(magic)+' (valid)');
  out.push('Disc version byte 0x61: '+fmt(disc[0x61])+' (not an encryption flag)');
  out.push('');
  out.push('CHECK 2 — inspect possible boot.bin headers');
  const candidates=[
   {name:'disc header area',base:0},
   {name:'partition data start',base:dataOff},
   {name:'partition data start + 0x400',base:dataOff+0x400},
   {name:'partition data start + 0x8000',base:dataOff+0x8000},
   {name:'partition data start + 0x8400',base:dataOff+0x8400}
  ];
  let bytesRead=0;const inspected=[];
  for(const c of candidates){
   if(c.base+0x440>file.size){out.push(c.name+' @ '+fmt(c.base)+': outside file');continue}
   const b=await read(file,c.base,0x440);bytesRead+=b.length;
   const fstOff=u32(b,0x424),fstSize=u32(b,0x428),fstMax=u32(b,0x42c);
   const item={...c,fstOff,fstSize,fstMax};
   inspected.push(item);
   out.push(c.name+' @ '+fmt(c.base)+': first 16 bytes='+hex(b,16));
   out.push('  boot-header fields at +0x424/+0x428/+0x42C: FST offset='+fmt(fstOff)+', size='+fmt(fstSize)+', max='+fmt(fstMax));
  }
  out.push('');
  out.push('CHECK 3 — check candidate FST ranges and entry structure');
  let plausible=0;
  for(const c of inspected.filter(x=>x.base!==0)){
   // This is only a raw-offset hypothesis; encrypted/hash-sector mapping may make it invalid.
   const abs=c.base+c.fstOff;
   const valid=c.fstOff>0&&c.fstSize>=12&&c.fstSize<0x10000000&&c.fstMax>=c.fstSize&&c.fstMax<0x10000000&&abs+c.fstSize<=file.size&&abs>=dataOff&&abs<dataOff+dataSize;
   out.push(c.name+': '+(valid?'numeric range plausible':'not plausible')+'; candidate FST absolute offset='+fmt(abs));
   if(valid){
    const fst=await read(file,abs,Math.min(32,c.fstSize));bytesRead+=fst.length;
    const type=u32(fst,0),nameOff=u32(fst,4)&0x00ffffff,next=u32(fst,8);
    const structure=(type===0&&next>0&&next<0x1000000&&nameOff< c.fstSize);
    out.push('  first 32 FST bytes: '+hex(fst,32));
    out.push('  first entry: typeWord='+fmt(type)+', nameOffset='+fmt(nameOff)+', nextIndex/size='+fmt(next)+'; root-entry shape '+(structure?'looks plausible':'not confirmed'));
    if(structure)plausible++;
   }
  }
  out.push('');
  out.push('Range bytes read (approx): '+(bytesRead+0x20+0x2c0).toLocaleString()+' bytes');
  out.push('Whole ISO copied: NO');
  out.push('');
  out.push('Caution: FST fields and ranges are only candidate interpretations. This test does not decrypt data or map logical Wii sectors through 0x8000-byte physical sectors, so even a plausible range is not proof of a valid FST.');
  postMessage({ok:true,message:out.join('\n')});
 }catch(err){postMessage({ok:false,message:(err&&err.stack)||String(err)})}
};