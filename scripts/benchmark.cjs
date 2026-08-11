/**
 * GeoJoiner Benchmark — Flatbush vs Multi-Res Grid + Ring Bbox Pruning
 * Fully inlined decode — no function calls, no closure captures.
 */
"use strict";
const { readFileSync } = require("fs");
const { join } = require("path");
const Flatbush = require("flatbush").default;

const DATA_DIR = join(__dirname, "..", "public", "data");
const LAYERS = [["countries","Countries"],["us-states","US States"],["us-counties","US Counties"],["nerc-regions","NERC Regions"],["balancing-authorities","Balancing Auth"],["canada-provinces","Canada Provinces"]];

function decodeGjbf(raw) {
  var src = new Uint8Array(raw.length);
  src.set(raw);
  var dv = new DataView(src.buffer);
  var dec = new TextDecoder();
  var off = 0;
  var v;

  // magic
  v = dv.getUint32(off, true); off += 4; if (v !== 0x46424a47) throw Error("bad magic");
  // ver
  v = dv.getUint32(off, true); off += 4; var ver = v;
  // nf
  v = dv.getUint32(off, true); off += 4; var nf = v;
  // npg
  v = dv.getUint32(off, true); off += 4; var npg = v;
  // nr
  v = dv.getUint32(off, true); off += 4; var nr = v;
  // pk
  v = dv.getUint32(off, true); off += 4; var pk = v;

  var pkT = pk > 0 ? dec.decode(new Uint8Array(src.buffer, off, pk)) : null;
  off += pk;

  // bboxes: copy to aligned buffer
  var bbN = nf * 4 * 8;
  var tmp = new Uint8Array(bbN);
  tmp.set(new Uint8Array(src.buffer, off, bbN));
  off += bbN;
  var bb = new Float64Array(tmp.buffer);

  // prop values
  var pv = [];
  for (var i = 0; i < nf; i++) {
    v = dv.getUint32(off, true); off += 4;
    var sl = v;
    pv.push(sl > 0 ? dec.decode(new Uint8Array(src.buffer, off, sl)) : "");
    off += sl;
  }

  // polyGroupStart
  var n2 = (nf + 1) * 4;
  tmp = new Uint8Array(n2); tmp.set(new Uint8Array(src.buffer, off, n2)); off += n2;
  var ps = new Uint32Array(tmp.buffer);

  // ringGroupStart
  n2 = (npg + 1) * 4;
  tmp = new Uint8Array(n2); tmp.set(new Uint8Array(src.buffer, off, n2)); off += n2;
  var rs = new Uint32Array(tmp.buffer);

  // ringToFeature
  n2 = nr * 4;
  tmp = new Uint8Array(n2); tmp.set(new Uint8Array(src.buffer, off, n2)); off += n2;
  var rf = new Uint32Array(tmp.buffer);

  // coord arrays
  var ca = [];
  for (var i = 0; i < nr; i++) {
    v = dv.getUint32(off, true); off += 4;
    var nc = v;
    var cn = nc * 2 * 8;
    tmp = new Uint8Array(cn); tmp.set(new Uint8Array(src.buffer, off, cn)); off += cn;
    ca.push(new Float64Array(tmp.buffer));
  }

  // ring bboxes (v2+)
  var rbx = null;
  if (ver >= 2) {
    n2 = nr * 4 * 8;
    tmp = new Uint8Array(n2); tmp.set(new Uint8Array(src.buffer, off, n2)); off += n2;
    rbx = new Float64Array(tmp.buffer);
  }

  return { nf, npg, nr, bb, pv, ps, rs, rf, ca, rbx };
}

function pointInRing(lo, la, ring) {
  var inside = false;
  var n = ring.length / 2;
  for (var i = 0, j = n - 1; i < n; j = i++) {
    var xi = ring[i*2], yi = ring[i*2+1], xj = ring[j*2], yj = ring[j*2+1];
    if ((yi > la) !== (yj > la) && lo < xj + (xi - xj) * (la - yj) / (yi - yj)) inside = !inside;
  }
  return inside;
}

function matchNB(lo, la, fi, d) {
  for (var pg = d.ps[fi]; pg < d.ps[fi+1]; pg++) {
    var rs = d.rs[pg], re = d.rs[pg+1];
    if (!pointInRing(lo, la, d.ca[rs])) continue;
    var ins = true;
    for (var r = rs+1; r < re; r++) if (pointInRing(lo, la, d.ca[r])) ins = !ins;
    if (ins) return true;
  }
  return false;
}

function matchBB(lo, la, fi, d) {
  var rb = d.rbx;
  for (var pg = d.ps[fi]; pg < d.ps[fi+1]; pg++) {
    var rs = d.rs[pg], re = d.rs[pg+1];
    if (rb) { var o = rs*4; if (lo < rb[o] || la < rb[o+1] || lo > rb[o+2] || la > rb[o+3]) continue; }
    if (!pointInRing(lo, la, d.ca[rs])) continue;
    var ins = true;
    for (var r = rs+1; r < re; r++) {
      if (rb) { var o = r*4; if (lo < rb[o] || la < rb[o+1] || lo > rb[o+2] || la > rb[o+3]) continue; }
      if (pointInRing(lo, la, d.ca[r])) ins = !ins;
    }
    if (ins) return true;
  }
  return false;
}

// Grid
var NCELL = 64800, NLA = 180, NLO = 360;

function buildGrid(d) {
  var gt = new Uint32Array(NCELL); gt.fill(0xffffffff);
  var buk = [], bm = new Uint32Array(NCELL); bm.fill(0xffffffff);
  for (var i = 0; i < d.nf; i++) {
    var cl0 = Math.max(0, Math.floor((d.bb[i*4+1]+90)/1)), cl1 = Math.min(179, Math.floor((d.bb[i*4+3]+90)/1));
    var cn0 = Math.max(0, Math.floor((d.bb[i*4]+180)/1)), cn1 = Math.min(359, Math.floor((d.bb[i*4+2]+180)/1));
    for (var c = cl0; c <= cl1; c++) for (var n = cn0; n <= cn1; n++) {
      var idx = c * NLO + n;
      var b = bm[idx]; if (b === 0xffffffff) { b = buk.length; bm[idx] = b; buk.push([i]); } else buk[b].push(i);
    }
  }
  var pts = [], st = new Uint32Array(NCELL); st.fill(0xffffffff); var go = 0;
  for (var ci = 0; ci < NCELL; ci++) {
    var b = bm[ci]; if (b === 0xffffffff) continue;
    var bk = buk[b];
    if (bk.length <= 20) {
      var e = new Uint32Array(1 + bk.length); e[0] = bk.length; for (var i = 0; i < bk.length; i++) e[1+i] = bk[i];
      st[ci] = go; pts.push(e); go += e.length;
    } else {
      var cl = Math.floor(ci/360)|0, cn = ci%360;
      var ol = -90 + cl, on = -180 + cn;
      var sb = Array.from({length:25}, function(){return [];});
      for (var fi = 0; fi < bk.length; fi++) {
        var fi2 = bk[fi];
        var sl0 = Math.max(0,(Math.max(d.bb[fi2*4+1],ol)-ol)*5|0), sl1 = Math.min(4,(Math.min(d.bb[fi2*4+3],ol+1)-ol)*5|0);
        var sn0 = Math.max(0,(Math.max(d.bb[fi2*4],on)-on)*5|0), sn1 = Math.min(4,(Math.min(d.bb[fi2*4+2],on+1)-on)*5|0);
        for (var c2 = sl0; c2 <= sl1; c2++) for (var n2 = sn0; n2 <= sn1; n2++) sb[c2*5+n2].push(fi2);
      }
      var sp = [], so = new Uint32Array(25);
      for (var s = 0; s < 25; s++) { var sbk = sb[s]; so[s] = sbk.length===0?0xffffffff:(sp.push(sbk.length),Array.prototype.push.apply(sp,sbk),sp.length-sbk.length-1); }
      var e = new Uint32Array(28+sp.length); e[0]=0; e[1]=5; e[2]=25;
      for (var s = 0; s < 25; s++) e[3+s] = so[s];
      for (var i = 0; i < sp.length; i++) e[28+i] = sp[i];
      st[ci]=go; pts.push(e); go+=e.length;
    }
  }
  var tl=0; for(var p = 0; p < pts.length; p++) tl+=pts[p].length;
  var ff=new Uint32Array(tl); var w=0;
  for(var p = 0; p < pts.length; p++){ff.set(pts[p],w);w+=pts[p].length;}
  for(var i=0;i<NCELL;i++) if(st[i]!==0xffffffff) gt[i]=st[i];
  return {gt:gt,ff:ff};
}

function qry(g,la,lo) {
  var ci=((la+90)/1)|0, cj=((lo+180)/1)|0;
  if(ci<0||ci>=180||cj<0||cj>=360) return {c:0,o:0,g:g};
  var off=g.gt[ci*360+cj]; if(off===0xffffffff) return {c:0,o:0,g:g};
  var ec=g.ff[off];
  if(ec===0) {
    var ol=-90+ci, on=-180+cj;
    var si=((la-ol)*5)|0, sj=((lo-on)*5)|0, sd=5;
    if(si<0||si>=sd||sj<0||sj>=sd) return {c:0,o:0,g:g};
    var so=g.ff[off+3+si*sd+sj]; if(so===0xffffffff) return {c:0,o:0,g:g};
    return {c:g.ff[off+3+25+so], o:off+3+25+so, g:g};
  }
  return {c:ec, o:off, g:g};
}

// ── Main ──
var NP = 100000, pts = [];
for(var i=0;i<NP;i++) pts.push({la:+(25+Math.random()*25).toFixed(6),lo:+(-125+Math.random()*65).toFixed(6)});

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  GeoJoiner — Flatbush vs Multi-Res Grid + Ring Bbox Pruning");
console.log("══════════════════════════════════════════════════════════════\n");
console.log("  " + NP.toLocaleString() + " test points (US continental focus)\n");

console.log("── Loading ──\n");
var ly = [];

for(var li = 0; li < LAYERS.length; li++) {
  var id = LAYERS[li][0], label = LAYERS[li][1];
  var raw = readFileSync(join(DATA_DIR, id+'.gjbf'));
  var t0 = performance.now(); var d = decodeGjbf(raw); var dt = performance.now()-t0;
  var t1 = performance.now(); var fb = new Flatbush(d.nf);
  for(var i=0;i<d.nf;i++) fb.add(d.bb[i*4],d.bb[i*4+1],d.bb[i*4+2],d.bb[i*4+3]);
  fb.finish(); var ft = performance.now()-t1;
  var t2 = performance.now(); var gr = buildGrid(d); var gt = performance.now()-t2;
  var ne=0,re=0; for(var i=0;i<NCELL;i++) if(gr.gt[i]!==0xffffffff){ne++;if(gr.ff[gr.gt[i]]===0)re++;}
  ly.push({id:id,label:label,d:d,fb:fb,gr:gr});
  var mb = (raw.length/1e6).toFixed(1);
  console.log("  " + label.padEnd(22) + " " + mb + "MB  d:" + dt.toFixed(1) + "ms  f:" + ft.toFixed(0) + "ms  g:" + gt.toFixed(1) + "ms  f:" + d.nf + "  r:" + d.nr + "  cells:" + ne + "  ref:" + re);
}

console.log("\n── Per-Layer ──\n");
console.log("  " + "Layer".padEnd(22) + "  Flatbush  Grid  GridBB  Cand     Match");
console.log("".repeat(63, "─"));

var tf=0,tg=0,tb=0,cf=0,cg=0;

for(var li = 0; li < ly.length; li++) {
  var l = ly[li], d = l.d;

  var t = performance.now(), fm=0, fc=0;
  for(var pi=0;pi<NP;pi++){var p=pts[pi];var c=l.fb.search(p.lo,p.la,p.lo,p.la);fc+=c.length;for(var fi=0;fi<c.length;fi++)if(matchNB(p.lo,p.la,c[fi],d)){fm++;break;}}
  var fT = performance.now()-t;

  t = performance.now(); var gm=0, gc=0;
  for(var pi=0;pi<NP;pi++){var p=pts[pi];var c=qry(l.gr,p.la,p.lo);gc+=c.c;for(var fi=0;fi<c.c;fi++)if(matchNB(p.lo,p.la,c.g.ff[c.o+1+fi],d)){gm++;break;}}
  var gT = performance.now()-t;

  t = performance.now(); var bm=0;
  for(var pi=0;pi<NP;pi++){var p=pts[pi];var c=qry(l.gr,p.la,p.lo);for(var fi=0;fi<c.c;fi++)if(matchBB(p.lo,p.la,c.g.ff[c.o+1+fi],d)){bm++;break;}}
  var bT = performance.now()-t;

  tf+=fT; tg+=gT; tb+=bT; cf+=fc; cg+=gc;
  var r1=(fT/gT).toFixed(2),r3=(fT/bT).toFixed(2);
  var avgFC=(fc/NP).toFixed(1), avgGC=(gc/NP).toFixed(1);
  console.log("  " + l.label.padEnd(22) + "  " + fT.toFixed(0) + "ms  " + gT.toFixed(0) + "ms  " + bT.toFixed(0) + "ms  " + avgFC + "/" + avgGC + "  " + fm + "/" + gm + "/" + bm + "  FB/G:" + r1 + "x  G+BB:" + r3 + "x");
}

console.log(("").padEnd(63, "─"));
var avgFC=(cf/(6*NP)).toFixed(1), avgGC=(cg/(6*NP)).toFixed(1);
console.log("  " + "TOTAL".padEnd(22) + "  " + tf.toFixed(0) + "ms  " + tg.toFixed(0) + "ms  " + tb.toFixed(0) + "ms  " + avgFC + "/" + avgGC);
console.log("\n  Grid+bbox vs Flatbush: " + (tf/tb).toFixed(2) + "x  (Grid no-bbox: " + (tf/tg).toFixed(2) + "x, Bbox speedup: " + (tg/tb).toFixed(2) + "x)");
console.log("  Per-ring bbox pruning: 4 float comparisons vs N coordinate-pair ring walk.\n");

// Polyfill padEnd for older Node
if (typeof "".padEnd !== "function") String.prototype.padEnd = function(n,s){var r=this;while(r.length<n)r+=s||" ";return r.substring(0,n);};