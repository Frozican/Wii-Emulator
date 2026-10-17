function u32(b,o){return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false)}
function hex(b,n=32){return Array.from(b.subarray(0,Math.min(n,b.length)),x=>x.toString(16).padStart(2,'0')).join(' ')}
function ascii(b,n=16){return Array.from(b.subarray(0,n),x=>x>=32&&x<127?String.fromCharCode(x):'.').join('')}
function fmt(n){return '0x'+n.toString(16)}
async function raw(file,off,len){if(!Number.isSafeInteger(off)||!Number.isSafeInteger(len)||off<0||len<0||off+len>file.size)throw Error('Invalid raw range '+fmt(off)+' + '+fmt(len));return new Uint8Array(await file.slice(off,off+len).arrayBuffer())}
// Logical Wii partition user-data byte offset -> physical 0x8000-byte sector, skipping each 0x400-byte hash area.
async function logical(file,dataOff,logicalOff,len){
 const out=new Uint8Array(len);let done=0;
 while(done<len){
  const pos=logicalOff+done, sector=Math.floor(pos/0x7c00), within=pos%0x7c00;
  const take=Math.min(len-done,0x7c00-within);
  const physical=dataOff+sector*0x8000+0x400+within;
  const part=await raw(file,physical,take);out.set(part,done);done+=take;
 }
 return out;
}
self.onmessage=async e=>{
 const file=e.data&&e.data.file;if(!file){postMessage({ok:false,message:'No ISO selected.'});return}
 try{
  postMessage({status:'Reading partition metadata and comparing raw vs logical-sector-mapped offsets…'});
  const disc=await raw(file,0,0x440), magic=u32(disc,0x18);
  if(magic!==0x5d1c9ea3)throw Error('Wii disc magic mismatch: '+fmt(magic));
  const table=await raw(file,0x40000,0x20);let part=null,groups=[];
  for(let g=0;g<4;g++){
   const count=u32(table,g*8),off=u32(table,g*8+4)*4;groups.push('type '+g+': count='+count+', table='+fmt(off));
   if(!count||off+8>file.size)continue;
   const entries=await raw(file,off,Math.min(count*8,0x1000));
   for(let i=0;i<Math.floor(entries.length/8);i++){const po=u32(entries,i*8)*4,type=u32(entries,i*8+4);if(type===0&&!part)part={off:po,group:g,index:i}}
  }
  if(!part)throw Error('No type-0 data partition found');
  const ph=await raw(file,part.off,0x2c0), dataOff=part.off+u32(ph,0x2b8)*4, dataSize=u32(ph,0x2bc)*4;
  const out=['Disc ID: '+ascii(disc,6),'File size: '+file.size.toLocaleString()+' bytes','Wii magic: '+fmt(magic),'Partition tables: '+groups.join(' | '),'Partition offset: '+fmt(part.off),'Data start: '+fmt(dataOff),'Data area ends at EOF: '+(dataOff+dataSize===file.size?'YES':'NO'),'','CHECK A — raw bytes versus mapped logical sector 0'];
  const rawStart=await raw(file,dataOff,0x440), mappedStart=await logical(file,dataOff,0,0x440);
  out.push('Raw at data start: '+hex(rawStart,32)+' | ASCII: '+ascii(rawStart,32));
  out.push('Mapped logical offset 0 (skips 0x400 hash bytes): '+hex(mappedStart,32)+' | ASCII: '+ascii(mappedStart,32));
  const fieldInfo=(label,b)=>{
   const vals=[u32(b,0x424),u32(b,0x428),u32(b,0x42c)];
   out.push(label+' fields +0x424/+0x428/+0x42C raw: FST offset='+fmt(vals[0])+', size='+fmt(vals[1])+', max='+fmt(vals[2]));
   out.push(label+' fields shifted left 2: FST offset='+fmt(vals[0]*4)+', size='+fmt(vals[1]*4)+', max='+fmt(vals[2]*4));
   return vals;
  };
  out.push('');out.push('CHECK B — candidate Wii boot header');
  const rawFields=fieldInfo('Raw data-start candidate',rawStart), mapFields=fieldInfo('Mapped logical-sector candidate',mappedStart);
  const candidates=[];
  if(mapFields[0]>0&&mapFields[1]>=12&&mapFields[1]<0x10000000)candidates.push({name:'mapped header (shifted offsets)',off:mapFields[0]*4,size:mapFields[1]*4});
  if(rawFields[0]>0&&rawFields[1]>=12&&rawFields[1]<0x10000000)candidates.push({name:'raw header (shifted offsets)',off:rawFields[0]*4,size:rawFields[1]*4});
  out.push('');out.push('CHECK C — read FST candidates through logical-sector mapping');
  if(!candidates.length)out.push('No bounded non-zero FST candidate fields found in either header interpretation.');
  let reads=0;
  for(const c of candidates){
   if(c.off+c.size>dataSize){out.push(c.name+': candidate out of partition user-data bounds (offset '+fmt(c.off)+', size '+fmt(c.size)+')');continue}
   const fst=await logical(file,dataOff,c.off,Math.min(32,c.size));reads+=fst.length;
   const first=u32(fst,0),name=u32(fst,4)&0xffffff,next=u32(fst,8);
   const valid=(first===0x01000000&&next>0&&next<0x1000000);
   out.push(c.name+': logical FST offset='+fmt(c.off)+', size='+fmt(c.size));
   out.push('  mapped bytes: '+hex(fst,32));
   out.push('  root entry: firstWord='+fmt(first)+', nameOffset='+fmt(name)+', parent/nextIndex='+fmt(next)+'; root shape '+(valid?'VALID-LOOKING':'NOT VALIDATED'));
  }
  out.push('');out.push('Approximate bytes read: small range reads only; FST sample bytes='+reads);
  out.push('Whole ISO copied: NO; file never uploaded.');
  out.push('');out.push('Important: this test maps logical user-data bytes over 0x8000 physical sectors by skipping 0x400 bytes per sector. It does NOT decrypt AES-encrypted Wii partition payload or validate NKit repair semantics. A valid-looking root is evidence only, not proof that the full partition is readable.');
  postMessage({ok:true,message:out.join('\n')});
 }catch(err){postMessage({ok:false,message:(err&&err.stack)||String(err)})}
};