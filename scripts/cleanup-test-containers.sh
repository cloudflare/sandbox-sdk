#!/bin/bash

# Cleanup script for orphaned test containers
# Run this after container tests to clean up Docker containers that weren't properly terminated

echo "🧹 Cleaning up orphaned test containers..."

# Find all containers with names containing "vitest-pool-workers" (test containers)
CONTAINERS=$(docker ps -q --filter "name=vitest-pool-workers")

if [ -z "$CONTAINERS" ]; then
    echo "✅ No orphaned test containers found"
else
    echo "🔄 Found $(echo "$CONTAINERS" | wc -l) orphaned test containers"
    echo "🛑 Stopping and removing containers..."
    
    # Stop and remove the containers
    docker stop $CONTAINERS
    docker rm $CONTAINERS
    
    echo "✅ Cleanup complete"
fi

# Also clean up any orphaned sandbox test images if needed
echo "🧹 Cleaning up unused sandbox test images..."
docker image prune -f --filter label=sandbox-test

echo "🎉 All cleanup operations completed"