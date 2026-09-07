FROM alpine:3.23
CMD ["sh", "-c", "trap 'echo graceful shutdown; exit 0' TERM; while :; do sleep 3600 & wait $!; done"]
