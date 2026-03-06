#!/bin/bash
# Set the Cloudflare wallpaper for whatever monitor XFCE detects.
# Runs as an XFCE autostart entry after xfdesktop initializes.
sleep 2
for prop in $(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep last-image); do
  xfconf-query -c xfce4-desktop -p "$prop" -s "/usr/share/backgrounds/cloudflare.png"
done
