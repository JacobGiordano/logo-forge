// Minimal ZIP builder — no compression, store-only
function buildZip(files) {
  const u16 = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0,n,true); return b; };
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0,n,true); return b; };
  const cat = (...a) => { const t=a.reduce((s,x)=>s+x.length,0); const o=new Uint8Array(t); let p=0; for(const x of a){o.set(x,p);p+=x.length;} return o; };

  function crc32(buf) {
    if (!crc32.t) {
      crc32.t = new Uint32Array(256);
      for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);crc32.t[i]=c;}
    }
    let c=0xFFFFFFFF;
    for(let i=0;i<buf.length;i++) c=crc32.t[(c^buf[i])&0xFF]^(c>>>8);
    return (c^0xFFFFFFFF)>>>0;
  }

  const records=[], central=[];
  let offset=0;

  for (const {name, data} of files) {
    const nb = new TextEncoder().encode(name);
    const crc = crc32(data);
    const lh = cat(
      new Uint8Array([0x50,0x4B,0x03,0x04]),
      u16(20),u16(0),u16(0),u16(0),u16(0),
      u32(crc),u32(data.length),u32(data.length),
      u16(nb.length),u16(0),nb
    );
    records.push(cat(lh, data));
    central.push(cat(
      new Uint8Array([0x50,0x4B,0x01,0x02]),
      u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),
      u32(crc),u32(data.length),u32(data.length),
      u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nb
    ));
    offset += lh.length + data.length;
  }

  const cd = cat(...central);
  const eocd = cat(
    new Uint8Array([0x50,0x4B,0x05,0x06]),
    u16(0),u16(0),u16(files.length),u16(files.length),
    u32(cd.length),u32(offset),u16(0)
  );

  return cat(...records, cd, eocd);
}
