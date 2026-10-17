self.onmessage=async({data})=>{
 const {file,name,offset,length}=data||{};if(!file)return self.postMessage("FAIL: no ISO selected");
 const u32=(b,o=0)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false);
 const read=async(o,n)=>new Uint8Array(await file.slice(o,o+n).arrayBuffer());
 const hx=n=>"0x"+n.toString(16);
 const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,"0")).join(" ");
 try{
  const marker=await read(0x200,4);if(new TextDecoder().decode(marker)!=="NKIT")throw Error("NKIT marker not found at 0x200; this reader expects an NKit ISO.");
  const table=await read(0x40000,0x40);let part=0;
  for(let t=0;t<4&&!part;t++){const count=u32(table,t*8),tableWords=u32(table,t*8+4);if(count>0&&count<10000&&tableWords){const entries=await read(tableWords*4,Math.min(count*8,0x10000));for(let i=0;i<count;i++){if(u32(entries,i*8+4)===0){part=u32(entries,i*8)*4;break;}}}}
  if(!part)throw Error("Type-0 data partition not found");
  const ph=await read(part,0x300),dataStart=part+u32(ph,0x2b8)*4;
  const boot=await read(dataStart,0x440);if(new TextDecoder().decode(boot.slice(0,6))!==new TextDecoder().decode(await read(0,6)))throw Error("Partition boot ID does not match disc ID");
  const fstOffset=u32(boot,0x424)*4,fstSize=u32(boot,0x428)*4,fst=await read(dataStart+fstOffset,fstSize);
  const count=u32(fst,8),stringsAt=count*12;if(!count||count>100000||stringsAt>fst.length)throw Error("Invalid FST");
  const decoder=new TextDecoder(),entries=[];
  for(let i=1;i<count;i++){const word=u32(fst,i*12);if((word>>>24)===1)continue;const no=word&0xffffff;let end=stringsAt+no;while(end<fst.length&&fst[end])end++;entries.push({name:decoder.decode(fst.slice(stringsAt+no,end)),offset:u32(fst,i*12+4)*4,size:u32(fst,i*12+8)});}
  const requested=String(name).split("/").filter(Boolean).pop().toLowerCase();
  const found=entries.find(e=>e.name===name)||entries.find(e=>e.name.toLowerCase()===requested);
  if(!found){const needle=String(name).toLowerCase().split("/").filter(Boolean).pop()||String(name).toLowerCase();const matches=entries.filter(e=>e.name.toLowerCase().includes(needle)).slice(0,25);return self.postMessage("File not found: "+name+"\\nThe FST reader currently indexes leaf filenames, not full directory paths.\\n\\nPossible filename matches:\\n"+(matches.map(e=>e.name).join("\\n")||"(none)")+"\\n\\nFST entries scanned: "+entries.length);}
  if(offset>found.size||length>found.size-offset)throw Error("Requested range exceeds file size. File size is "+found.size+" bytes.");
  const physical=dataStart+found.offset+offset,bytes=await read(physical,length);
  const result=[
   "PASS — NKit file-range read completed",
   "Disc ID: "+decoder.decode(boot.slice(0,6)),
   "File: "+found.name,
   "Logical file offset: "+hx(found.offset),
   "File size: "+found.size.toLocaleString("en-US")+" bytes ("+hx(found.size)+")",
   "Requested offset: "+offset+" bytes",
   "Physical ISO read offset: "+hx(physical),
   "Bytes requested / returned: "+length+" / "+bytes.length,
   "Hex: "+hex(bytes),
   "ASCII: "+Array.from(bytes,b=>b>=32&&b<=126?String.fromCharCode(b):".").join(""),
   "",
   "Only the requested byte range plus small metadata ranges were read. No whole-ISO or whole-file copy was made."
  ];
  self.postMessage(result.join("\n"));
 }catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};