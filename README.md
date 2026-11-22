# Life Web Cloud

The server for [Life Web](https://github.com/B-Kpr/lifeweb-server): it keeps your boards so every device (computers, phones, the people you invite, and
Claude) works on the same ones, with full history.

## Install (Ubuntu 22.04 or newer)

On the server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/B-Kpr/lifeweb-server/main/install.sh | bash
```

It installs Docker, starts Life Web Cloud and gives it a public https address through Tailscale (a free account; you click one sign-in
link, and on a new account one more to switch Funnel on). At the end it prints:

1. a **connection link**: in Life Web, File › Connections… › paste it into *Connection link or invite*;
2. a **Claude connector link**: in Claude, Settings › Connectors › Add custom connector.

Both stay in `~/life-web/CONNECT.txt` on the server. Keep them private: they open your boards.

Run the same command again to update. Your settings, boards and Tailscale sign-in are kept. `LIFEWEB_PUBLIC=0` keeps the server on your own
network only.

Life Web Cloud 2.1.1.
