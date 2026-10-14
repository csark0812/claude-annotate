#!/bin/bash
# start-chat.sh NAME PROJ [extra claude args...]
S=/private/tmp/claude-501/-Users-christophersarkissian-Repositories-claude-annotate/5a365e45-fa26-4ab0-a0f1-ee6847b0b5f8/scratchpad/soak; R=/Users/christophersarkissian/Repositories/claude-annotate
N=$1; P=$2; shift 2
cd /
env -u CLAUDECODE ANNOTATE_DESKTOP_DIR=$S/desktop nohup python3 -I $R/test/.scratch-soak/ptydrv.py $N $S/proj$P $S/logs -- claude --plugin-dir $R --model haiku --settings $S/settings.json "$@" > $S/logs/$N.driver.log 2>&1 &
