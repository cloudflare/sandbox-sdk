#!/bin/bash
set -euo pipefail

workflow=.github/workflows/release.yml

awk '/^concurrency:/{f=1} f&&/group: release-refs\/heads\/main/{g=1} f&&/cancel-in-progress: false/{c=1} END{exit !(g&&c)}' "$workflow"
awk '/release-orchestrator.ts stable/{s=NR} /promote-references.ts/{p=NR} /changesets\/action@/{ch=NR} END{exit !(s>0&&p>s&&ch>p)}' "$workflow"

echo 'release serialization + ordering guards passed'
