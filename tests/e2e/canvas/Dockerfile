# =============================================================================
# Canvas LMS image for Pawtograder LTI 1.3 end-to-end testing.
#
# Built FROM the official Instructure base image, mirroring the steps in
# Canvas's own Dockerfile.production (bundle install + yarn install +
# canvas:compile_assets) so that Ruby gems AND JS/CSS assets are baked into the
# image and the container boots without a long first-run asset build.
#
# Difference from Dockerfile.production: we run in RAILS_ENV=development. The
# Canvas-provided containerized config samples (docker-compose/config/*) ship a
# fully-populated `development` tree -- including pre-stubbed LTI signing JWKs
# under dynamic_settings.yml -> store.canvas.lti-keys -- which is exactly what
# LTI 1.3 launches need. Production would additionally require SECRET_KEY_BASE
# and per-deployment encryption keys wired in at asset-compile time; development
# avoids that friction while still producing a baked, bootable image. The web
# service still runs under puma (see docker-compose.yml).
#
# Pinned Canvas ref: tag release/2026-05-20.143
#                    commit 2e2b4a46d08e32667d4845f7b78e1214250345d3
#
# Build context MUST be a checkout of instructure/canvas-lms at that ref. The
# config/*.yml files that Canvas expects are layered in from the build context's
# sibling `e2e-config/` dir via the build (see build.sh).
# =============================================================================

ARG RUBY=3.4
FROM instructure/ruby-passenger:${RUBY}-jammy

LABEL org.opencontainers.image.source="https://github.com/instructure/canvas-lms"
LABEL org.opencontainers.image.description="Canvas LMS (release/2026-05-20.143) baked for Pawtograder LTI 1.3 e2e"

ARG RUBY
ARG POSTGRES_CLIENT=14
ARG CANVAS_RAILS=8.0
ARG NODE_MAJOR=20

ENV APP_HOME=/usr/src/app/
ENV RAILS_ENV=development
ENV CANVAS_RAILS=${CANVAS_RAILS}
ENV NODE_MAJOR=${NODE_MAJOR}
ENV NGINX_MAX_UPLOAD_SIZE=10g
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_CTYPE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV GEM_HOME=/home/docker/.gem/${RUBY}
ENV PATH=${APP_HOME}bin:${GEM_HOME}/bin:$PATH
ENV BUNDLE_APP_CONFIG=/home/docker/.bundle

WORKDIR $APP_HOME

USER root
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
  && printf 'path-exclude /usr/share/doc/*\npath-exclude /usr/share/man/*' > /etc/dpkg/dpkg.cfg.d/01_nodoc \
  && echo "deb http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && curl -sS https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - \
  && add-apt-repository ppa:git-core/ppa -ny \
  && apt-get update -qq \
  && apt-get install -qqy --no-install-recommends \
       nodejs \
       libxmlsec1-dev \
       python3-lxml \
       python-is-python3 \
       libicu-dev \
       libidn11-dev \
       parallel \
       postgresql-client-$POSTGRES_CLIENT \
       tzdata \
       unzip \
       pbzip2 \
       git \
       build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /home/docker/.gem/ruby/$RUBY_MAJOR.0

RUN gem install bundler --no-document -v 2.5.10 \
  && find $GEM_HOME ! -user docker | xargs chown docker:docker
RUN npm install -g npm@9.8.1 && npm cache clean --force

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare yarn@1.19.1 --activate

USER docker

# --- Application source (the canvas-lms checkout) ---------------------------
COPY --chown=docker:docker . /usr/src/app

# --- Layer in the e2e config files -----------------------------------------
# These are copied into the build context as ./e2e-config by build.sh.
COPY --chown=docker:docker e2e-config/ /usr/src/app/config/

RUN mkdir -p tmp/files log tmp/pids

# --- Ruby gems --------------------------------------------------------------
RUN unset RUBY && bundle config --global build.nokogiri --use-system-libraries \
  && bundle config --global build.ffi --enable-system-libffi \
  && bundle install

# --- JS deps + asset compile ------------------------------------------------
# Speed-ups: skip API docs and all-locales i18n (we only need English for e2e).
ENV COMPILE_ASSETS_BRAND_CONFIGS=0
ENV COMPILE_ASSETS_NPM_INSTALL=0
ENV COMPILE_ASSETS_API_DOCS=0
ENV RAILS_LOAD_ALL_LOCALES=0
RUN yarn install --frozen-lockfile || yarn install --frozen-lockfile --network-concurrency 1
# Rails boots the full app to run this rake task, which parses database.yml and
# security.yml. Those read POSTGRES_PASSWORD / ENCRYPTION_KEY from the env, which
# are only set at runtime (compose) — supply build-time placeholders so boot
# succeeds. No DB connection is made during asset compilation. DISABLE_SPRING
# avoids the dev preloader inside the build. These are scoped to this RUN only
# (not baked as image ENV), so compose's real runtime values still apply.
RUN POSTGRES_PASSWORD=build_placeholder \
    ENCRYPTION_KEY=build_time_placeholder_key_change_me \
    DISABLE_SPRING=1 \
    bin/rails canvas:compile_assets --trace \
  && rm -rf node_modules

EXPOSE 3000
