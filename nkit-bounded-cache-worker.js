self.onmessage=async({data})=>{
 const {file}=data||{};if(!file)return self.postMessage("FAIL: no ISO selected");
 const CHUNK=256*1024,MAX_CACHE=4*1024*1024;
 const u32=(b,o=0)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false);
 const direct=async(o,n)=>new Uint8Array(await file.slice(o,o+n).arrayBuffer());
 const hx=n=>"0x"+n.toString(16);
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join(" ");
 const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 try{
  const marker=await direct(0x200,4);if(new TextDecoder().decode(marker)!=="NKIT")throw Error("NKIT marker not found at 0x200");
  const table=await direct(0x40000,0x40);let part=0;
  for(let t=0;t<4&&!part;t++){const count=u32(table,t*8),tableWords=u32(table,t*8+4);if(count>0&&count<10000&&tableWords){const raw=await direct(tableWords*4,Math.min(count*8,0x10000));for(let i=0;i<count;i++){if(u32(raw,i*8+4)===0){part=u32(raw,i*8)*4;break;}}}}
  if(!part)throw Error("Type-0 data partition not found");
  const ph=await direct(part,0x300),dataStart=part+u32(ph,0x2b8)*4,boot=await direct(dataStart,0x440),decoder=new TextDecoder();
  if(decoder.decode(boot.slice(0,6))!==decoder.decode(await direct(0,6)))throw Error("Partition boot ID does not match disc ID");
  const fstOffset=u32(boot,0x424)*4,fstSize=u32(boot,0x428)*4,fst=await direct(dataStart+fstOffset,fstSize),count=u32(fst,8),stringsAt=count*12;
  if(!count||count>100000||stringsAt>fst.length)throw Error("Invalid FST");
  const entries=[];
  for(let i=1;i<count;i++){const word=u32(fst,i*12);if((word>>>24)===1)continue;const no=word&0xffffff;let end=stringsAt+no;while(end<fst.length&&fst[end])end++;entries.push({name:decoder.decode(fst.slice(stringsAt+no,end)),offset:u32(fst,i*12+4)*4,size:u32(fst,i*12+8)});}
  const cache=new Map();let cacheBytes=0,hit=0,miss=0,peak=0,sourceBytes=0;
  const getChunk=async idx=>{
   if(cache.has(idx)){const b=cache.get(idx);cache.delete(idx);cache.set(idx,b);hit++;return b;}
   miss++;const start=idx*CHUNK,b=await direct(start,Math.min(CHUNK,file.size-start));sourceBytes+=b.length;
   if(b.length>MAX_CACHE)throw Error("Internal cache block exceeds cap");
   while(cacheBytes+b.length>MAX_CACHE){const oldest=cache.keys().next().value;const old=cache.get(oldest);cache.delete(oldest);cacheBytes-=old.length;}
   cache.set(idx,b);cacheBytes+=b.length;peak=Math.max(peak,cacheBytes);return b;
  };
  const readCached=async(start,len)=>{
   if(start<0||len<0||start+len>file.size)throw Error("Read outside ISO bounds");
   const out=new Uint8Array(len);let done=0;
   while(done<len){const absolute=start+done,idx=Math.floor(absolute/CHUNK),within=absolute%CHUNK,b=await getChunk(idx),take=Math.min(len-done,b.length-within);if(take<=0)throw Error("Unexpected EOF while reading cached range");out.set(b.subarray(within,within+take),done);done+=take;}
   return out;
  };
  const targets=["SMG_boss01a_strm.ast","SMG_boss01b_strm.ast","SMG_boss03b_strm.ast","SMG_boss05b_strm.ast"];
  const lines=["NKit bounded range-cache prototype","Disc ID: "+decoder.decode(boot.slice(0,6)),"ISO size: "+file.size.toLocaleString("en-US")+" bytes","Cache chunk size: "+CHUNK.toLocaleString("en-US")+" bytes","Cache capacity: "+MAX_CACHE.toLocaleString("en-US")+" bytes",""];
  let tests=0,failures=0;
  for(const name of targets){
   const f=entries.find(e=>e.name.toLowerCase()===name.toLowerCase());
   if(!f){lines.push("FAIL missing FST file: "+name);failures++;continue;}
   const samples=[["start",0,64],["middle",Math.floor(f.size/2),64],["end",f.size-64,64],["cross-chunk",Math.max(0,Math.floor(f.size/2/CHUNK)*CHUNK-16),64]];
   lines.push(name+" | file size "+f.size.toLocaleString("en-US")+" | ISO base "+hx(dataStart+f.offset));
   for(const [label,off,len] of samples){
    if(off<0||off+len>f.size){lines.push("  FAIL "+label+": invalid file-local range");failures++;continue;}
    const physical=dataStart+f.offset+off;
    const uncached=await direct(physical,len),cached=await readCached(physical,len);
    if(!eq(uncached,cached)){lines.push("  FAIL "+label+" at "+hx(physical)+": cache bytes differ from direct File.slice()");failures++;}
    else {lines.push("  PASS "+label+" file+"+hx(off)+" ISO "+hx(physical)+" | "+hex(cached.slice(0,Math.min(16,cached.length)))+(len>16?" …":""));tests++;}
   }
   lines.push("");
  }
  lines.push("Range comparisons passed: "+tests+" | failures: "+failures);
  lines.push("Cache hits: "+hit+" | cache misses: "+miss);
  lines.push("Peak cached payload: "+peak.toLocaleString("en-US")+" / "+MAX_CACHE.toLocaleString("en-US")+" bytes");
  lines.push("Bytes fetched into cache blocks: "+sourceBytes.toLocaleString("en-US")+" (not the whole ISO unless a test actually touches that many blocks)");
  lines.push("Bound respected: "+(peak<=MAX_CACHE?"YES":"NO"));
  lines.push("Important: this is only a bounded JS cache prototype. Gecko still needs a compatible synchronous-read architecture; this test does not boot the game.");
  self.postMessage(lines.join("\n"));
 }catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};