FROM ghcr.io/tmih06/herdr-devcontainer-vibecode-essential:latest

# Replace inherited DooD metadata, which otherwise injects the host socket.
# Prepare private cgroup delegation before the image starts its local daemon.
COPY --chmod=0755 docker-init.sh /usr/local/share/meltiply-docker-init.sh
LABEL devcontainer.metadata='[{"entrypoint":"/usr/local/share/meltiply-docker-init.sh"}]'
ENTRYPOINT ["/usr/local/share/meltiply-docker-init.sh"]
