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
  const partLenRaw=u32(ph,0x2bc),partitionLengthBytes=partLenRaw*4,dataEnd=dataStart+partitionLengthBytes;
  const boot=await read(dataStart,0x440);if(new TextDecoder().decode(boot.slice(0,6))!=="RMGE01")throw Error("Boot header mismatch");
  const fstOff=u32(boot,0x424)*4,fstSize=u32(boot,0x428)*4,fstAbs=dataStart+fstOff,fstEnd=fstAbs+fstSize;
  const fst=await read(fstAbs,fstSize),count=u32(fst,8),stringsAt=count*12;
  if(count<1||count>100000||count*12>fst.length)throw Error("Invalid FST");
  const originalPartitionLengthRaw=u32(await read(dataStart+0x210,4));
  const originalPartitionLengthBytes=originalPartitionLengthRaw*4;
  const groups=Math.ceil(originalPartitionLengthBytes/0x200000),maskBytes=Math.ceil(groups/8);
  // NKit filesystem gaps begin immediately after FST; the preserved-hash mask is not stored here.
  const gapHeader=u32(await read(fstEnd,4));
  const gapSize=gapHeader&0xfffffffc,gapType=gapHeader&3;
  const dec=new TextDecoder();const entries=[];
  for(let i=1;i<count;i++){
   const w=u32(fst,i*12);if((w>>>24)===1)continue;
   const no=w&0xffffff,ns=stringsAt+no;let ne=ns;while(ne<fst.length&&fst[ne])ne++;
   const name=dec.decode(fst.slice(ns,ne));
   entries.push({name,offset:u32(fst,i*12+4)*4,size:u32(fst,i*12+8)*4});
  }
  entries.sort((a,b)=>a.offset-b.offset);
  const firstFile=entries[0],fstEndLogical=fstOff+fstSize;
  const expectedGap=firstFile?firstFile.offset-fstEndLogical:null;
  const tailStart=Math.max(0,file.size-maskBytes-16);
  const tail=await read(tailStart,Math.min(maskBytes+16,file.size-tailStart));
  const tailHex=Array.from(tail.slice(0,Math.min(24,tail.length)),b=>b.toString(16).padStart(2,"0")).join(" ");
  const lines=[
   "PASS — NKit filesystem-gap probe (corrected placement)",
   `Disc RMGE01; image size ${file.size.toLocaleString("en-US")} bytes`,
   `NKit source image length: ${hx(sourceLengthRaw)} raw words = ${hx(sourceLengthRaw*4)} bytes`,
   `Partition header: ${hx(part)}; data start ${hx(dataStart)}; partition data length ${hx(partitionLengthBytes)} bytes`,
   `Partition data end (calculated): ${hx(dataEnd)}; file EOF: ${hx(file.size)}`,
   `FST: ${hx(fstAbs)} size ${hx(fstSize)}; entries ${count}; physical FST end ${hx(fstEnd)}`,
   `First gap header immediately after FST @ ${hx(fstEnd)}: ${hx(gapHeader)}`,
   `Gap type bits: ${gapType} (${["all junk","zero-scrubbed","mixed encoded blocks","junk file"][gapType]}); declared logical gap size: ${hx(gapSize)}`,
   `Logical gap expected from FST end to first file: ${expectedGap===null?"unknown":hx(expectedGap)} bytes`,
   `Original partition length marker @ data+0x210: ${hx(originalPartitionLengthRaw)} raw words = ${hx(originalPartitionLengthBytes)} bytes`,
   `Estimated preserved-hash mask size: ${maskBytes} bytes across ${groups} groups (estimate only; tail location not yet validated)`,
   `Tail sample starts @ ${hx(tailStart)} (first ${Math.min(24,tail.length)} bytes): ${tailHex}`,
   "",
   "First files sorted by FST offset (both Wii offsets and sizes multiplied by 4):",
   ...entries.slice(0,16).map(e=>`${e.name}: offset=${hx(e.offset)} size=${hx(e.size)}`),
   "",
   "Reads only small File.slice ranges. This does not yet decode all gap types, reconstruct the partition, or boot the game."
  ];
  self.postMessage(lines.join("\n"));
 }catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};