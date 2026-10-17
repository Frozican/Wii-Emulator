self.onmessage = async ({data}) => {
  const file = data?.file;
  if (!file) return self.postMessage("FAIL: no file received");
  const u32 = (b,o=0)=>new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(o,false);
  const read = async (o,n)=>new Uint8Array(await file.slice(o,o+n).arrayBuffer());
  const hex = n => "0x"+n.toString(16);
  try {
    const head=await read(0x40000,0x40);
    let partition=0;
    for(let t=0;t<4&&!partition;t++){
      const count=u32(head,t*8), tableWords=u32(head,t*8+4);
      if(count>0&&count<10000&&tableWords>0){
        const tab=await read(tableWords*4,Math.min(count*8,0x10000));
        for(let i=0;i<count;i++) if(u32(tab,i*8+4)===0){partition=u32(tab,i*8)*4;break;}
      }
    }
    if(!partition) throw new Error("No type-0 data partition found.");
    const ph=await read(partition,0x300);
    const dataStart=partition+u32(ph,0x2b8)*4;
    const boot=await read(dataStart,0x440);
    if(new TextDecoder().decode(boot.slice(0,6))!=="RMGE01") throw new Error("Unexpected boot header at calculated data start.");
    const fstOffset=u32(boot,0x424)*4, fstSize=u32(boot,0x428)*4;
    if(fstSize<12||fstSize>16*1024*1024||dataStart+fstOffset+fstSize>file.size) throw new Error("FST range is invalid.");
    const fst=await read(dataStart+fstOffset,fstSize);
    const rootWord=u32(fst,0), count=u32(fst,8);
    if(rootWord!==0x01000000||count<1||count>100000||count*12>fst.length) throw new Error("FST root/entry count invalid.");
    const stringsAt=count*12;
    const decoder=new TextDecoder("utf-8");
    const nameAt=i=>{
      const off=u32(fst,i*12)&0xffffff, start=stringsAt+off;
      if(start>=fst.length) return "[bad-name-offset]";
      let end=start; while(end<fst.length&&fst[end]!==0) end++;
      return decoder.decode(fst.slice(start,end));
    };
    const entries=[];
    const stack=[];
    let files=0, dirs=0, bad=0, dol=null;
    for(let i=0;i<count;i++){
      const w=u32(fst,i*12), isDir=(w>>>24)===1, name=nameAt(i);
      if(i===0){ entries.push({i,isDir:true,name:"",path:"",second:u32(fst,4),third:u32(fst,8)}); dirs++; stack.push({end:count,path:""}); continue; }
      while(stack.length>1&&i>=stack[stack.length-1].end) stack.pop();
      const parent=stack[stack.length-1]||{path:""};
      const path=parent.path?parent.path+"/"+name:name;
      const second=u32(fst,i*12+4), third=u32(fst,i*12+8);
      if(isDir){dirs++; if(third<=i||third>count){bad++;} else stack.push({end:third,path});}
      else {files++; if(/\.dol$/i.test(name)||/\.dol$/i.test(path)) dol={i,path,offset:second,size:third};}
      if(entries.length<50) entries.push({i,isDir,name,path,second,third});
    }
    const samples=entries.filter(e=>e.i>0&&!e.isDir).slice(0,8);
    const checks=[];
    for(const e of samples){
      const off=dataStart+e.second;
      if(e.second>0&&e.third>0&&e.third<0x100000000&&off<file.size){
        const b=await read(off,Math.min(16,e.third));
        checks.push(`${e.path}: FST offset=${hex(e.second)}, size=${hex(e.third)}, raw-at-offset=${Array.from(b.slice(0,8),x=>x.toString(16).padStart(2,"0")).join(" ")}`);
      } else checks.push(`${e.path}: offset/size out of range for a raw-file probe`);
    }
    const lines=[
      "PASS — FST table read and parsed",
      `Disc: RMGE01; file size: ${file.size.toLocaleString("en-US")} bytes`,
      `Partition data start: ${hex(dataStart)}`,
      `FST physical range: ${hex(dataStart+fstOffset)} + ${hex(fstSize)} bytes`,
      `FST root entry count: ${count.toLocaleString("en-US")}`,
      `Parsed entries: directories=${dirs}, files=${files}, invalid directory ranges=${bad}`,
      `Boot DOL entry: ${dol?dol.path+" offset="+hex(dol.offset)+" size="+hex(dol.size):"not found in scanned entry names"}`,
      "",
      "First parsed entries:",
      ...entries.map(e=>`${e.i}: ${e.isDir?"DIR ":"FILE"} ${e.path||"/"} ${e.isDir?"end="+e.third:"offset="+hex(e.second)+" size="+hex(e.third)}`),
      "",
      "Raw physical-offset probes (diagnostic only):",
      ...checks,
      "",
      "Whole ISO copied: NO — only FST and small file samples were read.",
      "Important: valid FST parsing does not prove NKit gap decoding or game boot. Raw file-offset probes may fail because NKit compacts/encodes data gaps."
    ];
    self.postMessage(lines.join("\n"));
  } catch(e){self.postMessage("FAIL\n"+(e?.stack||e?.message||String(e)));}
};