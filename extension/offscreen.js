// Claude Annotate: the tab recorder. The background asks for a recording with a tab-capture stream
// id; this document holds the stream and the MediaRecorder for as long as the recording runs (the
// tab may load other pages meanwhile), then uploads the video to the session the tab sends to.

const TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
let rec = null; // { stream, recorder, chunks, type, startedAt, timer }

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.target !== "offscreen") return;
  const answer = (p) => p.then(reply, (e) => reply({ ok: false, error: e.message }));
  if (m.type === "start") { answer(start(m)); return true; }
  if (m.type === "stop") { answer(stop(m)); return true; }
});

// size: the page's own, scaled to fit 1920×1080, so the video has its shape and no black bars.
async function start({ streamId, size, maxMs }) {
  if (rec) throw new Error("a recording is already running");
  const k = Math.min(1, 1920 / size.w, 1080 / size.h);
  const w = 2 * Math.round((size.w * k) / 2), h = 2 * Math.round((size.h * k) / 2); // even, for the encoder
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, minWidth: w, maxWidth: w, minHeight: h, maxHeight: h, maxFrameRate: 15 } },
  });
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: type || undefined, videoBitsPerSecond: 1200000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  // The tab closed or crashed, or the limit was reached: the background decides what to keep.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => autostop("ended"));
  const timer = setTimeout(() => autostop("limit"), maxMs);
  rec = { stream, recorder, chunks, type, startedAt: Date.now(), timer };
  return { ok: true, startedAt: rec.startedAt };
}

function autostop(reason) {
  chrome.runtime.sendMessage({ type: "rec-autostop", reason }).catch(() => {});
}

// cancel: throw it away. Otherwise upload it with what the user did ({ endpoint, token } is the
// session the tab sends to now) and answer with the server's { id, file, frames, timeline, duration }.
async function stop({ cancel, upload, events }) {
  if (!rec) return { ok: false, error: "nothing is being recorded" };
  const r = rec;
  rec = null;
  clearTimeout(r.timer);
  if (r.recorder.state !== "inactive") {
    const stopped = new Promise((resolve) => { r.recorder.onstop = resolve; });
    r.recorder.stop();
    await stopped;
  }
  for (const t of r.stream.getTracks()) t.stop();
  if (cancel) return { ok: true, cancelled: true };
  const duration = (Date.now() - r.startedAt) / 1000;
  const blob = new Blob(r.chunks, { type: r.type || "video/webm" });
  if (blob.size < 1000) return { ok: false, error: "the recording came out empty" };
  const data = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  const res = await fetch(`${upload.endpoint}/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Annot-Token": upload.token },
    body: JSON.stringify({ data, duration, events }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body.error || `the session answered ${res.status}` };
  return { ok: true, video: body.video };
}
