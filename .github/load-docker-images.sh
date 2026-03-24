#!/bin/bash
# Load the Docker image list from docker-images.txt into the DOCKER_IMAGES array.
# Validates image names against an allowlist pattern.
#
# Sourced (not executed) by workflow steps — avoid changing shell options.
#
# Usage: source .github/load-docker-images.sh
#        for image in "${DOCKER_IMAGES[@]}"; do ... done

DOCKER_IMAGES=()

while IFS= read -r line; do
  line="${line%%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  if [[ ! "$line" =~ ^sandbox(-[a-z0-9]+)*$ ]]; then
    echo "::error::Invalid image name in docker-images.txt: '$line'"
    exit 1
  fi
  DOCKER_IMAGES+=("$line")
done < docker-images.txt

if [[ ${#DOCKER_IMAGES[@]} -eq 0 ]]; then
  echo "::error::No images found in docker-images.txt"
  exit 1
fi
