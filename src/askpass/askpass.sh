#!/bin/sh
# GIT_ASKPASS / SSH_ASKPASS entry point. Git runs it with the prompt as the argument.
# Electron acts as Node here, so the portable exe needs no Node installation.
ELECTRON_RUN_AS_NODE=1 exec "$GITLITE_ASKPASS_NODE" "$GITLITE_ASKPASS_MAIN" "$@"
