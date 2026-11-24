// Losslessly drop trailing digital silence (|sample|<=1) from 16-bit PCM WAVs.
import fs from 'fs';
const [,, src, dst] = process.argv;
const b = fs.readFileSync(src); let o = 12, fmt, data;
while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'fmt ') fmt = b.subarray(o + 8, o + 8 + sz); if (id === 'data') data = b.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz & 1); }
const ch = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), frame = ch * 2;
let end = data.length / frame;
while (end > 0) { let silent = true; for (let c = 0; c < ch; c++) if (Math.abs(data.readInt16LE((end - 1) * frame + c * 2)) > 1) silent = false; if (!silent) break; end--; }
end = Math.min(data.length / frame, end + 64);
const pcm = data.subarray(0, end * frame), h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * frame, 28); h.writeUInt16LE(frame, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(dst, Buffer.concat([h, pcm]));
console.log(dst, (data.length / frame / rate).toFixed(3) + 's ->', (end / rate).toFixed(3) + 's', pcm.length + 44, 'bytes');
