#!/bin/bash
# focus.sh NAME : the desktop app "focuses" that chat now
S=/private/tmp/claude-501/-Users-christophersarkissian-Repositories-claude-annotate/5a365e45-fa26-4ab0-a0f1-ee6847b0b5f8/scratchpad/soak
c=$(python3 -c "import json;print(json.load(open('$S/logs/$1.pid'))['claude'])")
tp=$(python3 -c "import json;print(json.load(open('$HOME/.cache/claude-annotate/sessions/$c.json'))['transcriptPath'])")
id=$(basename "$tp" .jsonl)
now=$(python3 -c "import time;print(int(time.time()*1000))")
printf '{"sessionId":"local_%s","cliSessionId":"%s","lastFocusedAt":%s,"isArchived":false}' "$1" "$id" "$now" > $S/desktop/acct/org/local_$1.json
echo "focused $1 ($id) at $now"
