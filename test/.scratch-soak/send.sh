#!/bin/bash
# send.sh NAME "text"  (use $'\r' for enter, $'\e[B' for down)
S=/private/tmp/claude-501/-Users-christophersarkissian-Repositories-claude-annotate/5a365e45-fa26-4ab0-a0f1-ee6847b0b5f8/scratchpad/soak
printf '%s' "$2" > $S/logs/$1.in
