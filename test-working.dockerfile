# Quick test dockerfile
FROM oven/bun:alpine

WORKDIR /app

# Create minimal test files since container_src doesn't exist
RUN echo 'console.log("Bun + Environment test ✅");' > index.ts
RUN echo '{"name": "test", "version": "1.0.0"}' > package.json

EXPOSE 3000

CMD ["bun", "run", "index.ts"]