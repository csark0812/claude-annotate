import http from "node:http";
export const PAGES = {
  "/lab": `<!doctype html><meta charset="utf-8"><title>Lab</title>
<style>
 body{font:16px system-ui;margin:0} header{position:sticky;top:0;height:60px;background:#222;color:#fff;z-index:5}
 .zoom{zoom:1.5} .tx{transform:scale(.5) translate(200px,0);transform-origin:0 0}
 @media (prefers-color-scheme: dark){ body{background:#111;color:#eee} }
 #scroller{height:200px;overflow:auto;border:1px solid}
</style>
<header id="hdr"><button id="hdr-btn">Header button</button></header>
<section style="padding:20px">
 <my-widget id="wc"></my-widget>
 <canvas id="cv" width="200" height="80" style="border:1px solid"></canvas>
 <svg id="sv" width="200" height="80"><rect id="svrect" x="10" y="10" width="80" height="40" fill="red"/><text id="svtext" x="100" y="40">SVG label</text></svg>
 <div class="zoom"><button id="zoomed">Zoomed</button></div>
 <div class="tx"><button id="scaled">Scaled button</button></div>
 <iframe id="same" src="/inner" width="300" height="120"></iframe>
 <iframe id="cross" src="CROSS/inner" width="300" height="120"></iframe>
 <div id="scroller">${Array.from({ length: 2000 }, (_, i) => `<div class="row" id="row${i}">Row ${i}</div>`).join("")}</div>
 <div style="height:1500px"></div>
 <button id="bottom">Bottom button</button>
</section>
<script>
customElements.define("my-widget", class extends HTMLElement { constructor(){ super(); const r=this.attachShadow({mode:"open"}); r.innerHTML='<style>button{color:blue}</style><div class="w"><button id="inner-btn">Shadow button</button><span>shadow text</span></div>'; } });
const c=document.getElementById("cv").getContext("2d"); c.fillStyle="green"; c.fillRect(10,10,60,40);
</script>`,
  "/inner": `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui"><h3 id="in-h">Inner frame heading</h3><button id="in-btn">Inner button</button></body>`,
};
export function serve(port, cross) {
  return new Promise((r) => {
    const s = http.createServer((req, res) => {
      const u = req.url.split("?")[0];
      const body = PAGES[u];
      if (!body) { res.writeHead(404); return res.end("nf"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(body.replace("CROSS", cross));
    });
    s.listen(port, "127.0.0.1", () => r(s));
  });
}
