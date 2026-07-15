FROM node:20-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox
# Bake libs OUTSIDE /sandbox: codapi bind-mounts the per-run code dir over
# /sandbox at run time, which would shadow a node_modules placed there. Install
# to /opt/nodelibs (world-readable) and let NODE_PATH resolve them offline.
RUN mkdir -p /opt/nodelibs \
 && cd /opt/nodelibs && npm install --no-fund --no-audit lodash dayjs
ENV NODE_PATH=/opt/nodelibs/node_modules
USER sandbox
WORKDIR /sandbox
