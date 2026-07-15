FROM docker:cli
ARG CODAPI_VERSION=0.14.0
ARG CODAPI_SHA256=c293b409f57ef788589081091cd915c75e2b0468aecc1549dfcc7943f45d3bd8
WORKDIR /opt/codapi
ADD https://github.com/nalgeon/codapi/releases/download/v${CODAPI_VERSION}/codapi_${CODAPI_VERSION}_linux_arm64.tar.gz /tmp/codapi.tgz
RUN echo "${CODAPI_SHA256}  /tmp/codapi.tgz" | sha256sum -c - \
 && tar xzf /tmp/codapi.tgz -C /opt/codapi codapi \
 && rm /tmp/codapi.tgz && chmod +x /opt/codapi/codapi
COPY codapi.json /opt/codapi/codapi.json
COPY sandboxes /opt/codapi/sandboxes
CMD ["./codapi"]
