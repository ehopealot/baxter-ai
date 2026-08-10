FROM docker:cli
ARG CODAPI_VERSION=0.14.0
# TARGETARCH (arm64 on a Pi, amd64 on an N100) is set by buildkit to the build
# platform and matches codapi's release suffix 1:1, so the same Dockerfile
# self-selects the right binary; the matching checksum is picked below. The
# Makefile also passes TARGETARCH explicitly (the daemon's arch) so this works
# without buildkit and under docker-outside-of-docker.
ARG CODAPI_SHA256_ARM64=c293b409f57ef788589081091cd915c75e2b0468aecc1549dfcc7943f45d3bd8
ARG CODAPI_SHA256_AMD64=292be3d1a37ae918308a9e40de828d38dfd61d5b490369caea00c108bb6ee985
ARG TARGETARCH
# Per-run sandbox OCI runtime, baked into codapi.json at build. Default `runc`
# so an un-provisioned box and Colima dev run unchanged. A hardened box builds
# with CODAPI_RUNTIME=runsc (gVisor) -- the Ansible codapi-hardening role sets it
# in the fleet's systemd environment, so `make run` bakes it in. The value is
# allow-listed below (never interpolated raw into the JSON) so the build arg can
# only ever select a known runtime, never inject arbitrary config.
ARG CODAPI_RUNTIME=runc
WORKDIR /opt/codapi
ADD https://github.com/nalgeon/codapi/releases/download/v${CODAPI_VERSION}/codapi_${CODAPI_VERSION}_linux_${TARGETARCH}.tar.gz /tmp/codapi.tgz
RUN case "$TARGETARCH" in \
      arm64) SHA="$CODAPI_SHA256_ARM64" ;; \
      amd64) SHA="$CODAPI_SHA256_AMD64" ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH' (need arm64 or amd64)" >&2; exit 1 ;; \
    esac \
 && echo "$SHA  /tmp/codapi.tgz" | sha256sum -c - \
 && tar xzf /tmp/codapi.tgz -C /opt/codapi codapi \
 && rm /tmp/codapi.tgz && chmod +x /opt/codapi/codapi
COPY codapi.json /opt/codapi/codapi.json
# Select the sandbox runtime (runc default; runsc on a gVisor-provisioned box).
# Allow-list the value, then rewrite ONLY the box.runtime string in codapi.json,
# so the committed file stays `runc` (dev parity) and the image reflects the box.
RUN case "$CODAPI_RUNTIME" in \
      runc|runsc) ;; \
      *) echo "unsupported CODAPI_RUNTIME '$CODAPI_RUNTIME' (need runc or runsc)" >&2; exit 1 ;; \
    esac \
 && sed -i "s/\"runtime\":[[:space:]]*\"[^\"]*\"/\"runtime\": \"${CODAPI_RUNTIME}\"/" /opt/codapi/codapi.json \
 && grep -q "\"runtime\": \"${CODAPI_RUNTIME}\"" /opt/codapi/codapi.json
COPY sandboxes /opt/codapi/sandboxes
CMD ["./codapi"]
