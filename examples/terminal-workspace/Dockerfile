FROM debian:trixie-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tmux \
  && rm -rf /var/lib/apt/lists/*
# Scroll back with the mouse wheel, and keep more history for reattached terminals.
RUN printf 'set -g mouse on\nset -g history-limit 50000\n' >/etc/tmux.conf
WORKDIR /workspace
CMD ["sleep", "infinity"]
