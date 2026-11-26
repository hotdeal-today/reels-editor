// zip.js — 캐러셀 카드 여러 장을 ZIP 한 파일로 묶습니다. (압축 없이 저장하는 방식, 라이브러리 불필요)
//  · JPG는 이미 압축돼 있어 저장(store) 방식으로 묶어도 용량 차이가 거의 없습니다.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function encName(name) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(name);
  const out = [];
  for (let i = 0; i < name.length; i++) out.push(name.charCodeAt(i) & 0xff);
  return new Uint8Array(out);
}

/**
 * @param {{name:string, blob:Blob}[]} files
 * @returns {Promise<Blob>}
 */
export async function buildZip(files) {
  const { time, date } = dosDateTime();
  const entries = [];
  let offset = 0;
  for (const f of files || []) {
    if (!f || !f.blob) continue;
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const nameBytes = encName(f.name || 'file.jpg');
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);          // version needed
    lv.setUint16(6, 0x0800, true);      // UTF-8 이름
    lv.setUint16(8, 0, true);           // store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    entries.push({ nameBytes, data, crc, offset, local });
    offset += local.length + data.length;
  }
  if (!entries.length) throw new Error('묶을 카드가 없습니다.');

  const centralParts = [];
  let centralSize = 0;
  for (const e of entries) {
    const central = new Uint8Array(46 + e.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);          // version made by
    cv.setUint16(6, 20, true);          // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.data.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, e.offset, true);
    central.set(e.nameBytes, 46);
    centralParts.push(central);
    centralSize += central.length;
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const parts = [];
  for (const e of entries) { parts.push(e.local, e.data); }
  parts.push(...centralParts, end);
  return new Blob(parts, { type: 'application/zip' });
}
