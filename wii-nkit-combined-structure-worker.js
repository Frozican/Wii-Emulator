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
   for(let i=0;i<Math.floor(entries.length/8);i++){
    const off=u32(entries,i*8)*4,type=u32(entries,i*8+4);
    if(type===0&&!part)part={off,type,group:g,index:i};
   }
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
  out.push('CHECK 2 — inspect candidate boot-header positions');
  const candidates=[{name:'disc file + 0x420',base:0x420},{name:'partition data + 0x420',base:dataOff+0x420},{name:'partition data + 0x400 + 0x420',base:dataOff+0x820},{name:'partition data + 0x8000 + 0x420',base:dataOff+0x8420},{name:'partition data + 0x8000 + 0x400 + 0x420',base:dataOff+0x8820}];
  let bytesRead=0;
  for(const c of candidates){
   if(c.base+0x40>file.size){out.push(c.name+': outside file');continue}
   const b=await read(file,c.base,0x40);bytesRead+=b.length;
   const fstOff=u32(b,4),fstSize=u32(b,8),fstMax=u32(b,12);
   out.push(c.name+' @ '+fmt(c.base)+': bytes[0..31]='+hex(b,32));
   out.push('  candidate FST fields (+4/+8/+12): offset='+fmt(fstOff)+', size='+fmt(fstSize)+', max='+fmt(fstMax));
  }
  out.push('');
  out.push('CHECK 3 — test FST candidate ranges and signatures');
  let plausible=0;
  for(const c of candidates.slice(1)){
   if(c.base+0x40>file.size)continue;
   const b=await read(file,c.base,0x40);
   const fstOff=u32(b,4),fstSize=u32(b,8),fstMax=u32(b,12);
   // Wii boot.bin fields are byte offsets/sizes, not word-scaled.
   const abs=dataOff+fstOff;
   const valid=fstOff>0&&fstSize>=12&&fstSize<0x10000000&&abs+Math.min(fstSize,32)<=file.size&&fstMax>=fstSize&&fstMax<0x10000000;
   out.push(c.name+': '+(valid?'range looks plausible':'not plausible')+' (computed dataStart+FSTOffset='+fmt(abs)+')');
   if(valid){
    plausible++;
    const fst=await read(file,abs,Math.min(32,fstSize));bytesRead+=fst.length;
    out.push('  first FST bytes: '+hex(fst,32));
    out.push('  FST first word: '+fmt(u32(fst,0))+'; first entry name offset='+fmt(u32(fst,4)&0x00ffffff));
   }
  }
  out.push('');
  out.push('Range bytes read (approx, including small metadata reads): '+(bytesRead+0x440+0x20+0x2c0).toLocaleString());
  out.push('Whole ISO copied: NO');
  out.push('');
  out.push('Interpretation: this is a diagnostic, not a decryption implementation. Candidate offsets are hypotheses. A plausible numeric range alone does NOT prove the FST is valid; the first entry bytes and actual NKit layout must be verified.');
  postMessage({ok:true,message:out.join('\n')});
 }catch(err){postMessage({ok:false,message:(err&&err.stack)||String(err)})}
};