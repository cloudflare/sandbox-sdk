FROM sandbox-desktop:local
EXPOSE 6080

# Cloudflare-branded desktop wallpaper
COPY assets/wallpaper.png /usr/share/backgrounds/cloudflare.png
COPY assets/set-wallpaper.sh /usr/local/bin/set-wallpaper.sh
RUN chmod +x /usr/local/bin/set-wallpaper.sh
COPY assets/set-wallpaper.desktop /etc/xdg/autostart/set-wallpaper.desktop
