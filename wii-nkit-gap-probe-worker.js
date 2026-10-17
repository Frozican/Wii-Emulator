self.onmessage = async ({data}) => {
 const file=data?.file;if(!file)return self.postMessage("FAIL: no file selected");
 const u32=(b,o=0)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false);
 const read=async(o,n)=>new Uint8Array(await file.slice(o,o+n).arrayBuffer());
 const hx=n=>"0x"+n.toString(16);
 try{
  const nkit=await read(0x200,0x18);
  if(new TextDecoder().decode(nkit.slice(0,4))!=="NKIT")throw Error("NKIT marker not found at 0x200");
  const sourceLengthRaw=u32(nkit,0x10);
  const phTable=await read(0x40000,0x40);let part=0;
  for(let t=0;t<4&&!part;t++){const c=u32(phTable,t*8),tw=u32(phTable,t*8+4);if(c>0&&c<10000&&tw){const tab=await read(tw*4,Math.min(c*8,0x10000));for(let i=0;i<c;i++)if(u32(tab,i*8+4)===0){part=u32(tab,i*8)*4;break;}}}
  if(!part)throw Error("Type-0 partition not found");
  const ph=await read(part,0x300),dataStart=part+u32(ph,0x2b8)*4;
  const boot=await read(dataStart,0x440);if(new TextDecoder().decode(boot.slice(0,6))!=="RMGE01")throw Error("Boot header mismatch");
  const fstOff=u32(boot,0x424)*4,fstSize=u32(boot,0x428)*4,fstAbs=dataStart+fstOff;
  const fst=await read(fstAbs,fstSize),count=u32(fst,8),stringsAt=count*12;
  if(count<1||count>100000||count*12>fst.length)throw Error("Invalid FST");
  // Wii partition lengths are stored in word units in these NKit fields.
  const originalPartitionLengthRaw=u32(await read(dataStart+0x210,4));
  const originalPartitionLengthBytes=originalPartitionLengthRaw*4;
  const sourceLengthBytes=sourceLengthRaw*4;
  const groups=Math.ceil(originalPartitionLengthBytes/0x200000),maskBytes=Math.ceil(groups/8);
  const maskStart=fstAbs+fstSize, gapStart=maskStart+maskBytes;
  const gapHeader=u32(await read(gapStart,4));
  const gapSize=gapHeader&0xfffffffc,gapType=gapHeader&3;
  const dec=new TextDecoder();const entries=[];
  for(let i=1;i<count;i++){
   const w=u32(fst,i*12);if((w>>>24)===1)continue;
   const no=w&0xffffff,ns=stringsAt+no;let ne=ns;while(ne<fst.length&&fst[ne])ne++;
   const name=dec.decode(fst.slice(ns,ne));
   // Wii FST file offsets and lengths are both stored in words.
   entries.push({name,offset:u32(fst,i*12+4)*4,size:u32(fst,i*12+8)*4});
  }
  entries.sort((a,b)=>a.offset-b.offset);
  const lines=[
   "PASS — NKit post-FST gap probe (corrected units)",
   `Disc RMGE01; image size ${file.size.toLocaleString("en-US")} bytes`,
   `NKit source image length field: ${hx(sourceLengthRaw)} raw = ${hx(sourceLengthBytes)} bytes (word-unit interpretation)`,
   `Partition data start: ${hx(dataStart)}`,
   `FST: ${hx(fstAbs)} size ${hx(fstSize)}; entries ${count}`,
   `Saved original partition length @ data+0x210: ${hx(originalPartitionLengthRaw)} raw = ${hx(originalPartitionLengthBytes)} bytes (word-unit interpretation)`,
   `Estimated 0x200000-byte groups: ${groups.toLocaleString("en-US")}`,
   `Estimated preserved-hash mask: ${maskBytes.toLocaleString("en-US")} bytes`,
   `Mask range: ${hx(maskStart)}..${hx(gapStart)}`,
   `First post-mask gap header @ ${hx(gapStart)}: ${hx(gapHeader)}`,
   `Gap type bits: ${gapType} (${["all junk","zero-scrubbed","mixed encoded blocks","junk file"][gapType]}); declared logical gap size: ${hx(gapSize)}`,
   "",
   "First files sorted by FST offset (both Wii offsets and sizes multiplied by 4):",
   ...entries.slice(0,16).map(e=>`${e.name}: offset=${hx(e.offset)} size=${hx(e.size)}`),
   "",
   "This is a layout diagnostic only. It does not decode gap contents or boot the game; only small File.slice ranges are read."
  ];
  self.postMessage(lines.join("\n"));
 }catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};