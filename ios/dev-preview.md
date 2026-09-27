# Live iPhone frontend preview

The remote WebView prototype can load the local React development server over
Tailscale HTTPS. React and CSS edits then update on the phone without a new IPA.
Swift, native navigation, app permissions, and bundled assets still need an IPA
build. This preview is for development only; the shipped app does not depend on
this host or Tailscale.

## One-time setup

Install the repository dependencies with `bun install --frozen-lockfile` in
`frontend/`. Run the GoonCave backend locally on port 4100 as described in the
project README. Sign in to Tailscale on both the Linux host and iPhone. Tailscale
HTTPS certificates must be enabled for the tailnet.

Find the Linux host's Tailscale DNS name with `tailscale status --json` (look for
`Self.DNSName`). Remove its trailing dot. On the iPhone, open **Change server**
in the remote WebView prototype and enter its HTTPS address. This phone setting
is saved across app launches.

## Start

Choose a free local port; the examples use 5174. In a terminal inside
`frontend/`, run the following command after replacing the example DNS name
with the host's actual Tailscale DNS name:

```sh
__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=your-host.your-tailnet.ts.net bunx vite --host 127.0.0.1 --port 5174 --strictPort
```

In another terminal, route Tailscale HTTPS to that port:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:5174
```

Open the host's HTTPS address with `/health` appended on the phone. It should
return a JSON response with `"status":"ok"`. Then open the app, sign in, and check a Gallery
image. The Vite proxy sends `/health` and `/api` (including authenticated media)
to the local backend. The browser and API therefore share one HTTPS origin and
one session cookie.

Edit a visible React or CSS value and save it. The phone should update without
reinstalling the IPA. Keep the Vite terminal open while previewing.

## Stop

Press Ctrl+C in the Vite terminal, then disable the background HTTPS route:

```sh
tailscale serve --https=443 off
```

If the app shows a connection error, check that the backend and Vite are still
running, both devices are on Tailscale, and the port in `tailscale serve status`
matches the Vite terminal. A port change requires running the Serve command
again with the new port.
