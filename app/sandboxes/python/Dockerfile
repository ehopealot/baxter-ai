FROM python:3.12-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox \
 && pip install --no-cache-dir numpy pandas python-dateutil beautifulsoup4 \
      pillow matplotlib reportlab
# Headless, file-only backend. Point matplotlib's config/cache at the writable
# tmpfs (/tmp is the only writable path at runtime under the read-only rootfs),
# so it can build its font cache per run without hitting the read-only FS. Fail
# the build early if any media lib is broken on this arch.
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib
RUN python -c "import matplotlib.pyplot, PIL, reportlab; print('media libs ok')"
COPY emit-artifacts.sh /usr/local/bin/emit-artifacts.sh
RUN chmod +x /usr/local/bin/emit-artifacts.sh
USER sandbox
WORKDIR /sandbox
