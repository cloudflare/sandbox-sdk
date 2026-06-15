#!/bin/bash
set -euo pipefail

VERSION=0.20.3
TARBALL="go-containerregistry_Linux_x86_64.tar.gz"

curl -sLO "https://github.com/google/go-containerregistry/releases/download/v${VERSION}/${TARBALL}"
curl -sLO "https://github.com/google/go-containerregistry/releases/download/v${VERSION}/checksums.txt"
grep "${TARBALL}" checksums.txt | sha256sum -c
tar xzf "${TARBALL}" crane
sudo mv crane /usr/local/bin/
rm -f "${TARBALL}" checksums.txt
