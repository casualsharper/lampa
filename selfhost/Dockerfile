# Runtime only: Python for selfhost/server.py plus ffmpeg for the browser audio fix.
# The app and server code come from the git checkout mounted at /srv/lampa, so code updates need no new image.
FROM python:3.12-alpine
RUN apk add --no-cache ffmpeg
ENV LAMPA_ROOT=/srv/lampa HOMESYNC_DATA=/data PORT=8080 PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
EXPOSE 8080
CMD ["python", "/srv/lampa/selfhost/server.py"]
