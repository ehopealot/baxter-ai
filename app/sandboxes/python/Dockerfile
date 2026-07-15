FROM python:3.12-slim
RUN adduser --home /sandbox --disabled-password --gecos "" sandbox \
 && pip install --no-cache-dir numpy pandas python-dateutil beautifulsoup4
USER sandbox
WORKDIR /sandbox
