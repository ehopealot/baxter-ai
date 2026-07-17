# syntax=docker/dockerfile:1
# Base image for stability and security
FROM node:22-slim

# Install system dependencies needed for git workflows and building native
# addons. docker.io provides the `docker` CLI so this container can drive
# the host's Docker daemon (mounted in via the Makefile's `dev` target) to
# build/run the app/ image -- no nested daemon runs inside this container.
RUN apt-get update && apt-get install -y \
    git \
    curl \
    make \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Set up the working directory and a non-root user for security
WORKDIR /app

# Create a local bin for global npm packages and add it to PATH
ENV PATH="/home/node/.local/bin:$PATH"

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Set user to node to avoid running as root
USER node

# Default command opens a bash shell inside the container
CMD ["/bin/bash"]
