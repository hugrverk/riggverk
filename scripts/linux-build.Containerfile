# Build image for the Linux release packages (AppImage, deb, rpm). See scripts/linux-build.sh.
#
# Ubuntu 22.04 (glibc 2.35) is the oldest supported base: the binary and the AppImage run on that glibc or newer.
# Every download is pinned by version and checksum, the base image by digest. Bump deliberately.
FROM docker.io/library/ubuntu:22.04@sha256:45e9ddc6895604674618a409ca9f73d301da8fdb75fe330e8e9a27b3b219e4ad

ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
# Must match rust-toolchain.toml.
ARG RUST_TOOLCHAIN=1.97.1

ENV DEBIAN_FRONTEND=noninteractive
# The same system packages as the Linux job in .github/workflows/ci.yml.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    file \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    pkg-config \
    wget \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
  && rm /tmp/node.tar.xz

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
  && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum -c - \
  && chmod +x /tmp/rustup-init \
  && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" \
    --component rustfmt --component clippy \
  && rm /tmp/rustup-init

# linuxdeploy is an AppImage itself; containers have no FUSE, so it unpacks itself instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1

COPY linux-build-inside.sh /usr/local/bin/riggverk-linux-build
