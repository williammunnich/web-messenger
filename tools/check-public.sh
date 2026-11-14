#!/bin/bash
# @file check-public.sh
# Run before pushing: fails if anything tracked by git looks private.
#   1. key and token shapes, and files that should never be committed
#   2. your own strings, one regex per line in .private-patterns (gitignored, so the list itself stays private)
# It also checks every commit's author address, since those are public too.
#
# @project web-messenger
# @usage bash tools/check-public.sh   (or: npm run check:public)
# @exit 0 when nothing private was found; 1 otherwise, after printing what was found.
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-12
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
files=$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v '^tools/check-public.sh$')

shapes='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_(live|test)_[0-9a-zA-Z]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|GOCSPX-[A-Za-z0-9_-]{20,}|[0-9]+-[a-z0-9]{32}\.apps\.googleusercontent\.com|arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:'
hits=$(echo "$files" | tr '\n' '\0' | xargs -0 grep -InE "$shapes" 2>/dev/null)
if [ -n "$hits" ]; then echo "Looks like a secret:"; echo "$hits" | cut -c1-120; fail=1; fi

bad=$(echo "$files" | grep -E '(^|/)(deploy\.env|Local\.xcconfig|\.env(\..*)?|\.private-patterns)$|\.(p8|pem|mobileprovision)$')
if [ -n "$bad" ]; then echo "These files must not be public:"; echo "$bad"; fail=1; fi

if [ -f .private-patterns ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue; case "$p" in \#*) continue ;; esac
    hits=$(echo "$files" | tr '\n' '\0' | xargs -0 grep -InEi -- "$p" 2>/dev/null)
    if [ -n "$hits" ]; then echo "Private string ($p):"; echo "$hits" | cut -c1-120; fail=1; fi
    if git rev-parse -q --verify HEAD >/dev/null && git log --all --format='%an %ae %cn %ce %B' | grep -qEi -- "$p"; then
      case "$p" in *noreply*) ;; *) echo "Private string in commit metadata: $p"; fail=1 ;; esac
    fi
  done < .private-patterns
fi

if git rev-parse -q --verify HEAD >/dev/null; then
  mails=$(git log --all --format='%ae%n%ce' | sort -u | grep -v 'noreply' || true)
  if [ -n "$mails" ]; then echo "Commit addresses that aren't noreply:"; echo "$mails"; fail=1; fi
fi

[ $fail = 0 ] && echo "public check passed ($(echo "$files" | wc -l | tr -d ' ') files)"
exit $fail
