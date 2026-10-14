# tx.py NAME : what the chat received and did with annotate
import json,sys,re,os
S="/private/tmp/claude-501/-Users-christophersarkissian-Repositories-claude-annotate/5a365e45-fa26-4ab0-a0f1-ee6847b0b5f8/scratchpad/soak"
pid=json.load(open(f"{S}/logs/{sys.argv[1]}.pid"))["claude"]
tp=sys.argv[2] if len(sys.argv)>2 else None
if not tp:
    try: tp=json.load(open(os.path.expanduser(f"~/.cache/claude-annotate/sessions/{pid}.json")))["transcriptPath"]
    except Exception: tp=open(f"{S}/logs/{sys.argv[1]}.tp").read().strip()
open(f"{S}/logs/{sys.argv[1]}.tp","w").write(tp)
def texts(c):
    if isinstance(c,str): yield c; return
    for b in c or []:
        if isinstance(b,dict):
            if b.get("type")=="text": yield b["text"]
            if b.get("type")=="tool_result":
                yield from texts(b.get("content"))
for line in open(tp):
    try: r=json.loads(line)
    except: continue
    t=r.get("type"); ts=r.get("timestamp","")[11:19]
    if t in("user","assistant"):
        m=r.get("message",{}); c=m.get("content")
        if t=="user":
            for x in texts(c):
                if "Browser annotations" in x:
                    hdr=re.search(r"Browser annotations · batch \d+[^\n]*",x)
                    notes=re.findall(r'### Note (\d+) — "([^"]*)"',x)
                    print(ts,"RECV",hdr.group(0) if hdr else "?", notes, "(isMeta)" if r.get("isMeta") else "")
                elif r.get("toolUseResult") is None and not x.startswith("<") and len(x)<300 and "tool_use_id" not in str(c):
                    print(ts,"USER",x[:150].replace("\n"," "))
            if isinstance(c,list):
                for b in c:
                    if isinstance(b,dict) and b.get("type")=="text" and "Browser annotations" not in b["text"] and not b["text"].startswith("<"): pass
        else:
            for b in c or []:
                if b.get("type")=="tool_use" and "annotate" in b.get("name",""):
                    print(ts,"TOOL",b["name"].split("__")[-1],json.dumps(b.get("input"))[:160])
                if b.get("type")=="text" and b["text"].strip(): print(ts,"SAY",b["text"][:140].replace("\n"," "))
    elif t=="attachment" or t=="system":
        s=json.dumps(r)
        if "Browser annotations" in s:
            m=re.search(r"Browser annotations · batch \d+[^\\]*",s); notes=re.findall(r'### Note (\d+) \\u2014 \\"([^\\]*)',s) or re.findall(r'### Note (\d+) — \\"([^\\]*)',s)
            print(ts,"RECV("+t+")",m.group(0) if m else "?",notes)
