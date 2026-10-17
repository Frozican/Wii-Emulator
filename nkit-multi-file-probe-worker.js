self.onmessage=async({data})=>{
 const {file}=data||{};if(!file)return self.postMessage("FAIL: no ISO selected");
 const u32=(b,o=0)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false);
 const read=async(o,n)=>new Uint8Array(await file.slice(o,o+n).arrayBuffer());
 const hx=n=>"0x"+n.toString(16);
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join(" ");
 try{
  const marker=await read(0x200,4);if(new TextDecoder().decode(marker)!=="NKIT")throw Error("NKIT marker not found at 0x200; expected an NKit ISO.");
  const table=await read(0x40000,0x40);let part=0;
  for(let t=0;t<4&&!part;t++){const count=u32(table,t*8),tableWords=u32(table,t*8+4);if(count>0&&count<10000&&tableWords){const entries=await read(tableWords*4,Math.min(count*8,0x10000));for(let i=0;i<count;i++){if(u32(entries,i*8+4)===0){part=u32(entries,i*8)*4;break;}}}}
  if(!part)throw Error("Type-0 data partition not found");
  const ph=await read(part,0x300),dataStart=part+u32(ph,0x2b8)*4;
  const boot=await read(dataStart,0x440),decoder=new TextDecoder();
  if(decoder.decode(boot.slice(0,6))!==decoder.decode(await read(0,6)))throw Error("Partition boot ID does not match disc ID");
  const fstOffset=u32(boot,0x424)*4,fstSize=u32(boot,0x428)*4,fst=await read(dataStart+fstOffset,fstSize);
  const count=u32(fst,8),stringsAt=count*12;if(!count||count>100000||stringsAt>fst.length)throw Error("Invalid FST");
  const entries=[];
  for(let i=1;i<count;i++){const word=u32(fst,i*12);if((word>>>24)===1)continue;const no=word&0xffffff;let end=stringsAt+no;while(end<fst.length&&fst[end])end++;entries.push({name:decoder.decode(fst.slice(stringsAt+no,end)),offset:u32(fst,i*12+4)*4,size:u32(fst,i*12+8)});}
  const targets=["SMG_astrodome02_strm.ast","SMG_astrodome03_strm.ast","SMG_astroout01_strm.ast","SMG_boss01a_strm.ast","SMG_boss01b_strm.ast","SMG_boss03b_strm.ast","SMG_boss05b_strm.ast"];
  const lines=["NKit multi-file range probe", "Disc ID: "+decoder.decode(boot.slice(0,6)), "ISO size: "+file.size.toLocaleString("en-US")+" bytes", "FST file entries scanned: "+entries.length, ""];
  let passed=0,failed=0;
  for(const target of targets){
   const f=entries.find(e=>e.name.toLowerCase()===target.toLowerCase());
   if(!f){lines.push("MISS "+target+" — not found in FST");failed++;continue;}
   const offsets=[["start",0],["middle",Math.max(0,Math.floor((f.size-16)/2))],["end",Math.max(0,f.size-16)]];
   lines.push(target+" | size "+f.size+" bytes | logical "+hx(f.offset));
   for(const [label,off] of offsets){
    const physical=dataStart+f.offset+off,b=await read(physical,16);
    if(b.length!==16){lines.push("  FAIL "+label+" @ "+hx(physical)+" returned "+b.length+"/16");failed++;continue;}
    lines.push("  PASS "+label+" logical+"+hx(off)+" -> ISO "+hx(physical)+" | "+hex(b)+" | "+Array.from(b,x=>x>=32&&x<=126?String.fromCharCode(x):".").join(""));
    passed++;
   }
   lines.push("");
  }
  lines.push("Sample ranges passed: "+passed+" | failed/missing files: "+failed);
  lines.push("Total payload read: "+(passed*16).toLocaleString("en-US")+" bytes, plus small disc/FST metadata ranges.");
  lines.push("Important: this checks sampled byte mapping only; it does not prove all NKit gaps/partitions are decoded or that the game boots.");
  self.postMessage(lines.join("\n"));
 }catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};