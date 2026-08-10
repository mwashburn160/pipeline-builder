#!/usr/bin/env bash
#
# Guards the exact regression that 404'd the custom-domain GitHub Pages site.
#
# When a custom domain is configured (a non-empty CNAME), the site is served at
# the domain ROOT, so Jekyll's `baseurl` MUST be empty. A leftover project-pages
# baseurl (e.g. "/pipeline-builder") makes every `relative_url` / `absolute_url`
# link render with a bogus "/<baseurl>/..." prefix → "must provide index.html"
# 404 on the homepage and every sub-page. This check fails fast on that mismatch.
#
set -euo pipefail

cd "$(dirname "$0")/../.."

cname=""
[ -f CNAME ] && cname="$(tr -d '[:space:]' < CNAME)"

baseurl=""
if [ -f _config.yml ]; then
  # Strip the key, surrounding quotes, inline comments, and whitespace.
  baseurl="$(grep -E '^baseurl:' _config.yml \
    | sed -E 's/^baseurl:[[:space:]]*//; s/#.*$//; s/^"//; s/"[[:space:]]*$//; s/^'\''//; s/'\''[[:space:]]*$//' \
    | tr -d '[:space:]')"
fi

if [ -n "$cname" ] && [ -n "$baseurl" ]; then
  echo "::error file=_config.yml::Custom domain '$cname' (CNAME) is set but _config.yml baseurl is '$baseurl'. A custom domain serves at the root, so baseurl MUST be empty (\"\") — a non-empty baseurl 404s every page via a bogus /$baseurl/ link prefix."
  exit 1
fi

echo "Pages baseurl/CNAME consistent — baseurl='${baseurl:-<empty>}', CNAME='${cname:-<none>}'."
